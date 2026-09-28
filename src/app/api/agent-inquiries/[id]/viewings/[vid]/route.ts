import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireAgentInquiry, VERSION_CONFLICT_MESSAGE } from "@/lib/agent-inquiry/guard";
import { viewingUpdateSchema } from "@/lib/agent-inquiry/validators";
import { inquiryAuditDetail } from "@/lib/agent-inquiry/audit-detail";
import { assertActiveUser } from "@/lib/agent-inquiry/user-check";

type Ctx = { params: Promise<{ id: string; vid: string }> };

/** 内見の変更・取り消し(戻すことも可)・結果の記入。 */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    const { session } = await requireAgentInquiry("write");
    const p = await ctx.params;
    const id = z.string().uuid().parse(p.id);
    const vid = z.string().uuid().parse(p.vid);
    const { version, ...input } = viewingUpdateSchema.parse(await parseJsonBody(request));
    // その反響の内見であることを確かめる(別の反響の内見 id を URL に混ぜても触れない)。
    const cur = await prisma.agentViewing.findFirst({ where: { id: vid, inquiryId: id }, select: { id: true } });
    if (!cur) throw new ApiError(404, "内見の予定が見つかりません", "NOT_FOUND");
    await assertActiveUser(input.attendantId, "INVALID_ATTENDANT");
    const data = {
      ...(input.scheduledAt !== undefined
        ? { scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null }
        : {}),
      ...(input.viewingType !== undefined ? { viewingType: input.viewingType } : {}),
      ...(input.attendantId !== undefined ? { attendantId: input.attendantId } : {}),
      ...(input.resultNote !== undefined ? { resultNote: input.resultNote?.trim() || null } : {}),
      ...(input.canceled !== undefined ? { canceledAt: input.canceled ? new Date() : null } : {}),
    };
    // 古い画面からの保存で黙って上書きしない(版番号・@codex #454 R3)。
    const res = await prisma.agentViewing.updateMany({
      where: { id: vid, inquiryId: id, version },
      data: { ...data, version: { increment: 1 } },
    });
    if (res.count === 0) throw new ApiError(409, VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
    await writeAuditLog({
      userId: session.id,
      action: "agent_viewing_update",
      targetTable: "agent_viewings",
      targetId: vid,
      detail: inquiryAuditDetail(Object.keys(input)),
    });
    return NextResponse.json({ ok: true, version: version + 1 }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
