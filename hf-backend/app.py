"""
hf-backend/app.py
FastAPI server for PDF Bench — deployed to Hugging Face Docker Space.

Exposes HTTP endpoints that mirror what the Next.js routes currently
spawn as local Python child processes:

  POST /preflight           — classify a PDF (page count, layout, text layer, etc.)
  POST /ground-truth        — run the GT extraction pipeline
  POST /extract             — run a single extraction engine
  POST /metrics             — compute benchmark metrics for a run
  GET  /health              — liveness check

All endpoints accept the PDF as raw bytes in base64 (pdf_b64 field).
They write results directly to the shared PostgreSQL database using
the db_url passed in the request body (the same DATABASE_URL env var
used by the Next.js app).

Authentication: requests must include the header
  X-Worker-Secret: <WORKER_SECRET>
which must match the WORKER_SECRET environment variable set on this Space.
"""

import asyncio
import base64
import os
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# ── Add workers/ to sys.path so Python can resolve `engines.*` and `metrics.*`
WORKERS_DIR = Path(__file__).parent / "workers"
sys.path.insert(0, str(WORKERS_DIR))

app = FastAPI(title="PDF Bench Worker", version="1.0.0")

# Allow requests from Netlify frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://pdfbenchmarksystem.netlify.app", "http://localhost:3000"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

WORKER_SECRET = os.environ.get("WORKER_SECRET", "")


# ─── AUTH GUARD ───────────────────────────────────────────────────────────────

def _check_auth(request: Request) -> None:
    """Raise 403 if the X-Worker-Secret header does not match."""
    secret = request.headers.get("x-worker-secret", "")
    if WORKER_SECRET and secret != WORKER_SECRET:
        raise HTTPException(status_code=403, detail="Forbidden: invalid worker secret")


# ─── REQUEST MODELS ───────────────────────────────────────────────────────────

class PreflightRequest(BaseModel):
    document_id: str
    pdf_b64: str          # base64-encoded PDF bytes
    db_url: str

class GroundTruthRequest(BaseModel):
    document_id: str
    pdf_b64: str
    stratum_id: str
    db_url: str

class ExtractRequest(BaseModel):
    result_id: str
    engine: str           # e.g. "PYMUPDF", "MISTRAL_OCR"
    pdf_b64: str
    db_url: str

class MetricsRequest(BaseModel):
    benchmark_run_id: str
    db_url: str


# ─── HELPER: decode PDF to temp file ──────────────────────────────────────────

def _save_pdf(pdf_b64: str) -> str:
    """Decode a base64 PDF and save it to a temp file. Returns the path."""
    pdf_bytes = base64.b64decode(pdf_b64)
    tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    tmp.write(pdf_bytes)
    tmp.close()
    return tmp.name


# ─── ENDPOINTS ────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/preflight")
async def preflight(body: PreflightRequest, request: Request):
    """
    Run the pre-flight PDF classifier and write results to the DB.
    Mirrors: workers/preflight.py
    """
    _check_auth(request)
    pdf_path = None
    try:
        pdf_path = _save_pdf(body.pdf_b64)

        # Import and run inline (no subprocess needed — we ARE the Python process)
        import fitz
        import psycopg2

        # Inline preflight logic (imported from workers/preflight.py)
        from preflight import classify_pdf, write_signals_to_db

        signals = classify_pdf(pdf_path)

        conn = psycopg2.connect(body.db_url.split("?")[0])
        write_signals_to_db(conn, body.document_id, signals)
        conn.close()

        return {"status": "ok", "signals": signals}

    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        if pdf_path and os.path.exists(pdf_path):
            os.unlink(pdf_path)


@app.post("/ground-truth")
async def ground_truth(body: GroundTruthRequest, request: Request):
    """
    Run the ground truth extraction pipeline.
    Mirrors: workers/gt_pipeline.py
    Runs in a background thread to avoid blocking the HTTP response.
    Returns immediately with {status: "triggered"}.
    """
    _check_auth(request)
    pdf_path = _save_pdf(body.pdf_b64)

    async def _run():
        try:
            import psycopg2
            # Set HF-friendly cache dir (not a Windows path)
            os.environ["HF_HOME"] = "/home/user/.cache/huggingface"
            os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

            from gt_pipeline import (
                extract_marker_text,
                extract_native_text,
                compute_similarity,
                extract_numeric_entities,
                write_ground_truth,
                write_progress,
                DIVERGENCE_THRESHOLD,
            )

            conn = psycopg2.connect(body.db_url.split("?")[0])
            try:
                write_progress(body.document_id, "processing", progress=0)
                marker_text = extract_marker_text(pdf_path, body.document_id)
                native_text = extract_native_text(pdf_path)
                similarity = compute_similarity(marker_text, native_text)

                derivation = (
                    "marker_auto_accepted"
                    if similarity >= (1.0 - DIVERGENCE_THRESHOLD)
                    else "marker_pending_human_review"
                )
                numeric_entities = extract_numeric_entities(marker_text)
                write_ground_truth(
                    conn,
                    document_id=body.document_id,
                    raw_text=marker_text,
                    vlm_similarity=similarity,
                    derivation_method=derivation,
                    numeric_entities=numeric_entities,
                )
                write_progress(body.document_id, "completed", progress=100)
            finally:
                conn.close()
        except Exception as exc:
            traceback.print_exc()
        finally:
            if os.path.exists(pdf_path):
                os.unlink(pdf_path)

    asyncio.create_task(_run())
    return JSONResponse({"status": "triggered", "document_id": body.document_id}, status_code=202)


@app.post("/extract")
async def extract(body: ExtractRequest, request: Request):
    """
    Run a single extraction engine and write the result to the DB.
    Mirrors: workers/engine_runner.py
    Runs in a background thread; returns immediately with {status: "triggered"}.
    """
    _check_auth(request)
    pdf_path = _save_pdf(body.pdf_b64)

    async def _run():
        try:
            import psycopg2
            from engine_runner import _get_engine, _classify_failures, _run_stage3, _write_result, PASS_CONFIDENCE

            conn = psycopg2.connect(body.db_url.split("?")[0])
            try:
                # Mark PROCESSING
                with conn.cursor() as cur:
                    cur.execute(
                        'UPDATE "ExtractionResult" SET status = %s WHERE id = %s',
                        ("PROCESSING", body.result_id),
                    )
                conn.commit()

                engine = _get_engine(body.engine)
                output = engine.timed_extract(pdf_path)

                # Stage 2/3 routing for PyMuPDF
                if body.engine == "PYMUPDF" and not output.error_message:
                    confidence = output.extraction_confidence or 0.0
                    if confidence < PASS_CONFIDENCE:
                        failures = _classify_failures(output)
                        output = _run_stage3(pdf_path, failures)

                has_text = bool((output.raw_text or "").strip())
                if not has_text and not output.error_message:
                    output.error_message = f"{body.engine} returned empty text."
                status = "COMPLETED" if (has_text and not output.error_message) else "FAILED"
                _write_result(conn, body.result_id, output, status)
            finally:
                conn.close()
        except Exception as exc:
            traceback.print_exc()
            # Try to mark FAILED in DB
            try:
                import psycopg2
                conn2 = psycopg2.connect(body.db_url.split("?")[0])
                with conn2.cursor() as cur:
                    cur.execute(
                        'UPDATE "ExtractionResult" SET status=\'FAILED\', "errorMessage"=%s WHERE id=%s',
                        (str(exc)[:1000], body.result_id),
                    )
                conn2.commit()
                conn2.close()
            except Exception:
                pass
        finally:
            if os.path.exists(pdf_path):
                os.unlink(pdf_path)

    asyncio.create_task(_run())
    return JSONResponse({"status": "triggered", "result_id": body.result_id}, status_code=202)


@app.post("/metrics")
async def metrics(body: MetricsRequest, request: Request):
    """
    Compute benchmark metrics for all ExtractionResults in a BenchmarkRun.
    Mirrors: workers/metric_worker.py
    Runs in background; returns immediately with {status: "triggered"}.
    """
    _check_auth(request)

    async def _run():
        try:
            import sys
            import importlib
            # Ensure metric submodules resolve
            sys.path.insert(0, str(WORKERS_DIR / "metrics"))

            import psycopg2
            from metric_worker import main as run_metrics

            # metric_worker.main() uses argparse — call it programmatically
            import argparse
            # Patch sys.argv to pass args (simplest approach for reusing CLI script)
            old_argv = sys.argv
            sys.argv = [
                "metric_worker.py",
                "--benchmark-run-id", body.benchmark_run_id,
                "--db-url", body.db_url,
            ]
            try:
                run_metrics()
            finally:
                sys.argv = old_argv
        except SystemExit:
            pass  # metric_worker.main() calls sys.exit(0) on success — that's fine
        except Exception as exc:
            traceback.print_exc()

    asyncio.create_task(_run())
    return JSONResponse({"status": "triggered", "benchmark_run_id": body.benchmark_run_id}, status_code=202)
