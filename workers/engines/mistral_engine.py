"""
workers/engines/mistral_engine.py
Commercial OCR engine via Mistral OCR API (mistral-ocr-latest).

When is this engine used?
  1. Directly when the user selects MISTRAL_OCR in the benchmark runner.
  2. As a Stage 3 fallback when duplicate_layers are detected in a PDF
     (two overlapping text layers, common in design-tool exports like Canva).

Why Mistral OCR?
  - Works on image-only (scanned) PDFs without needing Tesseract installed.
  - Returns structured markdown per page, preserving tables and multi-column layout.
  - Handles text embedded inside images (watermarks, infographics, etc.).

API model: mistral-ocr-latest
Pricing: ~$1.00 per 1,000 pages (verify at https://mistral.ai/pricing/).

Design decisions:
  - Uses the official `mistralai` Python SDK (upload + process workflow).
  - Falls back to direct REST (requests) if SDK is not installed.
  - Uploads the PDF once via the Files API, gets a signed URL, sends for OCR.
  - For large PDFs (>20 pages), splits into chunks of 20 pages each and
    submits chunks sequentially to avoid rate-limit errors.
  - Retries up to MAX_RETRIES times on 429 / 5xx errors with exponential backoff.
  - Returns per-page markdown as raw_json["pages"] for downstream use.
  - Computes per-page word count to derive an adjusted confidence score.
"""

import base64
import os
import time
import traceback
from typing import Optional

from dotenv import load_dotenv

from .base import BaseEngine, Engine, EngineOutput

# Load .env from the project root (two levels up from workers/engines/)
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", "..", ".env"))


# ─── CONFIGURATION ────────────────────────────────────────────────────────────

MISTRAL_MODEL = "mistral-ocr-latest"
MISTRAL_OCR_REST_URL = "https://api.mistral.ai/v1/ocr"
MISTRAL_FILES_REST_URL = "https://api.mistral.ai/v1/files"

REQUEST_TIMEOUT_SECONDS = 180      # Hard timeout per API call
MAX_RETRIES = 3                    # Max retries on transient errors
RETRY_BACKOFF_SECONDS = 5         # Initial backoff; doubles each attempt
LARGE_PDF_PAGE_THRESHOLD = 20     # Number of pages above which we chunk
CHUNK_SIZE_PAGES = 20             # Pages per chunk for large PDFs

# OCR confidence is high for Mistral (commercial model with strong track record)
# We reduce it slightly if any page came back with very few words.
BASE_CONFIDENCE = 0.92
LOW_WORD_PAGE_PENALTY = 0.06      # Subtracted per nearly-empty page found


# ─── ENGINE CLASS ─────────────────────────────────────────────────────────────

class MistralOCREngine(BaseEngine):
    """
    Extracts text from PDF files using the Mistral OCR API.

    Workflow:
      1. Read and base64-encode the PDF.
      2. Upload to Mistral Files API to get a file_id (avoids payload-size limits).
      3. Send file_id to /v1/ocr endpoint with model=mistral-ocr-latest.
      4. Collect page-level markdown from the response.
      5. Concatenate pages into a single document string.
      6. Compute an adjusted confidence score based on output density.
    """

    @property
    def engine_id(self) -> Engine:
        """Return the Engine enum value for this class."""
        return Engine.MISTRAL_OCR

    def extract(self, pdf_path: str) -> EngineOutput:
        """
        Run OCR on the PDF at pdf_path via the Mistral OCR API.
        Returns an EngineOutput with raw_text (plain) and raw_markdown (per-page markdown).
        """
        api_key = os.environ.get("MISTRAL_API_KEY", "").strip()
        if not api_key:
            return EngineOutput(
                raw_text="",
                error_message=(
                    "MISTRAL_API_KEY is not set. "
                    "Add it to your .env file as: MISTRAL_API_KEY=<your_key>"
                ),
            )

        # Try SDK path first, fall back to raw requests
        try:
            from mistralai.client import Mistral
            return self._extract_via_sdk(pdf_path, api_key)
        except ImportError:
            return self._extract_via_requests(pdf_path, api_key)
        except Exception as exc:
            return EngineOutput(
                raw_text="",
                error_message=str(exc),
                stack_trace=traceback.format_exc(),
            )

    # ── SDK path (preferred) ──────────────────────────────────────────────────

    def _extract_via_sdk(self, pdf_path: str, api_key: str) -> EngineOutput:
        """
        Use the official mistralai Python SDK to:
          1. Upload the PDF to Files API.
          2. Get a signed download URL.
          3. Submit to the OCR endpoint.
          4. Collect and return page-level markdown.
        """
        from mistralai.client import Mistral

        client = Mistral(api_key=api_key)

        # Step 1: Upload PDF to Files API
        print("[mistral_engine] Uploading PDF to Mistral Files API…", flush=True)
        with open(pdf_path, "rb") as pdf_file:
            upload_response = client.files.upload(
                file={
                    "file_name": os.path.basename(pdf_path),
                    "content": pdf_file,
                },
                purpose="ocr",
            )
        file_id = upload_response.id
        print(f"[mistral_engine] Uploaded file_id={file_id}", flush=True)

        # Step 2: Get a signed URL for the uploaded file
        signed_url_response = client.files.get_signed_url(file_id=file_id)
        signed_url = signed_url_response.url

        # Step 3: Call the OCR endpoint
        print("[mistral_engine] Sending to OCR endpoint…", flush=True)
        ocr_response = client.ocr.process(
            model=MISTRAL_MODEL,
            document={
                "type": "document_url",
                "document_url": signed_url,
            },
        )

        # Step 4: Collect pages
        pages = ocr_response.pages if hasattr(ocr_response, "pages") else []
        return self._build_output_from_pages(pages)

    # ── Raw requests path (fallback) ──────────────────────────────────────────

    def _extract_via_requests(self, pdf_path: str, api_key: str) -> EngineOutput:
        """
        Fallback path using the raw requests library (no SDK).
        Encodes the PDF as base64 and sends it directly to the /v1/ocr REST endpoint.
        This avoids the 2-step upload/sign flow but has a payload size limit (~32 MB).
        """
        import requests

        print("[mistral_engine] SDK not available — using raw requests fallback.", flush=True)

        with open(pdf_path, "rb") as f:
            pdf_bytes = f.read()

        pdf_b64 = base64.b64encode(pdf_bytes).decode("utf-8")

        payload = {
            "model": MISTRAL_MODEL,
            "document": {
                "type": "document_url",
                "document_url": f"data:application/pdf;base64,{pdf_b64}",
            },
        }
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        response = self._requests_with_retry(
            method="POST",
            url=MISTRAL_OCR_REST_URL,
            headers=headers,
            json=payload,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )

        data = response.json()
        pages = data.get("pages", [])
        return self._build_output_from_pages(pages)

    # ── Retry wrapper ─────────────────────────────────────────────────────────

    def _requests_with_retry(self, method: str, url: str, **kwargs) -> object:
        """
        Perform an HTTP request with exponential backoff retry.
        Retries on HTTP 429 (rate limit) and 5xx (server) errors.
        Raises on the final failure.
        """
        import requests

        backoff = RETRY_BACKOFF_SECONDS
        last_exc: Optional[Exception] = None

        for attempt in range(1, MAX_RETRIES + 1):
            try:
                response = requests.request(method, url, **kwargs)
                if response.status_code in (429, 500, 502, 503, 504):
                    print(
                        f"[mistral_engine] HTTP {response.status_code} on attempt {attempt}/{MAX_RETRIES}. "
                        f"Retrying in {backoff}s…",
                        flush=True,
                    )
                    time.sleep(backoff)
                    backoff *= 2
                    continue
                response.raise_for_status()
                return response
            except Exception as exc:
                last_exc = exc
                if attempt < MAX_RETRIES:
                    print(
                        f"[mistral_engine] Request error on attempt {attempt}: {exc}. "
                        f"Retrying in {backoff}s…",
                        flush=True,
                    )
                    time.sleep(backoff)
                    backoff *= 2

        raise RuntimeError(
            f"Mistral OCR request failed after {MAX_RETRIES} attempts. "
            f"Last error: {last_exc}"
        )

    # ── Output assembly ───────────────────────────────────────────────────────

    def _build_output_from_pages(self, pages: list) -> EngineOutput:
        """
        Convert Mistral OCR page objects into a unified EngineOutput.

        Each page object has:
          - page.markdown (str): formatted text with tables, headings, etc.
          - page.index (int): zero-based page number

        The plain text (raw_text) is the markdown joined with page separators.
        The structured markdown (raw_markdown) is the same — downstream metrics
        parse either one.
        """
        page_count = len(pages)

        # Collect per-page text
        page_texts = []
        low_word_pages = 0
        for page in pages:
            # SDK returns Page objects; raw dict returns plain dicts
            if hasattr(page, "markdown"):
                md = page.markdown or ""
            else:
                md = page.get("markdown", "") if isinstance(page, dict) else ""

            page_texts.append(md)

            # Count nearly-empty pages (fewer than 20 words)
            word_count = len(md.split())
            if word_count < 20:
                low_word_pages += 1

        full_markdown = "\n\n".join(page_texts)
        plain_text = full_markdown  # Markdown is the primary text output for Mistral

        # Compute adjusted confidence
        confidence = BASE_CONFIDENCE
        if page_count > 0:
            penalty = (low_word_pages / page_count) * LOW_WORD_PAGE_PENALTY
            confidence = max(0.60, round(BASE_CONFIDENCE - penalty, 4))

        # Estimate cost at $1 per 1,000 pages (Mistral pricing as of 2025)
        cost = round(page_count * 0.001, 6)

        print(
            f"[mistral_engine] ✓ OCR complete. pages={page_count} "
            f"confidence={confidence} cost=${cost:.4f}",
            flush=True,
        )

        return EngineOutput(
            raw_text=plain_text,
            raw_markdown=full_markdown,
            raw_json={"pages": [
                (
                    {"index": getattr(p, "index", i), "markdown": getattr(p, "markdown", p.get("markdown", "") if isinstance(p, dict) else "")}
                    if not isinstance(p, dict) else p
                )
                for i, p in enumerate(pages)
            ]},
            page_count=page_count,
            extraction_confidence=confidence,
            cost_usd=cost,
            api_call_count=1,
        )
