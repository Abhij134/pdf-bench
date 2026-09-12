"""
workers/engines/pymupdf_engine.py

Stage 1 extraction engine: PyMuPDF with column-aware reading-order reconstruction.

Key design decisions:
  - Uses fitz.TEXT_PRESERVE_LIGATURES to avoid ligature corruption (fi→ﬁ issue).
  - Uses fitz.TEXT_PRESERVE_WHITESPACE to maintain spacing.
  - Detects multi-column layout via x0 bimodal distribution.
  - Column threshold: 45% of page width. If >20% of blocks have x0 >= threshold,
    treat as multi-column and emit left column then right column.
  - Does NOT use fitz.TEXT_DEHYPHENATE — we want hyphens preserved verbatim.
"""
import re
import traceback
from typing import Optional
import fitz  # pymupdf

from .base import BaseEngine, Engine, EngineOutput


# Stage 2 validation thresholds (applied internally to set confidence signals)
THRESHOLDS = {
    "min_word_count": 50,
    "max_garble_ratio": 0.02,       # >2% non-printable chars = garbled
    "max_whitespace_ratio": 0.82,   # >82% whitespace chars = likely empty/scanned
    "max_dup_block_ratio": 0.30,    # >30% duplicate lines = dual text layer
}

# Regex: control characters and long non-ASCII runs (garble detection)
GARBLE_RE = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|[^\x00-\x7F]{6,}')


class PyMuPDFEngine(BaseEngine):

    @property
    def engine_id(self) -> Engine:
        return Engine.PYMUPDF

    @property
    def engine_version(self) -> Optional[str]:
        return fitz.__version__

    def extract(self, pdf_path: str) -> EngineOutput:
        """
        Extract text from a native PDF using PyMuPDF.
        Applies column-aware block sorting per page.
        Computes Stage 2 confidence signals and returns them in the output.
        """
        try:
            doc = fitz.open(pdf_path)
            page_texts = []

            for page in doc:
                raw_dict = page.get_text(
                    "dict",
                    flags=fitz.TEXT_PRESERVE_LIGATURES | fitz.TEXT_PRESERVE_WHITESPACE,
                )
                blocks = raw_dict.get("blocks", [])
                sorted_blocks = self._column_aware_sort(blocks, page.rect.width)

                # Concatenate all spans in reading order
                page_text = "\n".join(
                    " ".join(
                        span["text"]
                        for line in block.get("lines", [])
                        for span in line.get("spans", [])
                    ).strip()
                    for block in sorted_blocks
                    if block.get("type") == 0  # type 0 = text block (not image)
                )
                page_texts.append(page_text)

            doc.close()
            full_text = "\n\n".join(page_texts)

            # Compute Stage 2 confidence signals
            confidence, signals = self._compute_confidence_signals(full_text)

            return EngineOutput(
                raw_text=full_text,
                page_count=len(page_texts),
                extraction_confidence=confidence,
                garble_ratio=signals["garble_ratio"],
                whitespace_ratio=signals["whitespace_ratio"],
                duplicate_block_ratio=signals["duplicate_block_ratio"],
                numeric_anomaly_detected=signals["numeric_anomaly"],
            )

        except Exception as exc:
            return EngineOutput(
                raw_text="",
                error_message=str(exc),
                stack_trace=traceback.format_exc(),
            )

    def _column_aware_sort(self, blocks: list, page_width: float) -> list:
        """
        Sort text blocks into reading order.

        Algorithm:
          1. Separate image blocks (type=1) from text blocks (type=0).
          2. For text blocks, check if >20% have x0 >= 45% of page_width.
             If yes: multi-column layout detected.
          3. In multi-column mode: sort left blocks top-to-bottom, then
             sort right blocks top-to-bottom. Emit left + right.
          4. In single-column mode: sort all blocks by (y0, x0).
          5. Image blocks are excluded from text output (they have no spans).
        """
        text_blocks = [b for b in blocks if b.get("type") == 0]
        if not text_blocks:
            return []

        col_boundary = page_width * 0.45
        right_side = [b for b in text_blocks if b["bbox"][0] >= col_boundary]
        multi_column = len(right_side) / len(text_blocks) > 0.20

        if multi_column:
            left_col = sorted(
                [b for b in text_blocks if b["bbox"][0] < col_boundary],
                key=lambda b: b["bbox"][1],   # sort by y0 (top edge)
            )
            right_col = sorted(right_side, key=lambda b: b["bbox"][1])
            return left_col + right_col
        else:
            # Single column: sort by y0 first, then x0 for same-row blocks
            return sorted(text_blocks, key=lambda b: (b["bbox"][1], b["bbox"][0]))

    def _compute_confidence_signals(self, text: str) -> tuple:
        """
        Compute Stage 2 confidence signals from extracted text.
        Returns (confidence_score_0_to_1, signals_dict).

        Heuristic weights:
          H1 word_count   : 0.30
          H2 garble_ratio : 0.25
          H3 ws_ratio     : 0.15
          H4 dup_blocks   : 0.20
          H5 numeric      : 0.10
        """
        signals = {
            "garble_ratio": 0.0,
            "whitespace_ratio": 0.0,
            "duplicate_block_ratio": 0.0,
            "numeric_anomaly": False,
        }
        component_scores = []
        weights = [0.30, 0.25, 0.15, 0.20, 0.10]

        # H1: Word count
        word_count = len(text.split())
        if word_count < THRESHOLDS["min_word_count"]:
            component_scores.append(0.0)
        else:
            component_scores.append(min(1.0, word_count / 200))

        # H2: Garbled character ratio
        garble_count = len(GARBLE_RE.findall(text))
        garble_ratio = garble_count / max(len(text), 1)
        signals["garble_ratio"] = round(garble_ratio, 6)
        if garble_ratio > THRESHOLDS["max_garble_ratio"]:
            component_scores.append(max(0.0, 1.0 - garble_ratio * 25))
        else:
            component_scores.append(1.0)

        # H3: Whitespace ratio (spaces + newlines / total chars)
        ws_count = text.count(' ') + text.count('\n') + text.count('\t')
        ws_ratio = ws_count / max(len(text), 1)
        signals["whitespace_ratio"] = round(ws_ratio, 4)
        if ws_ratio > THRESHOLDS["max_whitespace_ratio"]:
            component_scores.append(0.2)
        else:
            component_scores.append(1.0)

        # H4: Duplicate block ratio (duplicate lines = dual text layer symptom)
        lines = [ln.strip() for ln in text.split('\n') if len(ln.strip()) > 10]
        unique_line_count = len(set(lines))
        dup_ratio = 1.0 - (unique_line_count / max(len(lines), 1))
        signals["duplicate_block_ratio"] = round(dup_ratio, 4)
        if dup_ratio > THRESHOLDS["max_dup_block_ratio"]:
            component_scores.append(max(0.0, 1.0 - dup_ratio * 2))
        else:
            component_scores.append(1.0)

        # H5: Numeric integrity spot-check
        # Flag if digit density > 4% but zero year-like patterns exist
        digit_density = len(re.findall(r'\d', text)) / max(len(text), 1)
        date_hits = len(re.findall(r'\b(19|20)\d{2}\b', text))
        if digit_density > 0.04 and date_hits == 0:
            signals["numeric_anomaly"] = True
            component_scores.append(0.65)
        else:
            component_scores.append(1.0)

        confidence = sum(s * w for s, w in zip(component_scores, weights))
        return round(confidence, 4), signals
