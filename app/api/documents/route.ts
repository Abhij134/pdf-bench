/**
 * app/api/documents/route.ts
 * POST /api/documents
 * Register a PDF into the system.
 *
 * Accepts multipart/form-data with fields:
 *   - file:      PDF binary
 *   - stratumId: sourcing matrix stratum (e.g. "NATIVE-TWO-COL")
 *   - edgeCaseTags: comma-separated tags
 *   - sourceSystem: optional (e.g. "canva", "linkedin")
 *
 * Actions:
 *   1. Compute SHA-256 hash (dedup guard).
 *   2. Save to storage.
 *   3. Create Document row.
 *   4. Return {id, sha256Hash, filename}.
 */
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { prisma } from '@/lib/prisma'
import { saveFile } from '@/lib/storage'

/**
 * GET /api/documents
 * List all registered documents with ground truth status.
 * Used by the dashboard to populate the documents table.
 */
export async function GET() {
  try {
    const docs = await prisma.document.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        groundTruth: {
          select: {
            id: true,
            derivationMethod: true,
            vlmSimilarityScore: true,
            validatedAt: true,
            createdAt: true,
          },
        },
      },
    })
    return NextResponse.json(docs)
  } catch (err) {
    console.error('[GET /api/documents]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('file') as File | null
    const stratumId = formData.get('stratumId') as string | null
    const edgeCaseTagsRaw = formData.get('edgeCaseTags') as string | null
    const sourceSystem = formData.get('sourceSystem') as string | null

    if (!file || file.size === 0) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }
    if (file.type !== 'application/pdf') {
      return NextResponse.json({ error: 'Only PDF files are accepted' }, { status: 415 })
    }

    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    // SHA-256 for deduplication
    const sha256Hash = crypto.createHash('sha256').update(buffer).digest('hex')

    // Check for duplicate
    const existing = await prisma.document.findUnique({ where: { sha256Hash } })
    if (existing) {
      return NextResponse.json(
        { id: existing.id, sha256Hash, filename: existing.filename, duplicate: true },
        { status: 200 }
      )
    }

    // Save PDF to storage
    const storageKey = `documents/${sha256Hash}/original.pdf`
    await saveFile(storageKey, buffer)

    const edgeCaseTags = edgeCaseTagsRaw
      ? edgeCaseTagsRaw.split(',').map(t => t.trim()).filter(Boolean)
      : []

    const doc = await prisma.document.create({
      data: {
        filename: file.name,
        sha256Hash,
        fileSizeBytes: buffer.length,
        originalStoragePath: storageKey,
        stratumId: stratumId ?? undefined,
        sourceSystem: sourceSystem ?? undefined,
        edgeCaseTags,
      },
    })

    return NextResponse.json({ id: doc.id, sha256Hash, filename: doc.filename }, { status: 201 })

  } catch (err) {
    console.error('[POST /api/documents]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
