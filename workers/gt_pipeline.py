"""
workers/gt_pipeline.py
Semi-automated ground truth pipeline.

Steps:
  1. Render each PDF page to PNG at 3x scale (~216 DPI equivalent).
  2. Send each page image to Claude via Anthropic API with strict ordering prompt.
  3. Run PyMuPDF native extraction on the same PDF.
  4. Compute SequenceMatcher similarity between VLM and native outputs.
  5. If similarity >= (1 - DIVERGENCE_THRESHOLD): auto-accept VLM text as GT.
  6. If similarity < threshold: save both versions; flag for human review.
  7. Extract numeric entities from the final GT text.
  8. Write GroundTruth row to PostgreSQL.

DIVERGENCE_THRESHOLD = 0.15 means: flag if similarity < 85%.
For multilingual docs, consider raising to 0.20.

Usage:
  python3 workers/gt_pipeline.py \\
    --document-id clxxx \\
    --pdf /abs/path/to/file.pdf \\
    --stratum-id NATIVE-TWO-COL \\
    --db-url postgresql://...
"""
import argparse
import base64
import hashlib
import json
import re
import sys
import traceback
import os
from difflib import SequenceMatcher
from pathlib import Path

import fitz
import psycopg2
from anthropic import Anthropic

DIVERGENCE_THRESHOLD = 0.15   # Flag for human review if similarity < 0.85
VLM_MODEL = "deepseek-v4-flash"
VLM_PAGE_SCALE = 3.0           # Scale factor for PNG rendering (3x ≈ 216 DPI)

# Regex patterns for numeric entity extraction (mirrors metrics/numeric_accuracy.py)
NUMERIC_PATTERNS = {
    "phones":      r'\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b',
    "dates":       r'\b(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:19|20)\d{2})\b',
    "year_ranges": r'\b(19|20)\d{2}\s*[-–—]\s*(?:(19|20)\d{2}|[Pp]resent|[Cc]urrent)\b',
    "salaries":    r'(?:₹|Rs\.?)\s*\d{1,3}(?:,\d{2,3})*(?:\.\d+)?(?:\s*(?:LPA|CTC|PA))?|\$\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?[KkMm]?',
    "percentages": r'\b\d{1,3}(?:\.\d+)?%',
    "versions":    r'\b[vV]?\d+\.\d+(?:\.\d+)*\b',
    "emails":      r'\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b',
    "urls":        r'https?://[^\s<>"{}|\\^`\[\]]+',
}


def render_page_to_b64_png(page: fitz.Page, scale: float = VLM_PAGE_SCALE) -> str:
    """Render a PDF page to a base64-encoded PNG string."""
    mat = fitz.Matrix(scale, scale)
    pix = page.get_pixmap(matrix=mat)
    png_bytes = pix.tobytes("png")
    return base64.standard_b64encode(png_bytes).decode("utf-8")


def extract_vlm_text(pdf_path: str, client: Anthropic) -> str:
    """
    Extract text from all pages using Claude Vision.
    Explicit prompt enforces:
      - Left-column-first ordering for multi-column layouts
      - Verbatim transcription (no paraphrasing)
      - Preservation of all numbers, dates, and punctuation
    """
    doc = fitz.open(pdf_path)
    page_outputs = []

    for page_num, page in enumerate(doc, start=1):
        img_b64 = render_page_to_b64_png(page)
        response = client.messages.create(
            model=VLM_MODEL,
            max_tokens=4096,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png",
                                "data": img_b64,
                            },
                        },
                        {
                            "type": "text",
                            "text": (
                                "Transcribe ALL text from this resume page exactly as it appears. "
                                "Rules: "
                                "(1) Preserve reading order: left-column top-to-bottom FIRST, "
                                "then right-column top-to-bottom. "
                                "(2) Never paraphrase, summarise, or omit any text. "
                                "(3) Preserve ALL numbers, dates, percentages, and punctuation verbatim — "
                                "do not normalise or reformat them. "
                                "(4) Separate visually distinct sections with a blank line. "
                                "(5) Output ONLY the transcribed text. "
                                "Do not add any commentary, labels, or explanations."
                            ),
                        },
                    ],
                }
            ],
        )
        page_text = response.content[0].text
        page_outputs.append(f"=== PAGE {page_num} ===\n{page_text}")
        print(f"  [gt_pipeline] VLM processed page {page_num}", flush=True)

    doc.close()
    return "\n\n".join(page_outputs)


def extract_native_text(pdf_path: str) -> str:
    """
    PyMuPDF native extraction with column-aware sort.
    Used as cross-reference for similarity scoring — NOT as the GT itself.
    """
    doc = fitz.open(pdf_path)
    pages = []
    for page in doc:
        raw = page.get_text(
            "dict",
            flags=fitz.TEXT_PRESERVE_LIGATURES | fitz.TEXT_PRESERVE_WHITESPACE,
        )
        blocks = [b for b in raw.get("blocks", []) if b.get("type") == 0]
        page_w = page.rect.width
        col_boundary = page_w * 0.45
        right_side = [b for b in blocks if b["bbox"][0] >= col_boundary]
        multi_col = len(right_side) / max(len(blocks), 1) > 0.20

        if multi_col:
            left = sorted([b for b in blocks if b["bbox"][0] < col_boundary], key=lambda b: b["bbox"][1])
            right = sorted(right_side, key=lambda b: b["bbox"][1])
            ordered = left + right
        else:
            ordered = sorted(blocks, key=lambda b: (b["bbox"][1], b["bbox"][0]))

        page_text = "\n".join(
            " ".join(s["text"] for ln in b.get("lines", []) for s in ln.get("spans", []))
            for b in ordered
        )
        pages.append(page_text)
    doc.close()
    return "\n\n".join(pages)


def compute_similarity(text_a: str, text_b: str) -> float:
    """Normalised similarity score using Python's SequenceMatcher."""
    a_norm = re.sub(r'\s+', ' ', text_a).lower().strip()
    b_norm = re.sub(r'\s+', ' ', text_b).lower().strip()
    return round(SequenceMatcher(None, a_norm, b_norm).ratio(), 4)


def extract_numeric_entities(text: str) -> dict:
    """Extract named numeric entities for targeted validation in benchmarks."""
    result = {}
    for entity_type, pattern in NUMERIC_PATTERNS.items():
        matches = list(set(re.findall(pattern, text, re.IGNORECASE)))
        # Flatten tuple matches (from groups in patterns like year_ranges)
        flat = [" ".join(m).strip() if isinstance(m, tuple) else m for m in matches]
        result[entity_type] = flat
    return result


def write_ground_truth(
    conn,
    document_id: str,
    raw_text: str,
    vlm_similarity: float,
    derivation_method: str,
    numeric_entities: dict,
) -> str:
    """Upsert a GroundTruth row. Returns the created/updated row ID."""
    import uuid
    gt_id = str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO "GroundTruth"
                (id, "documentId", "rawText", "numericEntities",
                 "derivationMethod", "vlmSimilarityScore", "createdAt", "updatedAt")
            VALUES (%s, %s, %s, %s, %s, %s, NOW(), NOW())
            ON CONFLICT ("documentId") DO UPDATE SET
                "rawText"            = EXCLUDED."rawText",
                "numericEntities"    = EXCLUDED."numericEntities",
                "derivationMethod"   = EXCLUDED."derivationMethod",
                "vlmSimilarityScore" = EXCLUDED."vlmSimilarityScore",
                "updatedAt"          = NOW()
            RETURNING id
            """,
            (
                gt_id,
                document_id,
                raw_text,
                json.dumps(numeric_entities),
                derivation_method,
                vlm_similarity,
            ),
        )
        row = cur.fetchone()
        returned_id = row[0] if row else gt_id
    conn.commit()
    return returned_id


def main():
    parser = argparse.ArgumentParser(description="Ground truth pipeline")
    parser.add_argument("--document-id", required=True)
    parser.add_argument("--pdf",         required=True)
    parser.add_argument("--stratum-id",  required=True)
    parser.add_argument("--db-url",      required=True)
    args = parser.parse_args()

    conn = psycopg2.connect(args.db_url)
    client = Anthropic(
        base_url=os.environ.get("ANTHROPIC_BASE_URL", "https://co.agentrouter.org"),
        api_key=os.environ.get("ANTHROPIC_API_KEY"),
    )

    try:
        print(f"[gt_pipeline] Starting VLM extraction for document {args.document_id}", flush=True)
        vlm_text = extract_vlm_text(args.pdf, client)

        print("[gt_pipeline] Running native cross-reference extraction", flush=True)
        native_text = extract_native_text(args.pdf)

        similarity = compute_similarity(vlm_text, native_text)
        print(f"[gt_pipeline] VLM vs native similarity: {similarity:.4f}", flush=True)

        if similarity >= (1.0 - DIVERGENCE_THRESHOLD):
            derivation = "vlm_auto_accepted"
        else:
            derivation = "vlm_pending_human_review"
            print(
                f"[gt_pipeline] ⚠ Similarity {similarity} < {1 - DIVERGENCE_THRESHOLD:.2f}. "
                "Flagged for human review in Label Studio.",
                flush=True,
            )

        numeric_entities = extract_numeric_entities(vlm_text)
        gt_id = write_ground_truth(
            conn,
            document_id=args.document_id,
            raw_text=vlm_text,
            vlm_similarity=similarity,
            derivation_method=derivation,
            numeric_entities=numeric_entities,
        )

        print(f"[gt_pipeline] ✓ Ground truth written. id={gt_id} method={derivation}", flush=True)
        sys.exit(0)

    except Exception as exc:
        print(f"[gt_pipeline] FATAL: {exc}", flush=True)
        traceback.print_exc()
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
