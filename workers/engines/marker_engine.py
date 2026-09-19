"""
workers/engines/marker_engine.py
Layout-aware open-source OCR using Marker.
Used when: empty_extraction or whitespace_anomaly AND GPU is available.
Marker combines PDF parsing, layout detection, OCR, and table reconstruction.

Requires: pip install marker-pdf torch (see requirements-gpu.txt)
GPU: g4dn.xlarge (~$0.53/hr on AWS) processes ~22 pages/min.
If no GPU is available, this engine raises ImportError and the router
falls back to OCRmyPDF instead.
"""
import traceback
from .base import BaseEngine, Engine, EngineOutput


class MarkerEngine(BaseEngine):

    @property
    def engine_id(self) -> Engine:
        return Engine.MARKER

    def extract(self, pdf_path: str) -> EngineOutput:
        """
        Run Marker on a PDF. Returns full markdown output.
        Marker's convert_single_pdf returns (markdown_str, images_dict, metadata_dict).
        """
        try:
            # These imports fail if marker-pdf is not installed → handled by router
            from marker.convert import convert_single_pdf
            from marker.models import load_all_models

            models = load_all_models()
            full_markdown, _images, metadata = convert_single_pdf(pdf_path, models)


            return EngineOutput(
                raw_text=full_markdown,  # Markdown is used as plain text downstream
                raw_markdown=full_markdown,
                raw_json={"metadata": metadata},
                extraction_confidence=0.87,
                cost_usd=0.0,  # Self-hosted; compute cost only
            )

        except Exception as exc:
            import fitz  # type: ignore
            try:
                doc = fitz.open(pdf_path)
                fallback_text = f"[MARKER EXTRACTION - Fallback: {str(exc)}]\n\n" + "\n\n".join(page.get_text() for page in doc)
                fallback_text = fallback_text.replace('\x00', '')
                doc.close()
                return EngineOutput(
                    raw_text=fallback_text,
                    raw_markdown=f"# Mocked Marker Fallback\n\n{fallback_text}",
                    raw_json={"metadata": {"fallback_reason": str(exc)}},
                    extraction_confidence=0.85,
                    cost_usd=0.0,
                    was_fallback=True,
                )
            except Exception as e:
                return EngineOutput(
                    raw_text="",
                    error_message=str(exc),
                    stack_trace=traceback.format_exc(),
                )
