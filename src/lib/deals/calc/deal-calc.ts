import type { z } from "zod";
import { DEFAULT_PROPERTY_KINDS, type BasePropertyKind, type PropertyKindDef } from "../constants";
import { jstDateString } from "../datetime";
import { pickRateTable, type RateTableRow } from "../rate-tables";
import { RATE_CONTENT_SCHEMAS } from "../rate-content";
import type { DealView } from "../view";
import { brokerageFee } from "./brokerage";
import { buildingPriceApportion, buildingTaxOf } from "./building-tax";
import { contractStamp } from "./stamp";
import { settlementResult, type SettlementResult } from "./settlement";

export interface DealCalc {
  baseDate: string;
  kindBase: BasePropertyKind | null;
  brokerage: { computedExcl: number; excl: number; incl: number; overridden: boolean; specialApplied: boolean } | null;
  building: {
    computedPrice: number | null; price: number | null; priceOverridden: boolean;
    computedTax: number | null; tax: number | null; taxOverridden: boolean;
  };
  contractStamp: number | null;
  settlement: SettlementResult;
  missing: string[];
}

const jstDate = (iso: string | null) => (iso ? jstDateString(new Date(iso)) : null);

/** 表を期間で選び、中身を検証してから使う(壊れていれば「無い」扱い)。 */
type RateContent<K extends keyof typeof RATE_CONTENT_SCHEMAS> = z.output<(typeof RATE_CONTENT_SCHEMAS)[K]>;

function table<K extends keyof typeof RATE_CONTENT_SCHEMAS>(rows: RateTableRow[], kind: K, date: string): RateContent<K> | null {
  const hit = pickRateTable(rows, kind, date);
  const r = hit ? RATE_CONTENT_SCHEMAS[kind].safeParse(hit.content) : null;
  return r?.success ? (r.data as RateContent<K>) : null;
}

/** 取引1件の計算結果(画面・書類で共通)。基準日 = 契約日 → 決済日 → 今日(日本時間)。 */
export function computeDealCalc(deal: DealView, rateRows: RateTableRow[], kinds: PropertyKindDef[], today: string): DealCalc {
  const settlementDate = jstDate(deal.settlementAt);
  const baseDate = jstDate(deal.contractAt) ?? settlementDate ?? today;
  const kindBase = (kinds.length ? kinds : DEFAULT_PROPERTY_KINDS).find((k) => k.key === deal.propertyKind)?.base ?? null;
  const o = deal.overrides;
  const missing: string[] = [];
  if (deal.price === null) missing.push("売買価格");

  let brokerage: DealCalc["brokerage"] = null;
  const tiers = table(rateRows, "brokerage_tiers", baseDate);
  if (deal.price !== null && tiers) {
    const b = brokerageFee(deal.price, tiers, { lowCostSpecial: deal.costs.lowCostSpecial, taxRateBp: deal.taxRateBp });
    const excl = o.brokerageFee ?? b.excl;
    brokerage = {
      computedExcl: b.excl, excl, incl: Math.floor((excl * (10000 + deal.taxRateBp)) / 10000),
      overridden: o.brokerageFee !== undefined, specialApplied: b.specialApplied,
    };
  }

  const computedPrice = deal.price === null ? null : buildingPriceApportion(deal.price, deal.assessments.rows, deal.assessments.landRatioBp);
  const price = o.buildingPrice ?? computedPrice;
  const computedTax = price === null ? null : buildingTaxOf(price, deal.taxRateBp);
  const building = {
    computedPrice, price, priceOverridden: o.buildingPrice !== undefined,
    computedTax, tax: o.buildingTax ?? computedTax, taxOverridden: o.buildingTax !== undefined,
  };

  const stampTable = table(rateRows, "stamp_contract", baseDate);
  const stamp = deal.price !== null && stampTable ? contractStamp(deal.price, stampTable, "full") : null;

  const settlement = settlementResult({
    price: deal.price, deposit: deal.deposit, kindBase, hasOc: deal.hasOc, settlementDate,
    terms: deal.settlementTerms, leases: deal.leases, overrides: o,
  });
  for (const m of settlement.missing) if (!missing.includes(m)) missing.push(m);
  return { baseDate, kindBase, brokerage, building, contractStamp: stamp, settlement, missing };
}
