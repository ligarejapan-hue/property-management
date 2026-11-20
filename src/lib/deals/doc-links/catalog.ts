import { scopeApplies, type ChecklistDealScope, type ChecklistScope } from "../checklist";
import type { DocLinkRole } from "./constants";

/**
 * お客様に出してもらう書類の一覧(売主・買主ごと・2026-11-20 発注者)。書類確認書の項目からは作らない。
 * ⚠書類確認書と同じ書類は、書類確認書の id のまま(受領すると書類確認書に ✓ が付く=receivedChecklistItemIds)。
 *   新しい書類の id は書類確認書の項目とぶつけない(doc_ で始める)。段取りは id を見ない(発行の有無と件数だけ)。
 * ⚠発行済みの依頼(DB の行)は、その時点の名前のまま残る(書き換えない)。
 */
export type DocLinkCatalogItem = { id: string; label: string; roles: readonly DocLinkRole[]; scope: ChecklistScope };

const BOTH = ["seller", "buyer"] as const;
export const DOC_LINK_CATALOG: readonly DocLinkCatalogItem[] = [
  { id: "s_bring_seal", label: "実印・印鑑証明書", roles: BOTH, scope: "all" },
  { id: "s_bring_id", label: "写真付き身分証明書", roles: BOTH, scope: "all" },
  { id: "s_bring_resident", label: "住民票", roles: BOTH, scope: "all" },
  { id: "doc_tax_certificate", label: "納税証明書", roles: ["buyer"], scope: "all" },
  { id: "doc_hoa_minutes", label: "管理組合議事録", roles: ["seller"], scope: "unit" },
  { id: "doc_purchase_brochure", label: "購入時のパンフレットや間取図", roles: ["seller"], scope: "all" },
  { id: "doc_property_tax_notice", label: "固定資産税・都市計画税課税明細書", roles: ["seller"], scope: "all" },
  { id: "s_recv_survey", label: "境界確認書・測量図", roles: ["seller"], scope: "land" },
  { id: "s_recv_leases", label: "賃貸借契約書の原本・預り敷金の明細", roles: ["seller"], scope: "oc" },
];

/** 発行画面に出す書類(その相手の役割と、取引の種別・OC に合うもの)。 */
export function docLinkOptionsFor(role: DocLinkRole, deal: ChecklistDealScope): { id: string; label: string }[] {
  return DOC_LINK_CATALOG.filter((c) => c.roles.includes(role) && scopeApplies(c.scope, deal)).map((c) => ({ id: c.id, label: c.label }));
}

/** 提出ページで書類名の下に出す、お客様向けの一言と撮り方の注意。 */
export type DocLinkHint = { text: string; howto: readonly string[] };
const HINTS: Readonly<Record<string, DocLinkHint>> = {
  s_bring_id: {
    text: "運転免許証・マイナンバーカード・パスポートなど（法務局や住宅ローンの手続きに使えるもの）",
    // マイナンバー(個人番号)は集めない(2026-11-20 発注者「番号を隠すように注意書きを」)。
    howto: [
      "運転免許証は表と裏の両方",
      "パスポートは顔写真が載っているページ",
      "マイナンバーカードは表面だけ。裏面の番号（マイナンバー）は写さないか、隠してください",
    ],
  },
};
export const docLinkHintOf = (checklistItemId: string): DocLinkHint | null => HINTS[checklistItemId] ?? null;
