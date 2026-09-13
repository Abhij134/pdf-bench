/**
 * app/api/ground-truth/[id]/route.ts
 * PATCH /api/ground-truth/:id
 * Human reviewer submits corrected ground truth text.
 *
 * Body: { rawText: string, reviewNotes?: string, validatedBy?: string }
 *
 * Updates derivationMethod → "vlm_human_verified", sets validatedAt to now.
 */
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'

const PatchSchema = z.object({
  rawText:      z.string().min(1),
  reviewNotes:  z.string().optional(),
  validatedBy:  z.string().optional(),
})

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = PatchSchema.parse(await req.json())

    const updated = await prisma.groundTruth.update({
      where: { id: params.id },
      data: {
        rawText:          body.rawText,
        derivationMethod: 'vlm_human_verified',
        reviewNotes:      body.reviewNotes ?? null,
        validatedBy:      body.validatedBy ?? 'human',
        validatedAt:      new Date(),
      },
    })

    return NextResponse.json({ id: updated.id, status: 'verified' })

  } catch (err) {
    console.error('[PATCH /api/ground-truth/:id]', err)
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.issues }, { status: 422 })
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
