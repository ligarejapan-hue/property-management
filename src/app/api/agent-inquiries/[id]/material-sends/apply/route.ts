import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError } from "@/lib/api-helpers";
import { requireAgentInquiry } from "@/lib/agent-inquiry/guard";
import { loadMaterialInquiry, reconcileMaterialSends } from "@/lib/agent-inquiry/material-send-service";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 送れたのに反響へ反映できていない記録を反映し直す(@codex 2巡目 P2)。
 * 送った記録の一覧(GET)が needsApply を返したときに画面が呼ぶ。GET では書き換えない。
 */
export async function POST(_req: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireAgentInquiry("write");
    const id = z.string().uuid().parse((await ctx.params).id);
    await loadMaterialInquiry(id, session, perms);
    const applied = await reconcileMaterialSends(id, session.id);
    return NextResponse.json({ applied }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
