"""
workers/preflight.py
Pre-flight PDF classifier — auto-detects and writes document metadata.

Called by the Next.js POST /api/documents route immediately after a PDF
is saved to storage. Updates the Document row with:
  - pageCount
  - pdfType        (NATIVE_DIGITAL | SCANNED_IMAGE | HYBRID | VECTOR_TEXT | ENCRYPTED)
  - layoutType     (SINGLE_COLUMN | TWO_COLUMN | THREE_COLUMN | SIDEBAR_LEFT | SIDEBAR_RIGHT | MIXED | UNKNOWN)
  - hasTextLayer
  - hasFontEmbeds
  - hasImages
  - isEncrypted
  - hasInvisibleText
  - hasDuplicateLayers
  - numericDensity

Usage:
  python3 workers/preflight.py \\
    --document-id clxxx \\
    --pdf /abs/path/to/file.pdf \\
    --db-url postgresql://...

Exits with code 0 on success, 1 on failure (non-fatal — the upload already
succeeded; missing preflight data is acceptable, just not ideal).
"""
import argparse
import re
import sys
import traceback

import fitz  # pymupdf
import psycopg2


# ─── THRESHOLDS ───────────────────────────────────────────────────────────────

# If > 20% of text-blocks start in the right half → multi-column
MULTI_COL_BLOCK_RATIO   = 0.20
# Column boundary: 45% of page width separates left/right columns
COL_BOUNDARY_RATIO      = 0.45
# Sidebar: narrow band < 20% of page width on left or right
SIDEBAR_BOUNDARY_LEFT   = 0.20
SIDEBAR_BOUNDARY_RIGHT  = 0.80
# Invisible text: white or near-white colour (RGB each > 240/255)
INVISIBLE_TEXT_THRESHOLD = 240
# Garble detection (same regex as pymupdf_engine.py)
GARBLE_RE = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|[^\x00-\x7F]{6,}')


# ─── SIGNAL EXTRACTION ────────────────────────────────────────────────────────

def classify_pdf(pdf_path: str) -> dict:
    """
    Open a PDF and return a dict of classification signals.
    All fields map directly to Prisma Document model column names (camelCase).
    """
    signals = {
        "pageCount":           None,
        "pdfType":             "NATIVE_DIGITAL",
        "layoutType":          "UNKNOWN",
        "hasTextLayer":        False,
        "hasFontEmbeds":       False,
        "hasImages":           False,
        "isEncrypted":         False,
        "hasInvisibleText":    False,
        "hasDuplicateLayers":  False,
        "numericDensity":      0.0,
    }

    try:
        doc = fitz.open(pdf_path)
    except Exception as exc:
        print(f"[preflight] fitz.open failed: {exc}", flush=True)
        return signals

    # ── Encrypted check ──────────────────────────────────────────────────────
    if doc.is_encrypted:
        doc.close()
        signals["isEncrypted"] = True
        signals["pdfType"] = "ENCRYPTED"
        return signals

    signals["pageCount"] = doc.page_count

    # ── Per-page analysis ────────────────────────────────────────────────────
    all_text_blocks = []   # list of all (x0, y0, x1, y1) bbox tuples across pages
    all_text        = []   # full raw text per page
    page_has_image  = []   # bool per page
    page_has_text   = []   # bool per page
    total_chars     = 0
    digit_chars     = 0
    invisible_count = 0

    for page in doc:
        page_w = page.rect.width

        # ── Text blocks ──
        raw = page.get_text("dict", flags=fitz.TEXT_PRESERVE_LIGATURES)
        blocks = raw.get("blocks", [])
        text_blocks = [b for b in blocks if b.get("type") == 0]
        image_blocks = [b for b in blocks if b.get("type") == 1]

        page_text_parts = []
        for blk in text_blocks:
            for line in blk.get("lines", []):
                for span in line.get("spans", []):
                    span_text = span.get("text", "")
                    page_text_parts.append(span_text)

                    # Invisible text detection — check span colour
                    color = span.get("color", 0)
                    if isinstance(color, int):
                        r = (color >> 16) & 0xFF
                        g = (color >>  8) & 0xFF
                        b = color         & 0xFF
                        if r > INVISIBLE_TEXT_THRESHOLD and g > INVISIBLE_TEXT_THRESHOLD and b > INVISIBLE_TEXT_THRESHOLD:
                            if span_text.strip():
                                invisible_count += 1

        page_text_joined = " ".join(page_text_parts)
        all_text.append(page_text_joined)
        total_chars += len(page_text_joined)
        digit_chars += len(re.findall(r'\d', page_text_joined))

        page_has_text.append(len(page_text_joined.strip()) > 20)
        page_has_image.append(len(image_blocks) > 0)

        # Collect block bboxes for layout analysis (normalised x0)
        for blk in text_blocks:
            bbox = blk.get("bbox", [0, 0, 0, 0])
            all_text_blocks.append((bbox[0] / max(page_w, 1), bbox[1]))

    doc.close()

    has_text  = any(page_has_text)
    has_image = any(page_has_image)

    signals["hasTextLayer"]  = has_text
    signals["hasImages"]     = has_image
    signals["hasInvisibleText"] = invisible_count > 0

    # ── numericDensity ───────────────────────────────────────────────────────
    if total_chars > 0:
        signals["numericDensity"] = round(digit_chars / total_chars, 4)

    # ── Duplicate layer detection ─────────────────────────────────────────────
    # Heuristic: if total lines have > 30% duplicates, two text layers likely overlap
    full_text = "\n".join(all_text)
    lines = [ln.strip() for ln in full_text.split('\n') if len(ln.strip()) > 10]
    if lines:
        dup_ratio = 1.0 - (len(set(lines)) / len(lines))
        signals["hasDuplicateLayers"] = dup_ratio > 0.30

    # ── Font embed detection ─────────────────────────────────────────────────
    # Re-open briefly to check font list (fitz.open is cheap)
    doc2 = fitz.open(pdf_path)
    fonts = []
    for page in doc2:
        fonts.extend(page.get_fonts(full=False))
    doc2.close()
    signals["hasFontEmbeds"] = len(fonts) > 0

    # ── PDF Type classification ───────────────────────────────────────────────
    if not has_text and has_image:
        signals["pdfType"] = "SCANNED_IMAGE"
    elif has_text and has_image and signals["hasDuplicateLayers"]:
        signals["pdfType"] = "HYBRID"
    elif has_text and not has_image and not signals["hasFontEmbeds"]:
        # Text is present but no fonts embedded → likely vector/path-based text
        signals["pdfType"] = "VECTOR_TEXT"
    elif has_text and has_image:
        # Selectable text + images → could be hybrid but without duplicate layers
        signals["pdfType"] = "HYBRID"
    else:
        signals["pdfType"] = "NATIVE_DIGITAL"

    # ── Layout type classification ────────────────────────────────────────────
    signals["layoutType"] = _classify_layout(all_text_blocks)

    return signals


def _classify_layout(blocks: list) -> str:
    """
    Classify the layout type from normalised (x0_ratio, y0) block positions.

    Algorithm:
      1. Count blocks in left (<20%), mid (20-80%), and right (>80%) x-bands.
      2. If > 20% of blocks are in right half (x0 > 0.45): multi-column candidate.
      3. Check for three-column: blocks cluster around x≈0.1, x≈0.4, x≈0.7.
      4. Check for sidebar: dense narrow left or right band.
      5. Otherwise: SINGLE_COLUMN.
    """
    if not blocks:
        return "UNKNOWN"

    total = len(blocks)
    left_narrow   = sum(1 for x, _ in blocks if x < SIDEBAR_BOUNDARY_LEFT)
    right_narrow  = sum(1 for x, _ in blocks if x > SIDEBAR_BOUNDARY_RIGHT)
    right_half    = sum(1 for x, _ in blocks if x >= COL_BOUNDARY_RATIO)
    mid_only      = sum(1 for x, _ in blocks if SIDEBAR_BOUNDARY_LEFT <= x <= SIDEBAR_BOUNDARY_RIGHT)

    right_ratio       = right_half   / total
    left_narrow_ratio = left_narrow  / total
    right_narrow_ratio= right_narrow / total

    # Sidebar patterns: dominant narrow band on one side + main body content
    if left_narrow_ratio > 0.15 and mid_only / total > 0.40:
        return "SIDEBAR_LEFT"
    if right_narrow_ratio > 0.15 and mid_only / total > 0.40:
        return "SIDEBAR_RIGHT"

    if right_ratio > MULTI_COL_BLOCK_RATIO:
        # Three-column: check for a third distinct x cluster around 0.65+
        far_right = sum(1 for x, _ in blocks if x > 0.65)
        if far_right / total > 0.10:
            return "THREE_COLUMN"
        return "TWO_COLUMN"

    return "SINGLE_COLUMN"


# ─── DATABASE WRITE ────────────────────────────────────────────────────────────

def write_signals_to_db(conn, document_id: str, signals: dict) -> None:
    """Update Document row with pre-flight classification signals."""
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE "Document" SET
                "pageCount"          = %s,
                "pdfType"            = %s,
                "layoutType"         = %s,
                "hasTextLayer"       = %s,
                "hasFontEmbeds"      = %s,
                "hasImages"          = %s,
                "isEncrypted"        = %s,
                "hasInvisibleText"   = %s,
                "hasDuplicateLayers" = %s,
                "numericDensity"     = %s
            WHERE id = %s
            """,
            (
                signals["pageCount"],
                signals["pdfType"],
                signals["layoutType"],
                signals["hasTextLayer"],
                signals["hasFontEmbeds"],
                signals["hasImages"],
                signals["isEncrypted"],
                signals["hasInvisibleText"],
                signals["hasDuplicateLayers"],
                signals["numericDensity"],
                document_id,
            ),
        )
    conn.commit()


# ─── ENTRY POINT ──────────────────────────────────────────────────────────────

def main():
    """CLI entry point — called by Next.js API route post-upload."""
    parser = argparse.ArgumentParser(description="Pre-flight PDF classifier")
    parser.add_argument("--document-id", required=True, help="Prisma Document row ID")
    parser.add_argument("--pdf",         required=True, help="Absolute path to PDF file")
    parser.add_argument("--db-url",      required=True, help="PostgreSQL connection string")
    args = parser.parse_args()

    print(f"[preflight] Classifying {args.pdf} (document_id={args.document_id})", flush=True)

    try:
        signals = classify_pdf(args.pdf)
        print(
            f"[preflight] Detected: pdfType={signals['pdfType']} "
            f"layout={signals['layoutType']} pages={signals['pageCount']} "
            f"textLayer={signals['hasTextLayer']} images={signals['hasImages']}",
            flush=True,
        )

        conn = psycopg2.connect(args.db_url)
        write_signals_to_db(conn, args.document_id, signals)
        conn.close()

        print("[preflight] DB updated successfully.", flush=True)
        sys.exit(0)

    except Exception as exc:
        print(f"[preflight] ERROR: {exc}", flush=True)
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
