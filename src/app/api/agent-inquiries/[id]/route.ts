import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { requireAgentInquiry, VERSION_CONFLICT_MESSAGE } from "@/lib/agent-inquiry/guard";
import { inquiryUpdateSchema, normalizeInquiryContact } from "@/lib/agent-inquiry/validators";
import { inquiryAuditDetail } from "@/lib/agent-inquiry/audit-detail";
import { INQUIRY_LIST_SELECT, toInquiryView } from "@/lib/agent-inquiry/inquiry-view";
import { DESK_PROPERTY_SELECT } from "@/lib/agent-inquiry/desk-property";
import { assertActiveUser } from "@/lib/agent-inquiry/user-check";

type Ctx = { params: Promise<{ id: string }> };
const NO_STORE = { "Cache-Control": "no-store" };
const idOf = async (ctx: Ctx) => z.string().uuid().parse((await ctx.params).id);

/** 反響の詳細。物件は許可リストの形+「メイン画面で物件を開く」を出してよいか。 */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireAgentInquiry("read");
    const id = await idOf(ctx);
    const row = await prisma.agentInquiry.findUnique({
      where: { id },
      select: {
        ...INQUIRY_LIST_SELECT,
        property: { select: { ...DESK_PROPERTY_SELECT, createdBy: true, assignedTo: true } },
      },
    });
    if (!row) throw new ApiError(404, "反響が見つかりません", "NOT_FOUND");
    const { createdBy, assignedTo } = row.property;
    // 既存の物件画面の閲覧規則(field_staff は作成者/担当の物件だけ)と同じ条件。
    const canOpenProperty =
      hasPermission(perms, "property", "read") &&
      (session.role !== "field_staff" || createdBy === session.id || assignedTo === session.id);
    // toInquiryView が toDeskProperty を通すので createdBy/assignedTo は外へ出ない。
    return NextResponse.json({ inquiry: toInquiryView(row), canOpenProperty }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}

/** 状態・担当・メモ・問い合わせ者の変更(version で 409・触っていない列は変えない)。 */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    const { session } = await requireAgentInquiry("write");
    const id = await idOf(ctx);
    const { version, status, assigneeId, note, ...contactIn } = inquiryUpdateSchema.parse(await parseJsonBody(request));
    await assertActiveUser(assigneeId, "INVALID_ASSIGNEE");
    const data = {
      ...normalizeInquiryContact(contactIn),
      ...(status !== undefined ? { status } : {}),
      ...(assigneeId !== undefined ? { assigneeId } : {}),
      ...(note !== undefined ? { note: note?.trim() || null } : {}),
    };
    const res = await prisma.agentInquiry.updateMany({
      where: { id, version },
      data: { ...data, version: { increment: 1 } },
    });
    if (res.count === 0) {
      const cur = await prisma.agentInquiry.findUnique({ where: { id }, select: { id: true } });
      if (!cur) throw new ApiError(404, "反響が見つかりません", "NOT_FOUND");
      throw new ApiError(409, VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
    }
    await writeAuditLog({
      userId: session.id,
      action: "agent_inquiry_update",
      targetTable: "agent_inquiries",
      targetId: id,
      detail: inquiryAuditDetail(Object.keys(data), { status }),
    });
    return NextResponse.json({ version: version + 1 }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
