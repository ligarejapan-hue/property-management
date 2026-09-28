import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireAgentInquiry } from "@/lib/agent-inquiry/guard";
import { DESK_PROPERTY_SELECT, toDeskProperty } from "@/lib/agent-inquiry/desk-property";

const LIMIT = 20;
const MAX_TERMS = 4;

const termWhere = (t: string) => ({
  OR: [
    { buildingName: { contains: t, mode: "insensitive" as const } },
    { building: { name: { contains: t, mode: "insensitive" as const } } },
    { roomNo: { contains: t } },
    { address: { contains: t, mode: "insensitive" as const } },
  ],
});

/**
 * 受付の窓の物件検索(設計 §4・方針10)。反響の受付の権限があれば全物件が対象(現地スタッフの
 * 作成者/担当の制限を掛けない=電話は誰が取るか分からない)。その代わり返す項目は許可リスト
 * (toDeskProperty)だけ、検索条件も物件名・棟名・部屋番号・所在地だけ=所有者・地番・メモでは
 * 当たらない(返さない情報を検索のヒット有無から推測させない)。しまった物件は出さない。
 */
export async function GET(request: Request) {
  try {
    await requireAgentInquiry("read");
    const q = (new URL(request.url).searchParams.get("q") ?? "").normalize("NFKC").trim();
    if ([...q].length < 2) {
      return NextResponse.json({ properties: [] }, { headers: { "Cache-Control": "no-store" } });
    }
    const terms = q.split(/\s+/).filter(Boolean).slice(0, MAX_TERMS);
    const rows = await prisma.property.findMany({
      where: { isArchived: false, AND: terms.map(termWhere) },
      select: DESK_PROPERTY_SELECT,
      orderBy: { updatedAt: "desc" },
      take: LIMIT,
    });
    return NextResponse.json({ properties: rows.map(toDeskProperty) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
