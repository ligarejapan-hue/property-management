import type { DealSide } from "@/lib/property-business-type";

/** 自社の当事者を作るのに使う会社の情報(会社の設定の値)。 */
export interface SelfCompany { nameJa: string; address: string; tel: string }

/**
 * 買取再販の取引を「仕入」「売却」で作るときの自社の当事者(2026-11-05 発注者: 仕入と売却は取引を分ける)。
 * 仕入=買主が自社・売却=売主が自社。仕入か売却かは今までどおり当事者の自社から読む(dealSideOf)。
 */
export function selfPartyFor(side: DealSide, company: SelfCompany) {
  return {
    role: side === "purchase" ? ("buyer" as const) : ("seller" as const),
    partyType: "corporation" as const,
    name: company.nameJa.trim() || "自社",
    representative: null,
    address: company.address.trim() || null,
    phone: company.tel.trim() || null,
    shareNum: null,
    shareDen: null,
    isSelf: true,
  };
}
