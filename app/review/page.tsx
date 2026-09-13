'use client'

/**
 * app/review/page.tsx
 * Human Ground Truth Review Interface.
 *
 * Lists all documents flagged as "pending_human_review" by the VLM pipeline
 * (similarity < 85% between VLM text and native extraction).
 *
 * For each flagged document, the reviewer can:
 *   1. See the VLM-extracted text (pre-filled in the editor).
 *   2. Read the similarity score and review notes.
 *   3. Edit the text directly.
 *   4. Submit the corrected text → marks GT as "vlm_human_verified".
 */
import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface PendingGT {
  id: string
  rawText: string
  vlmSimilarityScore: number | null
  reviewNotes: string | null
  createdAt: string
  document: {
    id: string
    filename: string
    pdfType: string | null
    layoutType: string | null
    stratumId: string | null
  }
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────

export default function ReviewPage() {
  const [items, setItems]   = useState<PendingGT[]>([])
  const [loading, setLoading] = useState(true)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [reviewNotes, setReviewNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  const loadPending = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/ground-truth/pending')
      if (res.ok) setItems(await res.json())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadPending() }, [loadPending])

  function selectItem(item: PendingGT) {
    setActiveId(item.id)
    setEditText(item.rawText)
    setReviewNotes(item.reviewNotes ?? '')
    setSaveMsg(null)
  }

  async function handleSave() {
    if (!activeId) return
    setSaving(true)
    setSaveMsg(null)
    try {
      const res = await fetch(`/api/ground-truth/${activeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawText: editText, reviewNotes }),
      })
      if (res.ok) {
        setSaveMsg('success:✓ Ground truth saved and marked as verified.')
        // Remove from pending list
        setItems(prev => prev.filter(i => i.id !== activeId))
        setActiveId(null)
        setEditText('')
      } else {
        const d = await res.json()
        setSaveMsg(`error:Save failed: ${JSON.stringify(d.error)}`)
      }
    } catch {
      setSaveMsg('error:Network error.')
    } finally {
      setSaving(false)
    }
  }

  const active = items.find(i => i.id === activeId)

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <>
      <header>
        <div className="container inner" style={{ justifyContent: 'space-between' }}>
          <div>
            <h1>PDF-Bench</h1>
            <div className="subtitle">Ground Truth Review Queue</div>
          </div>
          <Link href="/" className="btn btn-secondary btn-sm">← Back to Dashboard</Link>
        </div>
      </header>

      <main className="container" style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 24, alignItems: 'start', paddingTop: 32 }}>

        {/* ── LEFT: Pending list ── */}
        <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="card-title" style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', marginBottom: 0 }}>
            ⏳ Pending Review
            <span className="badge" style={{ marginLeft: 8 }}>{items.length}</span>
          </div>

          {loading ? (
            <div className="empty">Loading…</div>
          ) : items.length === 0 ? (
            <div className="empty">
              ✓ No documents pending review.<br />
              <span style={{ fontSize: '0.75rem', marginTop: 6, display: 'block' }}>
                All GT pipelines passed the 85% similarity threshold.
              </span>
            </div>
          ) : (
            <div>
              {items.map(item => (
                <button
                  key={item.id}
                  id={`review-item-${item.id}`}
                  onClick={() => selectItem(item)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '14px 20px',
                    background: activeId === item.id ? 'var(--surface2)' : 'transparent',
                    border: 'none',
                    borderBottom: '1px solid var(--border)',
                    cursor: 'pointer',
                    transition: 'background 0.1s',
                  }}
                >
                  <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text)', marginBottom: 4, fontFamily: 'monospace' }}>
                    {item.document.filename}
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <span className="status status-pending">{item.document.stratumId ?? '—'}</span>
                    {item.document.layoutType && (
                      <span className="status status-processing">{item.document.layoutType.replace('_', ' ')}</span>
                    )}
                    {item.vlmSimilarityScore !== null && (
                      <span style={{ fontSize: '0.7rem', color: 'var(--red)' }}>
                        sim={((item.vlmSimilarityScore ?? 0) * 100).toFixed(1)}%
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* ── RIGHT: Editor ── */}
        <section>
          {!active ? (
            <div className="card">
              <div className="empty">
                ← Select a document from the queue to begin reviewing.<br />
                <span style={{ fontSize: '0.75rem', marginTop: 6, display: 'block' }}>
                  The VLM-extracted text is pre-filled. Correct any errors, then click Save.
                </span>
              </div>
            </div>
          ) : (
            <>
              {/* Document info */}
              <div className="card" style={{ marginBottom: 20 }}>
                <div className="card-title" style={{ marginBottom: 8 }}>
                  📄 {active.document.filename}
                </div>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: '0.8rem', color: 'var(--muted)' }}>
                  <span><strong>Stratum:</strong> {active.document.stratumId ?? '—'}</span>
                  <span><strong>PDF Type:</strong> {active.document.pdfType ?? '—'}</span>
                  <span><strong>Layout:</strong> {active.document.layoutType ?? '—'}</span>
                  <span>
                    <strong>VLM Similarity:</strong>{' '}
                    <span style={{ color: 'var(--red)' }}>
                      {active.vlmSimilarityScore !== null
                        ? `${((active.vlmSimilarityScore) * 100).toFixed(1)}%`
                        : '—'}
                    </span>
                    {' '}(flagged because &lt; 85%)
                  </span>
                  <span><strong>GT Created:</strong> {new Date(active.createdAt).toLocaleString()}</span>
                </div>
                {active.reviewNotes && (
                  <div className="alert alert-info" style={{ marginTop: 12 }}>
                    <strong>Pipeline notes:</strong> {active.reviewNotes}
                  </div>
                )}
              </div>

              {/* Text editor */}
              <div className="card">
                <div className="card-title" style={{ marginBottom: 12 }}>
                  ✏️ Edit Ground Truth Text
                  <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 400 }}>
                    {editText.length} chars / {editText.split(/\s+/).filter(Boolean).length} words
                  </span>
                </div>
                <textarea
                  id="gt-text-editor"
                  value={editText}
                  onChange={e => setEditText(e.target.value)}
                  rows={28}
                  style={{
                    width: '100%',
                    background: 'var(--surface2)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)',
                    color: 'var(--text)',
                    fontSize: '0.8rem',
                    fontFamily: 'monospace',
                    padding: '12px',
                    resize: 'vertical',
                    outline: 'none',
                    lineHeight: 1.6,
                  }}
                />

                <div style={{ marginTop: 12 }}>
                  <label htmlFor="review-notes-input">Review Notes (optional)</label>
                  <input
                    id="review-notes-input"
                    type="text"
                    value={reviewNotes}
                    onChange={e => setReviewNotes(e.target.value)}
                    placeholder="e.g. Corrected phone number on page 2, fixed column order"
                    style={{ marginTop: 4 }}
                  />
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
                  <button
                    id="save-gt-btn"
                    className="btn btn-primary"
                    onClick={handleSave}
                    disabled={saving || !editText.trim()}
                  >
                    {saving ? 'Saving…' : '✓ Save & Mark Verified'}
                  </button>
                  <button
                    id="skip-gt-btn"
                    className="btn btn-secondary"
                    onClick={() => setActiveId(null)}
                  >
                    Skip for now
                  </button>
                </div>

                {saveMsg && (
                  <div className={`alert ${saveMsg.startsWith('error') ? 'alert-error' : 'alert-success'}`}>
                    {saveMsg.replace(/^(error|success):/, '')}
                  </div>
                )}
              </div>
            </>
          )}
        </section>

      </main>
    </>
  )
}
