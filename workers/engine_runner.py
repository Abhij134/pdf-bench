"""
workers/engine_runner.py
Entry point for per-engine extraction workers.
Called by the Next.js API route via child_process.spawn:

  python3 workers/engine_runner.py \\
    --engine PYMUPDF \\
    --pdf /path/to/file.pdf \\
    --result-id clxxx \\
    --db-url postgresql://...

This script:
  1. Imports the requested engine class.
  2. Runs extraction (timed).
  3. Updates the ExtractionResult row in PostgreSQL (status, all output fields).
  4. If confidence < 0.80, applies the Stage 3 fallback router.
  5. Exits with code 0 on success, 1 on failure.

IMPORTANT: This script must be self-contained — it does NOT import any Next.js code.
"""
import argparse
import json
import sys
import traceback
import psycopg2

# Confidence threshold — below this triggers Stage 3 fallback
PASS_CONFIDENCE = 0.80

ENGINE_MAP = {
    "PYMUPDF":              "engines.pymupdf_engine.PyMuPDFEngine",
    "PDFMINER":             "engines.pdfminer_engine.PDFMinerEngine",
    "MARKER":               "engines.marker_engine.MarkerEngine",
    "OCRMYPDF_TESSERACT":   "engines.ocrmypdf_engine.OCRmyPDFEngine",
    "MISTRAL_OCR":          "engines.mistral_engine.MistralOCREngine",
    "GOOGLE_DOCUMENT_AI":   "engines.google_dai_engine.GoogleDAIEngine",
}


def import_engine(engine_name: str):
    """Dynamically import and instantiate the engine class."""
    if engine_name not in ENGINE_MAP:
        raise ValueError(f"Unknown engine: {engine_name}. Valid options: {list(ENGINE_MAP)}")
    module_path, class_name = ENGINE_MAP[engine_name].rsplit(".", 1)
    import importlib
    module = importlib.import_module(module_path)
    return getattr(module, class_name)()


def write_result_to_db(conn, result_id: str, output, engine_name: str, status: str):
    """
    Write EngineOutput fields to the ExtractionResult row.
    Uses raw psycopg2 to avoid importing Prisma client in Python.
    NOTE: Column names are quoted because Prisma uses camelCase quoted identifiers.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE "ExtractionResult" SET
                status                   = %s,
                "rawText"                = %s,
                "rawMarkdown"            = %s,
                "rawJson"                = %s,
                "processingTimeMs"       = %s,
                "charCount"              = %s,
                "wordCount"              = %s,
                "pageCount"              = %s,
                "extractionConfidence"   = %s,
                "garbleRatio"            = %s,
                "whitespaceRatio"        = %s,
                "duplicateBlockRatio"    = %s,
                "numericAnomalyDetected" = %s,
                "wasFallback"            = %s,
                "costUsd"                = %s,
                "apiCallCount"           = %s,
                "errorMessage"           = %s,
                "stackTrace"             = %s
            WHERE id = %s
            """,
            (
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
                result_id,
            ),
        )
    conn.commit()


def gpu_available() -> bool:
    """Check for CUDA GPU availability without hard-importing torch."""
    try:
        import torch
        return torch.cuda.is_available()
    except ImportError:
        return False


def stage3_fallback(pdf_path: str, failures: list):
    """
    Stage 3 routing logic.
    failure_types comes from the PyMuPDF confidence signal names.
    Returns a fresh EngineOutput from the appropriate fallback engine.
    """
    failure_set = set(failures)

    if "empty_extraction" in failure_set or "whitespace_anomaly" in failure_set:
        # Likely scanned / image-only PDF
        if gpu_available():
            print("[router] Routing to Marker (GPU available)", flush=True)
            engine = import_engine("MARKER")
        else:
            print("[router] Routing to OCRmyPDF (no GPU)", flush=True)
            engine = import_engine("OCRMYPDF_TESSERACT")

    elif "duplicate_layers" in failure_set:
        print("[router] Routing to Mistral OCR (duplicate layers detected)", flush=True)
        engine = import_engine("MISTRAL_OCR")

    elif "garbled_text" in failure_set:
        # Try pdfminer first (different codec handling)
        print("[router] Routing to pdfminer (garbled text)", flush=True)
        engine = import_engine("PDFMINER")

    else:
        # Low overall confidence — try Marker if GPU available, else Mistral
        if gpu_available():
            engine = import_engine("MARKER")
        else:
            engine = import_engine("MISTRAL_OCR")

    output = engine.timed_extract(pdf_path)
    output.was_fallback = True
    return output


def build_failure_list(output) -> list:
    """
    Translate confidence signals back into named failure types
    so the Stage 3 router can dispatch correctly.
    """
    failures = []
    if output.word_count is not None and output.word_count < 50:
        failures.append("empty_extraction")
    if output.whitespace_ratio is not None and output.whitespace_ratio > 0.82:
        failures.append("whitespace_anomaly")
    if output.garble_ratio is not None and output.garble_ratio > 0.02:
        failures.append("garbled_text")
    if output.duplicate_block_ratio is not None and output.duplicate_block_ratio > 0.30:
        failures.append("duplicate_layers")
    if output.numeric_anomaly_detected:
        failures.append("numeric_anomaly")
    return failures


def main():
    parser = argparse.ArgumentParser(description="PDF extraction engine runner")
    parser.add_argument("--engine",    required=True, help="Engine enum name, e.g. PYMUPDF")
    parser.add_argument("--pdf",       required=True, help="Absolute path to the PDF file")
    parser.add_argument("--result-id", required=True, help="ExtractionResult Prisma row ID")
    parser.add_argument("--db-url",    required=True, help="PostgreSQL connection string")
    args = parser.parse_args()

    conn = psycopg2.connect(args.db_url)

    try:
        # Mark as PROCESSING immediately
        with conn.cursor() as cur:
            cur.execute(
                'UPDATE "ExtractionResult" SET status = %s WHERE id = %s',
                ("PROCESSING", args.result_id),
            )
        conn.commit()

        # --- Stage 1: Run requested engine ---
        engine = import_engine(args.engine)
        print(f"[engine_runner] Running {args.engine} on {args.pdf}", flush=True)
        output = engine.timed_extract(args.pdf)

        # --- Stage 2: Check confidence (only for PyMuPDF — it computes its own signals) ---
        should_fallback = (
            args.engine == "PYMUPDF"
            and output.extraction_confidence is not None
            and output.extraction_confidence < PASS_CONFIDENCE
        )

        if should_fallback:
            failures = build_failure_list(output)
            print(
                f"[engine_runner] Confidence {output.extraction_confidence} < {PASS_CONFIDENCE}. "
                f"Failures: {failures}. Triggering Stage 3 fallback.",
                flush=True,
            )
            output = stage3_fallback(args.pdf, failures)

        # --- Write result ---
        status = "FAILED" if output.error_message else "COMPLETED"
        write_result_to_db(conn, args.result_id, output, args.engine, status)
        print(
            f"[engine_runner] Done. Status={status} "
            f"words={output.word_count} confidence={output.extraction_confidence}",
            flush=True,
        )
        sys.exit(0 if status == "COMPLETED" else 1)

    except Exception as exc:
        print(f"[engine_runner] FATAL: {exc}", flush=True)
        traceback.print_exc()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    'UPDATE "ExtractionResult" SET status=%s, "errorMessage"=%s WHERE id=%s',
                    ("FAILED", str(exc)[:1000], args.result_id),
                )
            conn.commit()
        except Exception:
            pass
        finally:
            conn.close()
        sys.exit(1)


if __name__ == "__main__":
    main()
