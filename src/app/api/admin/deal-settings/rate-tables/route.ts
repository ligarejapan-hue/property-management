import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireDealAdmin } from "@/lib/deals/guard";
import { periodsOverlap, rateTableInputSchema, rateTableLockKey } from "@/lib/deals/rate-content";

const day = (d: Date) => d.toISOString().slice(0, 10);
const NO_STORE = { "Cache-Control": "no-store" };

/** 税率・税額の表の一覧(管理者)。直すときの楽観ロックに updatedAt を返す。 */
export async function GET() {
  try {
    await requireDealAdmin();
    const rows = await prisma.dealRateTable.findMany({ orderBy: [{ kind: "asc" }, { validFrom: "asc" }] });
    return NextResponse.json(
      {
        tables: rows.map((r) => ({
          id: r.id, kind: r.kind, validFrom: day(r.validFrom), validTo: r.validTo ? day(r.validTo) : null,
          content: r.content, updatedAt: r.updatedAt.toISOString(),
        })),
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    return handleApiError(error);
  }
}

/** 新しい期間の表を足す。同じ種類で期間が重なるものがあれば 422。 */
export async function POST(request: Request) {
  try {
    const session = await requireDealAdmin();
    const body = rateTableInputSchema.parse(await parseJsonBody(request));
    // 期間の重なりの確かめと書き込みを、種類ごとに1つずつにする(同時に2人が足しても重ならない・@codex 2巡目)。
    const created = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${rateTableLockKey(body.kind)})::bigint)`;
      const same = await tx.dealRateTable.findMany({ where: { kind: body.kind }, select: { id: true, validFrom: true, validTo: true } });
      if (same.some((r) => periodsOverlap(body, { validFrom: day(r.validFrom), validTo: r.validTo ? day(r.validTo) : null }))) {
        throw new ApiError(422, "同じ種類の表と期間が重なっています", "PERIOD_OVERLAP");
      }
      return tx.dealRateTable.create({
        data: {
          kind: body.kind, validFrom: new Date(`${body.validFrom}T00:00:00Z`),
          validTo: body.validTo ? new Date(`${body.validTo}T00:00:00Z`) : null,
          content: body.content as object, updatedById: session.id,
        },
        select: { id: true },
      });
    });
    await writeAuditLog({
      userId: session.id, action: "deal_rate_table_create", targetTable: "deal_rate_tables", targetId: created.id,
      detail: { fields: ["kind", "validFrom", "validTo", "content"] },
    });
    return NextResponse.json(created, { status: 201, headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
