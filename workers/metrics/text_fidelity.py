"""
workers/metrics/text_fidelity.py
CER, WER, and character-level Precision / Recall / F1.

Library: jiwer 3.0.3
  - cer() normalises by len(reference_characters)
  - wer() normalises by len(reference_words)
  - Both accept transform pipelines for consistent normalisation

Character F1 uses Counter intersection (handles repeated characters correctly,
e.g. "aaa" vs "aa" gives tp=2, not tp=3).
"""
from collections import Counter
from jiwer import cer as jiwer_cer
from jiwer import wer as jiwer_wer
from jiwer import transforms as tr


# Normalisation pipeline applied to BOTH hypothesis and reference before scoring
TEXT_NORMALISE = tr.Compose([
    tr.ToLowerCase(),
    tr.RemoveMultipleSpaces(),
    tr.Strip(),
    tr.RemovePunctuation(),
])


def compute_cer(hypothesis: str, reference: str) -> float:
    """
    Character Error Rate.
    Returns 0.0 for a perfect match. Can exceed 1.0 for heavy corruption.
    """
    if not reference.strip():
        return 1.0  # No reference = maximum error
    return round(
        jiwer_cer(
            reference,
            hypothesis,
            reference_transform=TEXT_NORMALISE,
            hypothesis_transform=TEXT_NORMALISE,
        ),
        6,
    )


def compute_wer(hypothesis: str, reference: str) -> float:
    """
    Word Error Rate.
    Returns 0.0 for a perfect match. Can exceed 1.0 for heavy corruption.
    """
    if not reference.strip():
        return 1.0
    return round(
        jiwer_wer(
            reference,
            hypothesis,
            reference_transform=TEXT_NORMALISE,
            hypothesis_transform=TEXT_NORMALISE,
        ),
        6,
    )


def compute_char_f1(hypothesis: str, reference: str) -> dict:
    """
    Character-level Precision, Recall, and F1 via Counter intersection.

    Precision = TP / (TP + FP) — how much of the extracted text is correct?
    Recall    = TP / (TP + FN) — how much of the reference text was found?
    F1        = harmonic mean of precision and recall.

    Lowercased before counting — preserves numeric and punctuation characters
    which carry factual information (a '5' and 'S' should not be treated as equal).
    """
    hyp_chars = Counter(hypothesis.lower())
    ref_chars = Counter(reference.lower())

    # True positives: characters in both, up to their reference count
    tp = sum(min(hyp_chars[c], ref_chars[c]) for c in ref_chars)
    fp = sum(hyp_chars.values()) - tp   # chars in hypothesis not in reference
    fn = sum(ref_chars.values()) - tp   # chars in reference not in hypothesis

    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall    = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1        = (2 * precision * recall) / (precision + recall) if (precision + recall) > 0 else 0.0

    return {
        "precision": round(precision, 6),
        "recall":    round(recall, 6),
        "f1":        round(f1, 6),
    }
