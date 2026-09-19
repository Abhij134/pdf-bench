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

import fs from 'fs'
const _localVenv = path.join(process.cwd(), '.venv', 'Scripts', 'python.exe')
const PYTHON_CMD = fs.existsSync(_localVenv) ? _localVenv : (process.platform === 'win32' ? 'python' : 'python3')

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
      PYTHON_CMD,
      [
        'metric_worker.py',
        '--benchmark-run-id', body.benchmarkRunId,
        '--db-url',           process.env.DATABASE_URL!,
      ],
      { env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, detached: true, stdio: 'ignore', cwd: path.join(process.cwd(), 'workers') }
    )
    proc.unref()

    return NextResponse.json({ status: 'triggered', benchmarkRunId: body.benchmarkRunId }, { status: 202 })

  } catch (err) {
    console.error('[POST /api/benchmark/internal/compute-metrics]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
