"""
workers/metrics/numeric_accuracy.py
Regex-based numeric / factual accuracy scoring.

For each entity type:
  - Extract the reference set from ground truth text.
  - Count how many reference entities appear verbatim (post-normalisation)
    in the hypothesis text.
  - Score = |matched| / |reference_set|

This is intentionally STRICT: a number like "2021-2024" that becomes
"20212024" (space/dash lost) or "2O21" (digit/letter confusion) will
NOT match and will reduce the score — which is correct for factual fidelity.

Returns per-type scores (None if no reference entities of that type exist)
plus an unweighted aggregate over available types.
"""
import re
from typing import Dict, List, Optional

import numpy as np


# ─── ENTITY PATTERNS ────────────────────────────────────────────────
# Each pattern is designed to be specific enough to avoid false positives
# but flexible enough to handle common formatting variations.

PATTERNS: Dict[str, str] = {
    "phone": (
        r'\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b'
    ),
    "date_iso": (
        r'\b(19|20)\d{2}[-/](0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01])\b'
    ),
    "date_text": (
        r'\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+'
        r'(19|20)\d{2}\b'
    ),
    "year_range": (
        r'\b(19|20)\d{2}\s*[-–—]\s*(?:(19|20)\d{2}|[Pp]resent|[Cc]urrent)\b'
    ),
    "salary_inr": (
        r'(?:₹|Rs\.?)\s*\d{1,3}(?:,\d{2,3})*(?:\.\d+)?(?:\s*(?:LPA|CTC|PA))?'
    ),
    "salary_usd": (
        r'\$\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?[KkMm]?'
    ),
    "percentage": (
        r'\b\d{1,3}(?:\.\d+)?%'
    ),
    "version": (
        r'\b[vV]?\d+\.\d+(?:\.\d+)*\b'
    ),
    "email": (
        r'\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b'
    ),
    "url": (
        r'https?://[^\s<>"{}|\\^`\[\]]+'
    ),
}


def _normalise_match(match) -> str:
    """
    Flatten a regex match (which may be a tuple from capturing groups)
    and normalise whitespace for comparison.
    """
    if isinstance(match, tuple):
        text = " ".join(part for part in match if part)
    else:
        text = str(match)
    return re.sub(r'\s+', ' ', text.strip().lower())


def compute_numeric_accuracy(
    hypothesis: str,
    reference: str,
    entity_types: Optional[List[str]] = None,
) -> Dict[str, Optional[float]]:
    """
    Compute per-entity-type and aggregate numeric accuracy.

    Args:
        hypothesis:   Extracted text from the engine under test.
        reference:    Ground truth text.
        entity_types: Optional subset of PATTERNS keys to evaluate.
                      Defaults to all patterns.

    Returns:
        Dict with keys matching PATTERNS plus an "aggregate" key.
        Values are floats in [0, 1] or None if no reference entities exist.
    """
    types_to_check = entity_types or list(PATTERNS.keys())
    results: Dict[str, Optional[float]] = {}

    for etype in types_to_check:
        pattern = PATTERNS[etype]

        ref_raw = re.findall(pattern, reference, re.IGNORECASE)
        if not ref_raw:
            results[etype] = None   # Entity type not present in this document
            continue

        ref_set = {_normalise_match(m) for m in ref_raw}
        hyp_set = {_normalise_match(m) for m in re.findall(pattern, hypothesis, re.IGNORECASE)}

        matched = ref_set & hyp_set
        results[etype] = round(len(matched) / len(ref_set), 6)

    # Unweighted average over available (non-None) types
    valid_scores = [v for v in results.values() if v is not None]
    results["aggregate"] = round(float(np.mean(valid_scores)), 6) if valid_scores else None

    return results


def find_missing_entities(
    hypothesis: str,
    reference: str,
) -> Dict[str, List[str]]:
    """
    Returns the specific entity strings that are present in the reference
    but absent from the hypothesis.
    Useful for failure-mode attribution: which exact values were lost or corrupted?
    """
    missing: Dict[str, List[str]] = {}

    for etype, pattern in PATTERNS.items():
        ref_set = {
            _normalise_match(m)
            for m in re.findall(pattern, reference, re.IGNORECASE)
        }
        hyp_set = {
            _normalise_match(m)
            for m in re.findall(pattern, hypothesis, re.IGNORECASE)
        }
        lost = sorted(ref_set - hyp_set)
        if lost:
            missing[etype] = lost

    return missing
