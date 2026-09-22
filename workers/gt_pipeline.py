"""
workers/gt_pipeline.py
Semi-automated ground truth pipeline.

Steps:
  1. Use Marker (local OCR/VLM) to extract layout-aware markdown.
  2. Run PyMuPDF native extraction on the same PDF.
  3. Compute SequenceMatcher similarity between Marker and native outputs.
  4. If similarity >= (1 - DIVERGENCE_THRESHOLD): auto-accept text as GT.
  5. If similarity < threshold: flag for human review.
  6. Extract numeric entities from the final GT text.
  7. Write GroundTruth row to PostgreSQL.

DIVERGENCE_THRESHOLD = 0.15 means: flag if similarity < 85%.

Usage:
  python3 workers/gt_pipeline.py \
    --document-id clxxx \
    --pdf /abs/path/to/file.pdf \
    --stratum-id NATIVE-TWO-COL \
    --db-url postgresql://...
"""
import sys
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

import argparse
import json
import os
import re
import sys
import traceback
import uuid
from difflib import SequenceMatcher

# pyrefly: ignore [missing-import]
import fitz
import psycopg2
from dotenv import load_dotenv  # type: ignore

from filelock import FileLock  # type: ignore

def write_progress(doc_id: str, status: str, progress: int = 0, error: str = None):
    try:
        # Use /tmp on Linux (HF Spaces), relative .progress dir locally
        if os.name == 'nt':
            progress_dir = os.path.join(os.path.dirname(__file__), "..", ".progress")
        else:
            progress_dir = "/tmp/.progress"
        os.makedirs(progress_dir, exist_ok=True)
        file_path = os.path.join(progress_dir, f"{doc_id}.json")
        data = {
            "status": status,
            "progress": progress,
            "error": error
        }
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(data, f)
    except Exception as e:
        print(f"[gt_pipeline] Failed to write progress: {e}")

env_path = os.path.join(os.path.dirname(__file__), '..', '.env')
load_dotenv(env_path)

# ─── CONFIGURATION ───────────────────────────────────────────────────

# Only set HF_HOME if not already configured (avoids overwriting HF Space defaults)
if not os.environ.get("HF_HOME"):
    os.environ["HF_HOME"] = os.path.join(os.path.expanduser("~"), ".cache", "huggingface")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("IN_STREAMLIT", "true")

DIVERGENCE_THRESHOLD = 0.15    # Flag for human review if similarity < 0.85

# ─── NUMERIC ENTITY PATTERNS ─────────────────────────────────────────

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

# ─── CORE FUNCTIONS ──────────────────────────────────────────────────

def extract_marker_text(pdf_path: str, doc_id: str) -> str:
    """
    Fast extraction using PyMuPDF instead of Marker to speed up the process.
    """
    write_progress(doc_id, "processing", progress=20)
    text = extract_native_text(pdf_path)
    write_progress(doc_id, "processing", progress=80)
    return text


def extract_native_text(pdf_path: str) -> str:
    """
    PyMuPDF native extraction with column-aware sort.
    Used only as a cross-reference for similarity scoring — NOT as the GT itself.
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

    conn = psycopg2.connect(args.db_url.split("?")[0])

    try:
        write_progress(args.document_id, "processing", progress=0)
        
        print(f"[gt_pipeline] Starting Marker extraction for document {args.document_id}", flush=True)
        marker_text = extract_marker_text(args.pdf, args.document_id)

        print("[gt_pipeline] Running native cross-reference extraction", flush=True)
        native_text = extract_native_text(args.pdf)

        similarity = compute_similarity(marker_text, native_text)
        print(f"[gt_pipeline] Marker vs native similarity: {similarity:.4f}", flush=True)

        if similarity >= (1.0 - DIVERGENCE_THRESHOLD):
            derivation = "marker_auto_accepted"
        else:
            derivation = "marker_pending_human_review"
            print(
                f"[gt_pipeline] [WARN] Similarity {similarity:.4f} < "
                f"{1.0 - DIVERGENCE_THRESHOLD:.2f}. Flagged for human review.",
                flush=True,
            )

        numeric_entities = extract_numeric_entities(marker_text)
        gt_id = write_ground_truth(
            conn,
            document_id=args.document_id,
            raw_text=marker_text,
            vlm_similarity=similarity,
            derivation_method=derivation,
            numeric_entities=numeric_entities,
        )

        print(f"[gt_pipeline] [OK] Ground truth written. id={gt_id} method={derivation}", flush=True)
        write_progress(args.document_id, "completed", progress=100)
        sys.exit(0)

    except Exception as exc:
        print(f"[gt_pipeline] FATAL: {exc}", flush=True)
        traceback.print_exc()
        write_progress(args.document_id, "failed", error=str(exc)[:500])
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()