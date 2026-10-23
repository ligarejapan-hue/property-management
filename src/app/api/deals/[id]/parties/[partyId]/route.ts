import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireDeal, DEAL_VERSION_CONFLICT_MESSAGE } from "@/lib/deals/guard";
import { partyUpdateSchema } from "@/lib/deals/schemas";

type Ctx = { params: Promise<{ id: string; partyId: string }> };
const NO_STORE = { "Cache-Control": "no-store" };

async function ids(ctx: Ctx) {
  const p = await ctx.params;
  return { dealId: z.string().uuid().parse(p.id), partyId: z.string().uuid().parse(p.partyId) };
}

/** 書けなかった理由を 404(無い)と 409(先に直された)に分ける。 */
async function missOrConflict(dealId: string, partyId: string): Promise<never> {
  const cur = await prisma.dealParty.findFirst({ where: { id: partyId, dealId }, select: { id: true } });
  if (!cur) throw new ApiError(404, "当事者が見つかりません", "NOT_FOUND");
  throw new ApiError(409, DEAL_VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
}

export async function PATCH(request: Request, ctx: Ctx) {
  try {
    const { session } = await requireDeal("write");
    const { dealId, partyId } = await ids(ctx);
    const { version, ...patch } = partyUpdateSchema.parse(await parseJsonBody(request));
    const res = await prisma.dealParty.updateMany({
      where: { id: partyId, dealId, version },
      data: { ...patch, version: { increment: 1 } },
    });
    if (res.count === 0) await missOrConflict(dealId, partyId);
    await writeAuditLog({
      userId: session.id, action: "deal_party_update", targetTable: "deals", targetId: dealId,
      detail: { fields: Object.keys(patch).sort() },
    });
    return NextResponse.json({ version: version + 1 }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request, ctx: Ctx) {
  try {
    const { session } = await requireDeal("write");
    const { dealId, partyId } = await ids(ctx);
    const version = z.coerce.number().int().positive().parse(new URL(request.url).searchParams.get("version"));
    const res = await prisma.dealParty.deleteMany({ where: { id: partyId, dealId, version } });
    if (res.count === 0) await missOrConflict(dealId, partyId);
    await writeAuditLog({
      userId: session.id, action: "deal_party_delete", targetTable: "deals", targetId: dealId, detail: { fields: [] },
    });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
