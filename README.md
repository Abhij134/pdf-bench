# PDF-Bench

**Production-grade PDF text extraction benchmarking system.**

Compares extraction engines (PyMuPDF, pdfminer.six, OCRmyPDF/Tesseract, Marker, Mistral OCR, Google Document AI) across a stratified corpus of 45 resume PDFs using quantitative metrics: CER, WER, CharF1, Reading-Order Accuracy, Numeric Accuracy, and Composite Score.

---

## Architecture

```
pdf-bench/
├── app/               Next.js 14 App Router (dashboard + REST API)
├── prisma/            PostgreSQL schema (5 models)
├── lib/               Prisma client, storage, BullMQ queue
├── workers/           Python extraction engines + metric workers
│   ├── engines/       PyMuPDF, pdfminer, OCRmyPDF, Mistral, Google DAI, Marker
│   ├── metrics/       text_fidelity, reading_order, numeric_accuracy, composite
│   ├── engine_runner.py
│   ├── gt_pipeline.py
│   └── metric_worker.py
└── scripts/           CLI: ingest_document.py, run_benchmark.py
```

---

## Quick Start

### Prerequisites
- Node.js 18+
- Python 3.11+
- PostgreSQL 15+
- Redis (for BullMQ, optional in dev)

### 1. Install Node dependencies
```bash
cd pdf-bench
npm install
```

### 2. Install Python dependencies
```bash
pip install -r requirements.txt
# GPU only (optional — enables Marker engine):
# pip install -r requirements-gpu.txt
```

### 3. Configure environment
```bash
cp .env.example .env
# Edit .env — fill in DATABASE_URL, ANTHROPIC_API_KEY, etc.
```

### 4. Run database migrations
```bash
npx prisma migrate dev --name init
npx prisma generate
```

### 5. Start the dev server
```bash
npm run dev
# → http://localhost:3000
```

### 6. Ingest a test PDF
```bash
python3 scripts/ingest_document.py \
  --pdf /path/to/resume.pdf \
  --stratum-id NATIVE-TWO-COL \
  --edge-case-tags two_column \
  --source-system linkedin \
  --trigger-gt
```

### 7. Run a benchmark
```bash
python3 scripts/run_benchmark.py \
  --document-id <id-from-step-6> \
  --engines PYMUPDF,PDFMINER
```

---

## Extraction Pipeline

```
Stage 1: PyMuPDF (native, column-aware)
Stage 2: Confidence validation (5 heuristics)
  → word count, garble ratio, whitespace ratio, duplicate blocks, numeric anomaly
Stage 3 (if confidence < 0.80):
  empty/scanned    → Marker (GPU) or OCRmyPDF (CPU)
  duplicate layers → Mistral OCR
  garbled text     → pdfminer → Google Document AI
```

## Metrics

| Metric | Description |
|---|---|
| CER | Character Error Rate (jiwer 3.0.3) |
| WER | Word Error Rate |
| Char F1 | Token-level precision/recall/F1 (Counter intersection) |
| Reading Order | Normalised Edit Distance on block index sequence |
| Numeric Accuracy | Regex entity matching (phones, dates, salaries, emails, etc.) |
| Composite Score | Weighted aggregate with doc-type overrides |

## Cost Reference (per 1K pages, approximate)

| Engine | Cost |
|---|---|
| PyMuPDF | ~$0.001 |
| OCRmyPDF | ~$0.06 |
| Marker (GPU) | ~$0.40 |
| Mistral OCR | ~$1.00 |
| Google Document AI | ~$1.50 |

Blended cost with smart routing ≈ **$0.12 / 1K pages**.

---

## Validation Checklist

- [ ] `npx prisma migrate dev` succeeds — 5 tables created
- [ ] `POST /api/documents` returns `{id, sha256Hash, filename}`
- [ ] Duplicate upload returns `{duplicate: true}`
- [ ] `POST /api/ground-truth` returns 202
- [ ] PyMuPDF engine produces left-column-first text on two-column PDF
- [ ] `compute_cer("hello world", "hello world")` returns `0.0`
- [ ] `reading_order_ned` returns `1.0` for identical texts
- [ ] Dashboard loads, upload works, results table renders with colour coding
