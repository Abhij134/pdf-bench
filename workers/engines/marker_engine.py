"""
workers/engines/marker_engine.py
Layout-aware open-source OCR using Marker.
Marker combines PDF parsing, layout detection, OCR, and table reconstruction.

Requires: pip install marker-pdf torch (see requirements-gpu.txt)
GPU: g4dn.xlarge (~$0.53/hr on AWS) processes ~22 pages/min.
CPU: Runs in CPU-only mode using eager attention (no SDPA/flash-attention needed).
"""
import os
import traceback
from .base import BaseEngine, Engine, EngineOutput


# Force CPU-safe attention before any torch/transformers import.
# Without this, transformers defaults to 'sdpa' which crashes on CPU-only Windows.
os.environ.setdefault("TORCH_DEVICE", "cpu")
os.environ.setdefault("ATTN_IMPLEMENTATION", "eager")


class MarkerEngine(BaseEngine):

    @property
    def engine_id(self) -> Engine:
        return Engine.MARKER

    def extract(self, pdf_path: str) -> EngineOutput:
        """
        Run Marker on a PDF. Returns full markdown output.
        Marker's convert_single_pdf returns (markdown_str, images_dict, metadata_dict).

        We force CPU-only mode and eager attention so this works on any machine
        without a CUDA GPU.
        """
        try:
            import torch

            # Patch torch SDPA to disable flash/memory-efficient attention.
            # This is the root cause of the 'sdpa' KeyError on CPU-only Windows.
            torch.backends.cuda.enable_flash_sdp(False)
            torch.backends.cuda.enable_mem_efficient_sdp(False)
            torch.backends.cuda.enable_math_sdp(True)

            from marker.convert import convert_single_pdf
            from marker.models import load_all_models

            models = load_all_models()
            full_markdown, _images, metadata = convert_single_pdf(pdf_path, models)

            if not full_markdown or not full_markdown.strip():
                raise ValueError("Marker returned empty output — PDF may be image-only or corrupt.")

            return EngineOutput(
                raw_text=full_markdown,
                raw_markdown=full_markdown,
                raw_json={"metadata": metadata},
                extraction_confidence=0.87,
                cost_usd=0.0,
            )

        except Exception as exc:
            # Only fall back if we truly cannot produce any output.
            # We log the full trace to stderr so the Next.js route captures it.
            import traceback as tb
            print(f"[MarkerEngine] ERROR: {exc}", flush=True)
            tb.print_exc()

            # Try PyMuPDF as a last resort so the user sees *something*.
            try:
                import fitz  # type: ignore
                doc = fitz.open(pdf_path)
                fallback_text = (
                    f"[MARKER EXTRACTION - Fallback: {str(exc)}]\n\n"
                    + "\n\n".join(page.get_text() for page in doc)
                )
                fallback_text = fallback_text.replace('\x00', '')
                doc.close()
                return EngineOutput(
                    raw_text=fallback_text,
                    raw_markdown=f"# Marker Fallback (PyMuPDF)\n\n{fallback_text}",
                    raw_json={"metadata": {"fallback_reason": str(exc)}},
                    extraction_confidence=0.50,
                    cost_usd=0.0,
                    was_fallback=True,
                )
            except Exception:
                return EngineOutput(
                    raw_text="",
                    error_message=str(exc),
                    stack_trace=traceback.format_exc(),
                )
