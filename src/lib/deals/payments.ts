/**
 * お金の受け渡し(2026-11-16 発注者「手付金・残金・精算金・その他のお金は、現金か振込かを確かめて送金先を入れる」)。
 * 計画: https://claude.ai/artifact/HmqrUfszuaBEXSccvwcdGg (発注者「進めて」)。
 * - 行=お金ごと。払う人・受け取る人・金額は取引の入力と決済の計算から出す(ここでは直さない)。
 * - 払い方=振込・現金・未定。精算金だけ「残金と一緒に」(払い方と口座は残金と同じ・向きが売主→買主なら残金から差し引く)。
 * - 口座が空で受け取る人が自社なら、取引の設定の口座を使う。
 * - 書類(残金決済のご案内2種類・準備チェックリスト)の初期値に入れる。書類の画面で直した値はその書類だけに残る。
 */
import { BANK_ACCOUNT_TYPE_LABELS } from "./constants";
import { EMPTY_PAYMENT_ENTRY, type BankAccount, type PaymentEntry, type PaymentFixedKey, type Payments } from "./schemas";
import type { DealCalc } from "./calc/deal-calc";
import type { DealView } from "./view";

export const PAYMENT_METHOD_LABELS = { transfer: "振込", cash: "現金", with_balance: "残金と一緒に", undecided: "未定" } as const;

export interface PaymentRow {
  /** 固定の鍵、または費用のその他の行は `other:<行の名前>`。 */
  key: PaymentFixedKey | `other:${string}`;
  label: string;
  from: string;
  to: string;
  /** 受け取る人が自社(口座が空なら取引の設定の口座を使う)。 */
  toSelf: boolean;
  amount: number | null;
  /** 「残金と一緒に」を選べる(精算金だけ)。 */
  allowWithBalance: boolean;
  entry: PaymentEntry;
}

const OTHER_PREFIX = "other:";
export const otherKeyOf = (label: string) => `${OTHER_PREFIX}${label}` as const;
export const isOtherKey = (key: string): key is `other:${string}` => key.startsWith(OTHER_PREFIX);

const SELF = "当社";
function sideOf(d: DealView, role: "seller" | "buyer"): { name: string; self: boolean } {
  const self = d.parties.some((p) => p.role === role && p.isSelf);
  return { name: self ? SELF : role === "seller" ? "売主" : "買主", self };
}

/** 取引で出すお金の行。費用が入っていない登記・抹消・測量は出さない(手付金・残金・精算金はいつも出す)。 */
export function paymentRows(d: DealView, calc: DealCalc | null): PaymentRow[] {
  const p: Payments = d.payments ?? {};
  const seller = sideOf(d, "seller");
  const buyer = sideOf(d, "buyer");
  const fixed = (key: PaymentFixedKey, label: string, from: string, to: string, toSelf: boolean, amount: number | null, allowWithBalance = false): PaymentRow =>
    ({ key, label, from, to, toSelf, amount, allowWithBalance, entry: p[key] ?? EMPTY_PAYMENT_ENTRY });
  const s = calc?.settlement ?? null;
  const reverse = s?.net.direction === "sellerToBuyer";
  const rows: PaymentRow[] = [
    fixed("deposit", "手付金", buyer.name, seller.name, seller.self, d.deposit),
    fixed("balance", "残金", buyer.name, seller.name, seller.self, s?.remaining ?? null),
    reverse
      ? fixed("settlement", "精算金", seller.name, buyer.name, buyer.self, s?.net.amount ?? null, true)
      : fixed("settlement", "精算金", buyer.name, seller.name, seller.self, s ? s.net.amount : null, true),
  ];
  if (d.costs.registrationFee) rows.push(fixed("registration", "登記費用", buyer.name, "司法書士", false, d.costs.registrationFee));
  if (d.costs.cancellationFee) rows.push(fixed("cancellation", "抹消費用", seller.name, "司法書士", false, d.costs.cancellationFee));
  if (d.costs.surveyFee) rows.push(fixed("survey", "測量費", seller.name, "測量の会社", false, d.costs.surveyFee));
  if (d.businessType === "brokerage") {
    const fee = calc?.brokerage?.incl ?? null;
    if (d.tradeSide === "seller" || d.tradeSide === "both") rows.push(fixed("brokerageSeller", "仲介手数料(売主)", seller.name, SELF, true, fee));
    if (d.tradeSide === "buyer" || d.tradeSide === "both") rows.push(fixed("brokerageBuyer", "仲介手数料(買主)", buyer.name, SELF, true, fee));
  }
  const seen = new Set<string>();
  for (const o of d.costs.others) {
    if (seen.has(o.label)) continue;
    seen.add(o.label);
    rows.push({
      key: otherKeyOf(o.label), label: o.label, from: seller.name, to: "支払先", toSelf: false, amount: o.amount, allowWithBalance: false,
      entry: p.others?.[o.label] ?? EMPTY_PAYMENT_ENTRY,
    });
  }
  return rows;
}

const hasAccount = (b: BankAccount) => !!(b.bankName || b.branchName || b.accountNumber || b.accountHolder);

/** 口座を1行に。銀行名が無ければ null。 */
export function formatBankAccount(b: BankAccount): string | null {
  if (!b.bankName) return null;
  return [b.bankName, b.branchName, b.accountType ? BANK_ACCOUNT_TYPE_LABELS[b.accountType] : null, b.accountNumber, b.accountHolder && `名義 ${b.accountHolder}`]
    .filter(Boolean).join(" ");
}

/** 行の払い方(「残金と一緒に」は残金の払い方)。 */
export function effectiveMethod(row: PaymentRow, rows: PaymentRow[]): PaymentEntry["method"] {
  if (row.entry.method !== "with_balance") return row.entry.method;
  const m = rows.find((r) => r.key === "balance")?.entry.method;
  return m && m !== "with_balance" ? m : "undecided";
}

/** 振込先の口座(振込でなければ null)。口座が空で自社が受け取るなら取引の設定の口座。 */
export function effectiveAccount(row: PaymentRow, rows: PaymentRow[], selfAccount: BankAccount): BankAccount | null {
  if (row.entry.method === "with_balance") {
    // 残金そのものが「残金と一緒に」なら探さない(堂々巡りを防ぐ・内部レビュー P3)。
    const balance = rows.find((r) => r.key === "balance");
    return balance && balance !== row && balance.entry.method !== "with_balance" ? effectiveAccount(balance, rows, selfAccount) : null;
  }
  if (row.entry.method !== "transfer") return null;
  if (hasAccount(row.entry.account)) return row.entry.account;
  return row.toSelf && hasAccount(selfAccount) ? selfAccount : null;
}

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;
const balanceRowOf = (d: DealView, calc: DealCalc) => {
  const rows = paymentRows(d, calc);
  return { rows, balance: rows.find((r) => r.key === "balance")!, settlement: rows.find((r) => r.key === "settlement")! };
};

/** 残金決済のご案内(買主様)の「お振込先」の初期値。残金が未定なら null(今までの初期値に任せる)。 */
export function balancePayeeText(d: DealView, calc: DealCalc, selfAccount: BankAccount): string | null {
  const { rows, balance, settlement } = balanceRowOf(d, calc);
  if (balance.entry.method === "cash") return "現金でお支払いください(お振込みは不要です)";
  if (balance.entry.method !== "transfer") return null;
  const text = formatBankAccount(effectiveAccount(balance, rows, selfAccount) ?? balance.entry.account);
  if (!text) return null;
  const pay = calc.settlement.paymentAtSettlement;
  const net = calc.settlement.net;
  if (settlement.entry.method !== "with_balance" || net.amount <= 0 || pay === null) return text;
  return net.direction === "sellerToBuyer"
    ? `${text}\n(残代金から精算金を差し引いた ${yen(pay)}をお振込みください)`
    : `${text}\n(残代金と精算金を合わせて ${yen(pay)}をお振込みください)`;
}

/** 残金決済のご案内(売主様)の「お受け取りの口座」の初期値。残金が未定なら null。 */
export function sellerReceiveText(d: DealView, calc: DealCalc, selfAccount: BankAccount): string | null {
  const { rows, balance } = balanceRowOf(d, calc);
  if (balance.entry.method === "cash") return "現金でお受け取りいただきます";
  if (balance.entry.method !== "transfer") return null;
  return formatBankAccount(effectiveAccount(balance, rows, selfAccount) ?? balance.entry.account);
}

type PayEntry = { method: "cash" | "transfer"; amount: number | null; other: null };
const asPay = (m: PaymentEntry["method"]): PayEntry["method"] | null => (m === "cash" || m === "transfer" ? m : null);

/**
 * 準備チェックリストの持参する金額の払い方の初期値(振込・現金だけ写す・未定は空)。
 * 残代金・精算金(payment)は残金の払い方。精算金だけ別の払い方(買主→売主)なら、2つに分けて金額を入れる。
 */
export function checklistPayDefault(amount: "deposit" | "payment" | "registration" | "cancellation" | "survey", d: DealView, calc: DealCalc): PayEntry[] {
  const p = d.payments ?? {};
  const one = (e: PaymentEntry | undefined): PayEntry[] => {
    const m = e ? asPay(e.method) : null;
    return m ? [{ method: m, amount: null, other: null }] : [];
  };
  if (amount !== "payment") return one(p[amount]);
  const bm = p.balance ? asPay(p.balance.method) : null;
  if (!bm) return [];
  const sm = p.settlement ? asPay(p.settlement.method) : null;
  const net = calc.settlement.net;
  const pay = calc.settlement.paymentAtSettlement;
  if (sm && sm !== bm && net.direction === "buyerToSeller" && net.amount > 0 && pay !== null) {
    return [{ method: bm, amount: pay - net.amount, other: null }, { method: sm, amount: net.amount, other: null }];
  }
  return [{ method: bm, amount: null, other: null }];
}

/** 口座番号の欄の文字をそろえる(全角の数字→半角・空白とハイフンを除く)。7桁までの数字でなければ null=読めない。 */
export function normalizeAccountNumber(v: string): string | null {
  const s = v.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/[\s\-－ー‐]/g, "");
  return /^\d{0,7}$/.test(s) ? s : null;
}

/**
 * 画面の下書き(行の鍵ごと)→ 保存する形。今の行に無い鍵(費用を消した登記・名前を変えたその他の行など)は保存済みの値を残す。
 * 精算金以外で「残金と一緒に」は送らない(未定にする)。
 */
export function paymentsForSave(stored: Payments, rows: PaymentRow[], drafts: Record<string, PaymentEntry>): Payments {
  const out: Payments = { ...stored, ...(stored.others ? { others: { ...stored.others } } : {}) };
  for (const r of rows) {
    const e = drafts[r.key] ?? r.entry;
    const entry: PaymentEntry = e.method === "with_balance" && !r.allowWithBalance ? { ...e, method: "undecided" } : e;
    if (isOtherKey(r.key)) out.others = { ...(out.others ?? {}), [r.key.slice(OTHER_PREFIX.length)]: entry };
    else out[r.key] = entry;
  }
  return out;
}
