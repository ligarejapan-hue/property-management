import { z } from "zod";
import { CROSSCHECK_NOTICE_IDS, type CrosscheckResult } from "./crosscheck";
import type { BasePropertyKind } from "./constants";

/**
 * 決済から逆算した段取り。**純関数だけ**(DB は schedule-sync.ts)。
 * ひな形は「取引の設定」に持ち、取引の日付と条件から項目を作る・付け直す。
 * 日付は日本時間の YYYY-MM-DD の文字列で扱う。
 */
export const SCHEDULE_BASES = { contract: "契約日", settlement: "決済日" } as const;
export type ScheduleBase = keyof typeof SCHEDULE_BASES;
/** 売主側・買主側には両手も含める(自社が両方を担当するため)。 */
export const SCHEDULE_TRADE_SCOPES = {
  all: "すべて", brokerage: "仲介(すべて)", brokerage_seller: "仲介 売主側(両手を含む)", brokerage_buyer: "仲介 買主側(両手を含む)", resale: "買取再販",
} as const;
export type ScheduleTradeScope = keyof typeof SCHEDULE_TRADE_SCOPES;
export const SCHEDULE_CONDITIONS = {
  all: "条件なし", unit: "区分だけ", land: "土地のある物件だけ", oc: "OC ありだけ", active_mortgage: "有効な担保があるときだけ",
} as const;
export type ScheduleCondition = keyof typeof SCHEDULE_CONDITIONS;
export const SCHEDULE_ASSIGNEE_RULES = { assignee: "取引の担当", sales: "営業担当", ops: "事務担当" } as const;
export type ScheduleAssigneeRule = keyof typeof SCHEDULE_ASSIGNEE_RULES;

export const SCHEDULE_LIMITS = { label: 60, items: 100, offsetDays: 365 } as const;
export const SCHEDULE_ITEM_ID = /^[a-z0-9_]{1,40}$/;
export const MORTGAGE_UNKNOWN_NOTE = "担保の有無を確認してください";
export const PRE_INTRODUCTION_NOTE = "済んでいれば完了にしてください";
export const COMPLETION_HINTS = {
  doc_issued: "書類を発行しました。送付・受け取りが済んだら完了にしてください",
  mortgage_cleared: "抹消済みの謄本を取り込みました。完了にしてよいか確認してください",
} as const;
export type CompletionHint = keyof typeof COMPLETION_HINTS;
/** 担保の有無。unknown=判定できない(物件が手入力・謄本が無い・読めない・足りない)。 */
export type MortgageState = "yes" | "no" | "unknown";

const keys = <T extends Record<string, string>>(o: T) => Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];

const templateItemSchema = z.object({
  id: z.string().regex(SCHEDULE_ITEM_ID),
  label: z.string().trim().min(1, "作業名が空の行があります").max(SCHEDULE_LIMITS.label, `作業名は${SCHEDULE_LIMITS.label}文字までです`),
  base: z.enum(keys(SCHEDULE_BASES)),
  /** 基準日からの日数(前はマイナス・後はプラス)。 */
  offsetDays: z.number().int().min(-SCHEDULE_LIMITS.offsetDays).max(SCHEDULE_LIMITS.offsetDays),
  tradeScope: z.enum(keys(SCHEDULE_TRADE_SCOPES)),
  condition: z.enum(keys(SCHEDULE_CONDITIONS)),
  assigneeRule: z.enum(keys(SCHEDULE_ASSIGNEE_RULES)),
}).strict();
export type ScheduleTemplateItem = z.output<typeof templateItemSchema>;

export const scheduleTemplateSchema = z.array(templateItemSchema).min(1, "段取りの項目を1つ以上入れてください").max(SCHEDULE_LIMITS.items)
  .refine((is) => new Set(is.map((i) => i.id)).size === is.length, "段取りの項目の鍵が重なっています");

const row = (
  id: string, label: string, base: ScheduleBase, offsetDays: number,
  tradeScope: ScheduleTradeScope = "all", condition: ScheduleCondition = "all",
): ScheduleTemplateItem => ({ id, label, base, offsetDays, tradeScope, condition, assigneeRule: "assignee" });

export const DEFAULT_SCHEDULE_TEMPLATE: ScheduleTemplateItem[] = [
  row("c_scrivener", "司法書士に決済日時と登記を依頼", "contract", 1),
  row("c_mortgage", "金融機関に抵当権抹消の書類を依頼", "contract", 3, "all", "active_mortgage"),
  row("s_management_report", "管理会社に重要事項調査報告書と管理費等の精算額を確認", "settlement", -21, "all", "unit"),
  row("s_seller_docs", "売主に決済時の必要書類を案内", "settlement", -21, "brokerage_seller"),
  row("s_tax", "固定資産税・都市計画税の年税額を確認", "settlement", -14),
  row("s_statement", "精算書を作成", "settlement", -7),
  row("s_loan", "融資実行の手配", "settlement", -7, "resale"),
  row("s_broker_check", "相手業者と精算金額を照合", "settlement", -5, "brokerage"),
  row("s_final", "残代金・精算金の最終確認と残金決済のご案内の送付", "settlement", -3),
  row("s_insurance", "火災保険の手配", "settlement", -3, "resale"),
  row("s_keys_docs", "鍵・書類一式をそろえる", "settlement", -1),
  row("s_settle", "決済・引渡し", "settlement", 0),
  row("s_key_receipt", "鍵受領書の受け取り", "settlement", 0),
  row("s_tenant_notice", "賃借人への所有者変更と賃料振込先の通知", "settlement", 0, "all", "oc"),
  row("s_mgmt_notify", "管理会社へ所有者変更の届出", "settlement", 1, "all", "unit"),
];

/** 保存したひな形(空・壊れているなら初期のひな形)。 */
export function resolveScheduleTemplate(raw: unknown): ScheduleTemplateItem[] {
  const r = scheduleTemplateSchema.safeParse(raw);
  return r.success ? r.data : DEFAULT_SCHEDULE_TEMPLATE;
}

/** 発行で完了にする項目(発行そのものが作業の完了と言える書類だけ)。鍵で結ぶので作業名を変えても効く。 */
const COMPLETE_ON_ISSUE: Readonly<Record<string, string>> = { settlement_statement: "s_statement", checklist_settlement: "s_seller_docs" };
/** 発行だけでは送付・受け取りまで確かめられない書類=完了候補にする。 */
const HINT_ON_ISSUE: Readonly<Record<string, string>> = {
  settlement_guide: "s_final", settlement_guide_seller: "s_final", key_receipt: "s_key_receipt", landlord_change_notice: "s_tenant_notice",
};
const SETTLE_KEY = "s_settle";
const TAX_KEY = "s_tax";

// ---------- 日付 ----------

export function addYmdDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
const diffDays = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00.000Z`) - Date.parse(`${b}T00:00:00.000Z`)) / 86_400_000);

/**
 * 土日の期限を寄せる。基準日より前は前の金曜、後は次の月曜。
 * 基準日の当日(offset 0)は寄せない: 決済や契約がその日にあるので、日付が動くと作業の日がずれる。
 */
export function shiftOffWeekend(ymd: string, offsetDays: number): string {
  if (offsetDays === 0) return ymd;
  const day = new Date(`${ymd}T00:00:00.000Z`).getUTCDay();
  if (day !== 0 && day !== 6) return ymd;
  if (offsetDays < 0) return addYmdDays(ymd, day === 6 ? -1 : -2);
  return addYmdDays(ymd, day === 6 ? 2 : 1);
}

export interface ReconcileDeal {
  businessType: string;
  tradeSide: string | null;
  kindBase: BasePropertyKind | null;
  hasOc: boolean;
  status: string;
  contractDate: string | null;
  settlementDate: string | null;
  assigneeId: string | null;
  salesStaffId: string | null;
  opsStaffId: string | null;
  createdById: string | null;
}

export function computeDueDate(t: Pick<ScheduleTemplateItem, "base" | "offsetDays">, d: Pick<ReconcileDeal, "contractDate" | "settlementDate">): string | null {
  const base = t.base === "contract" ? d.contractDate : d.settlementDate;
  return base ? shiftOffWeekend(addYmdDays(base, t.offsetDays), t.offsetDays) : null;
}

// ---------- どの項目を出すか ----------

function tradeApplies(s: ScheduleTradeScope, d: ReconcileDeal): boolean {
  if (s === "all") return true;
  if (s === "resale") return d.businessType === "resale";
  if (d.businessType !== "brokerage") return false;
  if (s === "brokerage") return true;
  return d.tradeSide === "both" || d.tradeSide === (s === "brokerage_seller" ? "seller" : "buyer");
}

function conditionApplies(c: ScheduleCondition, d: ReconcileDeal, mortgage: MortgageState): boolean {
  if (c === "all") return true;
  if (c === "unit") return d.kindBase === "unit";
  if (c === "land") return d.kindBase === "house" || d.kindBase === "land" || d.kindBase === "building";
  if (c === "oc") return d.hasOc;
  return mortgage !== "no";
}

/** 段取りを作る取引か。中止は作らない。決済日が過ぎた取引は、すでに項目があるものだけ続ける。 */
export function scheduleEligible(d: Pick<ReconcileDeal, "status" | "settlementDate">, hasItems: boolean, today: string): boolean {
  if (d.status === "cancelled") return false;
  return hasItems || !d.settlementDate || d.settlementDate >= today;
}

// ---------- 作る・付け直す ----------

export interface ScheduleItemState {
  id: string;
  /** null=手入力の項目(付け直しの対象にしない)。 */
  templateKey: string | null;
  dueDate: string;
  dueManual: boolean;
  assigneeId: string | null;
  assigneeManual: boolean;
  completed: boolean;
  excluded: boolean;
  excludedManual: boolean;
  preIntroduction: boolean;
  mortgageUnknown: boolean;
  completionHint: CompletionHint | null;
}

export interface ScheduleCreate {
  templateKey: string;
  label: string;
  base: ScheduleBase;
  dueDate: string;
  assigneeId: string | null;
  completed: boolean;
  preIntroduction: boolean;
  mortgageUnknown: boolean;
  completionHint: CompletionHint | null;
  sortOrder: number;
}

export type ScheduleItemPatch = Partial<Pick<ScheduleItemState, "dueDate" | "assigneeId" | "excluded" | "preIntroduction" | "mortgageUnknown" | "completionHint">>;

export interface ReconcileInput {
  template: ScheduleTemplateItem[];
  deal: ReconcileDeal;
  mortgage: MortgageState;
  items: ScheduleItemState[];
  today: string;
  /** 発行済みの書類の種類(作るときに完了・候補を付ける)。 */
  issuedDocTypes: string[];
  taxesEntered: boolean;
}

function assigneeOf(rule: ScheduleAssigneeRule, d: ReconcileDeal): string | null {
  const person = rule === "sales" ? d.salesStaffId : rule === "ops" ? d.opsStaffId : d.assigneeId;
  return person ?? d.assigneeId ?? d.createdById;
}

/**
 * 今の取引の日付と条件に、項目を合わせる。
 * - 完了済み・手入力の項目は触らない。手で直した期限と担当はそのまま。
 * - 要らなくなった未完了の項目は消さず対象外にする(手で対象外にしたものは戻さない)。
 * - 作った時点で期限が過ぎている項目は「導入前の項目」にする(期限超過の通知に入れない)。
 */
export function reconcileSchedule(input: ReconcileInput): { creates: ScheduleCreate[]; updates: Array<{ id: string; data: ScheduleItemPatch }> } {
  const { template, deal, mortgage, items, today, issuedDocTypes, taxesEntered } = input;
  const creates: ScheduleCreate[] = [];
  const updates: Array<{ id: string; data: ScheduleItemPatch }> = [];
  if (!scheduleEligible(deal, items.length > 0, today)) return { creates, updates };
  const byKey = new Map(items.flatMap((i) => (i.templateKey ? [[i.templateKey, i] as const] : [])));
  template.forEach((t, sortOrder) => {
    const due = computeDueDate(t, deal);
    const isMortgage = t.condition === "active_mortgage";
    const applies = !!due && tradeApplies(t.tradeScope, deal) && conditionApplies(t.condition, deal, mortgage);
    const cur = byKey.get(t.id);
    if (!cur) {
      if (!applies || !due) return;
      const completed = (COMPLETE_ON_ISSUE_BY_KEY.get(t.id)?.some((doc) => issuedDocTypes.includes(doc)) ?? false)
        || (t.id === TAX_KEY && taxesEntered) || (t.id === SETTLE_KEY && deal.status === "settled");
      creates.push({
        templateKey: t.id, label: t.label, base: t.base, dueDate: due, assigneeId: assigneeOf(t.assigneeRule, deal), completed,
        preIntroduction: due < today, mortgageUnknown: isMortgage && mortgage === "unknown",
        completionHint: !completed && HINT_ON_ISSUE_BY_KEY.get(t.id)?.some((doc) => issuedDocTypes.includes(doc)) ? "doc_issued" : null, sortOrder,
      });
      return;
    }
    if (cur.completed || cur.excludedManual) return;
    const data: ScheduleItemPatch = {};
    // 担保の項目: 謄本で担保が消えたら完了候補(対象外にしない)。判定できないまま作ったものは対象外に落とす。
    const cleared = isMortgage && !!due && tradeApplies(t.tradeScope, deal) && mortgage === "no" && !cur.mortgageUnknown && !cur.excluded;
    if (cleared) {
      if (cur.completionHint !== "mortgage_cleared") data.completionHint = "mortgage_cleared";
    } else if (!applies) {
      if (!cur.excluded) data.excluded = true;
      if (cur.mortgageUnknown) data.mortgageUnknown = false;
    } else {
      if (cur.excluded) data.excluded = false;
      // 担保ありと分かれば確認の印を外す。一時的に読めないだけで印を立てない(後で消えたとき完了候補にするため)。
      if (isMortgage && cur.mortgageUnknown && mortgage === "yes") data.mortgageUnknown = false;
      if (isMortgage && cur.excluded && !cur.mortgageUnknown && mortgage === "unknown") data.mortgageUnknown = true;
      if (isMortgage && mortgage === "yes" && cur.completionHint === "mortgage_cleared") data.completionHint = null;
    }
    if (due && !cur.dueManual && cur.dueDate !== due) {
      data.dueDate = due;
      // 導入前のまま先の日付になったら普通の項目に戻す。作ったあとに早めて過ぎたものは本当の期限超過。
      if (cur.preIntroduction && due >= today) data.preIntroduction = false;
    }
    if (!cur.assigneeManual) {
      const a = assigneeOf(t.assigneeRule, deal);
      if (a !== cur.assigneeId) data.assigneeId = a;
    }
    if (Object.keys(data).length) updates.push({ id: cur.id, data });
  });
  return { creates, updates };
}

const invert = (m: Readonly<Record<string, string>>) => {
  const out = new Map<string, string[]>();
  for (const [doc, key] of Object.entries(m)) out.set(key, [...(out.get(key) ?? []), doc]);
  return out;
};
const COMPLETE_ON_ISSUE_BY_KEY = invert(COMPLETE_ON_ISSUE);
const HINT_ON_ISSUE_BY_KEY = invert(HINT_ON_ISSUE);

// ---------- 自動で完了にする ----------

export interface ScheduleEvent {
  issuedDocType?: string;
  /** 取引の状態が決済済に変わった。 */
  settled?: boolean;
  /** 固定資産税と都市計画税の両方が入った。 */
  taxesEntered?: boolean;
}

export type ScheduleEventUpdate = { id: string; data: { completed: true; auto: true } | { completionHint: CompletionHint } };

/** 出来事で完了にする項目・完了候補にする項目。完了済み・対象外には何もしない。取り消した項目は次の出来事まで戻らない。 */
export function applyScheduleEvents(
  items: Pick<ScheduleItemState, "id" | "templateKey" | "completed" | "excluded" | "completionHint">[], e: ScheduleEvent,
): ScheduleEventUpdate[] {
  const complete = new Set<string>();
  if (e.issuedDocType && COMPLETE_ON_ISSUE[e.issuedDocType]) complete.add(COMPLETE_ON_ISSUE[e.issuedDocType]);
  if (e.settled) complete.add(SETTLE_KEY);
  if (e.taxesEntered) complete.add(TAX_KEY);
  const hint = e.issuedDocType ? HINT_ON_ISSUE[e.issuedDocType] : undefined;
  return items.flatMap((i): ScheduleEventUpdate[] => {
    if (i.completed || i.excluded || !i.templateKey) return [];
    if (complete.has(i.templateKey)) return [{ id: i.id, data: { completed: true, auto: true } }];
    if (i.templateKey === hint && i.completionHint !== "doc_issued") return [{ id: i.id, data: { completionHint: "doc_issued" } }];
    return [];
  });
}

// ---------- 担保の判定(照合の結果を読むだけ) ----------

/** 照合の注意 crosscheck.activeMortgage があれば担保あり。謄本を読めて足りていて無ければ担保なし。それ以外は判定できない。 */
export function mortgageStateOf(result: Pick<CrosscheckResult, "notices" | "items">): MortgageState {
  if (result.notices.some((n) => n.id === CROSSCHECK_NOTICE_IDS.activeMortgage)) return "yes";
  const registry = result.items.find((i) => i.key === "mortgage")?.sources.find((s) => s.key === "registry");
  return registry?.state === "value" ? "no" : "unknown";
}

// ---------- 通知 ----------

export type ScheduleNoticeSlot = "tomorrow" | "today" | "overdue";

/** 朝の通知の対象か。導入前の項目は期限超過に入れない。 */
export function scheduleNoticeSlot(
  i: { dueDate: string; completed: boolean; excluded: boolean; preIntroduction: boolean }, today: string,
): ScheduleNoticeSlot | null {
  if (i.completed || i.excluded) return null;
  if (i.dueDate === today) return "today";
  if (i.dueDate === addYmdDays(today, 1)) return "tomorrow";
  if (i.dueDate < today) return i.preIntroduction ? null : "overdue";
  return null;
}

/** その日の朝の通知を送り始める時刻(日本時間の 9:00)。 */
export function jstMorningSendAt(today: string): number {
  return Date.parse(`${today}T09:00:00.000+09:00`);
}

// ---------- 画面 ----------

export function scheduleBadge(
  i: { dueDate: string; completed: boolean; excluded: boolean; preIntroduction: boolean }, today: string,
): { tone: "done" | "muted" | "overdue" | "soon" | "normal"; text: string } {
  if (i.completed) return { tone: "done", text: "完了" };
  if (i.excluded) return { tone: "muted", text: "対象外になりました" };
  const d = diffDays(i.dueDate, today);
  if (d < 0) return i.preIntroduction ? { tone: "muted", text: "導入前の項目" } : { tone: "overdue", text: `${-d}日超過` };
  if (d === 0) return { tone: "soon", text: "今日" };
  if (d === 1) return { tone: "soon", text: "明日" };
  return { tone: "normal", text: `あと${d}日` };
}

export const SCHEDULE_GROUPS = {
  after_contract: "契約のあと", weeks3: "決済の3週間前ごろ", weeks2: "決済の2週間前ごろ", week1: "決済の1週間前ごろ", eve: "決済の前日・当日", after: "決済のあと",
} as const;
export type ScheduleGroup = keyof typeof SCHEDULE_GROUPS;

/** 時期のまとめ。決済日が無い取引の項目は「契約のあと」。 */
export function scheduleGroupOf(i: { base: string | null; dueDate: string }, settlementDate: string | null): ScheduleGroup {
  if (i.base === "contract" || !settlementDate) return "after_contract";
  const before = diffDays(settlementDate, i.dueDate);
  if (before < 0) return "after";
  if (before <= 1) return "eve";
  if (before <= 7) return "week1";
  if (before <= 14) return "weeks2";
  return "weeks3";
}
