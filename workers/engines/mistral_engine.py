"""
workers/engines/mistral_engine.py
Commercial OCR via Mistral OCR API.
Used when: duplicate_layers detected (conflicting text layers).
Returns Markdown-formatted output with page-level blocks.

Cost: ~$1.00 / 1K pages (verify at mistral.ai/pricing before production use).
API model: mistral-ocr-latest
"""
import base64
import os
import traceback
import requests

from .base import BaseEngine, Engine, EngineOutput


MISTRAL_OCR_URL = "https://api.mistral.ai/v1/ocr"
MISTRAL_MODEL = "mistral-ocr-latest"
REQUEST_TIMEOUT_SECONDS = 120


class MistralOCREngine(BaseEngine):

    @property
    def engine_id(self) -> Engine:
        return Engine.MISTRAL_OCR

    def extract(self, pdf_path: str) -> EngineOutput:
        """
        Upload PDF as base64 to Mistral OCR API.
        Concatenate page-level markdown into a single string.
        Store the raw page objects in raw_json for downstream use.
        """
        try:
            api_key = os.environ.get("MISTRAL_API_KEY")
            if not api_key:
                raise EnvironmentError("MISTRAL_API_KEY environment variable not set.")

            with open(pdf_path, "rb") as f:
                pdf_b64 = base64.b64encode(f.read()).decode("utf-8")

            payload = {
                "model": MISTRAL_MODEL,
                "document": {
                    "type": "document_url",
                    "document_url": f"data:application/pdf;base64,{pdf_b64}",
                },
            }

            response = requests.post(
                MISTRAL_OCR_URL,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            data = response.json()

            pages = data.get("pages", [])
            page_count = len(pages)

            # Combine page-level markdown into a single document
            markdown_text = "\n\n".join(
                page.get("markdown", "") for page in pages
            )

            # Plain text is the markdown itself — downstream consumers parse it directly
            plain_text = markdown_text

            return EngineOutput(
                raw_text=plain_text,
                raw_markdown=markdown_text,
                raw_json={"pages": pages},
                page_count=page_count,
                extraction_confidence=0.91,
                cost_usd=page_count * 0.001,  # ~$1/1K pages; verify at mistral.ai
                api_call_count=1,
            )

        except requests.Timeout:
            return EngineOutput(
                raw_text="",
                error_message=f"Mistral OCR API timed out after {REQUEST_TIMEOUT_SECONDS}s",
            )
        except requests.HTTPError as exc:
            return EngineOutput(
                raw_text="",
                error_message=f"Mistral OCR HTTP error: {exc.response.status_code} {exc.response.text[:300]}",
                stack_trace=traceback.format_exc(),
            )
        except Exception as exc:
            return EngineOutput(
                raw_text="",
                error_message=str(exc),
                stack_trace=traceback.format_exc(),
            )
