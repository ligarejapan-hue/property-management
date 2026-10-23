import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireDealAdmin, DEAL_VERSION_CONFLICT_MESSAGE } from "@/lib/deals/guard";
import { periodsOverlap, RATE_CONTENT_SCHEMAS } from "@/lib/deals/rate-content";
import type { RateTableKind } from "@/lib/deals/rate-tables";

type Ctx = { params: Promise<{ id: string }> };
const day = (d: Date) => d.toISOString().slice(0, 10);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const NO_STORE = { "Cache-Control": "no-store" };

const putSchema = z.object({
  validFrom: dateStr, validTo: dateStr.nullable(), content: z.unknown(), updatedAt: z.string().datetime(),
}).strict().refine((v) => v.validTo === null || v.validTo >= v.validFrom, "終わりの日は始まりの日以降にしてください");

async function current(ctx: Ctx) {
  const id = z.string().uuid().parse((await ctx.params).id);
  const row = await prisma.dealRateTable.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, "表が見つかりません", "NOT_FOUND");
  return row;
}

/** 表を直す(期間・中身)。更新日時が合わなければ 409=ほかの人が先に直した。 */
export async function PUT(request: Request, ctx: Ctx) {
  try {
    const session = await requireDealAdmin();
    const row = await current(ctx);
    const body = putSchema.parse(await parseJsonBody(request));
    const content = RATE_CONTENT_SCHEMAS[row.kind as RateTableKind]?.safeParse(body.content);
    if (!content?.success) throw new ApiError(422, "表の中身が正しくありません", "INVALID_CONTENT");
    const same = await prisma.dealRateTable.findMany({ where: { kind: row.kind }, select: { id: true, validFrom: true, validTo: true } });
    if (same.some((r) => r.id !== row.id && periodsOverlap(body, { validFrom: day(r.validFrom), validTo: r.validTo ? day(r.validTo) : null }))) {
      throw new ApiError(422, "同じ種類の表と期間が重なっています", "PERIOD_OVERLAP");
    }
    const res = await prisma.dealRateTable.updateMany({
      where: { id: row.id, updatedAt: new Date(body.updatedAt) },
      data: {
        validFrom: new Date(`${body.validFrom}T00:00:00Z`), validTo: body.validTo ? new Date(`${body.validTo}T00:00:00Z`) : null,
        content: content.data as object, updatedById: session.id,
      },
    });
    if (res.count === 0) throw new ApiError(409, DEAL_VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
    await writeAuditLog({
      userId: session.id, action: "deal_rate_table_update", targetTable: "deal_rate_tables", targetId: row.id,
      detail: { fields: ["validFrom", "validTo", "content"] },
    });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request, ctx: Ctx) {
  try {
    const session = await requireDealAdmin();
    const row = await current(ctx);
    const updatedAt = z.string().datetime().parse(new URL(request.url).searchParams.get("updatedAt"));
    const res = await prisma.dealRateTable.deleteMany({ where: { id: row.id, updatedAt: new Date(updatedAt) } });
    if (res.count === 0) throw new ApiError(409, DEAL_VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
    await writeAuditLog({
      userId: session.id, action: "deal_rate_table_delete", targetTable: "deal_rate_tables", targetId: row.id, detail: { fields: [] },
    });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
