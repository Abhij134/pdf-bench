import { NextRequest, NextResponse } from 'next/server'
export const dynamic = 'force-dynamic';
import { prisma } from '@/lib/prisma'
import { ExtractionEngine } from '@prisma/client'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'

const _localVenv = path.join(process.cwd(), '.venv', 'Scripts', 'python.exe')
const PYTHON_CMD = fs.existsSync(_localVenv) ? _localVenv : (process.platform === 'win32' ? 'python' : 'python3')

function extractEntities(groundTruth: string, hypothesis: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_CMD, ['extract_entities.py'], {
      cwd: path.join(process.cwd(), 'workers'),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
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

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const documentId = url.searchParams.get('documentId')
    const engine = url.searchParams.get('engine')

    if (!documentId || !engine) {
      return NextResponse.json({ error: 'Missing documentId or engine param' }, { status: 400 })
    }

    const gt = await prisma.groundTruth.findUnique({
      where: { documentId }
    })

    const ext = await prisma.extractionResult.findUnique({
      where: { documentId_engine: { documentId, engine: engine as ExtractionEngine } }
    })

    if (!gt || !ext || !ext.rawText || ext.status === 'FAILED') {
      return NextResponse.json({ error: 'Ground truth or extraction result not found' }, { status: 404 })
    }

    // If the stored result was a fallback (e.g. Marker crashed and used PyMuPDF),
    // treat it as missing so the frontend re-triggers a fresh real extraction.
    if (ext.wasFallback) {
      return NextResponse.json({ error: 'Stored result was a fallback — re-running extraction' }, { status: 404 })
    }

    const groundTruth = gt.rawText || ''
    const extractedText = ext.rawText || ''

    const metric = await prisma.benchmarkMetric.findFirst({
      where: { extractionResultId: ext.id },
      orderBy: { createdAt: 'desc' }
    })

    const entityResult = await extractEntities(groundTruth, extractedText)
    const missingEntities = entityResult.missingEntities || entityResult
    const computedMetrics = entityResult.metrics || {}

    return NextResponse.json({
      groundTruthText: groundTruth,
      engineText: extractedText,
      missingEntities,
      metrics: {
        cer: metric?.cer ?? computedMetrics.cer ?? null,
        readingOrderScore: metric?.readingOrderScore ?? computedMetrics.readingOrderScore ?? null,
        numericAccuracyAggregate: metric?.numericAccuracyAggregate ?? computedMetrics.numericAccuracyAggregate ?? null
      }
    })

  } catch (err) {
    console.error('[GET /api/extraction-compare]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
