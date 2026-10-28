import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { buildValuesXlsx } from "../business/values-xlsx";
import { computeDealCalc } from "../../calc/deal-calc";
import { DEFAULT_COSTS, DEFAULT_TERMS, EMPTY_BANK_ACCOUNT, EMPTY_BROKER, EMPTY_SNAPSHOT } from "../../schemas";
import { DEFAULT_PROPERTY_KINDS } from "../../constants";
import { INITIAL_RATE_TABLES, type RateTableRow } from "../../rate-tables";
import { DEFAULT_FUNDING_INPUTS } from "../../funding-schema";
import { DEFAULT_BUSINESS_INPUTS } from "../../business-schema";
import { resolveDealSettings } from "../../settings";
import type { DealPartyView, DealView } from "../../view";
import type { CompanyProfile } from "@/lib/sales-sheet/company-profile-store";
import type { BusinessDocContext } from "../business/common";
import { BUSINESS_DOCS, businessDocOf } from "../registry";
import { DocOptionError } from "../business/receipts";

const rateRows: RateTableRow[] = INITIAL_RATE_TABLES.map((t) => ({
  kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
}));
const party = (p: Partial<DealPartyView> & Pick<DealPartyView, "id" | "role" | "name">): DealPartyView => ({
  partyType: "individual", representative: null, address: null, phone: null, shareNum: null, shareDen: null, isSelf: false, sortOrder: 0, version: 1, ...p,
});
const SELLER = party({ id: "p-seller", role: "seller", name: "架空 一郎", address: "架空県架空市1-1" });
const BUYER = party({ id: "p-buyer", role: "buyer", name: "架空 花子" });
const SELF_SELLER = party({ id: "p-self", role: "seller", name: "架空不動産株式会社", partyType: "corporation", isSelf: true });
const deal: DealView = {
  id: "d", dealNo: "2026-0010", name: "試験", businessType: "brokerage", tradeSide: "both", status: "contracted",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "unit", hasOc: false,
  contractAt: "2026-04-30T15:00:00.000Z", contractPlace: null, settlementAt: "2026-06-30T01:00:00.000Z", settlementPlace: "架空銀行 架空支店",
  price: 30_000_000, buildingTax: null, deposit: 1_500_000, taxRateBp: 1000,
  propertySnapshot: { ...EMPTY_SNAPSHOT, buildingName: "試験マンション<b>", roomNo: "201", address: "架空県架空市2-2" },
  counterpartyBroker: EMPTY_BROKER, assessments: { rows: [], landRatioBp: 10000 }, costs: DEFAULT_COSTS,
  settlementTerms: { ...DEFAULT_TERMS, fixedAssetTax: 100_000, cityPlanningTax: 20_000, managementFee: 15_000, repairReserve: 5_000 },
  leases: [], overrides: {}, version: 1, createdAt: "", updatedAt: "", parties: [SELLER, BUYER],
  fundingPlan: DEFAULT_FUNDING_INPUTS, businessPlan: DEFAULT_BUSINESS_INPUTS,
};
const company: CompanyProfile = { nameJa: "架空不動産株式会社", license: "", tel: "", fax: "", email: "", hp: "", address: "架空県架空市3-3" };
const SEAL = "data:image/png;base64,c2VhbA==";
const ctx = (d: DealView = deal, extra: Partial<BusinessDocContext> = {}): BusinessDocContext => ({
  deal: d, calc: computeDealCalc(d, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-25"), settings: resolveDealSettings(null),
  company, rateRows, today: "2026-10-25", logo: null, seal: SEAL, ...extra,
});
const doc = (key: string) => businessDocOf(key)!;

describe("業務書類の一覧表", () => {
  it("段5a の5つ・必要な項目の空欄を返す", () => {
    expect(BUSINESS_DOCS.filter((d) => d.group === "settlement").map((d) => d.key)).toEqual(["settlement_statement", "settlement_guide", "settlement_guide_seller", "deposit_receipt", "balance_receipt", "settlement_receipt", "completion_confirmation"]);
    expect(doc("settlement_statement").missing(ctx())).toEqual([]);
    expect(doc("settlement_guide").missing(ctx({ ...deal, settlementPlace: null, parties: [SELLER] }))).toEqual(["決済場所", "買主"]);
    expect(doc("deposit_receipt").missing(ctx({ ...deal, deposit: null }))).toEqual(["手付金の金額"]);
  });
  it("精算金領収書は差引が 0 のときは出さない", () => {
    expect(doc("settlement_receipt").applies(ctx())).toBe(true);
    expect(doc("settlement_receipt").applies(ctx({ ...deal, settlementTerms: DEFAULT_TERMS }))).toBe(false);
  });
});

describe("精算書", () => {
  it("区分は固都税と管理費の行・合計・差引の1行・残代金との関係を出す(OC の行は無い)", () => {
    const c = ctx();
    const { html } = doc("settlement_statement").build(c, {});
    const s = c.calc.settlement;
    expect(html).toContain("固定資産税・都市計画税");
    expect(html).toContain("管理費・修繕積立金等");
    expect(html).not.toContain("賃料・共益費");
    expect(html).not.toContain("預り敷金");
    expect(html).toContain(`差引: ${s.netLine}`);
    expect(html).toContain("決済時のお支払額");
    expect(html).toContain("試験マンション&lt;b&gt; 201");
    for (const r of s.rows) if (r.formula) expect(html).toContain(r.formula);
  });
  it("土地には管理費の行が無い", () => {
    expect(doc("settlement_statement").build(ctx({ ...deal, propertyKind: "land" }), {}).html).not.toContain("管理費・修繕積立金等");
  });
  it("2枚目に回す形: 1枚目に各項目の金額と合計、2枚目「計算明細」に計算式", () => {
    const c = ctx();
    const out = doc("settlement_statement").build(c, {});
    const compact = out.compactHtml!;
    const [first, second] = compact.split("page-break-before:always");
    expect(second).toContain("計算明細");
    for (const r of c.calc.settlement.rows) {
      expect(first).toContain(r.label);
      if (r.formula) {
        expect(second).toContain(r.formula);
        expect(first).not.toContain(r.formula);
      }
    }
    expect(first).toContain("合計");
    expect(first).toContain(c.calc.settlement.netLine);
  });
});

describe("残金決済のご案内", () => {
  it("宛先は買主・金額は精算書と同じ計算の値・明朝", () => {
    const c = ctx();
    const { html } = doc("settlement_guide").build(c, { payee: null, belongings: "ご印鑑" });
    const s = c.calc.settlement;
    expect(html).toContain("架空 花子 様");
    expect(html).toContain(`${s.paymentAtSettlement!.toLocaleString("ja-JP")}円`);
    expect(html).toContain(`${s.remaining!.toLocaleString("ja-JP")}円`);
    expect(html).toContain("BIZ UDMincho");
    expect(html).toContain("司法書士");
  });
  it("振込先の初期値: 売主が自社なら取引の設定の口座・ほかは空", () => {
    const settings = { ...resolveDealSettings(null), bankAccount: { ...EMPTY_BANK_ACCOUNT, bankName: "架空銀行", branchName: "本店", accountType: "ordinary" as const, accountNumber: "1234567", accountHolder: "カクウフドウサン" } };
    expect(doc("settlement_guide").defaults(ctx(deal, { settings })).values.payee).toBeNull();
    expect(doc("settlement_guide").defaults(ctx({ ...deal, parties: [SELF_SELLER, BUYER] }, { settings })).values.payee).toBe("架空銀行 本店 普通 1234567 名義 カクウフドウサン");
  });
});

describe("領収書", () => {
  it("個人の売主: 名前・住所で出し、自社の角印・会社名は入れない・署名押印の欄は空欄", () => {
    const c = ctx();
    const { html } = doc("deposit_receipt").build(c, { issuer: SELLER.id, exempt: "no", receivedOn: "2026-05-01" });
    expect(html).toContain("金 1,500,000 円也");
    expect(html).toContain("架空 花子 様");
    expect(html).toContain("架空 一郎");
    expect(html).toContain("架空県架空市1-1");
    expect(html).toContain("署名・押印");
    expect(html).not.toContain(SEAL);
    expect(html).not.toContain("架空不動産株式会社");
    expect(html).toContain("収入印紙<br>400円");
  });
  it("個人の発行者は非課税の判断が要る(選ばなければ組み立てない)・非課税なら印紙なし", () => {
    expect(() => doc("deposit_receipt").build(ctx(), { issuer: SELLER.id, exempt: null, receivedOn: null })).toThrow(DocOptionError);
    expect(doc("deposit_receipt").build(ctx(), { issuer: SELLER.id, exempt: "yes", receivedOn: null }).html).toContain("非課税");
  });
  it("自社が発行: 会社名・角印あり・判断は要らない", () => {
    const { html } = doc("balance_receipt").build(ctx({ ...deal, parties: [SELF_SELLER, BUYER] }), { issuer: "self", exempt: null, receivedOn: null });
    expect(html).toContain("金 28,500,000 円也");
    expect(html).toContain("架空不動産株式会社");
    expect(html).toContain(SEAL);
    expect(html).not.toContain("署名・押印");
  });
  it("発行者の初期値と選べる値: 自社の当事者があれば自社・なければ最初の売主", () => {
    expect(doc("deposit_receipt").defaults(ctx()).values.issuer).toBe(SELLER.id);
    expect(doc("deposit_receipt").defaults(ctx({ ...deal, parties: [SELF_SELLER, BUYER] })).values.issuer).toBe("self");
    expect(doc("deposit_receipt").defaults(ctx()).issuers!.map((i) => i.value)).toEqual(["self", SELLER.id]);
    // 受け取る側でない当事者は選べない
    expect(() => doc("deposit_receipt").build(ctx(), { issuer: BUYER.id, exempt: "no", receivedOn: null })).toThrow(DocOptionError);
  });
  it("精算金領収書: 金額は精算書の差引・内訳は精算書の項目名・宛先は払う側", () => {
    const c = ctx();
    const { html } = doc("settlement_receipt").build(c, { issuer: SELLER.id, exempt: "no", receivedOn: null });
    const s = c.calc.settlement;
    expect(s.net.direction).toBe("buyerToSeller");
    expect(html).toContain(`金 ${s.net.amount.toLocaleString("ja-JP")} 円也`);
    expect(html).toContain("内訳: 固定資産税・都市計画税・管理費・修繕積立金等");
    expect(html).toContain("架空 花子 様");
  });
});

describe("最終レビューの直し", () => {
  it("個人が発行した領収書の Excel にも自社の名前を入れない", async () => {
    const out = doc("deposit_receipt").build(ctx(), { issuer: SELLER.id, exempt: "no", receivedOn: null });
    const buf = await buildValuesXlsx({ title: "手付金領収書", dealNo: "2026-0010", issuedOn: "2026-10-25", rows: out.rows, issuerName: out.issuerName ?? company.nameJa });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const values: unknown[] = [];
    wb.worksheets[0].eachRow((row) => row.eachCell((c) => values.push(c.value)));
    expect(JSON.stringify(values)).not.toContain("架空不動産株式会社");
    expect(wb.creator).toBe("架空 一郎");
    expect(values).toContain("架空 一郎");
  });
  it("精算書の Excel: 両方に金額がある行は、向きごとに2行で入れる・敷金の承継は合計のあと", () => {
    const d = {
      ...deal, hasOc: true,
      leases: [{ room: "101", tenant: "架空", contractType: "ordinary" as const, period: null, rent: 0, commonFee: 0, parking: 0, other: 0, deposit: 200_000, arrears: false, arrearsAmount: 0, manager: null }],
      settlementTerms: { ...deal.settlementTerms, others: [{ label: "測量費の負担", sellerToBuyer: 1_000, buyerToSeller: 5_000 }] },
    };
    const out = doc("settlement_statement").build(ctx(d), {});
    const labels = out.rows.map((r) => r.label);
    expect(labels).toContain("測量費の負担(売主→買主)");
    expect(labels).toContain("測量費の負担(買主→売主)");
    expect(labels.findIndex((l) => l.startsWith("預り敷金の承継"))).toBeGreaterThan(labels.indexOf("合計(買主→売主)"));
    // PDF でも敷金の承継は合計の行のあと
    expect(out.html.indexOf("預り敷金の承継")).toBeGreaterThan(out.html.indexOf(">合計<"));
  });
  it("金額が無い領収書は「空欄のまま出す」ができない(止める項目として返す)", () => {
    expect(doc("deposit_receipt").blocking(ctx({ ...deal, deposit: null }))).toEqual(["手付金の金額"]);
    expect(doc("deposit_receipt").blocking(ctx())).toEqual([]);
    expect(doc("settlement_statement").blocking(ctx({ ...deal, price: null }))).toEqual([]);
  });
});

describe("@codex の直し", () => {
  it("手で直した精算額は「手で直した金額」と出し、元の計算式を根拠に見せない(1枚の形・計算明細・Excel)", () => {
    const d = { ...deal, overrides: { "settlement.propertyTax": 12_345 } };
    const c = ctx(d);
    const row = c.calc.settlement.rows.find((r) => r.key === "propertyTax")!;
    expect(row.overridden).toBe(true);
    const out = doc("settlement_statement").build(c, {});
    expect(out.html).toContain(`手で直した金額(元の計算: ${row.formula})`);
    expect(out.html).not.toContain(`<td>${row.formula}</td>`);
    const detail = out.compactHtml!.split("page-break-before:always")[1];
    expect(detail).toContain(`手で直した金額(元の計算: ${row.formula})`);
    expect(out.rows.some((r) => r.label === "固定資産税・都市計画税・手で直した金額(買主→売主)")).toBe(true);
  });
  it("非課税を選んだら、印紙の表が無くても「非課税」と出す", () => {
    const { html, rows } = doc("deposit_receipt").build(ctx(deal, { rateRows: [] }), { issuer: SELLER.id, exempt: "yes", receivedOn: null });
    expect(html).toContain("非課税");
    expect(rows.find((r) => r.label === "収入印紙")?.value).toBe("非課税");
  });
});
