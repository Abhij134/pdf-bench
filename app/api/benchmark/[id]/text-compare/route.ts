import { NextRequest, NextResponse } from 'next/server'
import { spawn } from 'child_process'
import path from 'path'
import { prisma } from '@/lib/prisma'

import fs from 'fs'
const _localVenv = path.join(process.cwd(), '.venv', 'Scripts', 'python.exe')
const PYTHON_CMD = fs.existsSync(_localVenv) ? _localVenv : (process.platform === 'win32' ? 'python' : 'python3')

function extractEntities(groundTruth: string, hypothesis: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_CMD, ['extract_entities.py'], {
      cwd: path.join(process.cwd(), 'workers'),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })

    let stdoutData = ''
    let stderrData = ''

    proc.stdout.on('data', (data) => { stdoutData += data.toString() })
    proc.stderr.on('data', (data) => { stderrData += data.toString() })

    proc.on('close', (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(stdoutData))
        } catch (e) {
          reject(new Error(`Failed to parse extract_entities.py output: ${stdoutData}`))
        }
      } else {
        reject(new Error(`extract_entities.py failed: ${stderrData}`))
      }
    })

    proc.on('error', (err) => {
      reject(err)
    })

    proc.stdin.write(JSON.stringify({ reference: groundTruth, hypothesis }))
    proc.stdin.end()
  })
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const url = new URL(req.url)
    const engine = url.searchParams.get('engine')
    if (!engine) {
      return NextResponse.json({ error: 'Missing engine parameter' }, { status: 400 })
    }

    const run = await prisma.benchmarkRun.findUnique({
      where: { id: params.id },
      include: {
        document: {
          include: { groundTruth: true }
        }
      }
    })

    if (!run) {
      return NextResponse.json({ error: 'Benchmark run not found' }, { status: 404 })
    }

    const er = await prisma.extractionResult.findUnique({
      where: {
        documentId_engine: {
          documentId: run.documentId,
          engine: engine as any
        }
      }
    })

    if (!er) {
      return NextResponse.json({ error: 'Extraction result not found' }, { status: 404 })
    }

    if (er.status !== 'COMPLETED') {
      return NextResponse.json({ error: er.errorMessage || `Engine status is ${er.status}` }, { status: 409 })
    }

    const groundTruth = run.document.groundTruth?.rawText || ''
    const extractedText = er.rawText || ''

    const metric = await prisma.benchmarkMetric.findFirst({
      where: { benchmarkRunId: run.id, engine: engine as any }
    })

    const missingEntities = await extractEntities(groundTruth, extractedText)

    return NextResponse.json({
      groundTruth,
      extractedText,
      missingEntities,
      metrics: {
        cer: metric?.cer ?? null,
        readingOrderScore: metric?.readingOrderScore ?? null,
        numericAccuracyAggregate: metric?.numericAccuracyAggregate ?? null
      }
    })

  } catch (err) {
    console.error('[GET /api/benchmark/:id/text-compare]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
