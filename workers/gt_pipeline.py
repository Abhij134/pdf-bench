"""
workers/gt_pipeline.py
Semi-automated ground truth pipeline.

Steps:
  1. Render each PDF page to PNG at 150 DPI.
  2. Send each page image to Gemini with strict ordering prompt.
  3. Run PyMuPDF native extraction on the same PDF.
  4. Compute SequenceMatcher similarity between VLM and native outputs.
  5. If similarity >= (1 - DIVERGENCE_THRESHOLD): auto-accept VLM text as GT.
  6. If similarity < threshold: flag for human review.
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
import json
import os
import re
import sys
import time
import traceback
import uuid
from difflib import SequenceMatcher

# pyrefly: ignore [missing-import]
import fitz
import psycopg2
from google import genai
from google.genai import types
from dotenv import load_dotenv  # type: ignore


# ─── CONFIGURATION ───────────────────────────────────────────────────

DIVERGENCE_THRESHOLD = 0.15    # Flag for human review if similarity < 0.85
VLM_MODEL = "gemini-3.6-flash" # Must match an existing Gemini model name
VLM_PAGE_DPI = 150             # DPI for page rendering sent to VLM         # DPI for page rendering sent to VLM
RATE_LIMIT_SLEEP_SEC = 4.5     # Sleep between Gemini API calls (free tier limit)

# ─── NUMERIC ENTITY PATTERNS ─────────────────────────────────────────
# Mirrors workers/metrics/numeric_accuracy.py — keep in sync if patterns change.

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

VLM_PROMPT = (
    "Transcribe ALL text from this resume page exactly as it appears. Rules: "
    "(1) Preserve reading order: left-column top-to-bottom FIRST, "
    "then right-column top-to-bottom. "
    "(2) Never paraphrase, summarise, or omit any text. "
    "(3) Preserve ALL numbers, dates, percentages, and punctuation verbatim — "
    "do not normalise or reformat them. "
    "(4) Separate visually distinct sections with a blank line. "
    "(5) Output ONLY the transcribed text. "
    "Do not add any commentary, labels, or explanations."
)


# ─── CORE FUNCTIONS ──────────────────────────────────────────────────

def extract_vlm_text(pdf_path: str, client: genai.Client) -> str:
    """
    Extract text from all pages using Gemini Vision.
    Renders each page as a PNG and sends it with a strict ordering prompt.
    Sleeps RATE_LIMIT_SLEEP_SEC between pages to respect free-tier rate limits.
    """
    doc = fitz.open(pdf_path)
    page_outputs = []

    for page_num, page in enumerate(doc, start=1):
        # Render page to PNG bytes at the configured DPI
        pix = page.get_pixmap(dpi=VLM_PAGE_DPI)
        img_bytes = pix.tobytes("png")

        response = client.models.generate_content(
            model=VLM_MODEL,
            contents=[
                VLM_PROMPT,
                types.Part.from_bytes(data=img_bytes, mime_type="image/png"),
            ],
        )

        page_text = response.text
        page_outputs.append(f"=== PAGE {page_num} ===\n{page_text}")
        print(f"  [gt_pipeline] VLM processed page {page_num}", flush=True)

        # Rate limiting: sleep between pages to avoid 429 errors
        if page_num < len(doc):
            time.sleep(RATE_LIMIT_SLEEP_SEC)

    doc.close()
    return "\n\n".join(page_outputs)


def extract_native_text(pdf_path: str) -> str:
    """
    PyMuPDF native extraction with column-aware sort.
    Used only as a cross-reference for similarity scoring — NOT as the GT itself.
    The VLM text is always the authoritative GT because it reads visual layout directly.
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
            left = sorted(
                [b for b in blocks if b["bbox"][0] < col_boundary],
                key=lambda b: b["bbox"][1],
            )
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
    """
    Extract named numeric entities from text for targeted validation in benchmarks.
    Tuple matches (from capturing groups) are flattened to strings.
    """
    result = {}
    for entity_type, pattern in NUMERIC_PATTERNS.items():
        matches = list(set(re.findall(pattern, text, re.IGNORECASE)))
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
    """
    Upsert a GroundTruth row into PostgreSQL.
    Uses ON CONFLICT so re-running the pipeline updates the existing row.
    Returns the row ID.
    """
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


# ─── ENTRY POINT ─────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Ground truth pipeline")
    parser.add_argument("--document-id", required=True, help="Document row ID from the DB")
    parser.add_argument("--pdf",         required=True, help="Absolute path to the PDF file")
    parser.add_argument("--stratum-id",  required=True, help="Sourcing matrix stratum ID")
    parser.add_argument("--db-url",      required=True, help="PostgreSQL connection string")
    args = parser.parse_args()

    conn = psycopg2.connect(args.db_url)
    client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))

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
                f"[gt_pipeline] ⚠ Similarity {similarity:.4f} < "
                f"{1.0 - DIVERGENCE_THRESHOLD:.2f}. Flagged for human review.",
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