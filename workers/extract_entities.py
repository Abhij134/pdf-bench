import sys
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
import json
import re

import psycopg2

sys.path.insert(0, ".")
from metrics.numeric_accuracy import PATTERNS, _normalise_match, compute_numeric_accuracy
from metrics.text_fidelity import compute_cer
from metrics.reading_order import reading_order_ned

def main():
    try:
        input_data = json.load(sys.stdin)
        hyp = input_data.get("hypothesis", "")
        ref = input_data.get("reference", "")
        
        entities = {}
        for etype, pattern in PATTERNS.items():
            ref_raw = re.findall(pattern, ref, re.IGNORECASE)
            if not ref_raw:
                continue
                
            ref_set = {_normalise_match(m) for m in ref_raw}
            hyp_set = {_normalise_match(m) for m in re.findall(pattern, hyp, re.IGNORECASE)}
            
            found = sorted(ref_set & hyp_set)
            missing = sorted(ref_set - hyp_set)
            
            entities[etype] = {
                "found": found,
                "missing": missing
            }

        cer_score = compute_cer(hyp, ref) if ref and hyp else None
        ro_score = reading_order_ned(hyp, ref) if ref and hyp else None
        num_scores = compute_numeric_accuracy(hyp, ref) if ref and hyp else {}
        num_agg = num_scores.get("aggregate", None)
            
        print(json.dumps({
            "missingEntities": entities,
            "metrics": {
                "cer": cer_score,
                "readingOrderScore": ro_score,
                "numericAccuracyAggregate": num_agg
            }
        }))
        sys.exit(0)
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
