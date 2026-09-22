/**
 * app/api/ground-truth/route.ts
 * POST /api/ground-truth
 * Trigger the VLM ground truth pipeline for a document.
 *
 * Body: { documentId: string }
 *
 * In production: calls HF_BACKEND_URL/ground-truth with the PDF bytes.
 * In local dev:  spawns gt_pipeline.py as a child process.
 * Returns immediately with { status: "triggered", documentId }.
 */
import { NextRequest, NextResponse } from 'next/server'
export const dynamic = 'force-dynamic';
import { spawn } from 'child_process'
import path from 'path'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { getFile, resolveLocalPath } from '@/lib/storage'

import fs from 'fs'
const _localVenv = path.join(process.cwd(), '.venv', 'Scripts', 'python.exe')
const PYTHON_CMD = fs.existsSync(_localVenv) ? _localVenv : (process.platform === 'win32' ? 'python' : 'python3')

const RequestSchema = z.object({ documentId: z.string().min(1) })

export async function POST(req: NextRequest) {
  try {
    const body = RequestSchema.parse(await req.json())

    const doc = await prisma.document.findUniqueOrThrow({
      where: { id: body.documentId },
    })

    const hfUrl = process.env.HF_BACKEND_URL
    const secret = process.env.WORKER_SECRET ?? ''

    if (hfUrl) {
      // Production: send PDF bytes to HF backend
      const pdfBuffer = await getFile(doc.originalStoragePath)
      fetch(`${hfUrl}/ground-truth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-worker-secret': secret },
        body: JSON.stringify({
          document_id: doc.id,
          pdf_b64: pdfBuffer.toString('base64'),
          stratum_id: doc.stratumId ?? 'UNKNOWN',
          db_url: process.env.DATABASE_URL!,
        }),
      }).catch((err) => console.error('[POST /api/ground-truth] HF call error:', err))
    } else {
      // Local dev: spawn child process
      const pdfAbsPath = resolveLocalPath(doc.originalStoragePath)
      const proc = spawn(
        PYTHON_CMD,
        [
          'gt_pipeline.py',
          '--document-id', doc.id,
          '--pdf',         pdfAbsPath,
          '--stratum-id',  doc.stratumId ?? 'UNKNOWN',
          '--db-url',      process.env.DATABASE_URL!,
        ],
        {
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
          detached: true,
          stdio: 'ignore',
          cwd: path.join(process.cwd(), 'workers'),
          windowsHide: true,
        }
      )
      proc.unref()
    }

    return NextResponse.json(
      { status: 'triggered', documentId: doc.id },
      { status: 202 }
    )

  } catch (err) {
    console.error('[POST /api/ground-truth]', err)
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.issues }, { status: 422 })
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
