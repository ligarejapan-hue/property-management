import { z } from "zod";
import { text } from "./schema-parts";
import type { BASE_PROPERTY_KINDS } from "./constants";

/**
 * 書類確認書(契約時・決済時)の項目(設計 §4.6・計画 段5c-1)。項目は「取引の設定」に持つ。
 * 初めの項目は、どの会社でも使える一般的なもの(リースバックの項目は入れない)。
 */
export const CHECKLIST_PHASES = { contract: "契約時", settlement: "決済時" } as const;
export type ChecklistPhase = keyof typeof CHECKLIST_PHASES;
export const CHECKLIST_GROUPS = {
  prepare: "事前に手配・確認するもの", bring: "持参するもの", receive: "受け取るもの",
} as const;
export type ChecklistGroup = keyof typeof CHECKLIST_GROUPS;
/** land = 土地のある物件(元の種別が戸建・土地・一棟)。 */
export const CHECKLIST_SCOPES = {
  all: "すべての取引", unit: "区分だけ", land: "土地のある物件だけ(戸建・土地・一棟)", oc: "OC ありだけ",
} as const;
export type ChecklistScope = keyof typeof CHECKLIST_SCOPES;
/** 持参する金額の出どころ(持参するものだけに付ける)。 */
export const CHECKLIST_AMOUNTS = {
  deposit: "手付金", payment: "残代金・精算金(決済の計算)", registration: "登記費用", cancellation: "抹消費用", survey: "測量費",
} as const;
export type ChecklistAmount = keyof typeof CHECKLIST_AMOUNTS;
export const CHECKLIST_AMOUNT_KEYS = Object.keys(CHECKLIST_AMOUNTS) as ChecklistAmount[];
/** 持参する金額の払い方(発行のときに選ぶ)。 */
export const CHECKLIST_PAY_METHODS = { cash: "現金", from_deposit: "手付金から", from_balance: "残金から" } as const;
export type ChecklistPayMethod = keyof typeof CHECKLIST_PAY_METHODS;

export const CHECKLIST_ITEM_ID = /^[a-z0-9_]{1,40}$/;
export const CHECKLIST_LIMITS = { label: 60, note: 200, items: 100 } as const;

const keys = <T extends Record<string, string>>(o: T) => Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];

const checklistItemSchema = z.object({
  id: z.string().regex(CHECKLIST_ITEM_ID),
  phase: z.enum(keys(CHECKLIST_PHASES)),
  group: z.enum(keys(CHECKLIST_GROUPS)),
  label: z.string().trim().min(1, "項目名が空の行があります").max(CHECKLIST_LIMITS.label, `項目名は${CHECKLIST_LIMITS.label}文字までです`),
  note: text(CHECKLIST_LIMITS.note),
  scope: z.enum(keys(CHECKLIST_SCOPES)),
  amount: z.enum(keys(CHECKLIST_AMOUNTS)).nullable(),
}).strict().refine((i) => i.amount === null || i.group === "bring", "金額は「持参するもの」だけに付けられます");
export type ChecklistItem = z.output<typeof checklistItemSchema>;

export const checklistItemsSchema = z.array(checklistItemSchema).min(1, "項目を1つ以上入れてください").max(CHECKLIST_LIMITS.items)
  .refine((is) => new Set(is.map((i) => i.id)).size === is.length, "項目の鍵が重なっています");

type Seed = [id: string, label: string, opts?: { note?: string; scope?: ChecklistScope; amount?: ChecklistAmount }];
const seed = (phase: ChecklistPhase, group: ChecklistGroup, rows: Seed[]): ChecklistItem[] =>
  rows.map(([id, label, o]) => ({ id, phase, group, label, note: o?.note ?? null, scope: o?.scope ?? "all", amount: o?.amount ?? null }));

export const DEFAULT_CHECKLIST_ITEMS: ChecklistItem[] = [
  ...seed("contract", "prepare", [
    ["c_contract_draft", "売買契約書・重要事項説明書の作成と読み合わせ"],
    ["c_registry", "登記事項証明書・公図の取得", { note: "最新のもので所有者・権利を確認" }],
    ["c_identity", "当事者の本人確認", { note: "本人確認書類の写しを取る" }],
    ["c_deposit_account", "手付金の受け渡し方法の確認"],
    ["c_bylaws", "管理規約・重要事項調査報告書の取得", { scope: "unit" }],
    ["c_boundary", "境界・越境の確認", { scope: "land" }],
    ["c_leases", "賃貸借契約書・賃借人一覧の確認", { scope: "oc" }],
  ]),
  ...seed("contract", "bring", [
    ["c_bring_deposit", "手付金", { amount: "deposit" }],
    ["c_bring_stamp", "収入印紙", { note: "契約金額に応じた額" }],
    ["c_bring_seal", "印鑑(認印または実印)"],
    ["c_bring_id", "本人確認書類"],
  ]),
  ...seed("contract", "receive", [
    ["c_recv_contract", "売買契約書(署名・押印済み)"],
    ["c_recv_receipt", "手付金の領収書"],
    ["c_recv_explanation", "重要事項説明書の写し"],
  ]),
  ...seed("settlement", "prepare", [
    ["s_scrivener", "司法書士への登記の依頼", { note: "必要書類と日時を伝える" }],
    ["s_statement", "精算金額の確認", { note: "精算書の金額を当事者と確認" }],
    ["s_bank", "金融機関との日時・送金方法の確認"],
    ["s_valuation", "固定資産評価証明書の取得"],
    ["s_management", "管理会社への所有者変更の連絡", { scope: "unit" }],
    ["s_tenants", "賃借人への賃貸人変更の通知の準備", { scope: "oc" }],
  ]),
  ...seed("settlement", "bring", [
    ["s_bring_payment", "残代金・精算金", { amount: "payment" }],
    ["s_bring_registration", "登記費用", { amount: "registration", note: "司法書士へ" }],
    ["s_bring_seal", "実印・印鑑証明書"],
    ["s_bring_id", "本人確認書類"],
    ["s_bring_resident", "住民票", { note: "登記上の住所と今の住所が違うとき" }],
  ]),
  ...seed("settlement", "receive", [
    ["s_recv_keys", "鍵"],
    ["s_recv_title", "登記識別情報(権利証)・登記に必要な書類", { note: "司法書士が確認" }],
    ["s_recv_receipt", "残代金・精算金の領収書"],
    ["s_recv_bylaws", "管理規約・使用細則", { scope: "unit" }],
    ["s_recv_survey", "境界確認書・測量図", { scope: "land" }],
    ["s_recv_leases", "賃貸借契約書の原本・預り敷金の明細", { scope: "oc" }],
  ]),
];

/** 保存した項目(壊れている・空なら初めの項目)。 */
export function resolveChecklistItems(raw: unknown): ChecklistItem[] {
  const r = checklistItemsSchema.safeParse(raw);
  return r.success ? r.data : DEFAULT_CHECKLIST_ITEMS;
}

/** その取引・時点で出す項目(並びは保存の順のまま)。 */
export function itemsFor(
  items: ChecklistItem[], phase: ChecklistPhase, deal: { base: (typeof BASE_PROPERTY_KINDS)[number] | null; hasOc: boolean },
): ChecklistItem[] {
  const ok = (s: ChecklistScope) =>
    s === "all" || (s === "unit" && deal.base === "unit") || (s === "oc" && deal.hasOc)
    || (s === "land" && (deal.base === "house" || deal.base === "land" || deal.base === "building"));
  return items.filter((i) => i.phase === phase && ok(i.scope));
}
