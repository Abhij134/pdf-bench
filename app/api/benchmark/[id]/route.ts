/**
 * app/api/benchmark/[id]/route.ts
 * GET /api/benchmark/:id
 * Fetch a BenchmarkRun with its full metrics for all engines.
 * Returns all BenchmarkMetric rows joined to ExtractionResult metadata.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

const ENGINE_RATES: Record<string, number> = {
  'GOOGLE_DOCUMENT_AI': 0.0015,
  'MISTRAL_OCR': 0.001,
  'MARKER': 0.0004,
  'PYMUPDF': 0,
  'PDFMINER': 0,
  'OCRMYPDF_TESSERACT': 0,
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const run = await prisma.benchmarkRun.findUniqueOrThrow({
      where: { id: params.id },
      include: {
        document: {
          select: { filename: true, pdfType: true, layoutType: true, edgeCaseTags: true, pageCount: true },
        },
        metrics: {
          orderBy: { compositeScore: 'desc' },
        },
      },
    })

    const extractionResults = await prisma.extractionResult.findMany({
      where: {
        documentId: run.documentId,
      },
      select: {
        engine: true,
        status: true,
        processingTimeMs: true,
        costUsd: true,
        extractionConfidence: true,
        wasFallback: true,
        errorMessage: true,
      }
    })

    const pageCount = run.document.pageCount ?? 0;

    const enrichedResults = extractionResults.map(er => {
      let costUsd = er.costUsd;
      let estimated = false;
      if ((costUsd === null || costUsd === 0) && pageCount > 0 && ENGINE_RATES[er.engine] !== undefined) {
        costUsd = pageCount * ENGINE_RATES[er.engine];
        estimated = true;
      }
      return { ...er, costUsd, estimated };
    });

    const enrichedMetrics = run.metrics.map(m => {
      let costUsd = m.costUsd;
      let estimated = false;
      if ((costUsd === null || costUsd === 0) && pageCount > 0 && ENGINE_RATES[m.engine] !== undefined) {
        costUsd = pageCount * ENGINE_RATES[m.engine];
        estimated = true;
      }
      return { ...m, costUsd, estimated };
    });

    return NextResponse.json({ ...run, metrics: enrichedMetrics, extractionResults: enrichedResults })
  } catch (err) {
    console.error('[GET /api/benchmark/:id]', err)
    return NextResponse.json({ error: 'Benchmark run not found' }, { status: 404 })
  }
}
