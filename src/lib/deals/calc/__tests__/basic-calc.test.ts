import { describe, it, expect } from "vitest";
import { addDays, daysInclusive, daysInMonth, parseYmd, ymd } from "../dates";
import { yen } from "../format";
import { brokerageFee, type BrokerageTiers } from "../brokerage";
import { contractStamp, receiptStamp, stampTax } from "../stamp";
import { loanPayment } from "../loan";
import { INITIAL_RATE_TABLES } from "../../rate-tables";

const tiers = INITIAL_RATE_TABLES.find((t) => t.kind === "brokerage_tiers")!.content as BrokerageTiers;
const contractReduced = INITIAL_RATE_TABLES.filter((t) => t.kind === "stamp_contract")[0].content as { brackets: { upTo: number | null; tax: number }[] };
const receipt = INITIAL_RATE_TABLES.find((t) => t.kind === "stamp_receipt")!.content as { brackets: { upTo: number | null; tax: number }[] };

describe("日付", () => {
  it("読む・作る・足す・数える", () => {
    expect(parseYmd("2026-07-01")).toEqual({ y: 2026, m: 7, d: 1 });
    expect(ymd(2026, 4, 1)).toBe("2026-04-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(daysInclusive("2026-07-01", "2026-12-31")).toBe(184);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
  });
  it("金額の3桁区切り", () => {
    expect(yen(1056000)).toBe("1,056,000");
    expect(yen(0)).toBe("0");
  });
});

describe("仲介手数料(依頼書 3.1)", () => {
  it("3,000万円 → 税抜 960,000円・税込 1,056,000円", () => {
    expect(brokerageFee(30_000_000, tiers, { lowCostSpecial: false, taxRateBp: 1000 })).toEqual({ excl: 960_000, incl: 1_056_000, specialApplied: false });
  });
  it.each([4_000_001, 5_000_000, 12_345_678, 123_456_789])("400万円超は 価格×3%+6万円 と一致(%i円)", (p) => {
    expect(brokerageFee(p, tiers, { lowCostSpecial: false, taxRateBp: 1000 }).excl).toBe(Math.floor((p * 3) / 100) + 60_000);
  });
  it("200万円以下は 5%・400万円以下は 4%の部分まで", () => {
    expect(brokerageFee(1_000_000, tiers, { lowCostSpecial: false, taxRateBp: 1000 }).excl).toBe(50_000);
    expect(brokerageFee(3_000_000, tiers, { lowCostSpecial: false, taxRateBp: 1000 }).excl).toBe(140_000);
  });
  it("低廉な空家等の特例: 800万円以下なら上限30万円(税抜)・超えれば効かない", () => {
    expect(brokerageFee(5_000_000, tiers, { lowCostSpecial: true, taxRateBp: 1000 })).toEqual({ excl: 300_000, incl: 330_000, specialApplied: true });
    expect(brokerageFee(8_000_001, tiers, { lowCostSpecial: true, taxRateBp: 1000 }).specialApplied).toBe(false);
  });
});

describe("印紙税(依頼書 3.5)", () => {
  it("金額の区分の境目(軽減の表)", () => {
    expect(stampTax(9_999, contractReduced)).toBe(0);
    expect(stampTax(10_000, contractReduced)).toBe(200);
    expect(stampTax(10_000_000, contractReduced)).toBe(5_000);
    expect(stampTax(10_000_001, contractReduced)).toBe(10_000);
    expect(stampTax(9_000_000_000, contractReduced)).toBe(480_000);
  });
  it("折半は切り捨て", () => {
    expect(contractStamp(30_000_000, contractReduced, "half")).toBe(5_000);
    expect(contractStamp(30_000_000, contractReduced, "full")).toBe(10_000);
  });
  it("領収書の非課税: する=0・しない=表・判断が必要=表の額と確認が要る印", () => {
    expect(receiptStamp(3_000_000, receipt, "yes")).toEqual({ tax: 0, needsDecision: false });
    expect(receiptStamp(3_000_000, receipt, "no")).toEqual({ tax: 600, needsDecision: false });
    expect(receiptStamp(3_000_000, receipt, "unknown")).toEqual({ tax: 600, needsDecision: true });
    expect(receiptStamp(49_999, receipt, "no").tax).toBe(0);
  });
});

describe("ローン返済(依頼書 3.6)", () => {
  it("4,000万円・年1.0%・35年 → 月 112,914円(切り捨て)", () => {
    expect(loanPayment(40_000_000, 100, 35)).toBe(112_914);
  });
  it("金利0%は 借入額÷回数(切り捨て)・借入0は0", () => {
    expect(loanPayment(10_000_000, 0, 35)).toBe(Math.floor(10_000_000 / 420));
    expect(loanPayment(0, 100, 35)).toBe(0);
  });
});
