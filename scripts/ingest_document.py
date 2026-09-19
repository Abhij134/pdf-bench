"""
scripts/ingest_document.py
CLI tool to register a PDF into the benchmarking system via the API.

Usage:
  python3 scripts/ingest_document.py \\
    --pdf /path/to/resume.pdf \\
    --stratum-id NATIVE-TWO-COL \\
    --edge-case-tags two_column,sidebar \\
    --source-system canva \\
    --api-url http://localhost:3000

Optionally triggers the ground truth pipeline immediately with --trigger-gt.
"""
import argparse
import sys
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
import requests


def main():
    parser = argparse.ArgumentParser(description="Ingest a PDF into the benchmark system")
    parser.add_argument("--pdf",            required=True,  help="Path to PDF file")
    parser.add_argument("--stratum-id",     required=True,  help="Sourcing matrix stratum ID")
    parser.add_argument("--edge-case-tags", default="",     help="Comma-separated edge case tags")
    parser.add_argument("--source-system",  default="",     help="Origin system (canva, linkedin, etc.)")
    parser.add_argument("--api-url",        default="http://localhost:3000")
    parser.add_argument("--trigger-gt",     action="store_true", help="Immediately trigger GT pipeline")
    args = parser.parse_args()

    # Upload PDF
    with open(args.pdf, "rb") as f:
        resp = requests.post(
            f"{args.api_url}/api/documents",
            files={"file": (args.pdf.split("/")[-1], f, "application/pdf")},
            data={
                "stratumId":    args.stratum_id,
                "edgeCaseTags": args.edge_case_tags,
                "sourceSystem": args.source_system,
            },
        )

    if resp.status_code not in (200, 201):
        print(f"[ingest] Error: {resp.status_code} {resp.text}", file=sys.stderr)
        sys.exit(1)

    data = resp.json()
    doc_id = data["id"]
    print(f"[ingest] [OK] Document registered. id={doc_id} duplicate={data.get('duplicate', False)}")

    # Optionally trigger ground truth pipeline
    if args.trigger_gt:
        gt_resp = requests.post(
            f"{args.api_url}/api/ground-truth",
            json={"documentId": doc_id},
        )
        if gt_resp.status_code == 202:
            print("[ingest] [OK] Ground truth pipeline triggered (running asynchronously).")
        else:
            print(f"[ingest] [WARN] GT pipeline trigger failed: {gt_resp.status_code} {gt_resp.text}")


if __name__ == "__main__":
    main()
