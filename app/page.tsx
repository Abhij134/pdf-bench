'use client'

/**
 * app/page.tsx
 * Main dashboard for the PDF Text Extraction Benchmarking System.
 *
 * Sections:
 *   1. Registered Documents — list all registered PDFs with GT status.
 *   2. Upload PDF — register a new PDF, optionally trigger GT pipeline.
 *   3. Extract Text — run or view extraction for any document + engine.
 *   4. Benchmark Runner — select a document, pick engines, run benchmark.
 *   5. Benchmark Results — side-by-side metrics for all engines.
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
    errorMessage?: string | null
    extractionConfidence: number | null
  }
}

interface BenchmarkRunResult {
  id: string
  createdAt: string
  documentId: string
  enginesIncluded: string[]
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

function computeExtremes(metrics: MetricRow[], key: keyof MetricRow): { best: number | null; worst: number | null } {
  const vals = metrics.map(m => m[key] as number | null).filter((v): v is number => v !== null)
  if (vals.length === 0) return { best: null, worst: null }
  return { best: Math.max(...vals), worst: Math.min(...vals) }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button className="btn" style={{ padding: '4px 8px', fontSize: '0.8rem' }} onClick={handleCopy}>
      {copied ? 'Copied!' : 'Copy'}
    </button>
  )
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────

export default function HomePage() {
  // Close details dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest('.doc-select-details')) {
        document.querySelectorAll('details.doc-select-details').forEach(el => {
          el.removeAttribute('open');
        });
      }
    }
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  const [documents, setDocuments] = useState<DocumentRow[]>([])
  const [loadingDocs, setLoadingDocs] = useState(true)
  const [progressData, setProgressData] = useState<Record<string, { status: string; progress: number; error?: string }>>({})

  // Extraction section state
  const [viewerDocId, setViewerDocId] = useState<string>('')
  const [viewerEngine, setViewerEngine] = useState<string>('')
  const [docEngines, setDocEngines] = useState<Record<string, string>>({})
  const [compareDataList, setCompareDataList] = useState<Array<{ docId: string; docName: string; groundTruthText: string; engineText: string; metrics?: any; missingEntities?: any; isMissing?: boolean; engineUsed?: string }>>([])
  const [loadingCompare, setLoadingCompare] = useState(false)
  const [extractProgress, setExtractProgress] = useState(0)

  // Smooth gradual progress simulation for extraction
  useEffect(() => {
    let interval: NodeJS.Timeout
    if (loadingCompare) {
      setExtractProgress(0)
      interval = setInterval(() => {
        setExtractProgress(prev => {
          if (prev < 50) return prev + 2
          if (prev < 80) return prev + 1
          if (prev < 95) return prev + 0.2
          if (prev < 98) return prev + 0.05
          return prev
        })
      }, 1000)
    }
    return () => clearInterval(interval)
  }, [loadingCompare])

  // Upload form state
  const [uploadFiles, setUploadFiles] = useState<File[]>([])
  const [stratumId, setStratumId] = useState('')
  const [edgeCaseTags, setEdgeCaseTags] = useState('')
  const [sourceSystem, setSourceSystem] = useState('')
  const [triggerGT, setTriggerGT] = useState(true)
  const [uploadStatus, setUploadStatus] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

  // Benchmark state
  const [isBulkMode, setIsBulkMode] = useState(false)
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set()) // Shared for Table & Benchmark
  const [extractDocIds, setExtractDocIds] = useState<Set<string>>(new Set()) // Independent state for Extract Text
  const [selectedEngines, setSelectedEngines] = useState<Set<string>>(new Set(['PYMUPDF', 'PDFMINER']))
  const [running, setRunning] = useState(false)
  const [runStatus, setRunStatus] = useState<string | null>(null)
  const [runResults, setRunResults] = useState<BenchmarkRunResult[]>([])
  const [confirmState, setConfirmState] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmText: string;
    cancelText: string;
    onConfirm: () => void;
    onCancel: () => void;
  } | null>(null)

  const asyncConfirm = (title: string, message: string, confirmText = 'Yes', cancelText = 'Cancel'): Promise<boolean> => {
    return new Promise((resolve) => {
      setConfirmState({
        isOpen: true,
        title,
        message,
        confirmText,
        cancelText,
        onConfirm: () => { setConfirmState(null); resolve(true); },
        onCancel: () => { setConfirmState(null); resolve(false); }
      })
    })
  }

  const getSelectedDocNames = (ids: Set<string>) => {
    return Array.from(ids)
      .map(id => documents.find(d => d.id === id)?.filename)
      .filter(Boolean)
      .map(name => `• ${name}`)
      .join('\n')
  }

  // Load documents on mount and poll
  const loadDocuments = useCallback(async (isBackground = false) => {
    try {
      if (!isBackground) setLoadingDocs(true)
      const res = await fetch('/api/documents')
      if (res.ok) {
        const data = await res.json()
        setDocuments(data)

        // Clean up selected IDs that no longer exist
        const validIds = new Set(data.map((d: any) => d.id))

        setSelectedDocIds(prev => {
          const next = new Set(Array.from(prev).filter(id => validIds.has(id)))
          return next.size !== prev.size ? next : prev
        })

        setExtractDocIds(prev => {
          const next = new Set(Array.from(prev).filter(id => validIds.has(id)))
          return next.size !== prev.size ? next : prev
        })

        // Turn off bulk mode if there are no documents left
        setIsBulkMode(prev => data.length === 0 ? false : prev)
      }
    } catch (err) {
      console.error('Failed to load documents', err)
    } finally {
      if (!isBackground) setLoadingDocs(false)
    }
  }, [])

  useEffect(() => {
    loadDocuments()
    const interval = setInterval(() => {
      loadDocuments(true)
    }, 3000)
    return () => clearInterval(interval)
  }, [loadDocuments])

  // Fake gradual progress simulation for background GT
  useEffect(() => {
    const interval = setInterval(() => {
      setProgressData(prev => {
        let changed = false
        const next = { ...prev }
        for (const [id, data] of Object.entries(next)) {
          if (data.status === 'processing' && data.progress < 99) {
            next[id] = { ...data, progress: data.progress + 1 }
            changed = true
          }
        }
        return changed ? next : prev
      })
    }, 400)
    return () => clearInterval(interval)
  }, [])

  // Poll for benchmark metrics that are computing in the background
  useEffect(() => {
    const incompleteRuns = runResults.filter(r => !r.metrics || r.metrics.length === 0)
    if (incompleteRuns.length === 0) return

    const interval = setInterval(async () => {
      for (const run of incompleteRuns) {
        try {
          const res = await fetch(`/api/benchmark/${run.id}`)
          if (res.ok) {
            const result = await res.json()
            if (result.metrics && result.metrics.length > 0) {
              if (result.extractionResults) {
                result.metrics = result.metrics.map((m: any) => ({
                  ...m,
                  extractionResult: result.extractionResults.find((er: any) => er.id === m.extractionResultId)
                }))
              }
              setRunResults(prev => prev.map(r => r.id === result.id ? result : r))

              // Scroll to this specific result when it finishes generating
              setTimeout(() => {
                document.getElementById(`benchmark-results-${result.document.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }, 100)
            }
          }
        } catch (e) {
          console.error("Failed to poll benchmark result", e)
        }
      }
    }, 3000)
    return () => clearInterval(interval)
  }, [runResults])

  // ── Upload handler ──────────────────────────────────────────────────────────

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault()
    if (uploadFiles.length === 0) return
    setUploading(true)
    setUploadStatus(null)

    let successCount = 0
    let dupCount = 0
    let failCount = 0

    try {
      for (let i = 0; i < uploadFiles.length; i++) {
        const file = uploadFiles[i]
        setUploadStatus(`info:Uploading file ${i + 1} of ${uploadFiles.length}...`)

        const fd = new FormData()
        fd.append('file', file)
        fd.append('stratumId', stratumId)
        fd.append('edgeCaseTags', edgeCaseTags)
        fd.append('sourceSystem', sourceSystem)

        try {
          const res = await fetch('/api/documents', { method: 'POST', body: fd })
          const data = await res.json()

          if (!res.ok) {
            failCount++
            console.error(`Upload failed for ${file.name}: ${data.error}`)
            continue
          }

          const docId = data.id
          if (data.duplicate) {
            const replace = await asyncConfirm(
              'Duplicate File',
              `The file "${file.name}" has already been uploaded. Do you want to replace it?`,
              'Replace',
              'Skip'
            )
            if (replace) {
              await fetch(`/api/documents/${data.id}`, { method: 'DELETE' })
              const res2 = await fetch('/api/documents', { method: 'POST', body: fd })
              const data2 = await res2.json()
              if (!res2.ok) {
                failCount++
                console.error(`Upload failed for ${file.name}: ${data2.error}`)
                continue
              }
              successCount++
              if (triggerGT) {
                fetch('/api/ground-truth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId: data2.id }) }).catch(err => console.error(err))
              }
            } else {
              dupCount++
            }
          } else {
            successCount++
            if (triggerGT) {
              fetch('/api/ground-truth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ documentId: docId }),
              }).catch(err => console.error('GT trigger failed:', err))
            }
          }
        } catch (err) {
          failCount++
          console.error(`Network error for ${file.name}`, err)
        }
      }

      setUploadStatus(`success:Uploaded ${successCount}, Duplicates ${dupCount}, Failed ${failCount}`)
      setUploadFiles([])
        ; (document.getElementById('file-input') as HTMLInputElement).value = ''
      await loadDocuments()
    } catch (err) {
      setUploadStatus('error:Unexpected error during bulk upload')
    } finally {
      setUploading(false)
    }
  }

  // ── Extract Text handler (Single Unified Action) ───────────────────────────

  async function handleExtractText() {
    const docsToProcess = Array.from(extractDocIds)

    if (docsToProcess.length === 0) return
    setLoadingCompare(true)
    setCompareDataList([])

    try {
      const results = []
      for (const dId of docsToProcess) {
        const docName = documents.find(d => d.id === dId)?.filename || dId
        const currentEngine = docEngines[dId] || viewerEngine

        if (!currentEngine) {
          results.push({ docId: dId, docName, groundTruthText: '(Error)', engineText: '(No engine selected)', engineUsed: '' })
          continue
        }

        // Step 1: Attempt to load existing extraction compare result
        let res = await fetch(`/api/extraction-compare?documentId=${dId}&engine=${currentEngine}`)

        // Step 2: If not extracted yet (404), trigger extraction automatically
        if (res.status === 404) {
          // Ensure ground truth exists first
          const doc = documents.find(d => d.id === dId)
          if (doc && !doc.groundTruth) {
            results.push({ docId: dId, docName, groundTruthText: '(Error: No Ground Truth)', engineText: '(Generate GT first using Get Text button)', engineUsed: currentEngine })
            continue
          }

          await fetch('/api/extraction/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ documentId: dId, engine: currentEngine }),
          })

          res = await fetch(`/api/extraction-compare?documentId=${dId}&engine=${currentEngine}`)
        }

        if (!res.ok) {
          results.push({ docId: dId, docName, groundTruthText: '(Error)', engineText: '(Failed to load comparison)', engineUsed: currentEngine })
          continue
        }

        const data = await res.json()
        results.push({ docId: dId, docName, engineUsed: currentEngine, ...data })
      }
      setCompareDataList(results)
    } catch (err: any) {
      console.error(err)
      alert(`⚠ ${err.message}`)
    } finally {
      setLoadingCompare(false)
    }
  }

  // ── Benchmark handler ───────────────────────────────────────────────────────

  async function handleRunBenchmark() {
    if (selectedDocIds.size === 0 || selectedEngines.size === 0) return
    setRunning(true)
    setRunStatus(null)
    setRunResults([])

    let successCount = 0
    let failCount = 0

    try {
      for (const docId of Array.from(selectedDocIds)) {
        setRunStatus(`info:Triggering benchmark for doc ${docId}...`)

        try {
          const res = await fetch('/api/benchmark/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ documentId: docId, engines: Array.from(selectedEngines) }),
          })

          const data = await res.json()
          if (!res.ok) {
            failCount++
            console.error(`Benchmark run failed for ${docId}:`, data.error)
            continue
          }

          successCount++

          // Fetch result immediately for the LAST document processed (keeps UI simple)
          const resultRes = await fetch(`/api/benchmark/${data.benchmarkRunId}`)
          if (resultRes.ok) {
            const result: any = await resultRes.json()
            if (result.metrics && result.extractionResults) {
              result.metrics = result.metrics.map((m: any) => ({
                ...m,
                extractionResult: result.extractionResults.find((er: any) => er.id === m.extractionResultId)
              }))
            }
            setRunResults(prev => [...prev, result])
          }
        } catch (err) {
          failCount++
          console.error(`Error benchmarking ${docId}`, err)
        }
      }

      setRunStatus(`success:Started ${successCount} benchmarks (${failCount} failed)`)

      // Scroll to the results container when loading appears
      setTimeout(() => {
        document.getElementById('benchmark-results-container')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 100)
    } catch (err: any) {
      setRunStatus(`error:Failed to trigger benchmarks`)
    } finally {
      setRunning(false)
    }
  }

  async function handleBulkGT() {
    if (selectedDocIds.size === 0) return
    let success = 0
    for (const id of Array.from(selectedDocIds)) {
      try {
        const res = await fetch('/api/ground-truth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: id }),
        })
        if (res.ok) success++
      } catch (err) {
        console.error('Bulk GT error', err)
      }
    }
    alert(`Triggered GT for ${success} documents.`)
    await loadDocuments()
  }

  async function handleBulkDelete() {
    if (selectedDocIds.size === 0) return
    const confirmed = await asyncConfirm(
      'Confirm Deletion',
      `Are you sure you want to delete ${selectedDocIds.size} document(s)? This action cannot be undone and will remove all associated benchmark results.`,
      'Yes, Delete'
    )
    if (!confirmed) return

    let success = 0
    for (const id of Array.from(selectedDocIds)) {
      try {
        const res = await fetch(`/api/documents/${id}`, { method: 'DELETE' })
        if (res.ok) success++
      } catch (err) {
        console.error('Bulk delete error', err)
      }
    }
    setUploadStatus(null)
    setSelectedDocIds(new Set())
    await loadDocuments()
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
    const confirmed = await asyncConfirm(
      'Confirm Deletion',
      `Are you sure you want to delete "${filename}"? This action cannot be undone and will remove all associated benchmark results.`,
      'Yes, Delete'
    )
    if (!confirmed) return

    try {
      const res = await fetch(`/api/documents/${docId}`, { method: 'DELETE' })
      if (res.ok) {
        if (selectedDocIds.has(docId)) {
          const next = new Set(selectedDocIds)
          next.delete(docId)
          setSelectedDocIds(next)
          setRunResults(prev => prev.filter(r => r.documentId !== docId))
        }
        setUploadStatus(null)
        await loadDocuments()
      } else {
        const data = await res.json()
        alert(`⚠ Failed to delete document: ${data.error ?? 'Unknown error'}`)
      }
    } catch (err) {
      alert('⚠ Network error while deleting document')
    }
  }

  // ── Results column analysis ─────────────────────────────────────────────────
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


      <main className="container" style={{ marginTop: '32px', paddingBottom: '100px', flex: 1 }}>

        {/* ── 1. DOCUMENTS TABLE ── */}
        <section className="card">
          <div className="card-title">
            📄 Registered Documents
            <span className="badge">{documents.length}</span>

            <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center' }}>
              {isBulkMode && (
                <>

                  <button className="btn btn-secondary btn-sm" onClick={() => {
                    if (selectedDocIds.size === documents.length && documents.length > 0) {
                      setSelectedDocIds(new Set())
                    } else {
                      setSelectedDocIds(new Set(documents.map(d => d.id)))
                    }
                  }}>
                    {selectedDocIds.size === documents.length && documents.length > 0 ? 'Deselect All' : 'Select All'}
                  </button>

                  <button
                    className="btn btn-sm"
                    style={{ backgroundColor: 'var(--error)', color: 'white', border: 'none', opacity: selectedDocIds.size === 0 ? 0.5 : 1, cursor: selectedDocIds.size === 0 ? 'not-allowed' : 'pointer' }}
                    onClick={handleBulkDelete}
                    disabled={selectedDocIds.size === 0}
                  >
                    {selectedDocIds.size === documents.length ? 'Delete All' : `Delete (${selectedDocIds.size})`}
                  </button>
                </>
              )}

              <button
                className={`btn btn-sm ${isBulkMode ? 'btn-secondary' : 'btn-primary'}`}
                onClick={() => {
                  if (isBulkMode) {
                    setIsBulkMode(false)
                    setSelectedDocIds(new Set())
                  } else {
                    setIsBulkMode(true)
                  }
                }}
              >
                {isBulkMode ? 'Cancel Selection' : 'Select'}
              </button>

              <button id="refresh-docs" className="btn btn-secondary btn-sm" onClick={() => loadDocuments()}>
                ↻ Refresh
              </button>
            </div>
          </div>
          {loadingDocs ? (
            <div className="empty">Loading…</div>
          ) : documents.length === 0 ? (
            <div className="empty">No documents yet. Upload a PDF below.</div>
          ) : (
            <div className="table-wrap doc-table-responsive">
              <table style={{ width: '100%' }}>
                <thead>
                  <tr>
                    {isBulkMode && (
                      <th className="bulk-check-td" style={{ width: 36, textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={documents.length > 0 && selectedDocIds.size === documents.length}
                          onChange={e => {
                            if (e.target.checked) setSelectedDocIds(new Set(documents.map(d => d.id)))
                            else setSelectedDocIds(new Set())
                          }}
                        />
                      </th>
                    )}
                    <th style={{ width: '28%' }}>Filename</th>
                    <th style={{ width: '7%' }}>Size</th>
                    <th style={{ width: '12%' }}>PDF Type</th>
                    <th style={{ width: '8%' }}>Layout</th>
                    <th className="col-stratum" style={{ width: '8%' }}>Stratum</th>
                    <th className="col-edgetags" style={{ width: '8%' }}>Edge Tags</th>
                    <th style={{ width: '15%' }}>GT Status</th>
                    <th style={{ width: '14%' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {documents.map(doc => {
                    const pInfo = progressData[doc.id]
                    return (
                      <tr
                        key={doc.id}
                        onClick={() => {
                          if (isBulkMode) {
                            const next = new Set(selectedDocIds)
                            if (next.has(doc.id)) next.delete(doc.id)
                            else next.add(doc.id)
                            setSelectedDocIds(next)
                          }
                        }}
                        style={{ cursor: isBulkMode ? 'pointer' : 'default', background: isBulkMode && selectedDocIds.has(doc.id) ? 'rgba(99, 102, 241, 0.05)' : undefined }}
                      >
                        {isBulkMode && (
                          <td className="bulk-check-td" style={{ textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              style={{ cursor: 'pointer' }}
                              checked={selectedDocIds.has(doc.id)}
                              readOnly
                            />
                          </td>
                        )}
                        <td data-label="File" style={{ position: 'relative', overflow: 'visible' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0 }}>
                            {isBulkMode && (
                              <input
                                type="checkbox"
                                className="mobile-inline-check"
                                style={{ cursor: 'pointer', width: '14px', height: '14px', flexShrink: 0 }}
                                checked={selectedDocIds.has(doc.id)}
                                readOnly
                                onClick={e => e.stopPropagation()}
                                onChange={() => { }}
                              />
                            )}
                            <span className="filename-text" title={doc.filename}>{doc.filename}</span>
                            <span className="filename-info-wrap">
                              <button className="filename-info-btn" type="button" tabIndex={-1}>ℹ</button>
                              <span className="filename-tooltip">
                                <strong style={{ wordBreak: 'break-all' }}>{doc.filename}</strong>
                                <span style={{ color: 'var(--muted)', fontSize: '0.62rem', marginTop: '6px', display: 'block', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '4px' }}>
                                  Uploaded:<br />{new Date(doc.createdAt).toLocaleString()}
                                </span>
                              </span>
                            </span>
                          </div>
                        </td>
                        <td data-label="Size">{fmtBytes(doc.fileSizeBytes)}</td>
                        <td data-label="Type">{doc.pdfType ?? '—'}</td>
                        <td data-label="Layout">{doc.layoutType?.replace('_COLUMN', '') ?? '—'}</td>
                        <td data-label="Stratum">{doc.stratumId ?? '—'}</td>
                        <td data-label="Tags">
                          {doc.edgeCaseTags.length > 0
                            ? doc.edgeCaseTags.map(t => (
                              <span key={t} className="status status-processing" style={{ marginRight: 3 }}>{t}</span>
                            ))
                            : '—'}
                        </td>
                        <td data-label="GT">
                          {doc.groundTruth ? (
                            <span className="status status-completed">
                              ✓ {doc.groundTruth.derivationMethod.replace('vlm_', '').replace('_', ' ')}
                            </span>
                          ) : pInfo?.status === 'processing' ? (
                            <span className="status status-processing">
                              Processing ({pInfo.progress}%)
                            </span>
                          ) : (
                            <span className="status status-pending">Pending</span>
                          )}
                        </td>
                        <td data-label="Actions">
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              id={`select-doc-${doc.id}`}
                              className="btn btn-secondary btn-sm"
                              onClick={(e) => {
                                e.stopPropagation()
                                setExtractDocIds(new Set([doc.id]))
                                setTimeout(() => document.getElementById('extract-text-section')?.scrollIntoView({ behavior: 'smooth' }), 100)
                              }}
                            >
                              View & Extract
                            </button>
                            {!doc.groundTruth && (
                              <button
                                id={`trigger-gt-${doc.id}`}
                                className="btn btn-primary btn-sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleTriggerGT(doc.id);
                                }}
                              >
                                <span className="btn-full">Get Text</span>
                                <span className="btn-short">GT</span>
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── 2. UPLOAD FORM ── */}
        <section className="card">
          <div className="card-title">⬆ Upload PDF(s) in Bulk</div>
          <form id="upload-form" onSubmit={handleUpload}>
            <div className="form-grid">
              <div style={{ minWidth: 0 }}>
                <label htmlFor="file-input">PDF File *</label>
                <input
                  id="file-input"
                  type="file"
                  className="file-input w-full"
                  accept="application/pdf"
                  multiple
                  onChange={e => {
                    if (e.target.files) {
                      const newFiles = Array.from(e.target.files)
                      setUploadFiles(prev => {
                        const existing = new Set(prev.map(f => f.name))
                        const added = newFiles.filter(f => !existing.has(f.name))
                        return [...prev, ...added]
                      })
                    }
                    e.target.value = '' // Allow re-selecting the same file if needed
                  }}
                />
                {uploadFiles.length > 0 && (
                  <div style={{ marginTop: '8px', fontSize: '0.8rem', color: 'var(--muted)', background: 'var(--surface1)', padding: '6px 8px', borderRadius: '4px', border: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                      <div style={{ fontWeight: 600, color: 'var(--text)' }}>Selected Files ({uploadFiles.length}):</div>
                      <button type="button" onClick={() => setUploadFiles([])} style={{ fontSize: '0.75rem', color: 'var(--error)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Clear All</button>
                    </div>
                    {uploadFiles.map((f, i) => (
                      <div key={i} className="dropdown-item" style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0' }}>
                        <div style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0, marginRight: '8px' }}>
                          <span style={{ flexShrink: 0, marginRight: '4px' }}>•</span>
                          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }} title={f.name}>{f.name}</span>
                          <span className="dropdown-info-wrap" style={{ flexShrink: 0, marginLeft: '6px' }} onClick={e => { e.preventDefault(); e.stopPropagation(); }}>
                            <button className="filename-info-btn" type="button" tabIndex={-1}>ℹ</button>
                            <span className="filename-tooltip dropdown-tooltip">
                              {f.name}
                            </span>
                          </span>
                        </div>
                        <button type="button" onClick={() => setUploadFiles(prev => prev.filter((_, idx) => idx !== i))} style={{ color: 'var(--error)', background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, padding: '0 4px', flexShrink: 0 }} title="Remove">&times;</button>
                      </div>
                    ))}
                  </div>
                )}
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
              <button id="upload-btn" type="submit" className="btn btn-primary" disabled={uploading || uploadFiles.length === 0}>
                {uploading ? 'Uploading…' : uploadFiles.length > 0 ? `⬆ Upload ${uploadFiles.length} PDF${uploadFiles.length > 1 ? 's' : ''}` : '⬆ Upload PDF'}
              </button>
            </div>

            {uploadStatus && (
              <div className={`alert ${uploadStatus.startsWith('error') ? 'alert-error' : 'alert-success'}`}>
                {uploadStatus.replace(/^(error|success):/, '')}
              </div>
            )}
          </form>
        </section>

        {/* ── 3. EXTRACT TEXT SECTION ── */}
        <section className="card" id="extract-text-section">
          <div className="card-title">⚡ Extract Text</div>

          <div className="extract-controls" style={{ display: 'flex', gap: '16px', marginBottom: '20px', alignItems: 'flex-start' }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <label style={{ display: 'block', marginBottom: '6px', fontSize: '0.85rem', color: 'var(--muted)' }}>
                Document
              </label>
              <details className="doc-select-details" style={{ position: 'relative', background: 'var(--bg-gradient-1)', borderRadius: '6px', border: '1px solid var(--border)', flex: 1, display: 'flex', flexDirection: 'column' }}>
                <summary style={{ display: 'flex', flexDirection: 'column', padding: '10px 12px', cursor: 'pointer', outline: 'none', userSelect: 'none', gap: '6px', flex: 1, justifyContent: 'center' }} title={getSelectedDocNames(extractDocIds)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', width: '100%' }}>
                    <span style={{ margin: 0, fontSize: '0.9rem', color: extractDocIds.size > 0 ? 'var(--text)' : 'var(--muted)', fontWeight: extractDocIds.size > 0 ? 'bold' : 'normal' }}>
                      Document(s) ({extractDocIds.size} selected)
                    </span>
                    <span className="btn btn-sm" style={{ background: 'var(--surface2)', border: '1px solid var(--border)', padding: '4px 12px', fontSize: '0.8rem', borderRadius: '16px', color: 'var(--accent2)' }}>Select ▼</span>
                  </div>
                  {extractDocIds.size > 0 && (
                    <div style={{ fontSize: '0.8rem', color: 'var(--accent)', opacity: 0.9, width: '100%', lineHeight: '1.4', whiteSpace: 'pre-wrap' }}>
                      {getSelectedDocNames(extractDocIds)}
                    </div>
                  )}
                </summary>

                <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 50, padding: '12px', background: 'var(--bg-gradient-1)', border: '1px solid var(--border)', borderRadius: '6px', boxShadow: '0 4px 24px rgba(0,0,0,0.5)' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '400px', overflowY: 'auto', background: 'var(--surface)', padding: '8px', borderRadius: '6px', border: '1px solid var(--border)' }}>
                    {documents.length > 0 && (
                      <button
                        type="button"
                        className="btn btn-sm select-all-btn"
                        style={{ background: 'var(--surface2)', border: '1px solid var(--border)', fontSize: '0.8rem', padding: '4px 8px', color: 'var(--accent2)', alignSelf: 'flex-start', marginBottom: '4px' }}
                        onClick={(e) => {
                          e.preventDefault();
                          if (extractDocIds.size === documents.length && documents.length > 0) {
                            setExtractDocIds(new Set())
                          } else {
                            setExtractDocIds(new Set(documents.map(d => d.id)))
                          }
                          setCompareDataList([])
                        }}
                      >
                        {extractDocIds.size === documents.length && documents.length > 0 ? 'Deselect All' : 'Select All'}
                      </button>
                    )}
                    {documents.map(doc => (
                      <label key={doc.id} className="dropdown-item" style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.95rem', margin: 0, padding: '6px 8px', cursor: 'pointer', borderRadius: '4px' }}>
                        <input
                          type="checkbox"
                          style={{ width: '16px', height: '16px', accentColor: 'var(--accent)', cursor: 'pointer', flexShrink: 0 }}
                          checked={extractDocIds.has(doc.id)}
                          onChange={e => {
                            const next = new Set(extractDocIds)
                            if (e.target.checked) next.add(doc.id)
                            else next.delete(doc.id)
                            setExtractDocIds(next)
                            setCompareDataList([])
                          }}
                        />
                        <div style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0 }}>
                          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={doc.filename}>{doc.filename}</span>
                          <span className="dropdown-info-wrap" style={{ flexShrink: 0, marginLeft: '6px' }} onClick={e => { e.preventDefault(); e.stopPropagation(); }}>
                            <button className="filename-info-btn" type="button" tabIndex={-1}>ℹ</button>
                            <span className="filename-tooltip dropdown-tooltip">
                              {doc.filename}
                            </span>
                          </span>
                        </div>
                        <select
                          style={{ padding: '2px 4px', fontSize: '0.8rem', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text)', maxWidth: '140px' }}
                          value={docEngines[doc.id] || ''}
                          onChange={(e) => {
                            e.preventDefault(); e.stopPropagation();
                            setDocEngines(prev => ({ ...prev, [doc.id]: e.target.value }))
                            setCompareDataList([])
                          }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <option value="">Default Engine</option>
                          {[
                            'PYMUPDF', 'PDFMINER', 'MARKER',
                            'OCRMYPDF_TESSERACT', 'MISTRAL_OCR'
                          ].map(e => <option key={e} value={e}>{e.replace(/_/g, ' ')}</option>)}
                        </select>
                      </label>
                    ))}
                    {documents.length === 0 && (
                      <div style={{ fontSize: '0.9rem', color: 'var(--muted)', padding: '4px' }}>No documents available.</div>
                    )}
                  </div>
                </div>
              </details>
            </div>

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <label htmlFor="viewer-engine-select" style={{ display: 'block', marginBottom: '6px', fontSize: '0.85rem', color: 'var(--muted)' }}>
                Default Engine
              </label>
              <select
                id="viewer-engine-select"
                className="select w-full"
                value={viewerEngine}
                onChange={e => {
                  setViewerEngine(e.target.value)
                  setCompareDataList([])
                }}
              >
                <option value="">— Select an engine —</option>
                {[
                  'PYMUPDF',
                  'PDFMINER',
                  'MARKER',
                  'OCRMYPDF_TESSERACT',
                  'MISTRAL_OCR',
                ].map(e => (
                  <option key={e} value={e}>
                    {e.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <label style={{ display: 'block', marginBottom: '6px', fontSize: '0.85rem', visibility: 'hidden' }}>
                Action
              </label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  id="extract-text-btn"
                  className="btn btn-primary"
                  style={{ position: 'relative', overflow: 'hidden' }}
                  onClick={handleExtractText}
                  disabled={loadingCompare || extractDocIds.size === 0}
                >
                  {loadingCompare && (
                    <>
                      <div
                        style={{
                          position: 'absolute',
                          left: 0,
                          top: 0,
                          bottom: 0,
                          width: `${extractProgress}%`,
                          backgroundColor: 'rgba(255, 255, 255, 0.15)',
                          transition: 'width 0.2s ease-out'
                        }}
                      />
                      <div
                        style={{
                          position: 'absolute',
                          left: 0,
                          bottom: 0,
                          height: '4px',
                          width: `${extractProgress}%`,
                          backgroundColor: 'rgba(255, 255, 255, 0.9)',
                          transition: 'width 0.2s ease-out',
                          boxShadow: '0 -2px 10px rgba(255,255,255,0.5)'
                        }}
                      />
                    </>
                  )}
                  <span style={{ position: 'relative', zIndex: 1, textShadow: loadingCompare ? '0 1px 4px rgba(0,0,0,0.5)' : 'none', fontWeight: loadingCompare ? 600 : 500 }}>
                    {loadingCompare ? `⏳ Extracting (${Math.floor(extractProgress)}%)...` : '⚡ Extract Text'}
                  </span>
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    setExtractDocIds(new Set())
                    setViewerEngine('')
                    setDocEngines({})
                    setCompareDataList([])
                  }}
                  disabled={loadingCompare || (extractDocIds.size === 0 && !viewerEngine && compareDataList.length === 0 && Object.keys(docEngines).length === 0)}
                >
                  Reset
                </button>
              </div>
            </div>
          </div>

          {!loadingCompare && compareDataList.length === 0 && (
            <div className="empty">Select document(s) and an engine above, then click <strong>Extract Text</strong> to view or run extraction.</div>
          )}

          {compareDataList.map((compareData, idx) => (
            <div key={compareData.docId || idx} style={{ marginTop: idx > 0 ? '40px' : '16px', paddingTop: idx > 0 ? '40px' : '0', borderTop: idx > 0 ? '1px solid var(--border)' : 'none', display: 'flex', flexDirection: 'column', gap: '20px' }}>

              <h3 style={{ margin: 0, fontSize: '1.1rem', color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                📄 {compareData.docName}
              </h3>

              {/* Metrics Header */}
              {compareData.metrics && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
                  <div style={{ padding: '12px', background: 'var(--surface1)', borderRadius: '8px', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '4px' }}>Character Error Rate (CER)</div>
                    <div style={{ fontSize: '1.2rem', fontWeight: 600 }}>{fmt(compareData.metrics.cer)}</div>
                  </div>
                  <div style={{ padding: '12px', background: 'var(--surface1)', borderRadius: '8px', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '4px' }}>Reading Order Score</div>
                    <div style={{ fontSize: '1.2rem', fontWeight: 600 }}>{fmt(compareData.metrics.readingOrderScore)}</div>
                  </div>
                  <div style={{ padding: '12px', background: 'var(--surface1)', borderRadius: '8px', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '4px' }}>Numeric Accuracy</div>
                    <div style={{ fontSize: '1.2rem', fontWeight: 600 }}>{fmt(compareData.metrics.numericAccuracyAggregate)}</div>
                  </div>
                </div>
              )}

              {/* Text Comparison Columns */}
              <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 45%', display: 'flex', flexDirection: 'column', minWidth: '300px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <h4 style={{ margin: 0, fontSize: '0.88rem', fontWeight: 600 }}>Ground Truth</h4>
                    <CopyButton text={compareData.groundTruthText} />
                  </div>
                  <pre style={{ margin: 0, padding: '14px', background: 'var(--surface1)', border: '1px solid var(--border)', borderRadius: '6px', fontSize: '0.8rem', maxHeight: '500px', overflowY: 'auto', whiteSpace: 'pre-wrap', color: 'var(--text)' }}>
                    {compareData.groundTruthText || '(No Ground Truth Text Found)'}
                  </pre>
                </div>
                <div style={{ flex: '1 1 45%', display: 'flex', flexDirection: 'column', minWidth: '300px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <h4 style={{ margin: 0, fontSize: '0.88rem', fontWeight: 600 }}>Extracted Text ({compareData.engineUsed ? compareData.engineUsed.replace(/_/g, ' ') : (viewerEngine || '').replace(/_/g, ' ')})</h4>

                    <div style={{ display: 'flex', gap: '8px' }}>
                      {compareData.engineText && !['(No engine selected)', '(Failed to load comparison)', '(Generate GT first using Get Text button)'].includes(compareData.engineText) && (
                        <button className="btn btn-sm btn-secondary" onClick={() => {
                          const blob = new Blob([compareData.engineText!], { type: 'text/plain' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = `${compareData.docName}_${compareData.engineUsed || viewerEngine || 'Extraction'}.txt`;
                          a.click();
                          URL.revokeObjectURL(url);
                        }}>
                          📥 Download Text
                        </button>
                      )}
                      <CopyButton text={compareData.engineText} />
                    </div>
                  </div>
                  <pre style={{ margin: 0, padding: '14px', background: 'var(--surface1)', border: '1px solid var(--border)', borderRadius: '6px', fontSize: '0.8rem', maxHeight: '500px', overflowY: 'auto', whiteSpace: 'pre-wrap', color: 'var(--text)' }}>
                    {compareData.engineText || '(No Extracted Text Found)'}
                  </pre>
                </div>
              </div>

              {/* Per-Entity Numeric Breakdown */}
              {compareData.missingEntities && (
                <div style={{ background: 'var(--surface1)', padding: '16px', borderRadius: '8px', border: '1px solid var(--border)' }}>
                  <h4 style={{ marginBottom: '12px', fontSize: '0.9rem', fontWeight: 600 }}>Per-Entity Numeric Breakdown</h4>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '12px' }}>
                    {Object.entries(compareData.missingEntities).map(([etype, entities]: any) => (
                      <div key={etype} style={{ background: 'rgba(255,255,255,0.03)', padding: '12px', borderRadius: '6px', border: '1px solid var(--border)' }}>
                        <h5 style={{ textTransform: 'capitalize', color: 'var(--accent)', marginBottom: '8px', borderBottom: '1px solid var(--border)', paddingBottom: '4px', margin: 0 }}>
                          {etype.replace('_', ' ')}
                        </h5>
                        <div style={{ marginBottom: '8px', marginTop: '6px' }}>
                          <span style={{ fontSize: '0.8rem', color: '#4ade80', fontWeight: 600 }}>✓ Found ({entities.found?.length || 0})</span>
                          {entities.found?.length > 0 && <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: '2px', wordBreak: 'break-all' }}>{entities.found.join(', ')}</div>}
                        </div>
                        <div>
                          <span style={{ fontSize: '0.8rem', color: '#f87171', fontWeight: 600 }}>✗ Missing ({entities.missing?.length || 0})</span>
                          {entities.missing?.length > 0 && <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: '2px', wordBreak: 'break-all' }}>{entities.missing.join(', ')}</div>}
                        </div>
                      </div>
                    ))}
                    {Object.keys(compareData.missingEntities).length === 0 && (
                      <div className="empty" style={{ gridColumn: '1 / -1', padding: '16px', background: 'transparent' }}>No numeric entities found in ground truth.</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </section>

        {/* ── 4. BENCHMARK RUNNER ── */}
        <section className="card">
          <div className="card-title" style={{ marginBottom: '12px' }}>🚀 Run Benchmark</div>

          <details className="doc-select-details" style={{ position: 'relative', background: 'var(--bg-gradient-1)', borderRadius: '6px', border: '1px solid var(--border)', marginBottom: '12px' }}>
            <summary style={{ display: 'flex', flexDirection: 'column', padding: '10px 12px', cursor: 'pointer', outline: 'none', userSelect: 'none', gap: '6px' }} title={getSelectedDocNames(selectedDocIds)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', width: '100%' }}>
                <span style={{ margin: 0, fontSize: '0.9rem', color: selectedDocIds.size > 0 ? 'var(--text)' : 'var(--muted)', fontWeight: selectedDocIds.size > 0 ? 'bold' : 'normal' }}>
                  Documents ({selectedDocIds.size} selected)
                </span>
                <span className="btn btn-sm" style={{ background: 'var(--surface2)', border: '1px solid var(--border)', padding: '4px 12px', fontSize: '0.8rem', borderRadius: '16px', color: 'var(--accent2)' }}>Select ▼</span>
              </div>
              {selectedDocIds.size > 0 && (
                <div style={{ fontSize: '0.8rem', color: 'var(--accent)', opacity: 0.9, width: '100%', lineHeight: '1.4', whiteSpace: 'pre-wrap' }}>
                  {getSelectedDocNames(selectedDocIds)}
                </div>
              )}
            </summary>

            <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 50, padding: '12px', background: 'var(--bg-gradient-1)', border: '1px solid var(--border)', borderRadius: '6px', boxShadow: '0 4px 24px rgba(0,0,0,0.5)' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '400px', overflowY: 'auto', background: 'var(--surface)', padding: '8px', borderRadius: '6px', border: '1px solid var(--border)' }}>
                {documents.length > 0 && (
                  <button
                    type="button"
                    className="btn btn-sm select-all-btn"
                    style={{ background: 'var(--surface2)', border: '1px solid var(--border)', fontSize: '0.8rem', padding: '4px 8px', color: 'var(--accent2)', alignSelf: 'flex-start', marginBottom: '4px' }}
                    onClick={(e) => {
                      e.preventDefault();
                      if (selectedDocIds.size === documents.length && documents.length > 0) {
                        setSelectedDocIds(new Set())
                      } else {
                        setSelectedDocIds(new Set(documents.map(d => d.id)))
                      }
                    }}
                  >
                    {selectedDocIds.size === documents.length && documents.length > 0 ? 'Deselect All' : 'Select All'}
                  </button>
                )}
                {documents.map(doc => (
                  <label key={doc.id} className="dropdown-item" style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.95rem', margin: 0, padding: '6px 8px', cursor: 'pointer', borderRadius: '4px' }}>
                    <input
                      type="checkbox"
                      style={{ width: '16px', height: '16px', accentColor: 'var(--accent)', cursor: 'pointer', flexShrink: 0 }}
                      checked={selectedDocIds.has(doc.id)}
                      onChange={e => {
                        const next = new Set(selectedDocIds)
                        if (e.target.checked) next.add(doc.id)
                        else next.delete(doc.id)
                        setSelectedDocIds(next)
                      }}
                    />
                    <div style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0 }}>
                      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={doc.filename}>{doc.filename}</span>
                      <span className="dropdown-info-wrap" style={{ flexShrink: 0, marginLeft: '6px' }} onClick={e => { e.preventDefault(); e.stopPropagation(); }}>
                        <button className="filename-info-btn" type="button" tabIndex={-1}>ℹ</button>
                        <span className="filename-tooltip dropdown-tooltip">
                          {doc.filename}
                        </span>
                      </span>
                    </div>
                  </label>
                ))}
                {documents.length === 0 && (
                  <div style={{ fontSize: '0.9rem', color: 'var(--muted)', padding: '4px' }}>No documents available.</div>
                )}
              </div>
            </div>
          </details>

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

          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                id="run-benchmark-btn"
                className="btn btn-primary"
                onClick={handleRunBenchmark}
                disabled={running || selectedDocIds.size === 0 || selectedEngines.size === 0}
              >
                {running ? '⏳ Running…' : '▶ Run Benchmark'}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setSelectedDocIds(new Set())
                  setSelectedEngines(new Set(['PYMUPDF', 'PDFMINER']))
                  setRunStatus(null)
                  setRunResults([])
                }}
              >
                Reset
              </button>
            </div>

            {runStatus && (
              <span
                style={{
                  fontSize: '0.9rem',
                  color: runStatus.startsWith('error') ? '#f87171' : runStatus.startsWith('success') ? '#4ade80' : 'var(--muted)'
                }}
              >
                {runStatus.replace(/^(error|success|info):/, '')}
              </span>
            )}
          </div>
        </section>

        {/* ── 5. RESULTS TABLE ── */}
        {runResults.length > 0 && (
          <div id="benchmark-results-container" style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
            {runResults.map((runResult) => {
              const compositeExtremes = computeExtremes(runResult.metrics, 'compositeScore')
              const cerExtremes = computeExtremes(runResult.metrics, 'cer')
              const werExtremes = computeExtremes(runResult.metrics, 'wer')
              const roExtremes = computeExtremes(runResult.metrics, 'readingOrderScore')
              const numExtremes = computeExtremes(runResult.metrics, 'numericAccuracyAggregate')

              return (
                <section key={runResult.documentId} id={`benchmark-results-${runResult.documentId}`} className="card">
                  <div className="card-title">
                    📊 Benchmark Results
                    <span className="badge">{runResult.document.filename}</span>
                  </div>
                  {runResult.metrics.length === 0 ? (
                    <div className="empty">No metrics yet — metrics are computing in the background.</div>
                  ) : (
                    <div className="table-wrap">
                      <table style={{ width: '100%', minWidth: '1000px' }}>
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
                          {runResult.metrics
                            .filter(m => runResult.enginesIncluded.includes(m.engine))
                            .map(m => (
                              <tr key={m.id}>
                                <td>
                                  <strong>{m.engine.replace(/_/g, ' ')}</strong>
                                </td>
                                <td>
                                  <StatusBadge status={m.extractionResult?.status ?? 'UNKNOWN'} />
                                </td>
                                <td style={{ textAlign: 'center' }}>
                                  {m.extractionResult?.wasFallback ? (
                                    <span
                                      title={m.extractionResult.errorMessage || 'Engine failed and fell back to a basic text extractor.'}
                                      style={{ cursor: 'help', borderBottom: '1px dotted var(--muted)' }}
                                    >
                                      ⚠ yes (?)
                                    </span>
                                  ) : (
                                    '—'
                                  )}
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
              )
            })}
          </div>
        )}

      </main>

      <footer style={{ marginTop: '60px', padding: '40px 20px', borderTop: '1px solid var(--border)', background: 'var(--bg-gradient-3)', position: 'relative', zIndex: 10 }}>
        <div className="container" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
          <div style={{ textAlign: 'center' }}>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 700, margin: '0 0 8px 0', background: 'linear-gradient(to right, #3a8df4, #a78bfa)', backgroundClip: 'text', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', letterSpacing: '-0.5px' }}>
              HuntForTomorrow
            </h2>
            <p style={{ fontSize: '0.85rem', color: 'var(--muted)', margin: 0 }}>
              PDF Text Extraction Benchmarking System
            </p>
          </div>

          <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', justifyContent: 'center' }}>
            <a href="#" style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: '0.9rem', fontWeight: 500, transition: 'color 0.2s' }} onMouseOver={e => e.currentTarget.style.color = 'var(--text)'} onMouseOut={e => e.currentTarget.style.color = 'var(--muted)'}>Home</a>
            <a href="#extract-text-section" style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: '0.9rem', fontWeight: 500, transition: 'color 0.2s' }} onMouseOver={e => e.currentTarget.style.color = 'var(--text)'} onMouseOut={e => e.currentTarget.style.color = 'var(--muted)'}>Extract Text</a>
            <a href="#benchmark-runner" style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: '0.9rem', fontWeight: 500, transition: 'color 0.2s' }} onMouseOver={e => e.currentTarget.style.color = 'var(--text)'} onMouseOut={e => e.currentTarget.style.color = 'var(--muted)'}>Benchmark</a>
          </div>

          <div style={{ fontSize: '0.75rem', color: 'var(--surface2)', marginTop: '10px' }}>
            &copy; {new Date().getFullYear()} HuntForTomorrow. All rights reserved.
          </div>
        </div>
      </footer>

      {confirmState?.isOpen && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(2px)' }}>
          <div className="card" style={{ maxWidth: '450px', width: '90%', margin: '0 20px', background: 'var(--surface)', border: '1px solid var(--border)', boxShadow: '0 10px 40px rgba(0,0,0,0.8)' }}>
            <h3 style={{ margin: '0 0 16px 0', color: confirmState.confirmText === 'Replace' ? 'var(--accent)' : 'var(--error)' }}>{confirmState.title}</h3>
            <p style={{ lineHeight: 1.5, margin: 0, color: 'var(--text)' }}>
              {confirmState.message}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '24px' }}>
              <button className="btn btn-secondary" onClick={confirmState.onCancel}>
                {confirmState.cancelText}
              </button>
              <button
                className="btn"
                style={{ backgroundColor: confirmState.confirmText === 'Replace' ? 'var(--accent)' : 'var(--error)', color: 'white', border: 'none' }}
                onClick={confirmState.onConfirm}
              >
                {confirmState.confirmText}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
