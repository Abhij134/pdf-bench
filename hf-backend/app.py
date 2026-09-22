"""
hf-backend/app.py
Gradio Space backend for PDF Bench — deployed FREE on Hugging Face Spaces.

Gradio internally runs on FastAPI. We mount our custom API routes onto
Gradio's underlying FastAPI app, then expose a minimal Gradio UI.
This way we get:
  - Free hosting (Gradio Spaces = free, 16GB RAM / 2 CPU)
  - Full custom REST API at /preflight /ground-truth /extract /metrics
  - A visible status page in the HF Space UI

Endpoints:
  GET  /health          — liveness check
  POST /preflight       — classify a PDF (layout, text layer, page count, etc.)
  POST /ground-truth    — run the GT extraction pipeline
  POST /extract         — run one extraction engine
  POST /metrics         — compute benchmark metrics for a run

All endpoints accept PDF bytes as base64 (pdf_b64 field) and write results
directly to the shared PostgreSQL database via db_url in the request body.

Authentication: requests must include  X-Worker-Secret: <WORKER_SECRET>
matching the WORKER_SECRET secret set on this HF Space.
"""

import asyncio
import base64
import os
import sys
import tempfile
import traceback
from pathlib import Path

import gradio as gr
from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# ── Add workers/ to sys.path so Python can resolve `engines.*` and `metrics.*`
WORKERS_DIR = Path(__file__).parent / "workers"
sys.path.insert(0, str(WORKERS_DIR))

WORKER_SECRET = os.environ.get("WORKER_SECRET", "")


# ─── AUTH GUARD ───────────────────────────────────────────────────────────────

def _check_auth(request: Request) -> bool:
    """Return False (forbidden) if the secret header does not match."""
    if not WORKER_SECRET:
        return True  # No secret configured — allow all (useful for first-boot test)
    return request.headers.get("x-worker-secret", "") == WORKER_SECRET


# ─── REQUEST MODELS ───────────────────────────────────────────────────────────

class PreflightRequest(BaseModel):
    document_id: str
    pdf_b64: str
    db_url: str

class GroundTruthRequest(BaseModel):
    document_id: str
    pdf_b64: str
    stratum_id: str
    db_url: str

class ExtractRequest(BaseModel):
    result_id: str
    engine: str
    pdf_b64: str
    db_url: str

class MetricsRequest(BaseModel):
    benchmark_run_id: str
    db_url: str


# ─── HELPER ───────────────────────────────────────────────────────────────────

def _save_pdf(pdf_b64: str) -> str:
    """Decode a base64 PDF and save it to a temp file. Returns the path."""
    pdf_bytes = base64.b64decode(pdf_b64)
    tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    tmp.write(pdf_bytes)
    tmp.close()
    return tmp.name


# ─── BUILD GRADIO UI (minimal status page) ───────────────────────────────────

with gr.Blocks(title="PDF Bench Worker") as demo:
    gr.Markdown("""
# 📄 PDF Bench Worker API

**Status: 🟢 Running**

This Hugging Face Space is the Python backend for the
[PDF Benchmarking System](https://pdfbenchmarksystem.netlify.app/).

It exposes the following REST API endpoints (called by the Next.js frontend):

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Liveness check |
| `/preflight` | POST | Classify PDF (layout, text layer, page count) |
| `/ground-truth` | POST | Run ground truth extraction pipeline |
| `/extract` | POST | Run one extraction engine (PyMuPDF, OCR, etc.) |
| `/metrics` | POST | Compute benchmark accuracy metrics |

All endpoints require the `X-Worker-Secret` header.
""")


# ─── MOUNT CUSTOM ROUTES ONTO GRADIO'S FASTAPI APP ───────────────────────────
# Gradio exposes its internal FastAPI app via demo.app after blocks are defined.
# We add our custom routes directly to it.

app = demo.app  # The underlying FastAPI instance Gradio uses


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/preflight")
async def preflight(body: PreflightRequest, request: Request):
    """Run the PDF pre-flight classifier and write results to the DB."""
    if not _check_auth(request):
        return JSONResponse({"error": "Forbidden"}, status_code=403)

    pdf_path = None
    try:
        pdf_path = _save_pdf(body.pdf_b64)
        import psycopg2
        from preflight import classify_pdf, write_signals_to_db

        signals = classify_pdf(pdf_path)
        conn = psycopg2.connect(body.db_url.split("?")[0])
        write_signals_to_db(conn, body.document_id, signals)
        conn.close()
        return {"status": "ok", "signals": signals}

    except Exception as exc:
        traceback.print_exc()
        return JSONResponse({"error": str(exc)}, status_code=500)
    finally:
        if pdf_path and os.path.exists(pdf_path):
            os.unlink(pdf_path)


@app.post("/ground-truth")
async def ground_truth(body: GroundTruthRequest, request: Request):
    """Run the GT extraction pipeline. Returns 202 immediately; runs in background."""
    if not _check_auth(request):
        return JSONResponse({"error": "Forbidden"}, status_code=403)

    pdf_path = _save_pdf(body.pdf_b64)

    async def _run():
        try:
            import psycopg2
            os.environ.setdefault("HF_HOME", "/home/user/.cache/huggingface")
            os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

            from gt_pipeline import (
                extract_marker_text, extract_native_text,
                compute_similarity, extract_numeric_entities,
                write_ground_truth, write_progress, DIVERGENCE_THRESHOLD,
            )

            conn = psycopg2.connect(body.db_url.split("?")[0])
            try:
                write_progress(body.document_id, "processing", progress=0)
                marker_text = extract_marker_text(pdf_path, body.document_id)
                native_text = extract_native_text(pdf_path)
                similarity  = compute_similarity(marker_text, native_text)
                derivation  = (
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
        except Exception:
            traceback.print_exc()
        finally:
            if os.path.exists(pdf_path):
                os.unlink(pdf_path)

    asyncio.create_task(_run())
    return JSONResponse({"status": "triggered", "document_id": body.document_id}, status_code=202)


@app.post("/extract")
async def extract(body: ExtractRequest, request: Request):
    """Run one extraction engine. Returns 202 immediately; runs in background."""
    if not _check_auth(request):
        return JSONResponse({"error": "Forbidden"}, status_code=403)

    pdf_path = _save_pdf(body.pdf_b64)

    async def _run():
        try:
            import psycopg2
            from engine_runner import (
                _get_engine, _classify_failures,
                _run_stage3, _write_result, PASS_CONFIDENCE,
            )

            conn = psycopg2.connect(body.db_url.split("?")[0])
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        'UPDATE "ExtractionResult" SET status = %s WHERE id = %s',
                        ("PROCESSING", body.result_id),
                    )
                conn.commit()

                engine = _get_engine(body.engine)
                output = engine.timed_extract(pdf_path)

                if body.engine == "PYMUPDF" and not output.error_message:
                    if (output.extraction_confidence or 0.0) < PASS_CONFIDENCE:
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
    """Compute benchmark metrics. Returns 202 immediately; runs in background."""
    if not _check_auth(request):
        return JSONResponse({"error": "Forbidden"}, status_code=403)

    async def _run():
        try:
            # Patch sys.argv so metric_worker.main() (argparse-based) works inline
            old_argv = sys.argv
            sys.argv = [
                "metric_worker.py",
                "--benchmark-run-id", body.benchmark_run_id,
                "--db-url", body.db_url,
            ]
            try:
                from metric_worker import main as run_metrics
                run_metrics()
            except SystemExit:
                pass  # main() calls sys.exit(0) on success — expected
            finally:
                sys.argv = old_argv
        except Exception:
            traceback.print_exc()

    asyncio.create_task(_run())
    return JSONResponse(
        {"status": "triggered", "benchmark_run_id": body.benchmark_run_id},
        status_code=202,
    )


# ─── LAUNCH ───────────────────────────────────────────────────────────────────
# HF Spaces detect this and serve the app automatically.
if __name__ == "__main__":
    demo.launch()
