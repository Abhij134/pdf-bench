'use client'

/**
 * app/page.tsx
 * Main dashboard for the PDF Text Extraction Benchmarking System.
 *
 * Sections:
 *   1. Documents table — list all registered PDFs with GT status.
 *   2. Upload form — register a new PDF, optionally trigger GT pipeline.
 *   3. Benchmark runner — select a document, pick engines, run benchmark.
 *   4. Results table — side-by-side metrics for all engines, colour-coded.
 */

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface DocumentRow {
  id: string
  filename: string
  fileSizeBytes: number
  pdfType: string | null
  layoutType: string | null
  edgeCaseTags: string[]
  stratumId: string | null
  createdAt: string
  groundTruth: {
    id: string
    derivationMethod: string
    vlmSimilarityScore: number | null
    createdAt: string
  } | null
}

interface MetricRow {
  id: string
  engine: string
  cer: number | null
  wer: number | null
  charPrecision: number | null
  charRecall: number | null
  charF1: number | null
  readingOrderScore: number | null
  numericAccuracyAggregate: number | null
  noiseRate: number | null
  duplicationRate: number | null
  latencyMs: number | null
  costUsd: number | null
  compositeScore: number | null
  extractionResult: {
    engine: string
    status: string
    processingTimeMs: number | null
    wasFallback: boolean
    extractionConfidence: number | null
  }
}

interface BenchmarkRunResult {
  id: string
  createdAt: string
  document: { filename: string; pdfType: string | null; layoutType: string | null }
  metrics: MetricRow[]
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const ALL_ENGINES = [
  'PYMUPDF',
  'PDFMINER',
  'MARKER',
  'OCRMYPDF_TESSERACT',
  'MISTRAL_OCR',
  'GOOGLE_DOCUMENT_AI',
]

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmt(val: number | null, decimals = 4): string {
  if (val === null || val === undefined) return '—'
  return val.toFixed(decimals)
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`status status-${status.toLowerCase()}`}>
      {status}
    </span>
  )
}

// Find the best (max) and worst (min) values across a column of metrics
function computeExtremes(metrics: MetricRow[], key: keyof MetricRow): { best: number | null; worst: number | null } {
  const vals = metrics.map(m => m[key] as number | null).filter((v): v is number => v !== null)
  if (vals.length === 0) return { best: null, worst: null }
  return { best: Math.max(...vals), worst: Math.min(...vals) }
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────

export default function HomePage() {
  const [documents, setDocuments] = useState<DocumentRow[]>([])
  const [loadingDocs, setLoadingDocs] = useState(true)

  // Upload form state
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [stratumId, setStratumId] = useState('')
  const [edgeCaseTags, setEdgeCaseTags] = useState('')
  const [sourceSystem, setSourceSystem] = useState('')
  const [triggerGT, setTriggerGT] = useState(true)
  const [uploadStatus, setUploadStatus] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

  // Benchmark state
  const [selectedDocId, setSelectedDocId] = useState<string>('')
  const [selectedEngines, setSelectedEngines] = useState<Set<string>>(new Set(['PYMUPDF', 'PDFMINER']))
  const [running, setRunning] = useState(false)
  const [runStatus, setRunStatus] = useState<string | null>(null)
  const [runResult, setRunResult] = useState<BenchmarkRunResult | null>(null)

  // OCR quick-action state
  const [ocrDocId, setOcrDocId] = useState<string | null>(null)      // which doc is being OCR'd
  const [ocrStatus, setOcrStatus] = useState<string | null>(null)    // status message
  const [ocrText, setOcrText] = useState<string | null>(null)        // extracted text to display
  const [ocrFilename, setOcrFilename] = useState<string>('')

  // Load documents on mount
  const loadDocuments = useCallback(async () => {
    try {
      setLoadingDocs(true)
      const res = await fetch('/api/documents')
      if (res.ok) {
        const data = await res.json()
        setDocuments(data)
      }
    } catch (err) {
      console.error('Failed to load documents', err)
    } finally {
      setLoadingDocs(false)
    }
  }, [])

  useEffect(() => { loadDocuments() }, [loadDocuments])

  // ── Upload handler ──────────────────────────────────────────────────────────

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault()
    if (!uploadFile) return
    setUploading(true)
    setUploadStatus(null)
    try {
      const fd = new FormData()
      fd.append('file', uploadFile)
      fd.append('stratumId', stratumId)
      fd.append('edgeCaseTags', edgeCaseTags)
      fd.append('sourceSystem', sourceSystem)

      const res = await fetch('/api/documents', { method: 'POST', body: fd })
      const data = await res.json()

      if (!res.ok) {
        setUploadStatus(`error:${data.error ?? 'Upload failed'}`)
        return
      }

      const docId = data.id
      let msg = data.duplicate
        ? `✓ Duplicate detected — existing document ID: ${docId}`
        : `✓ Registered: ${data.filename} (id: ${docId})`

      // Optionally trigger GT pipeline
      if (triggerGT && !data.duplicate) {
        const gtRes = await fetch('/api/ground-truth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        })
        if (gtRes.ok) {
          msg += ' — GT pipeline triggered (running in background)'
        } else {
          msg += ' — ⚠ GT trigger failed'
        }
      }

      setUploadStatus(`success:${msg}`)
      setUploadFile(null)
      ;(document.getElementById('file-input') as HTMLInputElement).value = ''
      await loadDocuments()
    } catch (err) {
      setUploadStatus('error:Network error during upload')
    } finally {
      setUploading(false)
    }
  }

  // ── Benchmark handler ───────────────────────────────────────────────────────

  async function handleRunBenchmark() {
    if (!selectedDocId || selectedEngines.size === 0) return
    setRunning(true)
    setRunStatus(null)
    setRunResult(null)

    try {
      const res = await fetch('/api/benchmark/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId: selectedDocId,
          engines: Array.from(selectedEngines),
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        setRunStatus(`error:${JSON.stringify(data.error)}`)
        return
      }

      const runId = data.benchmarkRunId
      setRunStatus(`info:Run triggered (id: ${runId}). Polling for results...`)

      // Poll for metric results (max 30 attempts × 5s = 2.5 min)
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise(r => setTimeout(r, 5000))
        const resultRes = await fetch(`/api/benchmark/${runId}`)
        if (resultRes.ok) {
          const result: BenchmarkRunResult = await resultRes.json()
          if (result.metrics && result.metrics.length > 0) {
            setRunResult(result)
            setRunStatus(`success:✓ Benchmark complete — ${result.metrics.length} engine(s) scored`)
            return
          }
        }
      }
      setRunStatus('info:Metrics still computing — check again in a moment')
    } catch (err) {
      setRunStatus('error:Network error during benchmark')
    } finally {
      setRunning(false)
    }
  }

  // ── Trigger GT for existing doc ─────────────────────────────────────────────

  async function handleTriggerGT(docId: string) {
    const res = await fetch('/api/ground-truth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: docId }),
    })
    if (res.ok) {
      alert('✓ GT pipeline triggered for document ' + docId)
      await loadDocuments()
    } else {
      alert('⚠ GT trigger failed')
    }
  }

  // ── Delete existing doc ─────────────────────────────────────────────────────

  async function handleDeleteDocument(docId: string, filename: string) {
    if (!confirm(`Are you sure you want to delete "${filename}"? This will permanently delete the document, storage files, and all associated benchmark results.`)) {
      return
    }

    try {
      const res = await fetch(`/api/documents/${docId}`, { method: 'DELETE' })
      if (res.ok) {
        if (selectedDocId === docId) {
          setSelectedDocId('')
          setRunResult(null)
        }
        if (ocrDocId === docId) {
          setOcrDocId(null)
          setOcrText(null)
          setOcrStatus(null)
        }
        await loadDocuments()
      } else {
        const data = await res.json()
        alert(`⚠ Failed to delete document: ${data.error ?? 'Unknown error'}`)
      }
    } catch (err) {
      alert('⚠ Network error while deleting document')
    }
  }

  // ── Run Mistral OCR on a single document ────────────────────────────────────

  async function handleRunOCR(docId: string, filename: string) {
    setOcrDocId(docId)
    setOcrFilename(filename)
    setOcrText(null)
    setOcrStatus('info:🔍 Sending to Mistral OCR… this may take 30–90 seconds.')

    try {
      const res = await fetch('/api/ocr/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: docId }),
      })

      if (!res.ok) {
        const data = await res.json()
        setOcrStatus(`error:OCR trigger failed: ${data.error ?? 'Unknown error'}`)
        return
      }

      setOcrStatus('info:⏳ OCR is running in the background. Polling for result…')

      // Poll GET /api/documents/:id for the MISTRAL_OCR ExtractionResult (max 90s)
      for (let attempt = 0; attempt < 18; attempt++) {
        await new Promise(r => setTimeout(r, 5000))
        const docRes = await fetch(`/api/documents/${docId}`)
        if (!docRes.ok) continue
        const docData = await docRes.json()
        const ocrResult = docData.extractionResults?.find(
          (r: any) => r.engine === 'MISTRAL_OCR' && r.status === 'COMPLETED'
        )
        if (ocrResult) {
          // Fetch full rawText from a second call (extractionResults only has summary fields)
          setOcrStatus(`success:✓ OCR complete! Confidence: ${ocrResult.extractionConfidence?.toFixed(3) ?? '—'}`)
          // Load full text by re-querying the extraction result
          await loadOCRText(docId)
          await loadDocuments()
          return
        }
        const failedResult = docData.extractionResults?.find(
          (r: any) => r.engine === 'MISTRAL_OCR' && r.status === 'FAILED'
        )
        if (failedResult) {
          setOcrStatus('error:OCR failed. Check server logs for details.')
          return
        }
      }
      setOcrStatus('info:OCR is still running — refresh results in a moment.')
    } catch (err) {
      setOcrStatus('error:Network error while running OCR.')
    }
  }

  // ── Load the OCR text from the last ExtractionResult ────────────────────────

  async function loadOCRText(docId: string) {
    try {
      const res = await fetch(`/api/ocr/${docId}`)
      if (!res.ok) return
      const data = await res.json()
      if (data.status === 'COMPLETED') {
        const text = data.rawMarkdown || data.rawText || '(empty response)'
        setOcrText(text)
      }
    } catch (err) {
      console.error('Failed to load OCR text', err)
    }
  }

  // ── Results column analysis ─────────────────────────────────────────────────

  const compositeExtremes = runResult ? computeExtremes(runResult.metrics, 'compositeScore') : null
  const cerExtremes = runResult ? computeExtremes(runResult.metrics, 'cer') : null
  const werExtremes = runResult ? computeExtremes(runResult.metrics, 'wer') : null
  const roExtremes = runResult ? computeExtremes(runResult.metrics, 'readingOrderScore') : null
  const numExtremes = runResult ? computeExtremes(runResult.metrics, 'numericAccuracyAggregate') : null

  function cellClass(val: number | null, extreme: { best: number | null; worst: number | null } | null, higherIsBetter: boolean) {
    if (!extreme || val === null) return 'metric-val'
    if (higherIsBetter) {
      if (val === extreme.best) return 'metric-val cell-best'
      if (val === extreme.worst) return 'metric-val cell-worst'
    } else {
      if (val === extreme.worst) return 'metric-val cell-best'
      if (val === extreme.best) return 'metric-val cell-worst'
    }
    return 'metric-val'
  }

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── HEADER ── */}
      <header>
        <div className="container inner" style={{ justifyContent: 'space-between' }}>
          <div>
            <h1>PDF-Bench</h1>
            <div className="subtitle">PDF Text Extraction Benchmarking System</div>
          </div>
          <Link href="/review" id="review-queue-link" className="btn btn-secondary btn-sm">
            ✎ GT Review Queue
          </Link>
        </div>
      </header>

      <main className="container">

        {/* ── 1. DOCUMENTS TABLE ── */}
        <section className="card">
          <div className="card-title">
            📄 Registered Documents
            <span className="badge">{documents.length}</span>
            <button id="refresh-docs" className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }} onClick={loadDocuments}>
              ↻ Refresh
            </button>
          </div>
          {loadingDocs ? (
            <div className="empty">Loading…</div>
          ) : documents.length === 0 ? (
            <div className="empty">No documents yet. Upload a PDF below.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Filename</th>
                    <th>Size</th>
                    <th>PDF Type</th>
                    <th>Layout</th>
                    <th>Stratum</th>
                    <th>Edge Tags</th>
                    <th>GT Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {documents.map(doc => (
                    <tr key={doc.id}>
                      <td title={doc.id}>
                        <span style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>
                          {doc.filename}
                        </span>
                      </td>
                      <td>{fmtBytes(doc.fileSizeBytes)}</td>
                      <td>{doc.pdfType ?? '—'}</td>
                      <td>{doc.layoutType ?? '—'}</td>
                      <td>{doc.stratumId ?? '—'}</td>
                      <td>
                        {doc.edgeCaseTags.length > 0
                          ? doc.edgeCaseTags.map(t => (
                              <span key={t} className="status status-processing" style={{ marginRight: 3 }}>{t}</span>
                            ))
                          : '—'}
                      </td>
                      <td>
                        {doc.groundTruth ? (
                          <span className="status status-completed">
                            ✓ {doc.groundTruth.derivationMethod.replace('vlm_', '').replace('_', ' ')}
                          </span>
                        ) : (
                          <span className="status status-pending">Pending</span>
                        )}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            id={`select-doc-${doc.id}`}
                            className="btn btn-secondary btn-sm"
                            onClick={() => setSelectedDocId(doc.id)}
                          >
                            Select
                          </button>
                          {!doc.groundTruth && (
                            <button
                              id={`trigger-gt-${doc.id}`}
                              className="btn btn-primary btn-sm"
                              onClick={() => handleTriggerGT(doc.id)}
                            >
                              Build GT
                            </button>
                          )}
                          <button
                            id={`ocr-doc-${doc.id}`}
                            className="btn btn-ocr btn-sm"
                            disabled={ocrDocId === doc.id && ocrStatus?.startsWith('info')}
                            onClick={() => handleRunOCR(doc.id, doc.filename)}
                          >
                            {ocrDocId === doc.id && ocrStatus?.startsWith('info') ? '⏳ OCR…' : '🔍 OCR'}
                          </button>
                          <button
                            id={`delete-doc-${doc.id}`}
                            className="btn btn-danger btn-sm"
                            onClick={() => handleDeleteDocument(doc.id, doc.filename)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>


        {/* ── 2. UPLOAD FORM ── */}
        <section className="card">
          <div className="card-title">⬆ Upload PDF</div>
          <form id="upload-form" onSubmit={handleUpload}>
            <div className="form-grid">
              <div>
                <label htmlFor="file-input">PDF File *</label>
                <input
                  id="file-input"
                  type="file"
                  accept="application/pdf"
                  required
                  onChange={e => setUploadFile(e.target.files?.[0] ?? null)}
                />
              </div>
              <div>
                <label htmlFor="stratum-input">Stratum ID</label>
                <input
                  id="stratum-input"
                  type="text"
                  placeholder="e.g. NATIVE-TWO-COL"
                  value={stratumId}
                  onChange={e => setStratumId(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="tags-input">Edge Case Tags (comma-separated)</label>
                <input
                  id="tags-input"
                  type="text"
                  placeholder="e.g. two_column,sidebar"
                  value={edgeCaseTags}
                  onChange={e => setEdgeCaseTags(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="source-input">Source System</label>
                <input
                  id="source-input"
                  type="text"
                  placeholder="e.g. canva, linkedin, latex"
                  value={sourceSystem}
                  onChange={e => setSourceSystem(e.target.value)}
                />
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 0 }}>
                <input
                  type="checkbox"
                  checked={triggerGT}
                  onChange={e => setTriggerGT(e.target.checked)}
                  style={{ accentColor: 'var(--accent)' }}
                />
                Automatically trigger GT pipeline after upload
              </label>
              <button id="upload-btn" type="submit" className="btn btn-primary" disabled={uploading || !uploadFile}>
                {uploading ? 'Uploading…' : '⬆ Upload PDF'}
              </button>
            </div>

            {uploadStatus && (
              <div className={`alert ${uploadStatus.startsWith('error') ? 'alert-error' : 'alert-success'}`}>
                {uploadStatus.replace(/^(error|success):/, '')}
              </div>
            )}
          </form>
        </section>

        {/* ── 3. BENCHMARK RUNNER ── */}
        <section className="card">
          <div className="card-title">🚀 Run Benchmark</div>

          <div style={{ marginBottom: 12 }}>
            <label htmlFor="doc-select">Document</label>
            <select
              id="doc-select"
              value={selectedDocId}
              onChange={e => setSelectedDocId(e.target.value)}
            >
              <option value="">— Select a document —</option>
              {documents.map(doc => (
                <option key={doc.id} value={doc.id}>
                  {doc.filename} {doc.groundTruth ? '✓' : '(no GT)'}
                </option>
              ))}
            </select>
          </div>

          <label style={{ marginBottom: 8, display: 'block' }}>Engines</label>
          <div className="engine-grid">
            {ALL_ENGINES.map(eng => (
              <label key={eng} className="engine-check">
                <input
                  type="checkbox"
                  checked={selectedEngines.has(eng)}
                  onChange={e => {
                    const next = new Set(selectedEngines)
                    e.target.checked ? next.add(eng) : next.delete(eng)
                    setSelectedEngines(next)
                  }}
                />
                {eng.replace(/_/g, ' ')}
              </label>
            ))}
          </div>

          <button
            id="run-benchmark-btn"
            className="btn btn-primary"
            onClick={handleRunBenchmark}
            disabled={running || !selectedDocId || selectedEngines.size === 0}
          >
            {running ? '⏳ Running…' : '▶ Run Benchmark'}
          </button>

          {runStatus && (
            <div className={`alert ${runStatus.startsWith('error') ? 'alert-error' : runStatus.startsWith('success') ? 'alert-success' : 'alert-info'}`}>
              {runStatus.replace(/^(error|success|info):/, '')}
            </div>
          )}
        </section>

        {/* ── 4. RESULTS TABLE ── */}
        {runResult && (
          <section className="card">
            <div className="card-title">
              📊 Benchmark Results
              <span className="badge">{runResult.document.filename}</span>
            </div>
            {runResult.metrics.length === 0 ? (
              <div className="empty">No metrics yet — metrics are computing in the background.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Engine</th>
                      <th>Status</th>
                      <th>Fallback?</th>
                      <th title="Character Error Rate — lower is better">CER ↓</th>
                      <th title="Word Error Rate — lower is better">WER ↓</th>
                      <th title="Character F1 — higher is better">Char F1 ↑</th>
                      <th title="Reading Order NED — higher is better">Read Order ↑</th>
                      <th title="Numeric Accuracy Aggregate — higher is better">Numeric ↑</th>
                      <th title="Noise rate — lower is better">Noise ↓</th>
                      <th>Latency (ms)</th>
                      <th>Cost ($)</th>
                      <th title="Weighted composite — higher is better">Composite ↑</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runResult.metrics.map(m => (
                      <tr key={m.id}>
                        <td>
                          <strong>{m.engine.replace(/_/g, ' ')}</strong>
                        </td>
                        <td>
                          <StatusBadge status={m.extractionResult.status} />
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          {m.extractionResult.wasFallback ? '⚠ yes' : '—'}
                        </td>
                        <td className={cellClass(m.cer, cerExtremes, false)}>
                          {fmt(m.cer)}
                        </td>
                        <td className={cellClass(m.wer, werExtremes, false)}>
                          {fmt(m.wer)}
                        </td>
                        <td className={cellClass(m.charF1, null, true)}>
                          {fmt(m.charF1)}
                        </td>
                        <td className={cellClass(m.readingOrderScore, roExtremes, true)}>
                          {fmt(m.readingOrderScore)}
                        </td>
                        <td className={cellClass(m.numericAccuracyAggregate, numExtremes, true)}>
                          {fmt(m.numericAccuracyAggregate)}
                        </td>
                        <td className="metric-val">
                          {fmt(m.noiseRate)}
                        </td>
                        <td className="metric-val">
                          {m.latencyMs !== null ? m.latencyMs.toLocaleString() : '—'}
                        </td>
                        <td className="metric-val">
                          {m.costUsd !== null ? `$${m.costUsd.toFixed(4)}` : '—'}
                        </td>
                        <td className={cellClass(m.compositeScore, compositeExtremes, true)}>
                          {fmt(m.compositeScore)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ marginTop: 10, fontSize: '0.72rem', color: 'var(--muted)' }}>
                  <strong style={{ color: 'var(--green)' }}>Green</strong> = best per column &nbsp;|&nbsp;
                  <strong style={{ color: 'var(--amber)' }}>Amber</strong> = worst per column &nbsp;|&nbsp;
                  Sorted by composite score (highest first)
                </div>
              </div>
            )}
          </section>
        )}

        {/* ── 5. OCR STATUS / RESULT VIEWER ── */}
        {ocrDocId && ocrStatus && (
          <section className="card">
            <div className="card-title">
              🔍 Mistral OCR
              <span className="badge">{ocrFilename}</span>
              <button
                className="btn btn-secondary btn-sm"
                style={{ marginLeft: 'auto' }}
                onClick={() => { setOcrDocId(null); setOcrStatus(null); setOcrText(null) }}
              >
                ✕ Close
              </button>
            </div>

            {/* Status message */}
            {ocrStatus && (
              <div className={`alert ${ocrStatus.startsWith('error') ? 'alert-error' : ocrStatus.startsWith('success') ? 'alert-success' : 'alert-info'}`}>
                {ocrStatus.replace(/^(error|success|info):/, '')}
              </div>
            )}

            {/* OCR output text viewer */}
            {ocrText && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: 8 }}>
                  Extracted text (Markdown format) — {ocrText.length.toLocaleString()} chars
                </div>
                <textarea
                  readOnly
                  value={ocrText}
                  rows={20}
                  style={{
                    width: '100%',
                    background: 'var(--surface2)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)',
                    color: 'var(--text)',
                    fontSize: '0.78rem',
                    fontFamily: 'monospace',
                    padding: '12px',
                    resize: 'vertical',
                    outline: 'none',
                    lineHeight: 1.6,
                  }}
                />
              </div>
            )}

            {/* How-to hint */}
            <div style={{ marginTop: 12, fontSize: '0.72rem', color: 'var(--muted)' }}>
              The full extracted text is stored in the <code>ExtractionResult</code> database row (engine=MISTRAL_OCR).
              To include this in a full benchmark comparison, select the document above and include MISTRAL_OCR in the engine list.
            </div>
          </section>
        )}

      </main>
    </>
  )
}
