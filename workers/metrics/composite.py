"""
workers/metrics/composite.py
Weighted composite score aggregating all quality dimensions.

Base weights:
  char_f1         : 0.35  — Primary text fidelity
  reading_order   : 0.20  — Critical for multi-column resumes
  numeric_accuracy: 0.15  — Dates, salaries, phones, percentages
  section_f1      : 0.10  — Section grouping correctness
  ocr_accuracy    : 0.10  — 1 - CER (upweighted for scanned docs)
  table_accuracy  : 0.05  — Row/column preservation
  cost_efficiency : 0.05  — Normalised inverse cost

Doc-type overrides adjust weights based on the dominant challenge.
Missing metrics are excluded and remaining weights are renormalised to sum to 1.
"""
from typing import Dict, Optional


BASE_WEIGHTS: Dict[str, float] = {
    "char_f1":          0.35,
    "reading_order":    0.20,
    "numeric_accuracy": 0.15,
    "section_f1":       0.10,
    "ocr_accuracy":     0.10,
    "table_accuracy":   0.05,
    "cost_efficiency":  0.05,
}

# Per-doc-type weight overrides.
# Keys must be a subset of BASE_WEIGHTS keys.
# After override, all weights are renormalised to sum to 1.0.
DOC_TYPE_OVERRIDES: Dict[str, Dict[str, float]] = {
    "scanned": {
        "char_f1":          0.25,
        "ocr_accuracy":     0.25,   # OCR quality is the dominant factor
        "reading_order":    0.15,
        "numeric_accuracy": 0.12,
        "section_f1":       0.10,
        "table_accuracy":   0.08,
        "cost_efficiency":  0.05,
    },
    "numeric_dense": {
        "char_f1":          0.25,
        "numeric_accuracy": 0.28,   # Numeric fidelity is the dominant factor
        "reading_order":    0.15,
        "section_f1":       0.10,
        "ocr_accuracy":     0.08,
        "table_accuracy":   0.09,
        "cost_efficiency":  0.05,
    },
    "two_column": {
        "char_f1":          0.30,
        "reading_order":    0.30,   # Column ordering is the dominant factor
        "numeric_accuracy": 0.12,
        "section_f1":       0.12,
        "ocr_accuracy":     0.06,
        "table_accuracy":   0.05,
        "cost_efficiency":  0.05,
    },
}


def compute_composite_score(
    metrics: Dict[str, Optional[float]],
    doc_type: str = "native",
) -> float:
    """
    Compute the composite benchmark score for one engine on one document.

    Args:
        metrics:  Dict of metric_name → value (float in [0,1] or None if N/A).
                  Expected keys match BASE_WEIGHTS.
        doc_type: Determines which weight profile to use.
                  Valid values: "native", "scanned", "numeric_dense", "two_column".
                  Falls back to BASE_WEIGHTS for unknown doc_type.

    Returns:
        Composite score in [0, 1]. Returns 0.0 if no metrics are available.
    """
    # Select weight profile
    weight_profile = DOC_TYPE_OVERRIDES.get(doc_type, BASE_WEIGHTS).copy()

    # Remove metrics with None values — they are not applicable for this document
    available = {
        key: weight
        for key, weight in weight_profile.items()
        if metrics.get(key) is not None
    }

    if not available:
        return 0.0

    # Renormalise available weights to sum to 1.0
    total_weight = sum(available.values())
    normalised = {key: w / total_weight for key, w in available.items()}

    # Weighted sum
    score = sum(metrics[key] * weight for key, weight in normalised.items())
    return round(score, 6)
