/**
 * app/api/ground-truth/pending/route.ts
 * GET /api/ground-truth/pending
 * List all documents whose GT pipeline flagged them for human review
 * (derivationMethod = 'pending_human_review').
 *
 * Returns documents with their existing VLM-extracted text and
 * native extracted text for side-by-side comparison.
 */
import { NextResponse } from 'next/server'
export const dynamic = 'force-dynamic';
import { prisma } from '@/lib/prisma'

export async function GET() {
  try {
    const flagged = await prisma.groundTruth.findMany({
      where: { derivationMethod: 'pending_human_review' },
      orderBy: { createdAt: 'asc' },
      include: {
        document: {
          select: {
            id: true,
            filename: true,
            pdfType: true,
            layoutType: true,
            stratumId: true,
          },
        },
      },
    })
    return NextResponse.json(flagged)
  } catch (err) {
    console.error('[GET /api/ground-truth/pending]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
