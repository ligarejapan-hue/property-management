import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireAgentInquiry, VERSION_CONFLICT_MESSAGE } from "@/lib/agent-inquiry/guard";
import { agentUpdateSchema, normalizeAgentInput } from "@/lib/agent-inquiry/validators";
import { inquiryAuditDetail } from "@/lib/agent-inquiry/audit-detail";
import { DESK_PROPERTY_SELECT, toDeskProperty } from "@/lib/agent-inquiry/desk-property";

type Ctx = { params: Promise<{ id: string }> };
const NO_STORE = { "Cache-Control": "no-store" };
const idOf = async (ctx: Ctx) => z.string().uuid().parse((await ctx.params).id);

const HISTORY_PAGE = 50;

/** 業者の詳細+その業者からの反響(新しい順・ページ送り・物件は許可リストの形)。 */
export async function GET(request: Request, ctx: Ctx) {
  try {
    await requireAgentInquiry("read");
    const id = await idOf(ctx);
    const cursorRaw = new URL(request.url).searchParams.get("cursor");
    const cursor = cursorRaw ? z.string().uuid().parse(cursorRaw) : undefined;
    const agent = await prisma.agent.findUnique({ where: { id } });
    if (!agent) throw new ApiError(404, "業者が見つかりません", "NOT_FOUND");
    const inquiries = await prisma.agentInquiry.findMany({
      where: { agentId: id },
      // 固定の上限で古い履歴を見えなくしない=カーソルで続きを取れる(@codex #454 R7)。
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
      take: HISTORY_PAGE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        kind: true,
        status: true,
        receivedAt: true,
        contactName: true,
        property: { select: DESK_PROPERTY_SELECT },
      },
    });
    const page = inquiries.slice(0, HISTORY_PAGE).map(({ property, ...q }) => ({ ...q, property: toDeskProperty(property) }));
    return NextResponse.json(
      { agent, inquiries: page, nextCursor: inquiries.length > HISTORY_PAGE ? page[page.length - 1].id : null },
      { headers: NO_STORE },
    );
  } catch (error) {
    return handleApiError(error);
  }
}

/** 業者の編集・しまう(version で 409・触っていない列は変えない)。 */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    const { session } = await requireAgentInquiry("write");
    const id = await idOf(ctx);
    const { version, ...rest } = agentUpdateSchema.parse(await parseJsonBody(request));
    const data = normalizeAgentInput(rest);
    const res = await prisma.agent.updateMany({ where: { id, version }, data: { ...data, version: { increment: 1 } } });
    if (res.count === 0) {
      const cur = await prisma.agent.findUnique({ where: { id }, select: { id: true } });
      if (!cur) throw new ApiError(404, "業者が見つかりません", "NOT_FOUND");
      throw new ApiError(409, VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
    }
    await writeAuditLog({
      userId: session.id,
      action: rest.isArchived === true ? "agent_archive" : "agent_update",
      targetTable: "agents",
      targetId: id,
      detail: inquiryAuditDetail(Object.keys(data)),
    });
    return NextResponse.json({ version: version + 1 }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
