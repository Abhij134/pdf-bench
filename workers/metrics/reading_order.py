"""
workers/metrics/reading_order.py
Two reading-order accuracy methods:

  1. Normalised Edit Distance (NED) on matched block index sequences.
     Best for: detecting systematic column-swap (left/right entire column inversion).
     Returns 1.0 for perfect order, 0.0 for completely disordered.

  2. Kendall τ on matched block reference-rank pairs.
     Best for: detecting partial column inversion and rank-correlation analysis.
     Normalised from [-1, 1] to [0, 1] via (τ + 1) / 2.

Use NED as the primary metric stored in BenchmarkMetric.readingOrderScore.
Report Kendall τ in analysis / reporting layer.
"""
import re
from difflib import SequenceMatcher
from typing import List, Tuple

from Levenshtein import distance as levenshtein_distance
from scipy.stats import kendalltau


# Minimum character length to include a block in alignment (filters short headers)
MIN_BLOCK_CHARS = 20

# Minimum similarity ratio to accept a block alignment pair
ALIGNMENT_THRESHOLD = 0.55

# Maximum characters to compare per block during alignment (performance cap)
BLOCK_COMPARE_CHARS = 300


BLANK_LINE_RE = re.compile(r"\n\s*\n")

def segment_into_blocks(text: str) -> List[str]:
    """
    Split text into blocks. Primary: blank-line (paragraph) boundaries.
    Fallback: line-level blocks, for engines that emit single newlines
    (e.g. PyMuPDF page dict output) and would otherwise produce one
    giant block that defeats alignment.
    """
    blocks = [
        b.strip()
        for b in BLANK_LINE_RE.split(text)
        if len(b.strip()) >= MIN_BLOCK_CHARS
    ]
    if len(blocks) >= 2:
        return blocks
    return [
        ln.strip()
        for ln in text.split("\n")
        if len(ln.strip()) >= MIN_BLOCK_CHARS
    ]


def align_blocks(
    extracted_blocks: List[str],
    reference_blocks: List[str],
) -> List[Tuple[int, int]]:
    """
    Greedy alignment: for each extracted block (in extraction order),
    find the highest-similarity reference block not yet consumed.

    Returns: list of (reference_index, extraction_index) pairs.
    Only includes pairs above ALIGNMENT_THRESHOLD.
    """
    matched: List[Tuple[int, int]] = []
    consumed_ref_indices = set()

    for ext_i, ext_block in enumerate(extracted_blocks):
        best_ratio = 0.0
        best_ref_i = -1

        for ref_i, ref_block in enumerate(reference_blocks):
            if ref_i in consumed_ref_indices:
                continue
            # Compare only the first BLOCK_COMPARE_CHARS characters for speed
            ratio = SequenceMatcher(
                None,
                ext_block[:BLOCK_COMPARE_CHARS],
                ref_block[:BLOCK_COMPARE_CHARS],
            ).ratio()
            if ratio > best_ratio:
                best_ratio = ratio
                best_ref_i = ref_i

        if best_ratio >= ALIGNMENT_THRESHOLD and best_ref_i != -1:
            matched.append((best_ref_i, ext_i))
            consumed_ref_indices.add(best_ref_i)

    return matched


def reading_order_ned(
    hypothesis: str,
    reference: str,
) -> float:
    """
    Normalised Edit Distance reading-order accuracy.

    Algorithm:
      1. Segment both texts into blocks.
      2. Align extracted blocks to reference blocks (greedy, confidence-gated).
      3. Extract the reference_index sequence for matched pairs.
      4. The ideal sequence is sorted(reference_indices).
      5. Levenshtein edit distance between actual and ideal sequences.
      6. Normalise: score = 1 - (distance / max(len(sequence), 1)).

    Returns 1.0 for perfect order, 0.0 for maximally disordered.
    Returns 0.0 if fewer than 2 blocks could be aligned.
    """
    ext_blocks = segment_into_blocks(hypothesis)
    ref_blocks = segment_into_blocks(reference)

    if not ext_blocks or not ref_blocks:
        return 0.0

    matched = align_blocks(ext_blocks, ref_blocks)

    if len(matched) < 2:
        return 0.0  # Not enough matched pairs for meaningful ordering comparison

    # Extract the sequence of reference indices in extraction order
    # matched is already in ext_i order because align_blocks iterates ext_blocks in order
    ref_index_sequence = [ref_i for ref_i, _ext_i in matched]

    # Ideal: same indices but sorted ascending (perfect reading order)
    ideal_sequence = sorted(ref_index_sequence)

    dist = levenshtein_distance(ref_index_sequence, ideal_sequence)
    score = 1.0 - dist / max(len(ref_index_sequence), 1)
    return round(max(0.0, score), 6)


def reading_order_kendall_tau(
    hypothesis: str,
    reference: str,
) -> float:
    """
    Kendall τ reading-order accuracy, normalised to [0, 1].

    Returns 1.0 for perfect rank correlation, 0.0 for random, negative values
    normalised to > 0 (0.5 = uncorrelated, < 0.5 = inversely correlated).
    Returns 0.0 if fewer than 2 blocks could be aligned.
    """
    ext_blocks = segment_into_blocks(hypothesis)
    ref_blocks = segment_into_blocks(reference)

    if not ext_blocks or not ref_blocks:
        return 0.0

    matched = align_blocks(ext_blocks, ref_blocks)

    if len(matched) < 2:
        return 0.0

    ref_ranks = [ref_i for ref_i, _ext_i in matched]
    ext_ranks = [ext_i for _ref_i, ext_i in matched]

    tau, _p_value = kendalltau(ref_ranks, ext_ranks)

    # Normalise from [-1, 1] to [0, 1]
    return round((tau + 1.0) / 2.0, 6)
