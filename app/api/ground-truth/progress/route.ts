import { NextRequest, NextResponse } from 'next/server'
export const dynamic = 'force-dynamic';
import path from 'path'
import fs from 'fs'

export async function GET(req: NextRequest) {
  const documentId = req.nextUrl.searchParams.get('documentId')
  if (!documentId) {
    return NextResponse.json({ error: 'Missing documentId' }, { status: 400 })
  }

  // Use /tmp/.progress on Linux (Netlify/HF), local .progress on Windows (dev)
  const progressDir = process.platform === 'win32'
    ? path.join(process.cwd(), '.progress')
    : '/tmp/.progress'
  const filePath = path.join(progressDir, `${documentId}.json`)

  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      return NextResponse.json(data)
    } else {
      return NextResponse.json({ status: 'pending', progress: 0, error: null })
    }
  } catch (error) {
    console.error('Failed to read progress file:', error)
    return NextResponse.json({ status: 'pending', progress: 0, error: null })
  }
}
