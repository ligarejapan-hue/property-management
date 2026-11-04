import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BROKERAGE_QUICK_OPTIONS, brokerageQuick } from "../brokerage";
import { STAMP_CONTRACT_REDUCTION_END, stampNote } from "../stamp";
import { INITIAL_RATE_TABLES } from "../../rate-tables";

// 2026-11-04 発注者: 仲介手数料は自由入力・計算のボタンは「3%＋6万円＋消費税」「3%＋消費税」の選択式。
describe("正規の手数料率(速算)", () => {
  it("選択肢は2つ(3%＋6万円＋消費税 / 3%＋消費税)", () => {
    expect(BROKERAGE_QUICK_OPTIONS.map((o) => o.label)).toEqual(["3%＋6万円＋消費税", "3%＋消費税"]);
  });
  it("3%＋6万円(税抜)", () => {
    expect(brokerageQuick(30_000_000, "3pct_60k")).toBe(960_000);
  });
  it("3%(税抜)", () => {
    expect(brokerageQuick(30_000_000, "3pct")).toBe(900_000);
  });
  it("円未満は切り捨て", () => {
    expect(brokerageQuick(1_234_567, "3pct")).toBe(37_037);
    expect(brokerageQuick(1_234_567, "3pct_60k")).toBe(97_037);
  });
});

// 2026-11-04 発注者「印紙は最新の減税を確認」→ 国税庁: 平成26年4月1日〜令和9年3月31日に作成の不動産譲渡契約書(記載金額10万円超)。
describe("売買契約書の印紙税の軽減措置", () => {
  const reduced = INITIAL_RATE_TABLES.find((t) => t.kind === "stamp_contract" && t.validFrom === "2014-04-01");
  const regular = INITIAL_RATE_TABLES.find((t) => t.kind === "stamp_contract" && t.validTo === null);
  const taxOf = (content: unknown, amount: number) => {
    const b = (content as { brackets: { upTo: number | null; tax: number }[] }).brackets;
    return b.find((x) => x.upTo === null || amount <= x.upTo)!.tax;
  };
  it("軽減の期間は 2027-03-31 まで・その翌日から本則", () => {
    expect(reduced?.validTo).toBe(STAMP_CONTRACT_REDUCTION_END);
    expect(regular?.validFrom).toBe("2027-04-01");
  });
  it("軽減後の税額(国税庁の表)", () => {
    const cases: Array<[number, number]> = [
      [100_000, 200], [500_000, 200], [1_000_000, 500], [5_000_000, 1_000], [10_000_000, 5_000],
      [50_000_000, 10_000], [100_000_000, 30_000], [500_000_000, 60_000], [1_000_000_000, 160_000],
      [5_000_000_000, 320_000], [5_000_000_001, 480_000],
    ];
    for (const [amount, tax] of cases) expect(taxOf(reduced!.content, amount)).toBe(tax);
  });
  it("migration の初期値も同じ期間", () => {
    const sql = readFileSync(join(process.cwd(), "prisma/migrations/20261024100000_add_deals/migration.sql"), "utf8");
    expect(sql).toContain("('stamp_contract', DATE '2014-04-01', DATE '2027-03-31'");
    expect(sql).toContain("('stamp_contract', DATE '2027-04-01', NULL");
  });
  it("画面の説明は基準日で切り替わる", () => {
    expect(stampNote("2026-11-04")).toBe("軽減措置の税率(2027年3月31日までに作る契約書)");
    expect(stampNote("2027-03-31")).toBe("軽減措置の税率(2027年3月31日までに作る契約書)");
    expect(stampNote("2027-04-01")).toBe("本則の税率(軽減措置は2027年3月31日まで)");
  });
});
