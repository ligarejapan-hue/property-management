import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import DealPaymentsPanel from "../deal-payments-panel";
import { computeDealCalc } from "@/lib/deals/calc/deal-calc";
import { DEFAULT_COSTS, DEFAULT_TERMS, EMPTY_BANK_ACCOUNT, EMPTY_BROKER, EMPTY_SNAPSHOT, type BankAccount, type PaymentEntry } from "@/lib/deals/schemas";
import { DEFAULT_PROPERTY_KINDS } from "@/lib/deals/constants";
import { INITIAL_RATE_TABLES, type RateTableRow } from "@/lib/deals/rate-tables";
import { DEFAULT_FUNDING_INPUTS } from "@/lib/deals/funding-schema";
import { DEFAULT_BUSINESS_INPUTS } from "@/lib/deals/business-schema";
import type { DealPartyView, DealView } from "@/lib/deals/view";

const rateRows: RateTableRow[] = INITIAL_RATE_TABLES.map((t) => ({
  kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
}));
const party = (p: Partial<DealPartyView> & Pick<DealPartyView, "id" | "role" | "name">): DealPartyView => ({
  partyType: "individual", representative: null, address: null, phone: null, shareNum: null, shareDen: null, isSelf: false, sortOrder: 0, version: 1, ...p,
});
const SELLER = party({ id: "s", role: "seller", name: "架空 一郎" });
const BUYER = party({ id: "b", role: "buyer", name: "架空 花子" });
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
const render = (d: DealView, self: BankAccount = SELF_ACC) =>
  renderToStaticMarkup(<DealPaymentsPanel deal={d} calc={calcOf(d)} selfAccount={self} onSaved={async () => {}} />);

describe("お金の受け渡しのタブ(2026-11-16)", () => {
  it("お金ごとの行・払う人と受け取る人・金額を出す", () => {
    const html = render(base);
    for (const label of ["手付金", "残金", "精算金", "登記費用", "抹消費用", "仲介手数料(売主)", "仲介手数料(買主)", "家財の処分"]) expect(html).toContain(`aria-label="${label}の払い方"`);
    expect(html).toContain("買主 → 売主");
    expect(html).toContain("1,500,000円");
  });
  it("「残金と一緒に」は精算金だけ", () => {
    const html = render(base);
    expect(html.match(/残金と一緒に/g)).toHaveLength(1);
  });
  it("振込を選んだ行だけ口座の欄。自社が受け取る行で口座が空なら、自社の口座を使うと出す", () => {
    const d = { ...base, payments: { brokerageSeller: { method: "transfer" as const, account: EMPTY_BANK_ACCOUNT }, balance: tr() } };
    const html = render(d);
    expect(html).toContain('aria-label="仲介手数料(売主)の銀行名"');
    expect(html).toContain('aria-label="残金の口座番号(7桁まで)"');
    expect(html).not.toContain('aria-label="手付金の銀行名"');
    expect(html).toContain("空欄のときは自社の口座(自社銀行 駅前支店 当座 7654321 名義 カクウフドウサン)を使います");
    expect(html).toContain("残金と同じ口座にする");
  });
  it("自社の口座が設定に無ければ「自社の口座を入れる」は出さない", () => {
    const d = { ...base, payments: { balance: tr() } };
    expect(render(d, EMPTY_BANK_ACCOUNT)).not.toContain("自社の口座を入れる");
    expect(render(d)).toContain("自社の口座を入れる");
  });
  it("「残金と一緒に」の行には残金の口座を出す", () => {
    const d = { ...base, payments: { balance: tr(), settlement: { method: "with_balance" as const, account: EMPTY_BANK_ACCOUNT } } };
    expect(render(d)).toContain("残金と同じ払い方・口座です(見本銀行 本店 普通 1234567 名義 ミホン タロウ)");
  });
  it("その他の費用の行だけ、払う人・受け取る人を選べる。「その他」なら名前の欄(11-18 発注者)", () => {
    const html = render(base);
    expect(html).toContain('aria-label="家財の処分の払う人"');
    expect(html).toContain('aria-label="家財の処分の受け取る人"');
    expect(html).toContain('aria-label="家財の処分の受け取る人の名前"');
    expect(html).not.toContain('aria-label="家財の処分の払う人の名前"');
    expect(html).not.toContain('aria-label="手付金の払う人"');
    for (const l of ["未定", "売主", "買主", "当社", "仲介会社", "司法書士", "測量の会社", "その他(名前を入れる)"]) expect(html).toContain(`>${l}</option>`);
    const d = { ...base, payments: { others: { 家財の処分: { method: "cash" as const, account: EMPTY_BANK_ACCOUNT, to: { kind: "other" as const, name: "解体業者" } } } } };
    expect(render(d)).toContain('value="解体業者"');
  });
  it("見えない払い方の radio は、外側の label を位置の基準にする(押すとページ全体がずれて真っ白になった・11-17)", () => {
    const html = render(base);
    const labels = [...html.matchAll(/<label class="([^"]*)"><input type="radio" class="sr-only"/g)];
    expect(labels.length).toBeGreaterThan(0);
    for (const [, cls] of labels) expect(cls.split(" ")).toContain("relative");
  });
});

describe("説明の文", () => {
  it("払い方が入る書類は書類確認書(準備チェックリストではない)", () => {
    const html = render(base);
    expect(html).toContain("残金決済のご案内と書類確認書の払い方に最初から入ります");
    expect(html).not.toContain("準備チェックリスト");
  });
});
