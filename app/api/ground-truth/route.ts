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

const RequestSchema = z.object({ documentId: z.string().min(1) })

export async function POST(req: NextRequest) {
  try {
    const body = RequestSchema.parse(await req.json())

    const doc = await prisma.document.findUniqueOrThrow({
      where: { id: body.documentId },
    })

    const pdfAbsPath = resolveLocalPath(doc.originalStoragePath)

    const proc = spawn(
      'python3',
      [
        path.join(process.cwd(), 'workers', 'gt_pipeline.py'),
        '--document-id', doc.id,
        '--pdf',         pdfAbsPath,
        '--stratum-id',  doc.stratumId ?? 'UNKNOWN',
        '--db-url',      process.env.DATABASE_URL!,
      ],
      {
        env: { ...process.env },
        detached: true,   // Allow process to outlive the request
        stdio: 'ignore',  // Don't buffer stdio in Next.js process
        cwd: path.join(process.cwd(), 'workers'),
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
