import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireAgentInquiry } from "@/lib/agent-inquiry/guard";
import { inquiryAuditDetail } from "@/lib/agent-inquiry/audit-detail";
import { adoptRegistryAgent } from "@/lib/agent-registry/adopt";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * POST /api/agent-registry/{id}/adopt — 国交省の一覧の会社を名簿へ写す(受付の窓で候補を選んだとき)。
 * 権限は業者の新規登録と同じ(反響の受付の書き込み)。作ったときだけ監査を1件(値は書かない)。
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session } = await requireAgentInquiry("write");
    const id = z.string().uuid().parse((await params).id);
    const r = await adoptRegistryAgent(id, session.id);
    if (!r.ok) {
      if (r.reason === "not_found") throw new ApiError(404, "一覧に見つかりません", "NOT_FOUND");
      throw new ApiError(409, "この会社は一覧から外れたか、電話番号がありません", "UNAVAILABLE");
    }
    if (r.created) {
      await writeAuditLog({
        userId: session.id,
        action: "agent_create",
        targetTable: "agents",
        targetId: r.agent.id,
        detail: { ...inquiryAuditDetail(["companyName", "companyKana", "licenseNo", "address", "phone"]), source: "mlit_registry" },
      });
    }
    return NextResponse.json({ agent: r.agent, created: r.created }, { status: r.created ? 201 : 200, headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
