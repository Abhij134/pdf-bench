/**
 * app/api/benchmark/internal/compute-metrics/route.ts
 * POST /api/benchmark/internal/compute-metrics
 * Internal endpoint — only callable with the WORKER_SECRET header.
 * Spawns metric_worker.py for the given benchmarkRunId.
 */
import { NextRequest, NextResponse } from 'next/server'
import { spawn } from 'child_process'
import path from 'path'
import { z } from 'zod'

const RequestSchema = z.object({ benchmarkRunId: z.string().min(1) })

export async function POST(req: NextRequest) {
  // Guard with worker secret
  const secret = req.headers.get('x-worker-secret')
  if (secret !== process.env.WORKER_SECRET) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const body = RequestSchema.parse(await req.json())

    const proc = spawn(
      'python3',
      [
        path.join(process.cwd(), 'workers', 'metric_worker.py'),
        '--benchmark-run-id', body.benchmarkRunId,
        '--db-url',           process.env.DATABASE_URL!,
      ],
      { env: { ...process.env }, detached: true, stdio: 'ignore', cwd: path.join(process.cwd(), 'workers') }
    )
    proc.unref()

    return NextResponse.json({ status: 'triggered', benchmarkRunId: body.benchmarkRunId }, { status: 202 })

  } catch (err) {
    console.error('[POST /api/benchmark/internal/compute-metrics]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
