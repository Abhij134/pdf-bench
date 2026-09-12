"""
workers/engines/base.py
Abstract base class that every extraction engine must implement.
Enforces a consistent interface: input is a file path, output is a dict
that maps directly to the ExtractionResult Prisma model fields.
"""
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional
from enum import Enum


class Engine(str, Enum):
    PYMUPDF = "PYMUPDF"
    PDFMINER = "PDFMINER"
    MARKER = "MARKER"
    OCRMYPDF_TESSERACT = "OCRMYPDF_TESSERACT"
    MISTRAL_OCR = "MISTRAL_OCR"
    GOOGLE_DOCUMENT_AI = "GOOGLE_DOCUMENT_AI"


@dataclass
class EngineOutput:
    """
    Matches ExtractionResult Prisma model fields exactly.
    All fields except raw_text are optional — engines fill what they can.
    """
    raw_text: str
    raw_markdown: Optional[str] = None
    raw_json: Optional[dict] = None
    processing_time_ms: int = 0
    char_count: int = 0
    word_count: int = 0
    page_count: Optional[int] = None
    extraction_confidence: Optional[float] = None
    garble_ratio: Optional[float] = None
    whitespace_ratio: Optional[float] = None
    duplicate_block_ratio: Optional[float] = None
    numeric_anomaly_detected: bool = False
    was_fallback: bool = False
    cost_usd: float = 0.0
    api_call_count: int = 0
    error_message: Optional[str] = None
    stack_trace: Optional[str] = None

    def __post_init__(self):
        """Auto-populate word and char counts from raw_text if not set."""
        if self.raw_text and not self.char_count:
            self.char_count = len(self.raw_text)
        if self.raw_text and not self.word_count:
            self.word_count = len(self.raw_text.split())


class BaseEngine(ABC):
    """All extraction engines inherit from this class."""

    @property
    @abstractmethod
    def engine_id(self) -> Engine:
        """Return the Engine enum value for this engine."""
        ...

    @property
    def engine_version(self) -> Optional[str]:
        """Return the version string of the underlying library, if available."""
        return None

    @abstractmethod
    def extract(self, pdf_path: str) -> EngineOutput:
        """
        Extract text from the PDF at pdf_path.
        Must catch ALL exceptions internally and return an EngineOutput
        with error_message set — never raise from this method.
        """
        ...

    def timed_extract(self, pdf_path: str) -> EngineOutput:
        """Wraps extract() with wall-clock timing."""
        t0 = time.monotonic()
        result = self.extract(pdf_path)
        result.processing_time_ms = int((time.monotonic() - t0) * 1000)
        return result
