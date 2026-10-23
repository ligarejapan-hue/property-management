import type { BasePropertyKind } from "../constants";
import type { Lease, OverrideKey, Overrides, SettlementTerms } from "../schemas";
import { prorateAnnualTax, prorateMonthly } from "./proration";
import { depositSuccession } from "./deposit";
import { yen } from "./format";

export interface SettlementRow {
  key: string;
  label: string;
  period: string | null;
  formula: string | null;
  sellerToBuyer: number;
  buyerToSeller: number;
  /** 計算の値(自由行は null)。 */
  computed: number | null;
  overridden: boolean;
  note: string | null;
}

export interface SettlementInput {
  price: number | null;
  deposit: number | null;
  kindBase: BasePropertyKind | null;
  hasOc: boolean;
  /** 日本時間の決済日 YYYY-MM-DD。 */
  settlementDate: string | null;
  terms: SettlementTerms;
  leases: Lease[];
  overrides: Overrides;
}

export interface SettlementResult {
  ready: boolean;
  missing: string[];
  rows: SettlementRow[];
  depositRow: SettlementRow | null;
  totalSellerToBuyer: number;
  totalBuyerToSeller: number;
  net: { direction: "buyerToSeller" | "sellerToBuyer" | "none"; amount: number };
  netLine: string;
  remaining: number | null;
  depositOffset: number;
  paymentAtSettlement: number | null;
  warnings: string[];
}

const sum = (xs: (number | null)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);

/**
 * 決済の計算(依頼書 4.4)。精算書・残金決済のご案内・精算金領収書・書類確認書は、すべてこの結果を使う。
 * 行: 固都税(全件)・管理費等(区分だけ)・賃料等(OCだけ)・その他(自由行)。敷金の承継(OCだけ)は別の行。
 * 合計と差引は敷金を除いた精算金。お支払額 = 残代金 + 精算金(買主→売主を+) − 敷金承継(相殺のときだけ)。
 */
export function settlementResult(i: SettlementInput): SettlementResult {
  const remaining = i.price === null ? null : i.price - (i.deposit ?? 0);
  if (!i.settlementDate) {
    return {
      ready: false, missing: ["決済日時"], rows: [], depositRow: null, totalSellerToBuyer: 0, totalBuyerToSeller: 0,
      net: { direction: "none", amount: 0 }, netLine: "", remaining, depositOffset: 0, paymentAtSettlement: null, warnings: [],
    };
  }
  const date = i.settlementDate;
  const rows: SettlementRow[] = [];
  const warnings: string[] = [];
  const pick = (key: OverrideKey, computed: number) => {
    const o = i.overrides[key];
    return { value: o ?? computed, overridden: o !== undefined };
  };

  // 元の金額が無くても、手で直した値があれば行を出す(その値を精算に入れる)。
  const has = (k: OverrideKey) => i.overrides[k] !== undefined;

  const annual = sum([i.terms.fixedAssetTax, i.terms.cityPlanningTax]);
  if (annual > 0 || has("settlement.propertyTax")) {
    const p = prorateAnnualTax(annual, i.terms.taxStart, date);
    if (p.warning && annual > 0) warnings.push(p.warning);
    const v = pick("settlement.propertyTax", p.buyer);
    rows.push({
      key: "propertyTax", label: "固定資産税・都市計画税", period: `${date}〜${p.periodEnd}`, formula: annual > 0 ? p.formula : null,
      sellerToBuyer: 0, buyerToSeller: v.value, computed: p.buyer, overridden: v.overridden, note: null,
    });
  }

  const monthly = sum([i.terms.managementFee, i.terms.repairReserve, i.terms.otherMonthly]);
  if (i.kindBase === "unit" && (monthly > 0 || has("settlement.management"))) {
    const p = prorateMonthly(monthly, date, i.terms.managementPrepaidMonths);
    const v = pick("settlement.management", p.total);
    rows.push({
      key: "management", label: "管理費・修繕積立金等", period: null, formula: monthly > 0 ? p.formula : null,
      sellerToBuyer: 0, buyerToSeller: v.value, computed: p.total, overridden: v.overridden, note: null,
    });
  }

  let depositRow: SettlementRow | null = null;
  if (i.hasOc) {
    const rentMonthly = sum(i.leases.map((l) => l.rent + l.commonFee + l.parking + l.other));
    if (rentMonthly > 0 || has("settlement.rent")) {
      const p = prorateMonthly(rentMonthly, date, i.terms.rentPrepaidMonths);
      const v = pick("settlement.rent", p.total);
      rows.push({
        key: "rent", label: "賃料・共益費・駐車場代等", period: null, formula: rentMonthly > 0 ? p.formula : null,
        sellerToBuyer: v.value, buyerToSeller: 0, computed: p.total, overridden: v.overridden, note: null,
      });
    }
    const d = depositSuccession(i.leases.map((l) => l.deposit), i.terms.depositMode);
    if (d.total > 0) {
      depositRow = {
        key: "deposit", label: "預り敷金の承継", period: null, formula: null, sellerToBuyer: d.total, buyerToSeller: 0,
        computed: d.total, overridden: false, note: d.mode === "offset" ? "残代金と相殺" : "別途授受",
      };
    }
  }

  i.terms.others.forEach((o, n) => {
    rows.push({
      key: `other:${n}`, label: o.label, period: null, formula: null,
      sellerToBuyer: o.sellerToBuyer, buyerToSeller: o.buyerToSeller, computed: null, overridden: false, note: null,
    });
  });

  const totalSellerToBuyer = sum(rows.map((r) => r.sellerToBuyer));
  const totalBuyerToSeller = sum(rows.map((r) => r.buyerToSeller));
  const diff = totalBuyerToSeller - totalSellerToBuyer;
  const net = diff > 0
    ? { direction: "buyerToSeller" as const, amount: diff }
    : diff < 0 ? { direction: "sellerToBuyer" as const, amount: -diff } : { direction: "none" as const, amount: 0 };
  const netLine = net.direction === "buyerToSeller"
    ? `買主から売主へ ${yen(net.amount)}円`
    : net.direction === "sellerToBuyer" ? `売主から買主へ ${yen(net.amount)}円` : "精算金はありません";
  const depositOffset = depositRow && i.terms.depositMode === "offset" ? depositRow.sellerToBuyer : 0;
  const paymentAtSettlement = remaining === null ? null : remaining + diff - depositOffset;
  return {
    ready: true, missing: remaining === null ? ["売買価格"] : [], rows, depositRow, totalSellerToBuyer, totalBuyerToSeller,
    net, netLine, remaining, depositOffset, paymentAtSettlement, warnings,
  };
}
