import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireAgentInquiry } from "@/lib/agent-inquiry/guard";
import { listAgents, searchAgents } from "@/lib/agent-inquiry/agent-search";
import { agentCreateSchema, normalizeAgentInput } from "@/lib/agent-inquiry/validators";
import { inquiryAuditDetail } from "@/lib/agent-inquiry/audit-detail";
import { hasPermission } from "@/lib/permissions";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * 業者の検索(設計 §3)。代表電話・携帯・会社名のどれでも。
 * list=1 のときは名簿の一覧(名前順・反響件数と最終日・archived=1 でしまった業者)。
 */
export async function GET(request: Request) {
  try {
    const { perms } = await requireAgentInquiry("read");
    const sp = new URL(request.url).searchParams;
    if (sp.get("list") === "1") {
      const cursorRaw = sp.get("cursor");
      const cursor = cursorRaw ? z.string().uuid().parse(cursorRaw) : undefined;
      const page = await listAgents({ archived: sp.get("archived") === "1", cursor });
      // 名簿の画面は、編集・しまうを出すかどうかをこの値で決める(画面で権限表を読まない)。
      return NextResponse.json(
        { ...page, canWrite: hasPermission(perms, "agent_inquiry", "write") },
        { headers: NO_STORE },
      );
    }
    const q = sp.get("q") ?? "";
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
    // 同じ人が同じ鍵で送り直した(通信が切れて押し直した)=作らずに1回目の分を返す。鍵は登録者ごと。
    const replay = async () =>
      parsed.clientToken
        ? prisma.agent.findFirst({ where: { createdById: session.id, clientToken: parsed.clientToken }, select: { id: true } })
        : null;
    const prev = await replay();
    if (prev) return NextResponse.json({ id: prev.id, replayed: true }, { headers: NO_STORE });
    let row: { id: string };
    try {
      row = await prisma.agent.create({
        data: {
          ...input,
          companyName: parsed.companyName,
          phone: input.phone ?? parsed.phone,
          createdById: session.id,
          clientToken: parsed.clientToken ?? null,
        },
        select: { id: true },
      });
    } catch (e) {
      // 同じ鍵が同時に2回届いて一意の索引にぶつかった=先に入った方を返す(二重に作らない)。
      if ((e as { code?: string } | null)?.code === "P2002" && parsed.clientToken) {
        const again = await replay();
        if (again) return NextResponse.json({ id: again.id, replayed: true }, { headers: NO_STORE });
      }
      throw e;
    }
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
