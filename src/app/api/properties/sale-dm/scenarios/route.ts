import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireScenarioAdmin } from "@/lib/sale-dm-letter/scenario-guard";
import { saleDmScenarioCreateSchema } from "@/lib/validators-sale-dm";

/**
 * DMの種類(台帳)の一覧(設計 §3.6/§4)。中身の読み書きは管理者だけ。
 * 一覧では文面そのものは返さず「登録済みか(hasLetter/hasLp)」だけを返す。
 */
export async function GET() {
  try {
    await requireScenarioAdmin();
    const rows = await prisma.dmScenario.findMany({
      where: { deletedAt: null },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        autoKey: true,
        sortOrder: true,
        active: true,
        letterBodyTemplate: true,
        lpBodyText: true,
        updatedAt: true,
      },
    });
    return NextResponse.json(
      {
        scenarios: rows.map(({ letterBodyTemplate, lpBodyText, ...r }) => ({
          ...r,
          hasLetter: !!letterBodyTemplate,
          hasLp: !!lpBodyText,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}

/** 台帳への追加(名前だけ・他項目は後から PATCH)。同名(削除されていない行)は 409。 */
export async function POST(request: Request) {
  try {
    const { session } = await requireScenarioAdmin();
    const parsed = saleDmScenarioCreateSchema.parse(await parseJsonBody(request));
    const max = await prisma.dmScenario.aggregate({
      _max: { sortOrder: true },
      where: { deletedAt: null },
    });
    let row: { id: string };
    try {
      row = await prisma.dmScenario.create({
        data: { name: parsed.name, sortOrder: (max._max.sortOrder ?? 0) + 10 },
        select: { id: true },
      });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") {
        throw new ApiError(409, "同じ名前のDMの種類があります", "NAME_TAKEN");
      }
      throw e;
    }
    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_scenario_create",
      targetTable: "dm_scenarios",
      targetId: row.id,
      detail: { result: "created" },
    });
    return NextResponse.json({ id: row.id }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
