import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireAgentInquiry } from "@/lib/agent-inquiry/guard";
import { inquiryCreateSchema, normalizeInquiryContact } from "@/lib/agent-inquiry/validators";
import { inquiryAuditDetail } from "@/lib/agent-inquiry/audit-detail";
import { INQUIRY_STATUSES } from "@/lib/agent-inquiry/constants";
import { INQUIRY_LIST_SELECT, toInquiryView } from "@/lib/agent-inquiry/inquiry-view";
import { assertActiveUser } from "@/lib/agent-inquiry/user-check";

const NO_STORE = { "Cache-Control": "no-store" };
const PAGE = 50;

/** 反響の一覧(状態・担当で絞る・新しい順・カーソル式)。物件は許可リストの形。 */
export async function GET(request: Request) {
  try {
    const { session } = await requireAgentInquiry("read");
    const sp = new URL(request.url).searchParams;
    const status = z.enum(INQUIRY_STATUSES).optional().parse(sp.get("status") ?? undefined);
    const assigneeRaw = sp.get("assignee");
    const assigneeId =
      assigneeRaw === "me" ? session.id : assigneeRaw ? z.string().uuid().parse(assigneeRaw) : undefined;
    const cursorRaw = sp.get("cursor");
    const cursor = cursorRaw ? z.string().uuid().parse(cursorRaw) : undefined;
    const rows = await prisma.agentInquiry.findMany({
      where: { ...(status ? { status } : {}), ...(assigneeId ? { assigneeId } : {}) },
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
      take: PAGE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: INQUIRY_LIST_SELECT,
    });
    const items = rows.slice(0, PAGE).map(toInquiryView);
    return NextResponse.json(
      { items, nextCursor: rows.length > PAGE ? items[items.length - 1].id : null },
      { headers: NO_STORE },
    );
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * 反響の登録(設計 §2.2)。物件の閲覧権限は問わない(方針10=電話は誰が取るか分からない)。
 * 担当=登録者・状態=未対応。用件が内見なら内見の予定を同時に作れる。
 */
export async function POST(request: Request) {
  try {
    const { session } = await requireAgentInquiry("write");
    const input = inquiryCreateSchema.parse(await parseJsonBody(request));
    const [property, agent] = await Promise.all([
      prisma.property.findUnique({ where: { id: input.propertyId }, select: { id: true } }),
      prisma.agent.findUnique({ where: { id: input.agentId }, select: { id: true, isArchived: true } }),
    ]);
    if (!property) throw new ApiError(404, "物件が見つかりません", "PROPERTY_NOT_FOUND");
    if (!agent) throw new ApiError(404, "業者が見つかりません", "AGENT_NOT_FOUND");
    if (agent.isArchived) {
      throw new ApiError(409, "この業者はしまわれています。名簿で戻してから選んでください", "AGENT_ARCHIVED");
    }
    await assertActiveUser(input.viewing?.attendantId, "INVALID_ATTENDANT");
    const contact = normalizeInquiryContact(input);
    const note = input.note?.trim() || null;
    const row = await prisma.agentInquiry.create({
      data: {
        propertyId: input.propertyId,
        agentId: input.agentId,
        ...contact,
        kind: input.kind,
        channel: input.channel,
        note,
        status: "open",
        assigneeId: session.id,
        createdById: session.id,
        ...(input.viewing
          ? {
              viewings: {
                create: [
                  {
                    viewingType: input.viewing.viewingType,
                    scheduledAt: input.viewing.scheduledAt ? new Date(input.viewing.scheduledAt) : null,
                    attendantId: input.viewing.attendantId ?? null,
                  },
                ],
              },
            }
          : {}),
      },
      select: { id: true },
    });
    const filled = Object.entries(contact)
      .filter(([, v]) => v != null)
      .map(([k]) => k);
    await writeAuditLog({
      userId: session.id,
      action: "agent_inquiry_create",
      targetTable: "agent_inquiries",
      targetId: row.id,
      detail: inquiryAuditDetail(note ? [...filled, "note"] : filled, { kind: input.kind, status: "open" }),
    });
    return NextResponse.json({ id: row.id }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
