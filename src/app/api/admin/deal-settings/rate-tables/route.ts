import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireDealAdmin } from "@/lib/deals/guard";

const day = (d: Date) => d.toISOString().slice(0, 10);

/** 税率・税額の表(段1は見るだけ。編集は段2)。 */
export async function GET() {
  try {
    await requireDealAdmin();
    const rows = await prisma.dealRateTable.findMany({ orderBy: [{ kind: "asc" }, { validFrom: "asc" }] });
    return NextResponse.json(
      { tables: rows.map((r) => ({ id: r.id, kind: r.kind, validFrom: day(r.validFrom), validTo: r.validTo ? day(r.validTo) : null, content: r.content })) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
