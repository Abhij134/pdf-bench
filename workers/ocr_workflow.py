"""
workers/ocr_workflow.py
Standalone OCR workflow — runs Mistral OCR on a single PDF and writes the
result directly to the ExtractionResult table in PostgreSQL.

This is separate from the benchmark engine_runner because:
  - It is optimised purely for OCR quality (no Stage 3 fallback logic).
  - It can be called independently without a BenchmarkRun.
  - It is the target of POST /api/ocr/run — the "quick OCR" button in the UI.

Usage:
  python3 workers/ocr_workflow.py \\
    --document-id <cuid> \\
    --pdf /absolute/path/to/file.pdf \\
    --db-url postgresql://user:pass@host:5432/db \\
    [--upsert]   # Optional: upsert instead of insert (safe to re-run)

Output written to:
  - ExtractionResult row (engine=MISTRAL_OCR) in the DB.
  - Optionally updates Document.pdfType if it was UNKNOWN or NATIVE_DIGITAL
    and OCR produced significantly more text than the native layer.

Exit codes:
  0 = success (COMPLETED status written)
  1 = failure (FAILED status written, error logged)
"""

import argparse
import json
import os
import sys
import traceback
import uuid

import psycopg2
from dotenv import load_dotenv

# Load .env from project root (parent directory of this file's parent)
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

# Add the workers/ directory to sys.path so we can import engines.*
sys.path.insert(0, os.path.dirname(__file__))

from engines.mistral_engine import MistralOCREngine  # noqa: E402


# ─── DATABASE HELPERS ─────────────────────────────────────────────────────────

def upsert_extraction_result(conn, document_id: str, output) -> str:
    """
    Insert or update an ExtractionResult row for engine=MISTRAL_OCR.

    Uses ON CONFLICT to allow safe re-runs without creating duplicates.
    Returns the row ID.

    Column names are double-quoted because Prisma creates them in camelCase.
    """
    row_id = str(uuid.uuid4())
    status = "FAILED" if output.error_message else "COMPLETED"

    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO "ExtractionResult" (
                id, "documentId", engine, status,
                "rawText", "rawMarkdown", "rawJson",
                "processingTimeMs", "charCount", "wordCount", "pageCount",
                "extractionConfidence",
                "garbleRatio", "whitespaceRatio", "duplicateBlockRatio",
                "numericAnomalyDetected", "wasFallback",
                "costUsd", "apiCallCount",
                "errorMessage", "stackTrace"
            ) VALUES (
                %s, %s, 'MISTRAL_OCR', %s,
                %s, %s, %s,
                %s, %s, %s, %s,
                %s,
                %s, %s, %s,
                %s, %s,
                %s, %s,
                %s, %s
            )
            ON CONFLICT ("documentId", engine) DO UPDATE SET
                status                  = EXCLUDED.status,
                "rawText"               = EXCLUDED."rawText",
                "rawMarkdown"           = EXCLUDED."rawMarkdown",
                "rawJson"               = EXCLUDED."rawJson",
                "processingTimeMs"      = EXCLUDED."processingTimeMs",
                "charCount"             = EXCLUDED."charCount",
                "wordCount"             = EXCLUDED."wordCount",
                "pageCount"             = EXCLUDED."pageCount",
                "extractionConfidence"  = EXCLUDED."extractionConfidence",
                "garbleRatio"           = EXCLUDED."garbleRatio",
                "whitespaceRatio"       = EXCLUDED."whitespaceRatio",
                "duplicateBlockRatio"   = EXCLUDED."duplicateBlockRatio",
                "numericAnomalyDetected"= EXCLUDED."numericAnomalyDetected",
                "wasFallback"           = EXCLUDED."wasFallback",
                "costUsd"               = EXCLUDED."costUsd",
                "apiCallCount"          = EXCLUDED."apiCallCount",
                "errorMessage"          = EXCLUDED."errorMessage",
                "stackTrace"            = EXCLUDED."stackTrace"
            RETURNING id
            """,
            (
                row_id,
                document_id,
                status,
                output.raw_text or "",
                output.raw_markdown,
                json.dumps(output.raw_json) if output.raw_json else None,
                output.processing_time_ms,
                output.char_count,
                output.word_count,
                output.page_count,
                output.extraction_confidence,
                output.garble_ratio,
                output.whitespace_ratio,
                output.duplicate_block_ratio,
                output.numeric_anomaly_detected,
                output.was_fallback,
                output.cost_usd,
                output.api_call_count,
                output.error_message,
                output.stack_trace,
            ),
        )
        returned = cur.fetchone()
        actual_id = returned[0] if returned else row_id

    conn.commit()
    return actual_id


def maybe_update_pdf_type(conn, document_id: str, ocr_word_count: int) -> None:
    """
    If OCR produced substantial text but the document was classified as
    NATIVE_DIGITAL or UNKNOWN, update pdfType to HYBRID.

    This handles the common case where a Canva/LinkedIn export has a thin
    native text layer but is visually a scanned/image-heavy document.
    """
    with conn.cursor() as cur:
        cur.execute(
            'SELECT "pdfType", "wordCount" FROM "Document" WHERE id = %s',
            (document_id,),
        )
        row = cur.fetchone()

    if not row:
        return

    current_type, native_word_count = row[0], row[1] or 0

    # If OCR found >2× more words than native extraction → reclassify as HYBRID
    if (
        ocr_word_count > 50
        and (native_word_count == 0 or ocr_word_count > native_word_count * 2)
        and current_type in ("NATIVE_DIGITAL", "UNKNOWN", None)
    ):
        print(
            f"[ocr_workflow] OCR word count ({ocr_word_count}) >> native ({native_word_count}). "
            f"Reclassifying pdfType to HYBRID.",
            flush=True,
        )
        with conn.cursor() as cur:
            cur.execute(
                'UPDATE "Document" SET "pdfType" = %s WHERE id = %s',
                ("HYBRID", document_id),
            )
        conn.commit()


# ─── ENTRY POINT ──────────────────────────────────────────────────────────────

def main():
    """Parse CLI arguments, run Mistral OCR, and write results to the database."""
    parser = argparse.ArgumentParser(description="Standalone Mistral OCR workflow")
    parser.add_argument("--document-id", required=True, help="Prisma Document row ID")
    parser.add_argument("--pdf",         required=True, help="Absolute path to the PDF file")
    parser.add_argument("--db-url",      required=True, help="PostgreSQL connection string")
    args = parser.parse_args()

    print(
        f"[ocr_workflow] Starting Mistral OCR for document={args.document_id} "
        f"pdf={args.pdf}",
        flush=True,
    )

    conn = psycopg2.connect(args.db_url)

    try:
        # Mark as PROCESSING in the database immediately so the UI shows progress
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO "ExtractionResult" (id, "documentId", engine, status)
                VALUES (%s, %s, 'MISTRAL_OCR', 'PROCESSING')
                ON CONFLICT ("documentId", engine) DO UPDATE SET status = 'PROCESSING'
                """,
                (str(uuid.uuid4()), args.document_id),
            )
        conn.commit()

        # Run the Mistral OCR engine
        engine = MistralOCREngine()
        output = engine.timed_extract(args.pdf)

        # Write the result to the database
        result_id = upsert_extraction_result(conn, args.document_id, output)
        print(
            f"[ocr_workflow] ✓ Written ExtractionResult id={result_id} "
            f"status={'COMPLETED' if not output.error_message else 'FAILED'} "
            f"words={output.word_count} pages={output.page_count} "
            f"confidence={output.extraction_confidence} cost=${output.cost_usd:.4f}",
            flush=True,
        )

        # Optionally reclassify PDF type based on OCR vs native word count
        if not output.error_message and output.word_count:
            maybe_update_pdf_type(conn, args.document_id, output.word_count)

        sys.exit(0 if not output.error_message else 1)

    except Exception as exc:
        print(f"[ocr_workflow] FATAL: {exc}", flush=True)
        traceback.print_exc()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO "ExtractionResult" (id, "documentId", engine, status, "errorMessage")
                    VALUES (%s, %s, 'MISTRAL_OCR', 'FAILED', %s)
                    ON CONFLICT ("documentId", engine) DO UPDATE
                        SET status = 'FAILED', "errorMessage" = EXCLUDED."errorMessage"
                    """,
                    (str(uuid.uuid4()), args.document_id, str(exc)[:1000]),
                )
            conn.commit()
        except Exception:
            pass
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
