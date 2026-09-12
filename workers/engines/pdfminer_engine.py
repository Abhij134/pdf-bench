"""
workers/engines/pdfminer_engine.py
Fallback engine used when PyMuPDF produces garbled text (typically encoding/font issues).
pdfminer.six uses different codec handling and often recovers text that PyMuPDF garbles.
"""
import traceback
from typing import Optional
from pdfminer.high_level import extract_text
from pdfminer.layout import LAParams

from .base import BaseEngine, Engine, EngineOutput


class PDFMinerEngine(BaseEngine):

    @property
    def engine_id(self) -> Engine:
        return Engine.PDFMINER

    def extract(self, pdf_path: str) -> EngineOutput:
        """
        Extract text using pdfminer.six.
        LAParams controls layout analysis — char_margin and word_margin tuned
        for resume-style dense text. line_margin=0.5 groups lines into paragraphs.
        """
        try:
            laparams = LAParams(
                char_margin=2.0,    # chars within 2x char-width = same word
                word_margin=0.1,    # words within 0.1x char-width = same line
                line_margin=0.5,    # lines within 0.5x char-height = same paragraph
                boxes_flow=0.5,     # 0.5 = balanced h/v flow (good for two-column)
            )
            text = extract_text(pdf_path, laparams=laparams)

            return EngineOutput(
                raw_text=text or "",
            )
        except Exception as exc:
            return EngineOutput(
                raw_text="",
                error_message=str(exc),
                stack_trace=traceback.format_exc(),
            )
