"""
scripts/run_benchmark.py
CLI tool to trigger a benchmark run and poll for results.

Usage:
  python3 scripts/run_benchmark.py \\
    --document-id clxxx \\
    --engines PYMUPDF,PDFMINER,MARKER \\
    --api-url http://localhost:3000
"""
import argparse
import sys
import time
import requests


def main():
    parser = argparse.ArgumentParser(description="Run a benchmark for a document")
    parser.add_argument("--document-id", required=True)
    parser.add_argument("--engines",     required=True,
                        help="Comma-separated engine names, e.g. PYMUPDF,PDFMINER,MARKER")
    parser.add_argument("--api-url",     default="http://localhost:3000")
    args = parser.parse_args()

    engines = [e.strip().upper() for e in args.engines.split(",")]

    print(f"[benchmark] Triggering run for document {args.document_id} with engines: {engines}")
    resp = requests.post(
        f"{args.api_url}/api/benchmark/run",
        json={"documentId": args.document_id, "engines": engines},
    )

    if resp.status_code != 200:
        print(f"[benchmark] Error: {resp.status_code} {resp.text}", file=sys.stderr)
        sys.exit(1)

    data = resp.json()
    run_id = data["benchmarkRunId"]
    print(f"[benchmark] ✓ Run triggered. id={run_id} status={data['status']}")
    if data.get("failedEngines"):
        print(f"[benchmark] ⚠ Failed engines: {data['failedEngines']}")

    # Poll for metric completion (simple polling; replace with websocket in production)
    print("[benchmark] Waiting for metrics to compute (polling every 5s)...")
    for attempt in range(24):  # Max 2 minutes
        time.sleep(5)
        result_resp = requests.get(f"{args.api_url}/api/benchmark/{run_id}")
        if result_resp.status_code == 200:
            run_data = result_resp.json()
            if run_data.get("metrics") and len(run_data["metrics"]) > 0:
                print("\n[benchmark] Results:")
                print(f"{'Engine':<35} {'CER':>6} {'WER':>6} {'CharF1':>8} {'ReadOrd':>8} {'Composite':>10}")
                print("-" * 80)
                for m in run_data["metrics"]:
                    engine = m.get("engine", "?")
                    print(
                        f"{engine:<35} "
                        f"{(m.get('cer') or 0):.4f} "
                        f"{(m.get('wer') or 0):.4f} "
                        f"{(m.get('charF1') or 0):.6f} "
                        f"{(m.get('readingOrderScore') or 0):.6f} "
                        f"{(m.get('compositeScore') or 0):.6f}"
                    )
                sys.exit(0)
    print("[benchmark] ⚠ Timed out waiting for metrics. Check the database directly.")
    sys.exit(1)


if __name__ == "__main__":
    main()
