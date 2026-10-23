import { describe, it, expect } from "vitest";
import { INITIAL_RATE_TABLES, pickRateTable, consumptionTaxRateBp, type RateTableRow } from "../rate-tables";

const row = (kind: string, from: string, to: string | null, content: unknown): RateTableRow => ({
  kind, validFrom: new Date(`${from}T00:00:00Z`), validTo: to ? new Date(`${to}T00:00:00Z`) : null, content,
});

describe("期間で表を選ぶ", () => {
  const rows = [
    row("stamp_contract", "2014-04-01", "2027-03-31", { v: "reduced" }),
    row("stamp_contract", "2027-04-01", null, { v: "standard" }),
    row("consumption_tax", "2019-10-01", null, { rateBp: 1000 }),
  ];
  it("終了日の当日までは古い表・翌日から新しい表", () => {
    expect(pickRateTable(rows, "stamp_contract", "2027-03-31")?.content).toEqual({ v: "reduced" });
    expect(pickRateTable(rows, "stamp_contract", "2027-04-01")?.content).toEqual({ v: "standard" });
  });
  it("始まる前は無い", () => {
    expect(pickRateTable(rows, "stamp_contract", "2014-03-31")).toBeNull();
  });
  it("消費税率・表が無ければ 10%", () => {
    expect(consumptionTaxRateBp(rows, "2026-10-24")).toBe(1000);
    expect(consumptionTaxRateBp([], "2026-10-24")).toBe(1000);
  });
});

describe("初期データ", () => {
  it("5種類がそろい、同じ種類の期間は重ならない", () => {
    expect(new Set(INITIAL_RATE_TABLES.map((t) => t.kind))).toEqual(
      new Set(["consumption_tax", "brokerage_tiers", "stamp_contract", "stamp_receipt", "capital_gains"]),
    );
    const contract = INITIAL_RATE_TABLES.filter((t) => t.kind === "stamp_contract");
    expect(contract.map((t) => [t.validFrom, t.validTo])).toEqual([["2014-04-01", "2027-03-31"], ["2027-04-01", null]]);
  });
  it("印紙税の金額の区分は小さい順で、最後は上限なし", () => {
    for (const t of INITIAL_RATE_TABLES.filter((x) => x.kind.startsWith("stamp_"))) {
      const b = (t.content as { brackets: { upTo: number | null; tax: number }[] }).brackets;
      const ups = b.slice(0, -1).map((x) => x.upTo as number);
      expect([...ups].sort((x, y) => x - y)).toEqual(ups);
      expect(b[b.length - 1].upTo).toBeNull();
    }
  });
});
