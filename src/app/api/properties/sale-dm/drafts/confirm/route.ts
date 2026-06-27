import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";

// id は UUID 厳格検証(非UUIDを Prisma に渡して 500 にしない=422)。上限で巨大配列も弾く。
const confirmSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });

export async function POST(request: NextRequest) {
  try {
    const { session } = await requireSaleDmAccess();
    const { ids } = confirmSchema.parse(await parseJsonBody(request));
    // 作成者本人のキャンペーン配下の draft のみ確定(他人のキャンペーンの draft は対象外)。
    const result = await prisma.dmRecipientDraft.updateMany({
      // 生成失敗(body="")は確定対象から除外(空letterの確定→印刷→送付を防ぐ)。
      where: { id: { in: ids }, status: "draft", body: { not: "" }, campaign: { createdBy: session.id } },
      data: { status: "confirmed", confirmedAt: new Date() },
    });
    await writeAuditLog({ userId: session.id, action: "sale_dm_drafts_confirm", targetTable: "dm_recipient_drafts", detail: { count: result.count, confirmedAt: new Date().toISOString() } });
    return NextResponse.json({ count: result.count }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleApiError(error); }
}
