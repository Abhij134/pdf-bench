"""
workers/engines/google_dai_engine.py
Commercial Layout AI via Google Document AI.
Final fallback in the extraction router when all other methods fail.
Requires: GCP_PROJECT, GDAI_PROCESSOR_ID, GOOGLE_APPLICATION_CREDENTIALS env vars.

Cost: ~$1.50 / 1K pages for Layout Parser (verify at cloud.google.com/document-ai/pricing).
"""
import os
import traceback
from typing import Optional

from .base import BaseEngine, Engine, EngineOutput


class GoogleDAIEngine(BaseEngine):

    @property
    def engine_id(self) -> Engine:
        return Engine.GOOGLE_DOCUMENT_AI

    def extract(self, pdf_path: str) -> EngineOutput:
        """
        Process a PDF through Google Document AI Layout Parser.
        Returns structured text with bounding boxes stored in raw_json.
        """
        try:
            # Import here to avoid import errors when running without GCP credentials
            from google.cloud import documentai

            project = os.environ.get("GCP_PROJECT")
            processor_id = os.environ.get("GDAI_PROCESSOR_ID")
            if not project or not processor_id:
                raise EnvironmentError(
                    "GCP_PROJECT and GDAI_PROCESSOR_ID environment variables are required."
                )

            client = documentai.DocumentProcessorServiceClient()
            processor_name = (
                f"projects/{project}/locations/us/processors/{processor_id}"
            )

            with open(pdf_path, "rb") as f:
                content = f.read()

            raw_document = documentai.RawDocument(
                content=content,
                mime_type="application/pdf",
            )
            request = documentai.ProcessRequest(
                name=processor_name,
                raw_document=raw_document,
            )
            result = client.process_document(request=request)
            doc = result.document
            page_count = len(doc.pages)

            # Build structured block list from Document AI response
            blocks = []
            for block in doc.blocks:
                anchor = block.layout.text_anchor
                if anchor and anchor.text_segments:
                    block_text = ""
                    for seg in anchor.text_segments:
                        start = int(seg.start_index) if seg.start_index else 0
                        end = int(seg.end_index) if seg.end_index else 0
                        block_text += doc.text[start:end]
                    vertices = block.layout.bounding_poly.normalized_vertices
                    blocks.append({
                        "text": block_text,
                        "confidence": block.layout.confidence,
                        "bbox": [
                            vertices[0].x, vertices[0].y,
                            vertices[2].x, vertices[2].y,
                        ] if len(vertices) >= 3 else [],
                    })

            return EngineOutput(
                raw_text=doc.text,
                raw_json={"blocks": blocks},
                page_count=page_count,
                extraction_confidence=0.94,
                cost_usd=page_count * 0.0015,  # ~$1.50/1K pages; verify at cloud.google.com
                api_call_count=1,
            )

        except Exception as exc:
            return EngineOutput(
                raw_text="",
                error_message=str(exc),
                stack_trace=traceback.format_exc(),
            )
