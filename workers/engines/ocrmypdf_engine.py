"""
workers/engines/ocrmypdf_engine.py
CPU-based OCR fallback using OCRmyPDF + Tesseract.
Used when: empty_extraction or whitespace_anomaly detected AND no GPU available.
Adds an OCR text layer to the PDF, then re-extracts with PyMuPDF.

Options used:
  --force-ocr    : OCR even if the PDF has an existing text layer
  --deskew       : Correct page rotation/skew (critical for phone-camera scans)
  --clean        : Apply unpaper preprocessing to improve OCR quality
  --optimize 0   : Skip image compression — we want maximum OCR accuracy
  --output-type pdf : Output a searchable PDF we then re-extract
"""
import os
import subprocess
import tempfile
import traceback
from typing import Optional
import fitz

from .base import BaseEngine, Engine, EngineOutput


class OCRmyPDFEngine(BaseEngine):

    @property
    def engine_id(self) -> Engine:
        return Engine.OCRMYPDF_TESSERACT

    def extract(self, pdf_path: str) -> EngineOutput:
        """
        Run OCRmyPDF on the input PDF to produce a searchable PDF,
        then extract the text layer using PyMuPDF.
        """
        out_pdf = None
        try:
            # Write to a temp file so we don't overwrite the original
            with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as tmp:
                out_pdf = tmp.name

            result = subprocess.run(
                [
                    "ocrmypdf",
                    "--force-ocr",
                    "--deskew",
                    "--clean",
                    "--optimize", "0",
                    "--output-type", "pdf",
                    pdf_path,
                    out_pdf,
                ],
                capture_output=True,
                text=True,
                timeout=300,  # 5-minute hard timeout per document
            )

            if result.returncode != 0:
                raise RuntimeError(
                    f"ocrmypdf exited with code {result.returncode}. "
                    f"stderr: {result.stderr[:500]}"
                )

            # Re-extract text from the OCR'd PDF using PyMuPDF
            doc = fitz.open(out_pdf)
            page_texts = []
            for page in doc:
                page_texts.append(page.get_text())
            doc.close()

            full_text = "\n\n".join(page_texts)

            return EngineOutput(
                raw_text=full_text,
                page_count=len(page_texts),
                extraction_confidence=0.74,  # Tesseract baseline confidence
            )

        except subprocess.TimeoutExpired:
            return EngineOutput(
                raw_text="",
                error_message="ocrmypdf timed out after 300 seconds",
            )
        except Exception as exc:
            return EngineOutput(
                raw_text="",
                error_message=str(exc),
                stack_trace=traceback.format_exc(),
            )
        finally:
            # Always clean up temp file
            if out_pdf and os.path.exists(out_pdf):
                os.unlink(out_pdf)
