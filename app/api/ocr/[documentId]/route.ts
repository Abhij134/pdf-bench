/**
 * app/api/ocr/[documentId]/route.ts
 * GET /api/ocr/:documentId
 * Returns the full OCR extraction result for a document.
 *
 * This is separate from /api/documents/:id because the documents endpoint
 * returns only summary fields (engine, status, confidence) from extractionResults
 * for performance. The rawText can be large (thousands of words) and should
 * only be fetched on demand.
 *
 * Response shape:
 *   {
 *     documentId: string,
 *     engine: "MISTRAL_OCR",
 *     status: "COMPLETED" | "FAILED" | "PROCESSING" | "PENDING",
 *     rawText: string | null,
 *     rawMarkdown: string | null,
 *     pageCount: number | null,
 *     wordCount: number | null,
 *     charCount: number | null,
 *     extractionConfidence: number | null,
 *     processingTimeMs: number | null,
 *     costUsd: number | null,
 *     errorMessage: string | null,
 *   }
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(
  _req: NextRequest,
  { params }: { params: { documentId: string } }
) {
  try {
    const result = await prisma.extractionResult.findUnique({
      where: {
        documentId_engine: {
          documentId: params.documentId,
          engine: 'MISTRAL_OCR',
        },
      },
      select: {
        id: true,
        documentId: true,
        engine: true,
        status: true,
        rawText: true,
        rawMarkdown: true,
        pageCount: true,
        wordCount: true,
        charCount: true,
        extractionConfidence: true,
        processingTimeMs: true,
        costUsd: true,
        errorMessage: true,
        wasFallback: true,
      },
    })

    if (!result) {
      return NextResponse.json(
        { error: 'No MISTRAL_OCR extraction result found for this document' },
        { status: 404 }
      )
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error('[GET /api/ocr/:documentId]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
