/**
 * 税率・税額の表(設計 §2.5)。適用期間で切り替える。初期値は 2026-10 時点で公開されている現行の制度。
 * 率の単位は 1/100 %(10% = 1000)。金額の区分 upTo は「その金額以下」・null は上限なし。
 * ⚠この初期値は migration 20261024100000_add_deals の INSERT と一致させる(テストで照合)。
 */
export const RATE_TABLE_KINDS = ["consumption_tax", "brokerage_tiers", "stamp_contract", "stamp_receipt", "capital_gains"] as const;
export type RateTableKind = (typeof RATE_TABLE_KINDS)[number];
export const RATE_TABLE_KIND_LABELS: Record<RateTableKind, string> = {
  consumption_tax: "消費税率",
  brokerage_tiers: "仲介手数料",
  stamp_contract: "印紙税(売買契約書)",
  stamp_receipt: "印紙税(領収書)",
  capital_gains: "譲渡所得の税率",
};

export interface RateTableSeed { kind: RateTableKind; validFrom: string; validTo: string | null; content: unknown }

const bracket = (upTo: number | null, tax: number) => ({ upTo, tax });

export const INITIAL_RATE_TABLES: RateTableSeed[] = [
  { kind: "consumption_tax", validFrom: "2019-10-01", validTo: null, content: { rateBp: 1000 } },
  {
    kind: "brokerage_tiers", validFrom: "2024-07-01", validTo: null,
    content: {
      tiers: [{ upTo: 2000000, rateBp: 500 }, { upTo: 4000000, rateBp: 400 }, { upTo: null, rateBp: 300 }],
      lowCostSpecial: { priceLimit: 8000000, feeCap: 300000 },
    },
  },
  {
    // 軽減措置(令和9年3月31日まで)。
    kind: "stamp_contract", validFrom: "2014-04-01", validTo: "2027-03-31",
    content: { brackets: [
      bracket(9999, 0), bracket(100000, 200), bracket(500000, 200), bracket(1000000, 500), bracket(5000000, 1000),
      bracket(10000000, 5000), bracket(50000000, 10000), bracket(100000000, 30000), bracket(500000000, 60000),
      bracket(1000000000, 160000), bracket(5000000000, 320000), bracket(null, 480000),
    ] },
  },
  {
    // 本則。
    kind: "stamp_contract", validFrom: "2027-04-01", validTo: null,
    content: { brackets: [
      bracket(9999, 0), bracket(100000, 200), bracket(500000, 400), bracket(1000000, 1000), bracket(5000000, 2000),
      bracket(10000000, 10000), bracket(50000000, 20000), bracket(100000000, 60000), bracket(500000000, 100000),
      bracket(1000000000, 200000), bracket(5000000000, 400000), bracket(null, 600000),
    ] },
  },
  {
    // 売上代金の受取書。5万円未満は非課税。
    kind: "stamp_receipt", validFrom: "2014-04-01", validTo: null,
    content: { brackets: [
      bracket(49999, 0), bracket(1000000, 200), bracket(2000000, 400), bracket(3000000, 600), bracket(5000000, 1000),
      bracket(10000000, 2000), bracket(20000000, 4000), bracket(30000000, 6000), bracket(50000000, 10000),
      bracket(100000000, 20000), bracket(200000000, 40000), bracket(300000000, 60000), bracket(500000000, 100000),
      bracket(1000000000, 150000), bracket(null, 200000),
    ] },
  },
  {
    // 復興特別所得税(所得税額の 2.1%)は 2037 年まで。
    kind: "capital_gains", validFrom: "2013-01-01", validTo: "2037-12-31",
    content: {
      long: { incomeTaxBp: 1500, residentTaxBp: 500 },
      short: { incomeTaxBp: 3000, residentTaxBp: 900 },
      reconstructionBp: 210, longTermYears: 5, residentialDeduction: 30000000, unknownCostRateBp: 500,
    },
  },
];

export interface RateTableRow { kind: string; validFrom: Date; validTo: Date | null; content: unknown }

const day = (d: Date) => d.toISOString().slice(0, 10);

/** baseDate(YYYY-MM-DD)が期間に入る表。重なっていたら始まりが新しい方。 */
export function pickRateTable(rows: RateTableRow[], kind: string, baseDate: string): RateTableRow | null {
  const hits = rows.filter((r) => r.kind === kind && day(r.validFrom) <= baseDate && (r.validTo === null || baseDate <= day(r.validTo)));
  hits.sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime());
  return hits[0] ?? null;
}

export function consumptionTaxRateBp(rows: RateTableRow[], baseDate: string): number {
  const c = pickRateTable(rows, "consumption_tax", baseDate)?.content as { rateBp?: unknown } | undefined;
  return typeof c?.rateBp === "number" && Number.isInteger(c.rateBp) ? c.rateBp : 1000;
}
