import { describe, it, expect } from "vitest";
import { prorateAnnualTax, prorateMonthly } from "../proration";
import { depositSuccession } from "../deposit";

describe("固都税の日割り(依頼書 3.2)", () => {
  it("年 120,000円・1/1 起算・決済 2026-07-01 → 買主 60,493円・売主 59,507円", () => {
    const r = prorateAnnualTax(120_000, "01-01", "2026-07-01");
    expect(r).toMatchObject({ buyer: 60_493, seller: 59_507, yearDays: 365, buyerDays: 184, periodStart: "2026-01-01", periodEnd: "2026-12-31", warning: null });
    expect(r.formula).toBe("120,000円×184日÷365日");
  });
  it("決済が起算日の当日なら全額買主・大晦日なら1日分", () => {
    expect(prorateAnnualTax(365_000, "01-01", "2026-01-01").buyer).toBe(365_000);
    expect(prorateAnnualTax(365_000, "01-01", "2026-12-31").buyer).toBe(1_000);
  });
  it("うるう年は 366日", () => {
    expect(prorateAnnualTax(366_000, "01-01", "2028-07-01")).toMatchObject({ yearDays: 366, buyerDays: 184, buyer: 184_000 });
  });
  it("4/1 起算・決済が1〜3月 → 前の年度で数え、注意文を出す(うるう日を含む年度は366日)", () => {
    const r = prorateAnnualTax(120_000, "04-01", "2028-02-15");
    expect(r).toMatchObject({ periodStart: "2027-04-01", periodEnd: "2028-03-31", yearDays: 366, buyerDays: 46 });
    expect(r.buyer).toBe(Math.floor((120_000 * 46) / 366));
    expect(r.warning).toContain("2027-04-01〜2028-03-31");
  });
  it("4/1 起算・決済が4月以降は注意文なし", () => {
    expect(prorateAnnualTax(120_000, "04-01", "2026-07-01")).toMatchObject({ periodStart: "2026-04-01", periodEnd: "2027-03-31", warning: null });
  });
});

describe("月額の日割り(管理費・賃料)", () => {
  it("決済月の日割り+前払い月数", () => {
    const r = prorateMonthly(30_000, "2026-07-11", 1);
    expect(r).toMatchObject({ buyerDays: 21, monthDays: 31, current: Math.floor((30_000 * 21) / 31), prepaid: 30_000 });
    expect(r.total).toBe(r.current + 30_000);
    expect(r.formula).toBe("30,000円×21日÷31日＋30,000円×1か月");
  });
  it("月末の決済は1日分・月初は丸ごと", () => {
    expect(prorateMonthly(31_000, "2026-07-31", 0).current).toBe(1_000);
    expect(prorateMonthly(31_000, "2026-07-01", 0).current).toBe(31_000);
  });
});

describe("敷金の承継(依頼書 3.3)", () => {
  it("合計と相殺/別途", () => {
    expect(depositSuccession([100_000, 150_000], "offset")).toEqual({ total: 250_000, mode: "offset" });
    expect(depositSuccession([], "separate")).toEqual({ total: 0, mode: "separate" });
  });
});
