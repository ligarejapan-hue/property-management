import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";

const confirmSchema = z.object({ ids: z.array(z.string()).min(1) });

export async function POST(request: NextRequest) {
  try {
    const { session } = await requireSaleDmAccess();
    const { ids } = confirmSchema.parse(await request.json());
    // 作成者本人のキャンペーン配下の draft のみ確定(他人のキャンペーンの draft は対象外)。
    const result = await prisma.dmRecipientDraft.updateMany({
      where: { id: { in: ids }, status: "draft", campaign: { createdBy: session.id } },
      data: { status: "confirmed", confirmedAt: new Date() },
    });
    await writeAuditLog({ userId: session.id, action: "sale_dm_drafts_confirm", targetTable: "dm_recipient_drafts", detail: { count: result.count, confirmedAt: new Date().toISOString() } });
    return NextResponse.json({ count: result.count }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleApiError(error); }
}
