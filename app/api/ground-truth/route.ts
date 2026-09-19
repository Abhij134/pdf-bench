/**
 * app/api/ground-truth/route.ts
 * POST /api/ground-truth
 * Trigger the VLM ground truth pipeline for a document.
 *
 * Body: { documentId: string }
 *
 * Spawns gt_pipeline.py as a child process.
 * Returns immediately with { status: "triggered", documentId }.
 * The pipeline runs asynchronously and writes the GroundTruth row when done.
 */
import { NextRequest, NextResponse } from 'next/server'
import { spawn } from 'child_process'
import path from 'path'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { resolveLocalPath } from '@/lib/storage'

import fs from 'fs'
const _localVenv = path.join(process.cwd(), '..', '.venv', 'Scripts', 'python.exe')
const PYTHON_CMD = fs.existsSync(_localVenv) ? _localVenv : (process.platform === 'win32' ? 'python' : 'python3')

const RequestSchema = z.object({ documentId: z.string().min(1) })

export async function POST(req: NextRequest) {
  try {
    const body = RequestSchema.parse(await req.json())

    const doc = await prisma.document.findUniqueOrThrow({
      where: { id: body.documentId },
    })

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
        detached: true,   // Allow process to outlive the request
        stdio: 'ignore',  // Don't buffer stdio in Next.js process
        cwd: path.join(process.cwd(), 'workers'),
        windowsHide: true,
      }
    )
    proc.unref()  // Let Node.js exit without waiting for this process

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
