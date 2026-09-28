import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireAgentInquiry } from "@/lib/agent-inquiry/guard";
import { viewingCreateSchema } from "@/lib/agent-inquiry/validators";
import { inquiryAuditDetail } from "@/lib/agent-inquiry/audit-detail";
import { assertActiveUser } from "@/lib/agent-inquiry/user-check";

type Ctx = { params: Promise<{ id: string }> };

/** 内見の予定を足す(日程変更・2回目の案内・設計 方針5)。日時なし=日程調整中。 */
export async function POST(request: Request, ctx: Ctx) {
  try {
    const { session } = await requireAgentInquiry("write");
    const id = z.string().uuid().parse((await ctx.params).id);
    const input = viewingCreateSchema.parse(await parseJsonBody(request));
    const inq = await prisma.agentInquiry.findUnique({ where: { id }, select: { id: true, kind: true } });
    if (!inq) throw new ApiError(404, "反響が見つかりません", "NOT_FOUND");
    if (inq.kind !== "viewing") throw new ApiError(409, "内見の反響ではありません", "NOT_VIEWING");
    await assertActiveUser(input.attendantId, "INVALID_ATTENDANT");
    const row = await prisma.agentViewing.create({
      data: {
        inquiryId: id,
        viewingType: input.viewingType,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
        attendantId: input.attendantId ?? null,
      },
      select: { id: true },
    });
    await writeAuditLog({
      userId: session.id,
      action: "agent_viewing_create",
      targetTable: "agent_viewings",
      targetId: row.id,
      detail: inquiryAuditDetail(Object.keys(input)),
    });
    return NextResponse.json({ id: row.id }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
