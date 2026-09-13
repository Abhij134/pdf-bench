/**
 * app/api/ocr/run/route.ts
 * POST /api/ocr/run
 * Trigger a standalone Mistral OCR extraction on a specific document.
 *
 * This endpoint is separate from /api/benchmark/run. It is designed for
 * "quick OCR" — running only Mistral OCR on a document, without needing to
 * set up a full multi-engine benchmark run or requiring ground truth to exist.
 *
 * Use cases:
 *   - User uploads a scanned PDF and wants immediate OCR text.
 *   - Testing the Mistral OCR output before running a full benchmark.
 *   - Re-running OCR on a document where the previous result failed.
 *
 * Body: { documentId: string }
 *
 * The Python worker (workers/ocr_workflow.py) is spawned as a background
 * child process. The API returns immediately with { queued: true } so the
 * UI can poll for results without blocking the HTTP connection.
 *
 * Results are written to the ExtractionResult table (engine=MISTRAL_OCR).
 * Poll GET /api/documents/:id to check when the result appears.
 */
import { NextRequest, NextResponse } from 'next/server'
import { spawn } from 'child_process'
import path from 'path'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { resolveLocalPath } from '@/lib/storage'

/** Request body schema */
const RequestSchema = z.object({
  documentId: z.string().min(1),
})

/** Timeout for the OCR worker process (5 minutes — Mistral OCR can be slow for large PDFs) */
const OCR_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Spawn the Python OCR workflow as a background child process.
 * Returns a Promise that resolves on success or rejects on failure/timeout.
 */
function spawnOCRWorker(documentId: string, pdfAbsPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'python',
      [
        path.join(process.cwd(), 'workers', 'ocr_workflow.py'),
        '--document-id', documentId,
        '--pdf',         pdfAbsPath,
        '--db-url',      process.env.DATABASE_URL!,
      ],
      {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Set cwd to workers/ so Python can resolve `engines.*` as package imports
        cwd: path.join(process.cwd(), 'workers'),
      }
    )

    // Forward stdout/stderr to the Next.js server console for debugging
    proc.stdout?.on('data', (d: Buffer) =>
      console.log('[OCR worker]', d.toString().trim())
    )
    proc.stderr?.on('data', (d: Buffer) =>
      console.error('[OCR worker error]', d.toString().trim())
    )

    // Hard timeout to prevent hung processes
    const timeout = setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error(`OCR worker timed out after ${OCR_TIMEOUT_MS / 1000}s`))
    }, OCR_TIMEOUT_MS)

    proc.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`OCR worker exited with code ${code}`))
      }
    })
  })
}

export async function POST(req: NextRequest) {
  try {
    const body = RequestSchema.parse(await req.json())

    // Verify the document exists and fetch its storage path
    const doc = await prisma.document.findUnique({
      where: { id: body.documentId },
      select: { id: true, filename: true, originalStoragePath: true },
    })

    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }

    const pdfAbsPath = resolveLocalPath(doc.originalStoragePath)

    // Spawn the OCR worker in the background (fire-and-forget)
    // We don't await — just let it run and write to the DB.
    spawnOCRWorker(doc.id, pdfAbsPath).catch((err) => {
      console.error(`[POST /api/ocr/run] OCR worker failed for ${doc.id}:`, err)
    })

    return NextResponse.json({
      queued: true,
      documentId: doc.id,
      filename: doc.filename,
      message: 'Mistral OCR is running in the background. Poll /api/documents/:id for the result under extractionResults.',
    })

  } catch (err) {
    console.error('[POST /api/ocr/run]', err)
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.issues }, { status: 422 })
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
