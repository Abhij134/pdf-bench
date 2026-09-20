import { NextRequest, NextResponse } from 'next/server'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { resolveLocalPath } from '@/lib/storage'
import { ExtractionEngine } from '@prisma/client'

const _localVenv = path.join(process.cwd(), '.venv', 'Scripts', 'python.exe')
const PYTHON_CMD = fs.existsSync(_localVenv) ? _localVenv : (process.platform === 'win32' ? 'python' : 'python3')

const RequestSchema = z.object({
  documentId: z.string().min(1),
  engine: z.string().min(1),
})

const ENGINE_TIMEOUT_MS = 600_000 // 10 minutes (to allow for PyTorch model downloads and slow CPU inference)

function runEngineProcess(engine: string, pdfAbsPath: string, resultId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      PYTHON_CMD,
      ['engine_runner.py', '--engine', engine, '--pdf', pdfAbsPath, '--result-id', resultId, '--db-url', process.env.DATABASE_URL!],
      {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', TORCH_DEVICE: 'cpu', ATTN_IMPLEMENTATION: 'eager' },
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: path.join(process.cwd(), 'workers'),
      }
    )

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
      if (code === 0) resolve()
      else reject(new Error(`${engine} exited with non-zero code ${code}`))
    })
  })
}

export async function POST(req: NextRequest) {
  try {
    const body = RequestSchema.parse(await req.json())

    const doc = await prisma.document.findUnique({ where: { id: body.documentId } })
    if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 })

    const pdfAbsPath = resolveLocalPath(doc.originalStoragePath)

    const stub = await prisma.extractionResult.upsert({
      where: { documentId_engine: { documentId: body.documentId, engine: body.engine as ExtractionEngine } },
      create: { documentId: body.documentId, engine: body.engine as ExtractionEngine, status: 'PENDING' },
      update: { status: 'PENDING', errorMessage: null, stackTrace: null },
    })

    try {
      await runEngineProcess(body.engine, pdfAbsPath, stub.id)
    } catch (err: any) {
      const isTimeout = err.message?.includes('timed out')
      await prisma.extractionResult.update({
        where: { id: stub.id },
        data: {
          status: isTimeout ? 'TIMEOUT' : 'FAILED',
          errorMessage: isTimeout ? err.message : `Process crashed: ${err.message}`,
        },
      })
      return NextResponse.json({ error: err.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[POST /api/extraction/run]', err)
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.issues }, { status: 422 })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
