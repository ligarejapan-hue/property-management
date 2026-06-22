import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";

const patchSchema = z.object({ body: z.string().min(1) });

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSaleDmAccess();
    const { id } = await params;
    const { body } = patchSchema.parse(await request.json());
    const existing = await prisma.dmRecipientDraft.findUnique({ where: { id } });
    if (!existing) throw new ApiError(404, "下書きが見つかりません", "NOT_FOUND");
    const updated = await prisma.dmRecipientDraft.update({ where: { id }, data: { body } });
    return NextResponse.json({ id: updated.id }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleApiError(error); }
}
