/**
 * app/api/benchmark/run/route.ts
 * POST /api/benchmark/run
 * Trigger a benchmark run: extract text with all specified engines concurrently.
 *
 * Body: { documentId: string, engines: ExtractionEngine[] }
 *
 * Actions:
 *   1. Verify ground truth exists for the document.
 *   2. Create BenchmarkRun record.
 *   3. Upsert PENDING ExtractionResult stubs for each engine.
 *   4. Spawn one Python child process per engine (all concurrent).
 *   5. Wait for all processes to settle (Promise.allSettled).
 *   6. Trigger metric computation via internal HTTP call.
 *   7. Return { benchmarkRunId, failedEngines, status }.
 *
 * Each engine process has a hard 120-second timeout.
 * A process that times out is marked TIMEOUT in the DB.
 */
import { NextRequest, NextResponse } from 'next/server'
import { spawn } from 'child_process'
import path from 'path'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { resolveLocalPath } from '@/lib/storage'

import fs from 'fs'
const _localVenv = path.join(process.cwd(), '.venv', 'Scripts', 'python.exe')
const PYTHON_CMD = fs.existsSync(_localVenv) ? _localVenv : (process.platform === 'win32' ? 'python' : 'python3')

const ALL_ENGINES = [
  'PYMUPDF',
  'PDFMINER',
  'PDFPLUMBER',
  'MARKER',
  'OCRMYPDF_TESSERACT',
  'MISTRAL_OCR',
  'GOOGLE_DOCUMENT_AI',
  'AMAZON_TEXTRACT',
  'AZURE_DOCUMENT_INTELLIGENCE',
  'ADOBE_PDF_EXTRACT',
  'LLAMAPARSE',
  'UNSTRUCTURED'
] as const;

type ExtractionEngine = typeof ALL_ENGINES[number];

const RequestSchema = z.object({
  documentId: z.string().min(1),
  engines: z.array(z.enum(ALL_ENGINES)).min(1),
})

const ENGINE_TIMEOUT_MS = 120_000  // 2 minutes per engine

/** Spawn a Python engine worker and return a Promise that resolves/rejects on process exit. */
function runEngineProcess(
  engine: ExtractionEngine,
  pdfAbsPath: string,
  resultId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      PYTHON_CMD,
      [
        'engine_runner.py',
        '--engine',    engine,
        '--pdf',       pdfAbsPath,
        '--result-id', resultId,
        '--db-url',    process.env.DATABASE_URL!,
      ],
      {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', TORCH_DEVICE: 'cpu', ATTN_IMPLEMENTATION: 'eager' },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Set cwd to workers/ so Python can resolve `engines.*` and `metrics.*`
        // as package imports without needing PYTHONPATH to be set externally.
        cwd: path.join(process.cwd(), 'workers'),
      }
    )

    // Log stdout/stderr to server console for debugging
    proc.stdout?.on('data', (d: Buffer) => console.log(`[${engine}]`, d.toString().trim()))
    proc.stderr?.on('data', (d: Buffer) => console.error(`[${engine}]`, d.toString().trim()))

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error(`${engine} timed out after ${ENGINE_TIMEOUT_MS}ms`))
    }, ENGINE_TIMEOUT_MS)

    proc.on('error', (err) => {
      clearTimeout(timeout)
      reject(new Error(`${engine} failed to spawn: ${err.message}`))
    })

    proc.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`${engine} exited with non-zero code ${code}`))
      }
    })
  })
}

export async function POST(req: NextRequest) {
  try {
    const body = RequestSchema.parse(await req.json())

    // 1. Verify ground truth exists
    const doc = await prisma.document.findUniqueOrThrow({
      where: { id: body.documentId },
      include: { groundTruth: true },
    })

    if (!doc.groundTruth) {
      return NextResponse.json(
        { error: 'Get Text has not been established for this document. Please click "Get Text" in the Registered Documents table above first.' },
        { status: 422 }
      )
    }

    const pdfAbsPath = resolveLocalPath(doc.originalStoragePath)

    // 2. Create BenchmarkRun
    const benchmarkRun = await prisma.benchmarkRun.create({
      data: {
        documentId: body.documentId,
        runLabel: `run-${new Date().toISOString()}`,
        enginesIncluded: body.engines,
      },
    })

    // 3. Upsert ExtractionResult stubs (one per engine)
    const stubs = await prisma.$transaction(
      body.engines.map((engine) =>
        prisma.extractionResult.upsert({
          where: { documentId_engine: { documentId: body.documentId, engine } },
          create: { documentId: body.documentId, engine, status: 'PENDING' },
          update: { status: 'PENDING', errorMessage: null, stackTrace: null },
        })
      )
    )

    // 4. Fire all engines concurrently
    const tasks = stubs.map((stub: { id: string; engine: ExtractionEngine }) =>
      runEngineProcess(stub.engine, pdfAbsPath, stub.id)
    )

    const outcomes = await Promise.allSettled(tasks)

    // 5. Mark failed/timed-out processes in DB
    const failedEngines: string[] = []
    await Promise.all(
      outcomes.map(async (outcome: PromiseSettledResult<void>, i: number) => {
        if (outcome.status === 'rejected') {
          const engine = body.engines[i]
          failedEngines.push(engine)
          const isTimeout = outcome.reason?.message?.includes('timed out')
          
          const existing = await prisma.extractionResult.findUnique({
            where: { id: stubs[i].id },
            select: { status: true }
          })
          
          if (isTimeout || existing?.status === 'PENDING') {
            await prisma.extractionResult.update({
              where: { id: stubs[i].id },
              data: {
                status: isTimeout ? 'TIMEOUT' : 'FAILED',
                errorMessage: isTimeout ? outcome.reason?.message : `Process crashed: ${outcome.reason?.message ?? 'Unknown error'}`,
              },
            })
          }
        }
      })
    )

    // 6. Trigger metric computation (fire-and-forget via internal HTTP)
    triggerMetricComputation(benchmarkRun.id).catch((err) =>
      console.error('[benchmark/run] Failed to trigger metrics:', err)
    )

    return NextResponse.json({
      benchmarkRunId: benchmarkRun.id,
      failedEngines,
      status: failedEngines.length === 0 ? 'all_completed' : 'partial',
    })

  } catch (err) {
    console.error('[POST /api/benchmark/run]', err)
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.issues }, { status: 422 })
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

async function triggerMetricComputation(benchmarkRunId: string): Promise<void> {
  const url = `${process.env.INTERNAL_WORKER_URL}/api/benchmark/internal/compute-metrics`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-worker-secret': process.env.WORKER_SECRET ?? '',
    },
    body: JSON.stringify({ benchmarkRunId }),
  })
  if (!res.ok) {
    throw new Error(`Metric trigger failed: ${res.status} ${await res.text()}`)
  }
}
