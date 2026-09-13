/**
 * app/api/documents/[id]/route.ts
 * GET /api/documents/:id
 * Fetch a document with its ground truth status and extraction results.
 *
 * DELETE /api/documents/:id
 * Delete a document, its storage file, and associated database records.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { deleteFile } from '@/lib/storage'

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

/**
 * DELETE /api/documents/:id
 * Delete a document from database and delete its raw PDF file from storage.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const doc = await prisma.document.findUnique({
      where: { id: params.id },
    })

    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }

    // Try deleting physical file from storage
    try {
      await deleteFile(doc.originalStoragePath)
    } catch (storageErr) {
      console.warn(`[DELETE /api/documents/${params.id}] Storage file removal warning:`, storageErr)
    }

    // Delete record from database (cascade deletes GroundTruth, ExtractionResult, BenchmarkRun, BenchmarkMetric)
    await prisma.document.delete({
      where: { id: params.id },
    })

    return NextResponse.json({ deleted: true, id: params.id })
  } catch (err) {
    console.error('[DELETE /api/documents/:id]', err)
    return NextResponse.json({ error: 'Failed to delete document' }, { status: 500 })
  }
}

