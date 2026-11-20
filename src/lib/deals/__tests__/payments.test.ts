import { describe, expect, it } from "vitest";
import { computeDealCalc } from "../calc/deal-calc";
import { DEFAULT_COSTS, DEFAULT_TERMS, EMPTY_BANK_ACCOUNT, EMPTY_BROKER, EMPTY_SNAPSHOT, paymentsSchema, type BankAccount, type PaymentEntry } from "../schemas";
import { DEFAULT_PROPERTY_KINDS } from "../constants";
import { INITIAL_RATE_TABLES, type RateTableRow } from "../rate-tables";
import { DEFAULT_FUNDING_INPUTS } from "../funding-schema";
import { DEFAULT_BUSINESS_INPUTS } from "../business-schema";
import { readPayments } from "../inputs";
import {
  balancePayeeText, checklistPayDefault, effectiveAccount, formatBankAccount, paymentRows, paymentTotals, sellerReceiveText,
} from "../payments";
import type { DealPartyView, DealView } from "../view";

const rateRows: RateTableRow[] = INITIAL_RATE_TABLES.map((t) => ({
  kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
}));
const party = (p: Partial<DealPartyView> & Pick<DealPartyView, "id" | "role" | "name">): DealPartyView => ({
  partyType: "individual", representative: null, address: null, phone: null, shareNum: null, shareDen: null, isSelf: false, sortOrder: 0, version: 1, ...p,
});
const SELLER = party({ id: "s", role: "seller", name: "架空 一郎" });
const BUYER = party({ id: "b", role: "buyer", name: "架空 花子" });
const SELF_SELLER = party({ id: "x", role: "seller", name: "架空不動産", partyType: "corporation", isSelf: true });
const base: DealView = {
  id: "d", dealNo: "2026-0001", name: "試験", businessType: "brokerage", tradeSide: "both", status: "contracted",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "unit", hasOc: false,
  contractAt: "2026-04-30T15:00:00.000Z", contractPlace: null, settlementAt: "2026-06-30T01:00:00.000Z", settlementPlace: null,
  price: 30_000_000, buildingTax: null, deposit: 1_500_000, taxRateBp: 1000,
  propertySnapshot: EMPTY_SNAPSHOT, counterpartyBroker: EMPTY_BROKER, assessments: { rows: [], landRatioBp: 10000 },
  costs: { ...DEFAULT_COSTS, registrationFee: 300_000, cancellationFee: 20_000, others: [{ label: "家財の処分", amount: 50_000 }] },
  settlementTerms: { ...DEFAULT_TERMS, taxInputMode: "total", fixedAssetTax: 100_000, cityPlanningTax: 20_000 },
  leases: [], overrides: {}, version: 1, createdAt: "", updatedAt: "", parties: [SELLER, BUYER],
  fundingPlan: DEFAULT_FUNDING_INPUTS, businessPlan: DEFAULT_BUSINESS_INPUTS,
};
const calcOf = (d: DealView) => computeDealCalc(d, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-25");
const ACC: BankAccount = { bankName: "見本銀行", branchName: "本店", accountType: "ordinary", accountNumber: "1234567", accountHolder: "ミホン タロウ" };
const SELF_ACC: BankAccount = { bankName: "自社銀行", branchName: "駅前支店", accountType: "current", accountNumber: "7654321", accountHolder: "カクウフドウサン" };
const tr = (account: BankAccount = ACC): PaymentEntry => ({ method: "transfer", account });
const cash: PaymentEntry = { method: "cash", account: EMPTY_BANK_ACCOUNT };
const keys = (d: DealView) => paymentRows(d, calcOf(d)).map((r) => r.key);

describe("お金の受け渡しの行", () => {
  it("両手の仲介: 手付金・残金・精算金・登記・抹消・仲介手数料(売主・買主)・その他の行。測量費が無ければ出さない", () => {
    expect(keys(base)).toEqual(["deposit", "balance", "settlement", "registration", "cancellation", "brokerageSeller", "brokerageBuyer", "other:家財の処分"]);
  });
  it("売主側の仲介は売主の仲介手数料だけ・買主側は買主の分だけ", () => {
    expect(keys({ ...base, tradeSide: "seller" })).toContain("brokerageSeller");
    expect(keys({ ...base, tradeSide: "seller" })).not.toContain("brokerageBuyer");
    expect(keys({ ...base, tradeSide: "buyer" })).not.toContain("brokerageSeller");
  });
  it("買取再販: 相手方の仲介会社か手で入れた仲介手数料があれば「当社 → 仲介会社」の1行(11-18 発注者「仲介手数料が入っていない」)", () => {
    const resale: DealView = { ...base, businessType: "resale", tradeSide: null, parties: [SELF_SELLER, BUYER] };
    // 仲介会社も手入力も無い=直接の取引かもしれない → 出さない(上限額の計算だけで行を作らない)
    expect(keys(resale).some((k) => k.startsWith("brokerage"))).toBe(false);
    const withBroker = { ...resale, counterpartyBroker: { company: "見本不動産", staff: null, tel: null } };
    const r = paymentRows(withBroker, calcOf(withBroker)).find((x) => x.key === "brokerageResale")!;
    expect([r.label, r.from, r.to, r.toSelf]).toEqual(["仲介手数料", "当社", "見本不動産", false]);
    expect(r.amount).toBe(calcOf(withBroker).brokerage!.incl);
    const typed = { ...resale, overrides: { brokerageFee: 500_000 } };
    const t = paymentRows(typed, calcOf(typed)).find((x) => x.key === "brokerageResale")!;
    expect([t.to, t.amount]).toEqual(["仲介会社", 550_000]);
    // 0円と手で入れたら手数料なし → 出さない(仲介会社が入っていても)
    const zero = { ...withBroker, overrides: { brokerageFee: 0 } };
    expect(keys(zero)).not.toContain("brokerageResale");
    // 仲介の取引には出さない
    expect(keys({ ...base, counterpartyBroker: { company: "見本不動産", staff: null, tel: null } })).not.toContain("brokerageResale");
  });
  it("費用が入っていない登記・抹消は出さない(手付金・残金・精算金はいつも出す)", () => {
    const d = { ...base, costs: DEFAULT_COSTS, deposit: null };
    expect(keys(d)).toEqual(["deposit", "balance", "settlement", "brokerageSeller", "brokerageBuyer"]);
  });
  it("払う人・受け取る人と金額。自社の当事者は「当社」、仲介手数料は当社が受け取る", () => {
    const rows = paymentRows(base, calcOf(base));
    const by = (k: string) => rows.find((r) => r.key === k)!;
    expect([by("deposit").from, by("deposit").to, by("deposit").amount]).toEqual(["買主", "売主", 1_500_000]);
    expect(by("balance").amount).toBe(28_500_000);
    expect([by("registration").from, by("registration").to]).toEqual(["買主", "司法書士"]);
    expect([by("cancellation").from, by("cancellation").to]).toEqual(["売主", "司法書士"]);
    expect([by("brokerageSeller").from, by("brokerageSeller").to, by("brokerageSeller").toSelf]).toEqual(["売主", "当社", true]);
    expect(by("deposit").toSelf).toBe(false);
    const self = paymentRows({ ...base, parties: [SELF_SELLER, BUYER] }, calcOf(base));
    expect([self[0].to, self[0].toSelf]).toEqual(["当社", true]);
  });
  it("精算金は向きで払う人が変わり、「残金と一緒に」を選べるのは精算金だけ", () => {
    const rows = paymentRows(base, calcOf(base));
    expect(rows.filter((r) => r.allowWithBalance).map((r) => r.key)).toEqual(["settlement"]);
    const s = rows.find((r) => r.key === "settlement")!;
    expect([s.from, s.to]).toEqual(["買主", "売主"]);
  });
  it("保存した払い方を行に入れる(無い行は未定)", () => {
    const d = { ...base, payments: { deposit: cash, others: { 家財の処分: tr() } } };
    const rows = paymentRows(d, calcOf(d));
    expect(rows.find((r) => r.key === "deposit")!.entry.method).toBe("cash");
    expect(rows.find((r) => r.key === "balance")!.entry.method).toBe("undecided");
    expect(rows.find((r) => r.key === "other:家財の処分")!.entry.method).toBe("transfer");
  });
});

describe("費用のその他の行の払う人・受け取る人(2026-11-18 発注者「選択式に」)", () => {
  const other = (d: DealView) => paymentRows(d, calcOf(d)).find((r) => r.key === "other:家財の処分")!;
  it("何も選んでいなければ 未定 → 支払先(11-19 発注者「初期値は未定」)。固定の行は選べない", () => {
    const r = other(base);
    expect([r.from, r.to, r.toSelf]).toEqual(["未定", "支払先", false]);
    expect(r.parties).toEqual({ from: { kind: "undecided", name: null }, to: { kind: "other", name: null } });
    expect(paymentRows(base, calcOf(base)).find((x) => x.key === "deposit")!.parties).toBeNull();
  });
  it("保存した相手で出す: 名前を入れた「その他」はその名前・司法書士・測量の会社・買主", () => {
    const d = { ...base, payments: { others: { 家財の処分: { ...cash, payer: { kind: "buyer" as const, name: null }, to: { kind: "other" as const, name: "解体業者" } } } } };
    expect([other(d).from, other(d).to]).toEqual(["買主", "解体業者"]);
    const d2 = { ...base, payments: { others: { 家財の処分: { ...cash, payer: { kind: "scrivener" as const, name: null }, to: { kind: "surveyor" as const, name: null } } } } };
    expect([other(d2).from, other(d2).to]).toEqual(["司法書士", "測量の会社"]);
    const d3 = { ...base, payments: { others: { 家財の処分: { ...cash, payer: { kind: "seller" as const, name: null } } } } };
    expect(other(d3).from).toBe("売主");
  });
  it("仲介会社: 基本タブの相手方の仲介会社の名前(空なら「仲介会社」)(11-19 発注者「支払先に仲介会社が無い」)", () => {
    const d = { ...base, counterpartyBroker: { company: "見本不動産", staff: null, tel: null }, payments: { others: { 家財の処分: { ...cash, payer: { kind: "self" as const, name: null }, to: { kind: "broker" as const, name: null } } } } };
    expect([other(d).from, other(d).to, other(d).toSelf]).toEqual(["当社", "見本不動産", false]);
    const d2 = { ...d, counterpartyBroker: { company: null, staff: null, tel: null } };
    expect(other(d2).to).toBe("仲介会社");
  });
  it("前の形(from)で保存された「売主」は、初期値のままか見分けられないので未定として読む。ほかの相手はそのまま", () => {
    const legacySeller = { ...base, payments: { others: { 家財の処分: { ...cash, from: { kind: "seller" as const, name: null } } } } };
    expect(other(legacySeller).from).toBe("未定");
    expect(other(legacySeller).parties!.from.kind).toBe("undecided");
    const legacyBuyer = { ...base, payments: { others: { 家財の処分: { ...cash, from: { kind: "buyer" as const, name: null } } } } };
    expect(other(legacyBuyer).from).toBe("買主");
    // 新しい形(payer)の売主は、人が選んだものとしてそのまま
    const both = { ...base, payments: { others: { 家財の処分: { ...cash, from: { kind: "buyer" as const, name: null }, payer: { kind: "seller" as const, name: null } } } } };
    expect(other(both).from).toBe("売主");
  });
  it("受け取る人が当社(または自社の当事者)なら、口座が空のとき自社の口座を使う", () => {
    const d = { ...base, payments: { others: { 家財の処分: { ...tr(EMPTY_BANK_ACCOUNT), to: { kind: "self" as const, name: null } } } } };
    const rows = paymentRows(d, calcOf(d));
    const r = rows.find((x) => x.key === "other:家財の処分")!;
    expect([r.to, r.toSelf]).toEqual(["当社", true]);
    expect(effectiveAccount(r, rows, SELF_ACC)).toEqual(SELF_ACC);
    const d2 = { ...base, parties: [SELF_SELLER, BUYER], payments: { others: { 家財の処分: { ...cash, payer: { kind: "buyer" as const, name: null }, to: { kind: "seller" as const, name: null } } } } };
    expect([other(d2).to, other(d2).toSelf]).toEqual(["当社", true]);
  });
  it("画面で選び直した相手で行を出し直す(withParties)", async () => {
    const { withParties } = await import("../payments");
    const r = withParties(base, other(base), { kind: "self", name: null }, { kind: "other", name: "" });
    expect([r.from, r.to, r.toSelf]).toEqual(["当社", "支払先", false]);
    const fixed = paymentRows(base, calcOf(base)).find((x) => x.key === "deposit")!;
    expect(withParties(base, fixed, { kind: "self", name: null }, { kind: "self", name: null })).toBe(fixed);
  });
  it("保存の形: 相手は知っている種類だけ・名前は50文字まで。固定の行には付けられない。古い形(相手なし)も読める", () => {
    expect(paymentsSchema.safeParse({ others: { x: { ...cash, to: { kind: "other", name: "解体業者" } } } }).success).toBe(true);
    expect(paymentsSchema.safeParse({ others: { x: { ...cash, to: { kind: "bogus", name: null } } } }).success).toBe(false);
    expect(paymentsSchema.safeParse({ others: { x: { ...cash, to: { kind: "other", name: "あ".repeat(51) } } } }).success).toBe(false);
    expect(paymentsSchema.safeParse({ deposit: { ...cash, to: { kind: "self", name: null } } }).success).toBe(false);
    const to = { kind: "self" as const, name: null };
    expect(readPayments({ others: { x: { ...cash, to }, y: cash } })).toEqual({ others: { x: { ...cash, to }, y: cash } });
  });
});

describe("払う人ごとの合計(2026-11-20 発注者「送金合計額・現金用意の金額が一目で分からない」)", () => {
  const amt = (rows: ReturnType<typeof paymentRows>, k: string) => rows.find((r) => r.key === k)!.amount!;
  it("払う人ごとに、振込・現金・未定の合計。行の順に払う人を並べる", () => {
    const rows = paymentRows(base, calcOf(base));
    const t = paymentTotals(rows);
    expect(t.map((g) => g.payer)).toEqual(["買主", "売主", "未定"]);
    const buyer = t[0];
    expect(buyer.undecided).toBe(amt(rows, "deposit") + amt(rows, "balance") + amt(rows, "settlement") + amt(rows, "registration") + amt(rows, "brokerageBuyer"));
    expect([buyer.transfer, buyer.cash, buyer.missing]).toEqual([0, 0, 0]);
    expect(t[1].undecided).toBe(amt(rows, "cancellation") + amt(rows, "brokerageSeller"));
    expect(t[2].undecided).toBe(50_000);
  });
  it("振込・現金に分ける。精算金の「残金と一緒に」は残金の払い方で、残金の払う人に足す", () => {
    const d = { ...base, payments: { deposit: cash, balance: tr(), settlement: { method: "with_balance" as const, account: EMPTY_BANK_ACCOUNT }, registration: cash } };
    const rows = paymentRows(d, calcOf(d));
    const buyer = paymentTotals(rows)[0];
    expect(buyer.cash).toBe(amt(rows, "deposit") + amt(rows, "registration"));
    expect(buyer.transfer).toBe(amt(rows, "balance") + amt(rows, "settlement"));
    expect(buyer.undecided).toBe(amt(rows, "brokerageBuyer"));
  });
  it("売主から買主への精算金を「残金と一緒に」なら、残金から差し引く(売主の合計には入れない)", () => {
    const rows = paymentRows(base, calcOf(base)).map((r) => (r.key === "settlement"
      ? { ...r, from: "売主", to: "買主", amount: 30_000, entry: { method: "with_balance" as const, account: EMPTY_BANK_ACCOUNT } }
      : r.key === "balance" ? { ...r, entry: tr() } : r));
    const t = paymentTotals(rows);
    expect(t.find((g) => g.payer === "買主")!.transfer).toBe(amt(rows, "balance") - 30_000);
    expect(t.find((g) => g.payer === "売主")!.transfer).toBe(0);
  });
  it("預り敷金を残代金と相殺するなら、残金の側から差し引く(決済時のお支払額と合わせる・@codex #764 P2)", () => {
    const d = { ...base, payments: { balance: tr(), settlement: { method: "with_balance" as const, account: EMPTY_BANK_ACCOUNT } } };
    const rows = paymentRows(d, calcOf(d));
    const without = paymentTotals(rows)[0].transfer;
    expect(paymentTotals(rows, 240_000)[0].transfer).toBe(without - 240_000);
    // 残金が現金なら現金の側から
    const c = { ...base, payments: { balance: cash } };
    const crows = paymentRows(c, calcOf(c));
    expect(paymentTotals(crows, 240_000)[0].cash).toBe(amt(crows, "balance") - 240_000);
  });
  it("金額が出ていない行は数に入れず、件数で知らせる", () => {
    const d = { ...base, price: null };
    const t = paymentTotals(paymentRows(d, calcOf(d)));
    expect(t[0].missing).toBeGreaterThan(0);
  });
});

describe("振込先", () => {
  it("口座を1行に(銀行名が無ければ null)", () => {
    expect(formatBankAccount(ACC)).toBe("見本銀行 本店 普通 1234567 名義 ミホン タロウ");
    expect(formatBankAccount(EMPTY_BANK_ACCOUNT)).toBeNull();
  });
  it("口座が空で自社が受け取るなら取引の設定の口座・入れた口座があればそれ・振込でなければ無し", () => {
    const d = { ...base, payments: { brokerageSeller: { method: "transfer" as const, account: EMPTY_BANK_ACCOUNT }, balance: tr(), deposit: cash } };
    const rows = paymentRows(d, calcOf(d));
    const by = (k: string) => rows.find((r) => r.key === k)!;
    expect(effectiveAccount(by("brokerageSeller"), rows, SELF_ACC)).toEqual(SELF_ACC);
    expect(effectiveAccount(by("balance"), rows, SELF_ACC)).toEqual(ACC);
    expect(effectiveAccount(by("deposit"), rows, SELF_ACC)).toBeNull();
    expect(effectiveAccount(by("registration"), rows, SELF_ACC)).toBeNull();
  });
  it("「残金と一緒に」は残金の口座を使う", () => {
    const d = { ...base, payments: { balance: tr(), settlement: { method: "with_balance" as const, account: EMPTY_BANK_ACCOUNT } } };
    const rows = paymentRows(d, calcOf(d));
    expect(effectiveAccount(rows.find((r) => r.key === "settlement")!, rows, SELF_ACC)).toEqual(ACC);
  });
});

describe("書類に入れる文", () => {
  it("買主様あての振込先: 残金が振込なら口座・精算金が一緒なら合わせた額を添える", () => {
    const d = { ...base, payments: { balance: tr(), settlement: { method: "with_balance" as const, account: EMPTY_BANK_ACCOUNT } } };
    const c = calcOf(d);
    expect(balancePayeeText(d, c, SELF_ACC)).toBe(`見本銀行 本店 普通 1234567 名義 ミホン タロウ\n(残代金と精算金を合わせて ${c.settlement.paymentAtSettlement!.toLocaleString("ja-JP")}円をお振込みください)`);
    const only = { ...base, payments: { balance: tr() } };
    expect(balancePayeeText(only, calcOf(only), SELF_ACC)).toBe("見本銀行 本店 普通 1234567 名義 ミホン タロウ");
  });
  it("買主様あて: 精算金が売主→買主の向きで「残金と一緒に」なら、差し引いた額を添える", () => {
    const d = { ...base, settlementTerms: { ...DEFAULT_TERMS, others: [{ label: "返金", sellerToBuyer: 80_000, buyerToSeller: 0 }] },
      payments: { balance: tr(), settlement: { method: "with_balance" as const, account: EMPTY_BANK_ACCOUNT } } };
    const c = calcOf(d);
    expect(c.settlement.net.direction).toBe("sellerToBuyer");
    expect(balancePayeeText(d, c, SELF_ACC)).toContain(`(残代金から精算金を差し引いた ${c.settlement.paymentAtSettlement!.toLocaleString("ja-JP")}円をお振込みください)`);
    const row = paymentRows(d, c).find((r) => r.key === "settlement")!;
    expect([row.from, row.to, row.amount]).toEqual(["売主", "買主", 80_000]);
  });
  it("買主様あて: 残金が現金なら現金の案内・未定なら null(今までの初期値に任せる)", () => {
    const d = { ...base, payments: { balance: cash } };
    expect(balancePayeeText(d, calcOf(d), SELF_ACC)).toBe("現金でお支払いください(お振込みは不要です)");
    expect(balancePayeeText(base, calcOf(base), SELF_ACC)).toBeNull();
  });
  it("売主様あてのお受け取りの口座: 残金の口座・現金なら現金・未定なら null", () => {
    const d = { ...base, payments: { balance: tr() } };
    expect(sellerReceiveText(d, calcOf(d), SELF_ACC)).toBe("見本銀行 本店 普通 1234567 名義 ミホン タロウ");
    expect(sellerReceiveText({ ...base, payments: { balance: cash } }, calcOf(base), SELF_ACC)).toBe("現金でお受け取りいただきます");
    expect(sellerReceiveText(base, calcOf(base), SELF_ACC)).toBeNull();
  });
  it("書類確認書の払い方: 振込・現金だけ写す(未定は空)。残代金・精算金は残金の払い方", () => {
    const d = { ...base, payments: { deposit: cash, balance: tr(), registration: tr(), cancellation: { method: "undecided" as const, account: EMPTY_BANK_ACCOUNT } } };
    const c = calcOf(d);
    expect(checklistPayDefault("deposit", d, c)).toEqual([{ method: "cash", amount: null, other: null }]);
    expect(checklistPayDefault("payment", d, c)).toEqual([{ method: "transfer", amount: null, other: null }]);
    expect(checklistPayDefault("registration", d, c)).toEqual([{ method: "transfer", amount: null, other: null }]);
    expect(checklistPayDefault("cancellation", d, c)).toEqual([]);
    expect(checklistPayDefault("survey", d, c)).toEqual([]);
  });
  it("売主→買主の精算金を別に払う: 振込先に差し引く前の額を添え、チェックリストの払い方は空(@codex #751)", () => {
    const d = { ...base, settlementTerms: { ...DEFAULT_TERMS, others: [{ label: "返金", sellerToBuyer: 80_000, buyerToSeller: 0 }] },
      payments: { balance: tr(), settlement: cash } };
    const c = calcOf(d);
    expect(balancePayeeText(d, c, SELF_ACC)).toContain(`(精算金 80,000円は売主から別にお支払いします。お振込みいただく額は ${(c.settlement.paymentAtSettlement! + 80_000).toLocaleString("ja-JP")}円です)`);
    expect(checklistPayDefault("payment", d, c)).toEqual([]);
    const undecided = { ...d, payments: { balance: tr() } };
    expect(checklistPayDefault("payment", undecided, calcOf(undecided))).toEqual([{ method: "transfer", amount: null, other: null }]);
  });
  it("費用のその他で同じ名前の行は、1行にまとめて金額を足す(@codex #751)", () => {
    const d = { ...base, costs: { ...base.costs, others: [{ label: "処分費", amount: 10_000 }, { label: "処分費", amount: 20_000 }] } };
    const rows = paymentRows(d, calcOf(d)).filter((r) => r.key.startsWith("other:"));
    expect(rows.map((r) => [r.label, r.amount])).toEqual([["処分費", 30_000]]);
  });
  it("書類確認書: 精算金だけ別の払い方なら、残代金と精算金を分けて金額を入れる", () => {
    const d = { ...base, payments: { balance: tr(), settlement: cash } };
    const c = calcOf(d);
    const net = c.settlement.net.amount;
    expect(checklistPayDefault("payment", d, c)).toEqual([
      { method: "transfer", amount: c.settlement.paymentAtSettlement! - net, other: null },
      { method: "cash", amount: net, other: null },
    ]);
  });
});

describe("保存の形", () => {
  it("知らない鍵・口座番号の文字は断る", () => {
    expect(paymentsSchema.safeParse({ foo: cash }).success).toBe(false);
    expect(paymentsSchema.safeParse({ balance: { method: "transfer", account: { ...ACC, accountNumber: "12-34" } } }).success).toBe(false);
    expect(paymentsSchema.safeParse({ balance: tr(), others: { 家財の処分: cash } }).success).toBe(true);
  });
  it("「残金と一緒に」は精算金だけ保存できる・ほかの鍵に入っていたら未定として読む・残金が一緒にでも止まらない", () => {
    const wb = { method: "with_balance" as const, account: EMPTY_BANK_ACCOUNT };
    expect(paymentsSchema.safeParse({ settlement: wb }).success).toBe(true);
    expect(paymentsSchema.safeParse({ balance: wb }).success).toBe(false);
    expect(paymentsSchema.safeParse({ others: { 家財の処分: wb } }).success).toBe(false);
    expect(readPayments({ balance: wb, settlement: wb, others: { x: wb } })).toEqual({ balance: { ...wb, method: "undecided" }, settlement: wb, others: { x: { ...wb, method: "undecided" } } });
    const d = { ...base, payments: { balance: wb, settlement: wb } };
    const rows = paymentRows(d, calcOf(d));
    expect(effectiveAccount(rows.find((r) => r.key === "balance")!, rows, SELF_ACC)).toBeNull();
    expect(effectiveAccount(rows.find((r) => r.key === "settlement")!, rows, SELF_ACC)).toBeNull();
  });
  it("読むときは壊れた項目だけ落とす", () => {
    expect(readPayments({ deposit: cash, balance: { method: "bogus" }, others: { ok: cash, "": cash } })).toEqual({ deposit: cash, others: { ok: cash } });
    expect(readPayments(null)).toEqual({});
  });
});

describe("保存する形を組み立てる", () => {
  it("今の行の下書きを入れ、行に無い保存済みの鍵は残す", async () => {
    const { paymentsForSave } = await import("../payments");
    const d = { ...base, payments: { survey: cash, others: { 古い行: cash } } };
    const rows = paymentRows(d, calcOf(d));
    const out = paymentsForSave(d.payments, rows, { balance: tr(), "other:家財の処分": tr(), deposit: { method: "with_balance", account: EMPTY_BANK_ACCOUNT } });
    expect(out.balance).toEqual(tr());
    expect(out.survey).toEqual(cash);
    expect(out.others).toEqual({ 古い行: cash, 家財の処分: { ...tr(), payer: { kind: "undecided", name: null }, to: { kind: "other", name: null } } });
    expect(out.deposit!.method).toBe("undecided");
    expect(out.settlement!.method).toBe("undecided");
    expect(paymentsSchema.safeParse(out).success).toBe(true);
  });
  it("その他の行は払う人・受け取る人も保存する(名前は「その他」のときだけ)。固定の行には付けない", async () => {
    const { paymentsForSave } = await import("../payments");
    const rows = paymentRows(base, calcOf(base));
    const out = paymentsForSave({}, rows, {
      "other:家財の処分": { ...cash, payer: { kind: "buyer", name: "消える" }, to: { kind: "other", name: " 解体業者 " } },
      balance: { ...tr(), payer: { kind: "self", name: null } },
    });
    // 払う人は新しい形(payer)で保存し、前の形(from)は書かない
    expect(out.others!["家財の処分"]).toEqual({ ...cash, payer: { kind: "buyer", name: null }, to: { kind: "other", name: "解体業者" } });
    expect(out.balance).toEqual(tr());
    expect(paymentsSchema.safeParse(out).success).toBe(true);
  });
  it("その他の行で下書きに払う人・受け取る人が無ければ、行の今の値(初期値)を保存する", async () => {
    const { paymentsForSave } = await import("../payments");
    const rows = paymentRows(base, calcOf(base));
    const out = paymentsForSave({}, rows, { "other:家財の処分": cash });
    expect(out.others!["家財の処分"]).toEqual({ ...cash, payer: { kind: "undecided", name: null }, to: { kind: "other", name: null } });
  });
  it("口座番号の欄: 全角・空白・ハイフンをそろえ、7桁を超える・数字でないものは読めない", async () => {
    const { normalizeAccountNumber } = await import("../payments");
    expect(normalizeAccountNumber("１２３ ４５６７")).toBe("1234567");
    expect(normalizeAccountNumber("123-4567")).toBe("1234567");
    expect(normalizeAccountNumber("")).toBe("");
    expect(normalizeAccountNumber("12345678")).toBeNull();
    expect(normalizeAccountNumber("12a")).toBeNull();
  });
});
