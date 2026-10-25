import type { RegistryRightsSummary } from "@/lib/registry-strike";

/**
 * 取引の物件の謄本(全部事項の最新の1件)から読んだ「登記の現況」(設計 §4.6.1・計画 段5c-2)。
 * 判定結果は保存しない(開くたび・出すたびに読む)。
 * ⚠summary には氏名・住所が入る。画面へは registryRightsView、書類へは registryDocInfo を通す。
 */
export type DealRegistryState =
  | { status: "none" }
  | { status: "unreadable" }
  | { status: "ok"; attachmentCreatedAt: string; summary: RegistryRightsSummary };

export type RegistryRightsView =
  | { status: "none" }
  | { status: "unreadable" }
  | {
    status: "ok";
    attachmentCreatedAt: string;
    activeRights: { rank: string; purpose: string; amount: string | null; holder: string | null }[];
    cautions: { section: "甲区" | "乙区"; rank: string; purpose: string }[];
    notes: string[];
  };

/** 甲区を読めない謄本は判定できない(自動の項目は出さない)。 */
const readable = (s: DealRegistryState): s is Extract<DealRegistryState, { status: "ok" }> => s.status === "ok" && s.summary.hasKouku;

/** 画面に出す形。権利者名は「所有者の閲覧」もある人だけ。債務者・今の所有者は出さない。 */
export function registryRightsView(s: DealRegistryState, o: { showNames: boolean }): RegistryRightsView {
  if (s.status === "none") return { status: "none" };
  if (!readable(s)) return { status: "unreadable" };
  return {
    status: "ok",
    attachmentCreatedAt: s.attachmentCreatedAt,
    activeRights: s.summary.activeRights.map((r) => ({ rank: r.rank, purpose: r.purpose, amount: r.amount, holder: o.showNames ? r.holder : null })),
    cautions: s.summary.cautions.map((c) => ({ section: c.section, rank: c.rank, purpose: c.purpose })),
    notes: [...s.summary.notes],
  };
}

export const REGISTRY_UNREADABLE_NOTE = "謄本を確認してください(登記の現況を判定できませんでした)";

/** 書類確認書に使うもの(名前は入れない): 残っている乙区の権利の件数と、頭に出す注意の1行。 */
export function registryDocInfo(s: DealRegistryState): { activeRights: number; caution: string | null } {
  if (s.status === "none") return { activeRights: 0, caution: null };
  if (!readable(s)) return { activeRights: 0, caution: REGISTRY_UNREADABLE_NOTE };
  const parts = [
    ...(s.summary.cautions.length ? [`${s.summary.cautions.map((c) => `${c.section} ${c.rank}番 ${c.purpose}`).join("・")}が残っています。`] : []),
    ...s.summary.notes,
  ];
  return { activeRights: s.summary.activeRights.length, caution: parts.length ? parts.join("/ ") : null };
}
