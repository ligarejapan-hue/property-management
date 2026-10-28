import type { FormChoice, FormDef } from "./types";

/** 媒介契約書の型(設計 第2段階 §4.5)。同じ書類の中でタブで選ぶ(発注者の指示 2026-10-28)。 */
export type MediationKind = "general" | "exclusive" | "dedicated";
export const MEDIATION_KIND_LABELS: Record<MediationKind, string> = { general: "一般", exclusive: "専任", dedicated: "専属専任" };

/** to から from まで(大きいほうが先=初めの値は法の範囲でいちばん長いもの)。 */
const range = (from: number, to: number): FormChoice[] => Array.from({ length: to - from + 1 }, (_, i) => ({ value: String(to - i), label: `${to - i}` }));
const YN: FormChoice[] = [{ value: "yes", label: "有" }, { value: "no", label: "無" }];
const FIXED: MediationKind[] = ["exclusive", "dedicated"];

/**
 * 法の範囲(宅建業法 34条の2)の選択肢だけを持つ(計画 段D の決めたこと 3)。
 * 型ごとに別の欄にする(タブを切り替えても、ほかの型の値が法の範囲を超えて残らない)。
 */
export const MEDIATION_FORM: FormDef = {
  key: "mediation",
  tabs: {
    key: "kind", label: "契約の型",
    choices: (Object.keys(MEDIATION_KIND_LABELS) as MediationKind[]).map((k) => ({ value: k, label: MEDIATION_KIND_LABELS[k] })),
  },
  entries: [
    { kind: "section", title: "契約" },
    { kind: "item", key: "requestKind", label: "依頼の内容", choices: [{ value: "sale", label: "売却" }, { value: "purchase", label: "購入" }, { value: "exchange", label: "交換" }] },
    { kind: "item", key: "contractDate", label: "契約の日付", fields: [{ key: "contractDateText", label: "日付(例: 2026年11月1日)", max: 30 }] },
    { kind: "item", key: "months", label: "有効期間(月)", choices: range(1, 3), fields: [{ key: "expiry", label: "満了日(例: 2027年1月31日)", max: 30 }] },
    { kind: "item", key: "otherAgentsItem", label: "依頼する乙以外の宅地建物取引業者(1行に1社「商号 / 所在地」)", only: ["general"], fields: [{ key: "otherAgents", label: "業者", max: 1000, lines: 3 }] },
    { kind: "item", key: "listing", label: "指定流通機構への登録の有無", only: ["general"], choices: YN, fields: [{ key: "listingName", label: "指定流通機構の名称", max: 100 }] },
    { kind: "item", key: "reportMethod", label: "業務の処理状況の報告の方法", only: FIXED, choices: [{ value: "document", label: "文書" }, { value: "email", label: "電子メール" }] },
    { kind: "item", key: "reportFrequencyExclusive", label: "報告の頻度", only: ["exclusive"], choices: [{ value: "２週間に１", label: "２週間に１回以上" }, { value: "１週間に１", label: "１週間に１回以上" }] },
    { kind: "item", key: "reportFrequencyDedicated", label: "報告の頻度", only: ["dedicated"], choices: [{ value: "１週間に１", label: "１週間に１回以上" }] },
    { kind: "item", key: "registryItem", label: "登録する指定流通機構", only: FIXED, fields: [{ key: "registryName", label: "名称", max: 100 }] },
    { kind: "item", key: "registerDaysExclusive", label: "登録までの日数(契約の翌日から・休業日を除く)", only: ["exclusive"], choices: range(1, 7) },
    { kind: "item", key: "registerDaysDedicated", label: "登録までの日数(契約の翌日から・休業日を除く)", only: ["dedicated"], choices: range(1, 5) },
    { kind: "item", key: "otherDutyItem", label: "そのほかの業務", fields: [{ key: "otherDuty", label: "内容", max: 200 }] },
    { kind: "item", key: "inspection", label: "建物状況調査を実施する者のあっせん", choices: YN, fields: [{ key: "inspectionReason", label: "「無」の理由(既存の住宅のとき)", max: 200 }] },
    { kind: "section", title: "報酬・特約" },
    { kind: "item", key: "feeItem", label: "約定報酬額", fields: [{ key: "feeExcl", label: "税抜き(円)", max: 20 }, { key: "feeTax", label: "消費税(円)", max: 20 }] },
    { kind: "item", key: "feeTimingItem", label: "約定報酬の受領の時期", fields: [{ key: "feeTiming", label: "時期", max: 200 }] },
    { kind: "item", key: "specialTermsItem", label: "特約事項", fields: [{ key: "specialTerms", label: "内容", max: 2000, lines: 4 }] },
  ],
};
