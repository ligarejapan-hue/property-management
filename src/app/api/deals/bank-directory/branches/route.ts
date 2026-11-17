import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { requireDeal } from "@/lib/deals/guard";
import { searchDirectory } from "@/lib/bank-directory/search";

/**
 * 支店の候補(2026-11-17 発注者「支店名は一文字目で、その銀行の支店の中から選ぶ」)。
 * GET /api/deals/bank-directory/branches?bank=<銀行コード4桁>&q=… → { data: [{ code, name }] }(最大20件)。
 * その銀行の支店だけを読んで純関数で絞る(1行あたり最大でも数百件)。
 */
export async function GET(request: Request) {
  try {
    await requireDeal("read");
    const params = new URL(request.url).searchParams;
    const bank = params.get("bank") ?? "";
    if (!/^\d{4}$/.test(bank)) throw new ApiError(400, "銀行コードの形が違います", "BAD_REQUEST");
    const q = (params.get("q") ?? "").slice(0, 50);
    if (q.trim() === "") return NextResponse.json({ data: [] }, { headers: { "Cache-Control": "no-store" } });
    const rows = await prisma.bankBranch.findMany({
      where: { bankCode: bank },
      select: { code: true, name: true, kana: true, roma: true },
    });
    const data = searchDirectory(q, rows).map(({ code, name }) => ({ code, name }));
    return NextResponse.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
