/**
 * app/api/documents/[id]/route.ts
 * GET /api/documents/:id
 * Fetch a document with its ground truth status and extraction results.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const doc = await prisma.document.findUniqueOrThrow({
      where: { id: params.id },
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
        extractionResults: {
          select: {
            engine: true,
            status: true,
            extractionConfidence: true,
            wasFallback: true,
            processingTimeMs: true,
          },
        },
      },
    })
    return NextResponse.json(doc)
  } catch (err) {
    console.error('[GET /api/documents/:id]', err)
    return NextResponse.json({ error: 'Document not found' }, { status: 404 })
  }
}
