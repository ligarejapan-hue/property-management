import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireDeal } from "@/lib/deals/guard";
import { searchDirectory } from "@/lib/bank-directory/search";

/**
 * 金融機関の候補(2026-11-17 発注者「銀行名の一文字目で検索」)。取引のお金の受け渡し・取引の設定の口座で使う。
 * GET /api/deals/bank-directory/banks?q=… → { data: [{ code, name }] }(name=正式な名前・最大20件)。
 * 表は1,100件ほどなので全件読んで純関数で絞る(探し方は src/lib/bank-directory/search.ts)。
 */
export async function GET(request: Request) {
  try {
    await requireDeal("read");
    const q = (new URL(request.url).searchParams.get("q") ?? "").slice(0, 50);
    if (q.trim() === "") return NextResponse.json({ data: [] }, { headers: { "Cache-Control": "no-store" } });
    const rows = await prisma.bankInstitution.findMany({ select: { code: true, name: true, kana: true, roma: true } });
    const data = searchDirectory(q, rows).map(({ code, name }) => ({ code, name }));
    return NextResponse.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
