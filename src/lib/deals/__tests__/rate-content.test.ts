import { describe, it, expect } from "vitest";
import { RATE_CONTENT_SCHEMAS, periodsOverlap, rateTableInputSchema } from "../rate-content";
import { INITIAL_RATE_TABLES } from "../rate-tables";

describe("税率の表の中身の検証", () => {
  it("初期データはすべて通る", () => {
    for (const t of INITIAL_RATE_TABLES) expect(RATE_CONTENT_SCHEMAS[t.kind].safeParse(t.content).success, t.kind).toBe(true);
  });
  it("区分は小さい順で最後だけ上限なし", () => {
    const s = RATE_CONTENT_SCHEMAS.stamp_receipt;
    expect(s.safeParse({ brackets: [{ upTo: 100, tax: 0 }, { upTo: null, tax: 200 }] }).success).toBe(true);
    expect(s.safeParse({ brackets: [{ upTo: 100, tax: 0 }, { upTo: 50, tax: 1 }, { upTo: null, tax: 200 }] }).success).toBe(false);
    expect(s.safeParse({ brackets: [{ upTo: 100, tax: 0 }] }).success).toBe(false);
  });
  it("入力: 期間の終わりは始まり以降・中身は種類ごとに検証", () => {
    expect(rateTableInputSchema.safeParse({ kind: "consumption_tax", validFrom: "2030-01-01", validTo: null, content: { rateBp: 1200 } }).success).toBe(true);
    expect(rateTableInputSchema.safeParse({ kind: "consumption_tax", validFrom: "2030-01-01", validTo: "2029-12-31", content: { rateBp: 1200 } }).success).toBe(false);
    expect(rateTableInputSchema.safeParse({ kind: "consumption_tax", validFrom: "2030-01-01", validTo: null, content: { rateBp: "10%" } }).success).toBe(false);
  });
  it("期間の重なり(終わりが空=期限なし)", () => {
    expect(periodsOverlap({ validFrom: "2014-04-01", validTo: "2027-03-31" }, { validFrom: "2027-04-01", validTo: null })).toBe(false);
    expect(periodsOverlap({ validFrom: "2014-04-01", validTo: null }, { validFrom: "2027-04-01", validTo: null })).toBe(true);
    expect(periodsOverlap({ validFrom: "2020-01-01", validTo: "2020-12-31" }, { validFrom: "2020-12-31", validTo: "2021-12-31" })).toBe(true);
  });
});
