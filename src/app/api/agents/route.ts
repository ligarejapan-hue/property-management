import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireAgentInquiry } from "@/lib/agent-inquiry/guard";
import { searchAgents } from "@/lib/agent-inquiry/agent-search";
import { agentCreateSchema, normalizeAgentInput } from "@/lib/agent-inquiry/validators";
import { inquiryAuditDetail } from "@/lib/agent-inquiry/audit-detail";

const NO_STORE = { "Cache-Control": "no-store" };

/** 業者の検索(設計 §3)。代表電話・携帯・会社名のどれでも。 */
export async function GET(request: Request) {
  try {
    await requireAgentInquiry("read");
    const q = new URL(request.url).searchParams.get("q") ?? "";
    return NextResponse.json({ agents: await searchAgents(q) }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}

/** 業者の新規登録(反響を登録する人がその場で・設計 方針7)。 */
export async function POST(request: Request) {
  try {
    const { session } = await requireAgentInquiry("write");
    const parsed = agentCreateSchema.parse(await parseJsonBody(request));
    const input = normalizeAgentInput(parsed);
    const row = await prisma.agent.create({
      data: {
        ...input,
        companyName: parsed.companyName,
        phone: input.phone ?? parsed.phone,
        createdById: session.id,
      },
      select: { id: true },
    });
    await writeAuditLog({
      userId: session.id,
      action: "agent_create",
      targetTable: "agents",
      targetId: row.id,
      detail: inquiryAuditDetail(Object.keys(input)),
    });
    return NextResponse.json({ id: row.id }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
