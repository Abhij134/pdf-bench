"""
workers/metric_worker.py
Triggered by POST /api/benchmark/internal/compute-metrics after all engines finish.

For each ExtractionResult in the BenchmarkRun:
  1. Load the GroundTruth for the document.
  2. Compute all metrics from workers/metrics/*.
  3. Write a BenchmarkMetric row.
  4. Compute composite score and write it back.

Usage:
  python3 workers/metric_worker.py \\
    --benchmark-run-id clxxx \\
    --db-url postgresql://...
"""
import argparse
import json
import sys
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
import traceback
import uuid
from collections import Counter

import psycopg2

from metrics.text_fidelity import compute_cer, compute_wer, compute_char_f1
from metrics.reading_order import reading_order_ned
from metrics.numeric_accuracy import compute_numeric_accuracy
from metrics.composite import compute_composite_score


def main():
    parser = argparse.ArgumentParser(description="Metric computation worker")
    parser.add_argument("--benchmark-run-id", required=True)
    parser.add_argument("--db-url",           required=True)
    args = parser.parse_args()

    conn = psycopg2.connect(args.db_url)

    try:
        # 1. Fetch the BenchmarkRun and its ExtractionResults
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT br."documentId", er.id, er.engine, er."rawText",
                       er."processingTimeMs", er."costUsd"
                FROM "BenchmarkRun" br
                JOIN "ExtractionResult" er ON er."documentId" = br."documentId"
                WHERE br.id = %s
                  AND er.status = 'COMPLETED'
                  AND er."rawText" IS NOT NULL
                  AND NULLIF(BTRIM(er."rawText"), '') IS NOT NULL
                """,
                (args.benchmark_run_id,),
            )
            results = cur.fetchall()

        if not results:
            print("[metric_worker] No completed ExtractionResults found for this run.", flush=True)
            sys.exit(0)

        document_id = results[0][0]

        # 2. Fetch ground truth
        with conn.cursor() as cur:
            cur.execute(
                'SELECT "rawText", "numericEntities" FROM "GroundTruth" WHERE "documentId" = %s',
                (document_id,),
            )
            gt_row = cur.fetchone()

        if not gt_row:
            print(f"[metric_worker] No ground truth for document {document_id}. Aborting.", flush=True)
            sys.exit(1)

        gt_text = gt_row[0]
        numeric_entities_json = gt_row[1]  # Already parsed by psycopg2 if stored as jsonb

        # Infer doc_type from numeric entity density for composite score weighting
        # (Simple heuristic: if GT has > 10 salary/date entities → numeric_dense)
        numeric_count = 0
        if isinstance(numeric_entities_json, dict):
            numeric_count = sum(
                len(v) for k, v in numeric_entities_json.items()
                if k in ("salaries", "dates", "year_ranges", "percentages")
            )
        doc_type = "numeric_dense" if numeric_count > 10 else "native"

        # 3. Compute metrics for each extraction result
        for (doc_id, result_id, engine, hyp_text, latency_ms, cost_usd) in results:
            print(f"[metric_worker] Computing metrics for engine={engine} result={result_id}", flush=True)

            hyp = hyp_text or ""
            ref = gt_text or ""

            # Text fidelity
            cer_val = compute_cer(hyp, ref)
            wer_val = compute_wer(hyp, ref)
            char_metrics = compute_char_f1(hyp, ref)

            # Reading order
            ro_score = reading_order_ned(hyp, ref)

            # Numeric accuracy
            numeric_scores = compute_numeric_accuracy(hyp, ref)

            # Noise rate: chars in hyp not in ref / total hyp chars
            ref_chars = Counter(ref.lower())
            hyp_chars = Counter(hyp.lower())
            tp_chars = sum(min(hyp_chars[c], ref_chars[c]) for c in ref_chars)
            total_hyp_chars = sum(hyp_chars.values())
            noise_rate = max(0.0, (total_hyp_chars - tp_chars) / max(total_hyp_chars, 1))

            # Duplication rate
            lines = [ln.strip() for ln in hyp.split('\n') if len(ln.strip()) > 10]
            unique_lines = len(set(lines))
            dup_rate = 1.0 - (unique_lines / max(len(lines), 1))

            # OCR accuracy = 1 - CER (only meaningful for scanned docs but store always)
            ocr_accuracy = max(0.0, 1.0 - cer_val)

            # Composite
            metric_inputs = {
                "char_f1":          char_metrics["f1"],
                "reading_order":    ro_score,
                "numeric_accuracy": numeric_scores.get("aggregate"),
                "ocr_accuracy":     ocr_accuracy,
                "cost_efficiency":  None,  # Computed at run level, not here
            }
            composite = compute_composite_score(metric_inputs, doc_type=doc_type)

            # 4. Write BenchmarkMetric row
            metric_id = str(uuid.uuid4())
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO "BenchmarkMetric" (
                        id, "benchmarkRunId", "extractionResultId", engine,
                        cer, wer, "charPrecision", "charRecall", "charF1",
                        "readingOrderScore",
                        "numericAccuracyAggregate", "phoneAccuracy", "dateAccuracy",
                        "emailAccuracy", "urlAccuracy", "percentageAccuracy",
                        "salaryAccuracy", "versionAccuracy",
                        "noiseRate", "duplicationRate",
                        "latencyMs", "costUsd",
                        "compositeScore", "createdAt"
                    ) VALUES (
                        %s, %s, %s, %s,
                        %s, %s, %s, %s, %s,
                        %s,
                        %s, %s, %s,
                        %s, %s, %s,
                        %s, %s,
                        %s, %s,
                        %s, %s,
                        %s, NOW()
                    )
                    ON CONFLICT DO NOTHING
                    """,
                    (
                        metric_id,
                        args.benchmark_run_id,
                        result_id,
                        engine,
                        cer_val,
                        wer_val,
                        char_metrics["precision"],
                        char_metrics["recall"],
                        char_metrics["f1"],
                        ro_score,
                        numeric_scores.get("aggregate"),
                        numeric_scores.get("phone"),
                        numeric_scores.get("date_text") or numeric_scores.get("date_iso"),
                        numeric_scores.get("email"),
                        numeric_scores.get("url"),
                        numeric_scores.get("percentage"),
                        numeric_scores.get("salary_inr") or numeric_scores.get("salary_usd"),
                        numeric_scores.get("version"),
                        round(noise_rate, 6),
                        round(dup_rate, 6),
                        latency_ms,
                        cost_usd,
                        composite,
                    ),
                )
            conn.commit()
            print(
                f"[metric_worker] [OK] engine={engine} CER={cer_val:.4f} "
                f"WER={wer_val:.4f} RO={ro_score:.4f} composite={composite:.4f}",
                flush=True,
            )

        print("[metric_worker] All metrics computed successfully.", flush=True)
        sys.exit(0)

    except Exception as exc:
        print(f"[metric_worker] FATAL: {exc}", flush=True)
        traceback.print_exc()
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
