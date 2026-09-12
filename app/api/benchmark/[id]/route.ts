/**
 * app/api/benchmark/[id]/route.ts
 * GET /api/benchmark/:id
 * Fetch a BenchmarkRun with its full metrics for all engines.
 * Returns all BenchmarkMetric rows joined to ExtractionResult metadata.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const run = await prisma.benchmarkRun.findUniqueOrThrow({
      where: { id: params.id },
      include: {
        document: {
          select: { filename: true, pdfType: true, layoutType: true, edgeCaseTags: true },
        },
        metrics: {
          include: {
            extractionResult: {
              select: {
                engine: true,
                status: true,
                processingTimeMs: true,
                costUsd: true,
                extractionConfidence: true,
                wasFallback: true,
              },
            },
          },
          orderBy: { compositeScore: 'desc' },
        },
      },
    })
    return NextResponse.json(run)
  } catch (err) {
    console.error('[GET /api/benchmark/:id]', err)
    return NextResponse.json({ error: 'Benchmark run not found' }, { status: 404 })
  }
}
