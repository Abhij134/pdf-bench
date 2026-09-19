"""
workers/engine_runner.py
Per-engine extraction worker for benchmark runs.

Called by Next.js app/api/benchmark/run/route.ts via child_process.spawn:

  python workers/engine_runner.py \
    --engine PYMUPDF \
    --pdf /absolute/path/to/file.pdf \
    --result-id clxxx \
    --db-url postgresql://user:pass@host:5432/pdf_bench

Responsibilities:
  1. Set ExtractionResult status to PROCESSING immediately.
  2. Import and instantiate the correct engine class.
  3. Run timed_extract(pdf_path).
  4. For PYMUPDF only: check Stage 2 confidence signals.
     If confidence < PASS_CONFIDENCE, run Stage 3 fallback.
  5. For PDFMINER (when used as Stage 3 sub-step): re-validate and
     escalate to Google DAI if still below RETRY_CONFIDENCE.
  6. Write ALL output fields to the ExtractionResult row in the DB.
  7. Exit 0 on COMPLETED, 1 on FAILED.

IMPORTANT CONSTRAINTS:
  - This file must NEVER import Next.js, Prisma, or any TypeScript modules.
  - All DB writes use raw psycopg2 with double-quoted column names.
  - All print() output is ASCII-safe (no Unicode special chars).
  - sys.path.insert ensures engines.* imports work regardless of cwd.
"""

import argparse
import importlib
import json
import os
import sys
import traceback
import uuid

# ── Force UTF-8 on Windows terminals (cp1252 cannot encode non-ASCII) ──
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# ── Add workers/ to sys.path so 'engines.*' and 'metrics.*' resolve ──
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import psycopg2
from dotenv import load_dotenv

# Load .env from the project root (one level up from workers/)
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

from engines.base import Engine, EngineOutput
from engines.pymupdf_engine import PyMuPDFEngine
from engines.pdfminer_engine import PDFMinerEngine
from engines.ocrmypdf_engine import OCRmyPDFEngine
from engines.mistral_engine import MistralOCREngine
from engines.google_dai_engine import GoogleDAIEngine


# ─── CONFIGURATION ────────────────────────────────────────────────────────────

# PASS_CONFIDENCE: PyMuPDF results at or above this score need no fallback.
PASS_CONFIDENCE = 0.80

# RETRY_CONFIDENCE: If PDFMiner is used for garbled_text and still scores
# below this, escalate to Google Document AI.
RETRY_CONFIDENCE = 0.70

# Per-engine confidence signal thresholds (must match pymupdf_engine.py THRESHOLDS)
MIN_WORD_COUNT       = 50
MAX_GARBLE_RATIO     = 0.02
MAX_WHITESPACE_RATIO = 0.82
MAX_DUP_BLOCK_RATIO  = 0.30


# ─── ENGINE REGISTRY ──────────────────────────────────────────────────────────
# Maps the Prisma enum string value (passed as --engine arg) to the engine class.
# Marker is imported lazily inside _get_engine() to avoid hard ImportError when
# marker-pdf is not installed.

ENGINE_REGISTRY = {
    "PYMUPDF":              lambda: PyMuPDFEngine(),
    "PDFMINER":             lambda: PDFMinerEngine(),
    "OCRMYPDF_TESSERACT":   lambda: OCRmyPDFEngine(),
    "MISTRAL_OCR":          lambda: MistralOCREngine(),
    "GOOGLE_DOCUMENT_AI":   lambda: GoogleDAIEngine(),
    # MARKER loaded lazily — see _get_engine()
}


def _get_engine(engine_name: str):
    """
    Instantiate the engine class for the given Prisma enum string.
    Marker is loaded lazily so a missing marker-pdf package does not
    prevent other engines from running.
    """
    if engine_name == "MARKER":
        from engines.marker_engine import MarkerEngine
        return MarkerEngine()

    if engine_name not in ENGINE_REGISTRY:
        raise ValueError(
            f"Unknown engine: '{engine_name}'. "
            f"Valid values: {sorted(list(ENGINE_REGISTRY.keys()) + ['MARKER'])}"
        )
    return ENGINE_REGISTRY[engine_name]()


def _gpu_available() -> bool:
    """
    Check for CUDA GPU availability without hard-importing torch at module level.
    Returns False if torch is not installed.
    """
    try:
        import torch
        return torch.cuda.is_available()
    except ImportError:
        return False


# ─── STAGE 2: FAILURE CLASSIFICATION ─────────────────────────────────────────

def _classify_failures(output: EngineOutput) -> list:
    """
    Translate PyMuPDF EngineOutput signals into named failure types.
    Returns a list of failure strings; empty list means no failures detected.

    Called ONLY on PYMUPDF output. Other engines do not produce these signals.
    """
    failures = []

    if (output.word_count is not None and output.word_count < MIN_WORD_COUNT):
        failures.append("empty_extraction")

    if (output.whitespace_ratio is not None
            and output.whitespace_ratio > MAX_WHITESPACE_RATIO):
        failures.append("whitespace_anomaly")

    if (output.garble_ratio is not None
            and output.garble_ratio > MAX_GARBLE_RATIO):
        failures.append("garbled_text")

    if (output.duplicate_block_ratio is not None
            and output.duplicate_block_ratio > MAX_DUP_BLOCK_RATIO):
        failures.append("duplicate_layers")

    if output.numeric_anomaly_detected:
        failures.append("numeric_anomaly")

    return failures


# ─── STAGE 3: FALLBACK ROUTING ────────────────────────────────────────────────

def _pdfminer_confidence(text: str) -> float:
    """
    Compute a simple confidence score for PDFMiner output.
    Mirrors the word-count and garble heuristics from pymupdf_engine.py
    but without the full 5-signal suite (PDFMiner does not emit those signals).
    Used only to decide whether to escalate to Google DAI.
    """
    import re
    word_count = len(text.split())
    garble_count = len(re.findall(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', text))
    garble_ratio = garble_count / max(len(text), 1)

    if word_count < MIN_WORD_COUNT:
        return 0.0
    if garble_ratio > MAX_GARBLE_RATIO:
        return max(0.0, 0.65 - garble_ratio * 10)
    return 0.75  # PDFMiner baseline when text is present and non-garbled


def _run_stage3(pdf_path: str, failures: list) -> EngineOutput:
    """
    Route to the appropriate Stage 3 fallback engine based on failure types.

    Routing rules (ordered by priority — earlier rules win):
      1. empty_extraction OR whitespace_anomaly → scanned PDF
         GPU available → Marker
         No GPU       → OCRmyPDF

      2. duplicate_layers → conflicting text layers (Canva, design tools)
         Always → Mistral OCR (reads visual truth, ignores bad text layer)

      3. garbled_text → encoding/font issue
         1st attempt → PDFMiner (different codec handling)
         If PDFMiner confidence < RETRY_CONFIDENCE → Google Document AI

      4. numeric_anomaly only (or low confidence, no specific failure)
         GPU available → Marker
         No GPU       → Mistral OCR

    All fallback outputs have was_fallback=True set before returning.
    """
    failure_set = set(failures)

    # ── Rule 1: Scanned / image PDF ──
    if "empty_extraction" in failure_set or "whitespace_anomaly" in failure_set:
        if _gpu_available():
            print("[engine_runner] Stage 3: routing to Marker (GPU available)", flush=True)
            engine = _get_engine("MARKER")
        else:
            print("[engine_runner] Stage 3: routing to OCRmyPDF (no GPU)", flush=True)
            engine = _get_engine("OCRMYPDF_TESSERACT")
        output = engine.timed_extract(pdf_path)
        output.was_fallback = True
        return output

    # ── Rule 2: Duplicate/conflicting text layers ──
    if "duplicate_layers" in failure_set:
        print("[engine_runner] Stage 3: routing to Mistral OCR (duplicate layers)", flush=True)
        engine = _get_engine("MISTRAL_OCR")
        output = engine.timed_extract(pdf_path)
        output.was_fallback = True
        return output

    # ── Rule 3: Garbled text (encoding/font issue) ──
    if "garbled_text" in failure_set:
        print("[engine_runner] Stage 3: trying PDFMiner (garbled text detected)", flush=True)
        pdfminer = _get_engine("PDFMINER")
        pm_output = pdfminer.timed_extract(pdf_path)

        if pm_output.error_message:
            # PDFMiner itself failed — go straight to Google DAI
            print("[engine_runner] PDFMiner failed, escalating to Google DAI", flush=True)
            engine = _get_engine("GOOGLE_DOCUMENT_AI")
            output = engine.timed_extract(pdf_path)
            output.was_fallback = True
            return output

        pm_confidence = _pdfminer_confidence(pm_output.raw_text or "")
        print(
            f"[engine_runner] PDFMiner confidence: {pm_confidence:.4f} "
            f"(threshold: {RETRY_CONFIDENCE})",
            flush=True,
        )

        if pm_confidence >= RETRY_CONFIDENCE:
            pm_output.was_fallback = True
            return pm_output
        else:
            print("[engine_runner] PDFMiner below threshold, escalating to Google DAI", flush=True)
            engine = _get_engine("GOOGLE_DOCUMENT_AI")
            output = engine.timed_extract(pdf_path)
            output.was_fallback = True
            return output

    # ── Rule 4: Numeric anomaly or unclassified low confidence ──
    if _gpu_available():
        print(
            f"[engine_runner] Stage 3: routing to Marker (failures={failures})", flush=True
        )
        engine = _get_engine("MARKER")
    else:
        print(
            f"[engine_runner] Stage 3: routing to Mistral OCR (failures={failures})", flush=True
        )
        engine = _get_engine("MISTRAL_OCR")

    output = engine.timed_extract(pdf_path)
    output.was_fallback = True
    return output


# ─── DATABASE: WRITE ExtractionResult ─────────────────────────────────────────

def _write_result(conn, result_id: str, output: EngineOutput, status: str) -> None:
    """
    Write all EngineOutput fields to the ExtractionResult row WHERE id = result_id.

    Uses UPDATE (not INSERT) because the Next.js route pre-creates the row
    with status=PENDING before spawning this process.

    Column names are double-quoted because Prisma generates camelCase identifiers
    which are case-sensitive in PostgreSQL when quoted.
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


# ─── ENTRY POINT ──────────────────────────────────────────────────────────────

def main() -> None:
    """
    Parse args, run the requested engine, apply Stage 3 routing if needed,
    write the result, and exit with an appropriate code.
    """
    parser = argparse.ArgumentParser(description="PDF extraction engine worker")
    parser.add_argument(
        "--engine",
        required=True,
        help="Prisma ExtractionEngine enum value (e.g. PYMUPDF, MISTRAL_OCR)",
    )
    parser.add_argument(
        "--pdf",
        required=True,
        help="Absolute path to the PDF file to process",
    )
    parser.add_argument(
        "--result-id",
        required=True,
        help="ExtractionResult row ID (cuid) pre-created by Next.js",
    )
    parser.add_argument(
        "--db-url",
        required=True,
        help="PostgreSQL connection string",
    )
    args = parser.parse_args()

    print(
        f"[engine_runner] Starting engine={args.engine} "
        f"pdf={args.pdf} result_id={args.result_id}",
        flush=True,
    )

    conn = psycopg2.connect(args.db_url.split("?")[0])

    try:
        # Step 1: Mark row as PROCESSING so the UI shows progress immediately
        with conn.cursor() as cur:
            cur.execute(
                'UPDATE "ExtractionResult" SET status = %s WHERE id = %s',
                ("PROCESSING", args.result_id),
            )
        conn.commit()

        # Step 2: Run the requested engine
        engine = _get_engine(args.engine)
        print(f"[engine_runner] Running {args.engine}...", flush=True)
        output = engine.timed_extract(args.pdf)

        # Step 3: For PYMUPDF only — apply Stage 2 validation + Stage 3 routing
        if args.engine == "PYMUPDF" and not output.error_message:
            confidence = output.extraction_confidence or 0.0
            print(
                f"[engine_runner] PyMuPDF confidence={confidence:.4f} "
                f"(pass threshold={PASS_CONFIDENCE})",
                flush=True,
            )

            if confidence < PASS_CONFIDENCE:
                failures = _classify_failures(output)
                print(
                    f"[engine_runner] Confidence below threshold. "
                    f"Failures detected: {failures}",
                    flush=True,
                )
                # Stage 3: replace output with fallback result
                output = _run_stage3(args.pdf, failures)

        # Step 4: Determine final status and write to DB
        has_text = bool((output.raw_text or "").strip())
        if not has_text and not output.error_message:
            output.error_message = (
                f"{args.engine} returned empty text. Likely cause: engine not installed "
                f"(marker-pdf/torch), import failure swallowed, or conversion produced no output."
            )
        status = "COMPLETED" if (has_text and not output.error_message) else "FAILED"
        _write_result(conn, args.result_id, output, status)

        print(
            f"[engine_runner] [OK] Done. engine={args.engine} "
            f"status={status} words={output.word_count} "
            f"confidence={output.extraction_confidence} "
            f"was_fallback={output.was_fallback} "
            f"cost=${output.cost_usd:.4f} "
            f"time_ms={output.processing_time_ms}",
            flush=True,
        )

        sys.exit(0 if status == "COMPLETED" else 1)

    except Exception as exc:
        # Unhandled exception — write FAILED status and exit 1
        print(f"[engine_runner] FATAL: {exc}", flush=True)
        traceback.print_exc()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE "ExtractionResult"
                    SET status = 'FAILED',
                        "errorMessage" = %s,
                        "stackTrace" = %s
                    WHERE id = %s
                    """,
                    (str(exc)[:1000], traceback.format_exc()[:3000], args.result_id),
                )
            conn.commit()
        except Exception:
            pass  # If DB write fails, still exit with error code
        sys.exit(1)

    finally:
        conn.close()


if __name__ == "__main__":
    main()
