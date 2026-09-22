---
title: PDF Bench Worker
emoji: 📄
colorFrom: blue
colorTo: indigo
sdk: docker
pinned: false
license: mit
short_description: Python backend for PDF text extraction benchmarking
---

# PDF Bench Worker

FastAPI backend for the [PDF Benchmarking System](https://pdfbenchmarksystem.netlify.app/).

This Space runs all Python-heavy tasks:
- PDF pre-flight classification (page count, layout type, text layer detection)
- Ground truth extraction pipeline
- Multi-engine text extraction (PyMuPDF, PDFMiner, OCRmyPDF, Mistral OCR, Google DAI)
- Benchmark metric computation (CER, WER, CharF1, reading order, numeric accuracy)

It is called exclusively by the Next.js frontend via authenticated HTTP requests.
