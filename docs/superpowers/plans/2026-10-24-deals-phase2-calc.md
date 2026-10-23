# 取引・帳票機能 段2(計算) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 依頼書3章の計算(仲介手数料・日割り精算・敷金承継・建物消費税の按分・印紙税・ローン返済・譲渡所得の目安)をサーバーの純粋関数にし、取引の画面に「金額・費用」「精算」「OC」タブと評価額の入力・上書き/計算に戻す・税率の表の編集を足す。

**Architecture:**
- 計算は `src/lib/deals/calc/` の純粋関数にまとめる。DB にも時刻にも触らない。
- まとめ役の `computeDealCalc(deal, rateRows, kinds, today)` は、取引1件と税率の表から、画面と書類が使う計算結果を1つ返す。
- `GET /api/deals/[id]/calc` は、その結果を返すだけにする。
- 入力は取引の JSONB 列(段1で作成済み)に保存し、検証は zod で行う。
- 手で直した値は `overrides` に入れる。表示する値は「上書き ?? 計算」。
- DB の変更はしない(migration なし)。

**Tech Stack:** Next.js 16、React 19、Prisma 7、zod 4、vitest 4(env=node)

**Spec:** `docs/superpowers/specs/2026-10-23-deals-documents-design.md`(§3 計算、§5 画面)

## Global Constraints

- 金額は整数(円)。率は整数(1/100 %。10% = 1000)。端数は関数ごとに決め、コメントに書く。割り算は最後に1回だけ切り捨てる。
- 依頼書の例は必ずテストにする。
  - 3,000万円の仲介手数料 → 税抜 960,000 / 税込 1,056,000
  - 固都税: 年 120,000円・1/1 起算・決済 2026-07-01 → 買主 60,493 / 売主 59,507
  - ローン: 4,000万円・年1.0%・35年 → 月 112,914
- 400万円超の手数料は「価格×3%+6万円」と一致すること。
- 決済日の前日までを売主の負担、決済日からを買主の負担にする。
- 固都税は、買主の分を先に出して切り捨て、売主の分は年税額からの差し引きにする。
- 起算日が4/1で決済が1〜3月のときは、注意文と計算期間を出す。
- 譲渡所得には必ず「概算です。正確な税額は税理士にご確認ください。」を出す。
- 税率・税額は表(適用期間つき)から読む。コードに直接書かない。表を選ぶ基準日は、契約日、なければ決済日、それもなければ今日。
- DB の変更はしない。テストの値はすべて架空のもの。監査記録の detail には項目の名前だけを入れる。
- 素の `<button>` は使わず `Button` を使う。ページ送りは `Pagination`。effect の中で setState する関数を呼ばない(promise の then で入れる)。

## Review Focus

1. **決済日がまだ無い取引**: 精算は計算せず「決済日時を入れてください」と出す。例外で落ちない(Task 5)。
2. **起算日 4/1 で 1〜3月決済、うるう年をまたぐ年度**: 期間の日数が 366 になり、注意文が出る(Task 2)。
3. **評価額が全部 0、または行が無い**: 按分は「計算できない」になり、0で割らない(Task 3)。
4. **ほかのタブに保存していない入力があるときに、別のタブで保存する**: 入力が消えない(Task 8 で、パネルの key をそのパネル自身のデータにする)。
5. **税率の表の期間が重なる・区分の並びが崩れている**: 保存できず 422(Task 6)。

---

## ファイルの地図

| ファイル | 役目 |
|---|---|
| `src/lib/deals/calc/dates.ts` | 日付の計算(YYYY-MM-DD・UTC で数える) |
| `src/lib/deals/calc/format.ts` | 金額の3桁区切り |
| `src/lib/deals/calc/brokerage.ts` | 仲介手数料 |
| `src/lib/deals/calc/stamp.ts` | 印紙税 |
| `src/lib/deals/calc/loan.ts` | ローンの月返済 |
| `src/lib/deals/calc/proration.ts` | 日割り(固都税・月額) |
| `src/lib/deals/calc/deposit.ts` | 敷金の承継 |
| `src/lib/deals/calc/building-tax.ts` | 建物消費税の按分 |
| `src/lib/deals/calc/capital-gains.ts` | 譲渡所得の目安 |
| `src/lib/deals/calc/settlement.ts` | 決済の計算(精算書の行・合計・お支払額) |
| `src/lib/deals/calc/deal-calc.ts` | 取引1件の計算結果のまとめ |
| `src/lib/deals/rate-content.ts` | 税率の表の中身の検証・期間の重なり |
| `src/lib/deals/schemas.ts`(変更) | 段2の入力(評価額・費用・精算条件・賃貸条件・上書き)と、更新の検証 |
| `src/lib/deals/inputs.ts` | 保存済みの JSON を読む(壊れていれば初期値) |
| `src/lib/deals/change-values.ts`(変更) | 金額の列と JSON の更新 |
| `src/lib/deals/view.ts`(変更) | DealView に段2の項目を足す |
| `src/lib/deals/money-forms.ts` | 画面の金額の入力・変換(純粋関数) |
| `src/app/api/deals/[id]/calc/route.ts` | 計算結果を返す |
| `src/app/api/admin/deal-settings/rate-tables/route.ts`(変更) | 税率の表を足す(POST) |
| `src/app/api/admin/deal-settings/rate-tables/[id]/route.ts` | 税率の表を直す・消す |
| `src/components/deals/form-parts.tsx`(変更) | YenInput・OverrideField・SelectBox(使えない値・disabled) |
| `src/components/deals/deal-money-panel.tsx` | 金額・費用タブ |
| `src/components/deals/deal-settlement-panel.tsx` | 精算タブ |
| `src/components/deals/deal-oc-panel.tsx` | OC タブ |
| `src/components/deals/assessments-editor.tsx` | 物件タブの評価額 |
| `src/components/deals/rate-table-editor.tsx` | 税率の表の編集 |

---

### Task 1: 日付・金額表示・仲介手数料・印紙税・ローン

**Files:**
- Create: `src/lib/deals/calc/dates.ts`, `format.ts`, `brokerage.ts`, `stamp.ts`, `loan.ts`
- Test: `src/lib/deals/calc/__tests__/basic-calc.test.ts`

**Interfaces:**
- Produces:
  - `parseYmd(s): {y,m,d}`
  - `ymd(y,m,d): string`
  - `addDays(s, n): string`
  - `daysInclusive(from, to): number`
  - `daysInMonth(y, m): number`
  - `yen(n): string`
  - `interface BrokerageTiers { tiers: {upTo: number|null; rateBp: number}[]; lowCostSpecial: {priceLimit: number; feeCap: number} }`
  - `brokerageFee(price, tiers, {lowCostSpecial, taxRateBp}): {excl; incl; specialApplied}`
  - `interface Brackets { brackets: {upTo: number|null; tax: number}[] }`
  - `stampTax(amount, table): number`
  - `contractStamp(amount, table, share: "full"|"half"): number`
  - `type ReceiptExempt = "yes"|"no"|"unknown"`
  - `receiptStamp(amount, table, exempt): {tax; needsDecision}`
  - `loanPayment(principal, annualRateBp, years): number`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/deals/calc/__tests__/basic-calc.test.ts
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
```

- [ ] **Step 2: テストを走らせて、失敗することを確かめる**

Run: `npx vitest run src/lib/deals/calc`
Expected: FAIL(`Cannot find module '../dates'`)

- [ ] **Step 3: 実装する**

```ts
// src/lib/deals/calc/dates.ts
/** 計算用の日付は "YYYY-MM-DD" の文字列。時差を持ち込まないよう UTC の暦で数える。 */
const DAY = 24 * 60 * 60 * 1000;

export function parseYmd(s: string): { y: number; m: number; d: number } {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
}

export function ymd(y: number, m: number, d: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${y}-${p(m)}-${p(d)}`;
}

const utc = (s: string) => {
  const { y, m, d } = parseYmd(s);
  return Date.UTC(y, m - 1, d);
};

export function addDays(s: string, n: number): string {
  return new Date(utc(s) + n * DAY).toISOString().slice(0, 10);
}

/** from から to まで(両端を含む)の日数。 */
export function daysInclusive(from: string, to: string): number {
  return Math.round((utc(to) - utc(from)) / DAY) + 1;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
```

```ts
// src/lib/deals/calc/format.ts
/** 金額の3桁区切り(書類・計算式の文字列用)。 */
export function yen(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
```

```ts
// src/lib/deals/calc/brokerage.ts
export interface BrokerageTiers {
  tiers: { upTo: number | null; rateBp: number }[];
  lowCostSpecial: { priceLimit: number; feeCap: number };
}
export interface BrokerageResult { excl: number; incl: number; specialApplied: boolean }

/**
 * 仲介手数料の上限(依頼書 3.1)。段ごとの「部分×率」を足し、税抜は最後に1回だけ円未満切り捨て。
 * 低廉な空家等の特例(オン かつ 価格が上限以下)は、上限額を特例の額にする。
 * 税込 = 税抜 × (1 + 税率)、円未満切り捨て。
 */
export function brokerageFee(
  price: number,
  t: BrokerageTiers,
  opts: { lowCostSpecial: boolean; taxRateBp: number },
): BrokerageResult {
  let lower = 0;
  let numer = 0; // Σ 部分 × rateBp(÷10000 は最後に1回)
  for (const tier of t.tiers) {
    const upper = tier.upTo ?? Number.POSITIVE_INFINITY;
    numer += Math.max(0, Math.min(price, upper) - lower) * tier.rateBp;
    if (price <= upper) break;
    lower = upper;
  }
  let excl = Math.floor(numer / 10000);
  const specialApplied = opts.lowCostSpecial && price <= t.lowCostSpecial.priceLimit;
  if (specialApplied) excl = Math.max(excl, t.lowCostSpecial.feeCap);
  const incl = Math.floor((excl * (10000 + opts.taxRateBp)) / 10000);
  return { excl, incl, specialApplied };
}
```

```ts
// src/lib/deals/calc/stamp.ts
export interface Brackets { brackets: { upTo: number | null; tax: number }[] }

/** 金額の区分で税額を引く(upTo は「その金額以下」・null は上限なし)。 */
export function stampTax(amount: number, table: Brackets): number {
  const hit = table.brackets.find((b) => b.upTo === null || amount <= b.upTo);
  return hit ? hit.tax : 0;
}

/** 売買契約書の印紙税。折半は ÷2 の円未満切り捨て(依頼書 3.5)。 */
export function contractStamp(amount: number, table: Brackets, share: "full" | "half"): number {
  const tax = stampTax(amount, table);
  return share === "half" ? Math.floor(tax / 2) : tax;
}

/** 領収書の非課税(個人が事業用でない物件を売る場合)。初期値は「判断が必要」=出力前に確認を求める。 */
export type ReceiptExempt = "yes" | "no" | "unknown";

export function receiptStamp(amount: number, table: Brackets, exempt: ReceiptExempt): { tax: number; needsDecision: boolean } {
  if (exempt === "yes") return { tax: 0, needsDecision: false };
  return { tax: stampTax(amount, table), needsDecision: exempt === "unknown" };
}
```

```ts
// src/lib/deals/calc/loan.ts
/**
 * 元利均等返済の月額(依頼書 3.6)。月利 = 年利 ÷ 12。金利0%は 借入額 ÷ 回数。
 * 端数: 円未満切り捨て(浮動小数の誤差で x.99999… になるのを避けるため、ごく小さい値を足してから切り捨てる)。
 */
export function loanPayment(principal: number, annualRateBp: number, years: number): number {
  const n = Math.round(years * 12);
  if (principal <= 0 || n <= 0) return 0;
  if (annualRateBp === 0) return Math.floor(principal / n);
  const r = annualRateBp / 10000 / 12;
  const f = Math.pow(1 + r, n);
  return Math.floor((principal * r * f) / (f - 1) + 1e-7);
}
```

- [ ] **Step 4: テストを走らせて、通ることを確かめる**

Run: `npx vitest run src/lib/deals/calc`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add src/lib/deals/calc
git commit -m "feat(deals): 仲介手数料・印紙税・ローン返済の計算(依頼書の例をテスト)"
```

---

### Task 2: 日割り(固都税・月額)と敷金の承継

**Files:**
- Create: `src/lib/deals/calc/proration.ts`, `src/lib/deals/calc/deposit.ts`
- Test: `src/lib/deals/calc/__tests__/proration.test.ts`

**Interfaces:**
- Consumes: Task 1 の `dates`・`yen`
- Produces:
  - `type TaxStart = "01-01"|"04-01"`
  - `prorateAnnualTax(annual, start, settlement): {buyer; seller; periodStart; periodEnd; yearDays; buyerDays; formula; warning: string|null}`
  - `prorateMonthly(monthly, settlement, prepaidMonths): {current; prepaid; total; buyerDays; monthDays; formula}`
  - `depositSuccession(deposits: number[], mode: "offset"|"separate"): {total; mode}`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/deals/calc/__tests__/proration.test.ts
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
```

- [ ] **Step 2: テストを走らせて、失敗することを確かめる**

Run: `npx vitest run src/lib/deals/calc/__tests__/proration.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

```ts
// src/lib/deals/calc/proration.ts
import { addDays, daysInMonth, daysInclusive, parseYmd, ymd } from "./dates";
import { yen } from "./format";

export type TaxStart = "01-01" | "04-01";

/**
 * 固都税の日割り(依頼書 3.2)。決済日の前日までを売主、決済日からを買主の負担にする。
 * 期間 = 決済日を含む「起算日から1年」(うるう日を含めば366日)。
 * 端数: 買主分を先に出して円未満切り捨て、売主分 = 年税額 − 買主分。
 */
export function prorateAnnualTax(annual: number, start: TaxStart, settlement: string) {
  const { y, m, d } = parseYmd(settlement);
  const [sm, sd] = start === "01-01" ? [1, 1] : [4, 1];
  const startYear = m > sm || (m === sm && d >= sd) ? y : y - 1;
  const periodStart = ymd(startYear, sm, sd);
  const periodEnd = addDays(ymd(startYear + 1, sm, sd), -1);
  const yearDays = daysInclusive(periodStart, periodEnd);
  const buyerDays = daysInclusive(settlement, periodEnd);
  const buyer = Math.floor((annual * buyerDays) / yearDays);
  const warning = start === "04-01" && m <= 3
    ? `起算日が4月1日のため、計算期間は ${periodStart}〜${periodEnd} です。どの年度の税額か確かめてください。`
    : null;
  return {
    buyer, seller: annual - buyer, periodStart, periodEnd, yearDays, buyerDays,
    formula: `${yen(annual)}円×${buyerDays}日÷${yearDays}日`, warning,
  };
}

/**
 * 月額の日割り(管理費等・賃料)。決済月の月額を日割りし(決済日から月末まで)、前払い月数分を足す。
 * 端数: 当月分は円未満切り捨て。前払い分は 月額×月数。
 */
export function prorateMonthly(monthly: number, settlement: string, prepaidMonths: number) {
  const { y, m, d } = parseYmd(settlement);
  const monthDays = daysInMonth(y, m);
  const buyerDays = monthDays - d + 1;
  const current = Math.floor((monthly * buyerDays) / monthDays);
  const prepaid = monthly * prepaidMonths;
  const formula = `${yen(monthly)}円×${buyerDays}日÷${monthDays}日` + (prepaidMonths > 0 ? `＋${yen(monthly)}円×${prepaidMonths}か月` : "");
  return { current, prepaid, total: current + prepaid, buyerDays, monthDays, formula };
}
```

```ts
// src/lib/deals/calc/deposit.ts
/** 敷金の承継(依頼書 3.3)。預り敷金の合計を買主が承継する。相殺=残代金から差し引く / 別途=別に授受する。 */
export function depositSuccession(deposits: number[], mode: "offset" | "separate") {
  return { total: deposits.reduce((a, b) => a + b, 0), mode };
}
```

- [ ] **Step 4: テストを走らせて、通ることを確かめる**

Run: `npx vitest run src/lib/deals/calc`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add src/lib/deals/calc
git commit -m "feat(deals): 固都税・月額の日割りと敷金の承継"
```

---

### Task 3: 建物消費税の按分と譲渡所得の目安

**Files:**
- Create: `src/lib/deals/calc/building-tax.ts`, `src/lib/deals/calc/capital-gains.ts`
- Test: `src/lib/deals/calc/__tests__/tax-calc.test.ts`

**Interfaces:**
- Produces:
  - `interface AssessmentRow { building: number; land: number; shareNum: number; shareDen: number }`
  - `buildingPriceApportion(price, rows, landRatioBp): number | null`(評価額が無ければ null)
  - `buildingTaxOf(buildingPriceInclTax, taxRateBp): number`
  - `interface CapitalGainsRates`
  - `interface CapitalGainsInput`
  - `capitalGainsEstimate(input, rates)`
  - `CAPITAL_GAINS_NOTE`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/deals/calc/__tests__/tax-calc.test.ts
import { describe, it, expect } from "vitest";
import { buildingPriceApportion, buildingTaxOf } from "../building-tax";
import { capitalGainsEstimate, CAPITAL_GAINS_NOTE, type CapitalGainsRates } from "../capital-gains";
import { INITIAL_RATE_TABLES } from "../../rate-tables";

const rates = INITIAL_RATE_TABLES.find((t) => t.kind === "capital_gains")!.content as CapitalGainsRates;

describe("建物消費税の按分(依頼書 3.4)", () => {
  it("家屋割合 = 家屋 ÷ (家屋 + 土地)", () => {
    const p = buildingPriceApportion(30_000_000, [{ building: 10_000_000, land: 20_000_000, shareNum: 1, shareDen: 1 }], 10000);
    expect(p).toBe(10_000_000);
    expect(buildingTaxOf(p!, 1000)).toBe(909_090);
  });
  it("筆ごとに 評価額×持分 を足す", () => {
    const rows = [
      { building: 8_000_000, land: 0, shareNum: 1, shareDen: 2 },
      { building: 0, land: 12_000_000, shareNum: 1, shareDen: 3 },
    ];
    // 家屋 4,000,000 ・ 土地 4,000,000 → 1/2
    expect(buildingPriceApportion(20_000_001, rows, 10000)).toBe(10_000_000);
  });
  it("土地の割合 50%(借地権など)", () => {
    const p = buildingPriceApportion(30_000_000, [{ building: 10_000_000, land: 20_000_000, shareNum: 1, shareDen: 1 }], 5000);
    expect(p).toBe(15_000_000);
    expect(buildingTaxOf(p!, 1000)).toBe(1_363_636);
  });
  it("評価額が無い・全部0なら計算できない(0で割らない)", () => {
    expect(buildingPriceApportion(30_000_000, [], 10000)).toBeNull();
    expect(buildingPriceApportion(30_000_000, [{ building: 0, land: 0, shareNum: 1, shareDen: 1 }], 10000)).toBeNull();
  });
});

describe("譲渡所得の目安(依頼書 3.7)", () => {
  const base = { salePrice: 50_000_000, acquisitionCost: 30_000_000, sellingCosts: 1_800_000, acquiredOn: "2015-04-01", saleDate: "2026-07-01", residentialDeduction: false };
  it("長期: 課税所得は千円未満・税額は税目ごとに百円未満を切り捨て", () => {
    const r = capitalGainsEstimate(base, rates);
    expect(r).toMatchObject({ gain: 18_200_000, taxable: 18_200_000, longTerm: true });
    expect(r.incomeTax).toBe(2_730_000);
    expect(r.reconstructionTax).toBe(57_300);
    expect(r.residentTax).toBe(910_000);
    expect(r.total).toBe(2_730_000 + 57_300 + 910_000);
    expect(r.note).toBe(CAPITAL_GAINS_NOTE);
  });
  it("取得費が分からないときは売却価格の5%", () => {
    const r = capitalGainsEstimate({ ...base, acquisitionCost: null }, rates);
    expect(r.acquisitionCost).toBe(2_500_000);
    expect(r.usedEstimatedCost).toBe(true);
  });
  it("売却年の1月1日時点で5年を超えれば長期・ちょうど5年は短期", () => {
    expect(capitalGainsEstimate({ ...base, acquiredOn: "2020-12-31" }, rates).longTerm).toBe(true);
    expect(capitalGainsEstimate({ ...base, acquiredOn: "2021-01-01" }, rates).longTerm).toBe(false);
  });
  it("居住用3,000万円控除・損なら0", () => {
    expect(capitalGainsEstimate({ ...base, residentialDeduction: true }, rates)).toMatchObject({ deduction: 18_200_000, taxable: 0, total: 0 });
    expect(capitalGainsEstimate({ ...base, acquisitionCost: 60_000_000 }, rates)).toMatchObject({ taxable: 0, total: 0 });
  });
});
```

- [ ] **Step 2: テストを走らせて、失敗することを確かめる**

Run: `npx vitest run src/lib/deals/calc/__tests__/tax-calc.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

```ts
// src/lib/deals/calc/building-tax.ts
export interface AssessmentRow { building: number; land: number; shareNum: number; shareDen: number }

type Frac = { n: bigint; d: bigint };
const add = (a: Frac, n: bigint, d: bigint): Frac => ({ n: a.n * d + n * a.d, d: a.d * d });

/**
 * 建物価格(税込)の按分(依頼書 3.4)。評価額は筆ごとに「評価額×持分」を合計し、土地には土地の割合を掛ける。
 * 建物価格 = 売買価格 × 家屋 ÷ (家屋 + 土地)。持分の分数で誤差が出ないよう整数の分数(BigInt)で計算し、
 * 最後に1回だけ円未満を切り捨てる。評価額が無い・合計0のときは null(計算できない)。
 */
export function buildingPriceApportion(price: number, rows: AssessmentRow[], landRatioBp: number): number | null {
  let h: Frac = { n: BigInt(0), d: BigInt(1) };
  let l: Frac = { n: BigInt(0), d: BigInt(1) };
  for (const r of rows) {
    h = add(h, BigInt(r.building) * BigInt(r.shareNum), BigInt(r.shareDen));
    l = add(l, BigInt(r.land) * BigInt(r.shareNum) * BigInt(landRatioBp), BigInt(r.shareDen) * BigInt(10000));
  }
  const num = h.n * l.d;
  const den = h.n * l.d + l.n * h.d;
  if (den === BigInt(0)) return null;
  return Number((BigInt(price) * num) / den);
}

/** 建物消費税 = 建物価格(税込) × 税率 ÷ (1 + 税率)、円未満切り捨て。 */
export function buildingTaxOf(buildingPriceInclTax: number, taxRateBp: number): number {
  return Math.floor((buildingPriceInclTax * taxRateBp) / (10000 + taxRateBp));
}
```

```ts
// src/lib/deals/calc/capital-gains.ts
export interface CapitalGainsRates {
  long: { incomeTaxBp: number; residentTaxBp: number };
  short: { incomeTaxBp: number; residentTaxBp: number };
  reconstructionBp: number;
  longTermYears: number;
  residentialDeduction: number;
  unknownCostRateBp: number;
}
export interface CapitalGainsInput {
  salePrice: number;
  /** 分からないときは null(売却価格の5%で計算する)。 */
  acquisitionCost: number | null;
  sellingCosts: number;
  acquiredOn: string;
  saleDate: string;
  residentialDeduction: boolean;
}

export const CAPITAL_GAINS_NOTE = "概算です。正確な税額は税理士にご確認ください。";

/**
 * 譲渡所得税の目安(依頼書 3.7)。
 * 端数: 取得費の5%は円未満切り捨て・課税譲渡所得は千円未満切り捨て・税額は税目ごとに百円未満切り捨て。
 * 長期 = 売却年の1月1日時点で所有期間が5年を超える(取得日 < (売却年−5)年1月1日)。
 */
export function capitalGainsEstimate(i: CapitalGainsInput, r: CapitalGainsRates) {
  const usedEstimatedCost = i.acquisitionCost === null;
  const acquisitionCost = i.acquisitionCost ?? Math.floor((i.salePrice * r.unknownCostRateBp) / 10000);
  const gain = i.salePrice - (acquisitionCost + i.sellingCosts);
  const deduction = i.residentialDeduction ? Math.min(Math.max(gain, 0), r.residentialDeduction) : 0;
  const taxable = Math.floor(Math.max(0, gain - deduction) / 1000) * 1000;
  const saleYear = Number(i.saleDate.slice(0, 4));
  const longTerm = i.acquiredOn < `${saleYear - r.longTermYears}-01-01`;
  const k = longTerm ? r.long : r.short;
  const hundred = (v: number) => Math.floor(v / 100) * 100;
  const incomeTax = hundred((taxable * k.incomeTaxBp) / 10000);
  const reconstructionTax = hundred((incomeTax * r.reconstructionBp) / 10000);
  const residentTax = hundred((taxable * k.residentTaxBp) / 10000);
  return {
    acquisitionCost, usedEstimatedCost, gain, deduction, taxable, longTerm,
    incomeTax, reconstructionTax, residentTax, total: incomeTax + reconstructionTax + residentTax,
    note: CAPITAL_GAINS_NOTE,
  };
}
```

- [ ] **Step 4: テストを走らせて、通ることを確かめる**

Run: `npx vitest run src/lib/deals/calc`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add src/lib/deals/calc
git commit -m "feat(deals): 建物消費税の按分と譲渡所得の目安"
```

---

### Task 4: 段2の入力(検証・読み込み・更新・表示)と、後回しにした小さな点 M1・M6

**Files:**
- Modify: `src/lib/deals/schemas.ts`
  - `text` と `yenInt` を export する
  - 段2の検証を足し、dealUpdateSchema に足す
  - 物件種別の基本4つは `base === key` にする(M1)
- Create: `src/lib/deals/inputs.ts`
- Modify: `src/lib/deals/change-values.ts`
- Modify: `src/lib/deals/view.ts`
- Modify: `src/lib/deals/__tests__/schemas.test.ts`、`change-values.test.ts`、`deal-item-route.test.ts`(M6)
- Test: `src/lib/deals/__tests__/inputs.test.ts`

**Interfaces:**
- Produces:
  - 検証:
    - `assessmentsSchema`
    - `costsSchema`
    - `settlementTermsSchema`
    - `leaseSchema`
    - `overridesSchema`
    - `OVERRIDE_KEYS = ["brokerageFee","buildingPrice","buildingTax","settlement.propertyTax","settlement.management","settlement.rent"]`
  - 型: `Assessments`、`Costs`、`SettlementTerms`、`Lease`、`Overrides`、`OverrideKey`
  - 初期値: `DEFAULT_ASSESSMENTS`、`DEFAULT_COSTS`、`DEFAULT_TERMS`
  - 読み込み: `readAssessments(json)`、`readCosts(json)`、`readTerms(json)`、`readLeases(json)`、`readOverrides(json)`
  - `DealView` に足す項目: `assessments`、`costs`、`settlementTerms`、`leases`、`overrides`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/deals/__tests__/inputs.test.ts
import { describe, it, expect } from "vitest";
import {
  assessmentsSchema, costsSchema, settlementTermsSchema, leaseSchema, overridesSchema, dealUpdateSchema,
  DEFAULT_ASSESSMENTS, DEFAULT_COSTS, DEFAULT_TERMS,
} from "../schemas";
import { readAssessments, readCosts, readLeases, readOverrides, readTerms } from "../inputs";

const lease = {
  room: "101", tenant: "試験 次郎", contractType: "ordinary", period: "2025-04-01〜2027-03-31",
  rent: 80_000, commonFee: 5_000, parking: 0, other: 0, deposit: 160_000, arrears: false, arrearsAmount: 0, manager: "試験管理",
};

describe("段2の入力の検証", () => {
  it("初期値は検証を通る", () => {
    expect(assessmentsSchema.parse(DEFAULT_ASSESSMENTS)).toEqual(DEFAULT_ASSESSMENTS);
    expect(costsSchema.parse(DEFAULT_COSTS)).toEqual(DEFAULT_COSTS);
    expect(settlementTermsSchema.parse(DEFAULT_TERMS)).toEqual(DEFAULT_TERMS);
    expect(leaseSchema.parse(lease)).toEqual(lease);
  });
  it("持分は分子≦分母・金額は0以上の整数", () => {
    expect(() => assessmentsSchema.parse({ rows: [{ building: 1, land: 1, shareNum: 3, shareDen: 2 }], landRatioBp: 10000 })).toThrow();
    expect(() => leaseSchema.parse({ ...lease, rent: -1 })).toThrow();
    expect(() => leaseSchema.parse({ ...lease, rent: 1.5 })).toThrow();
  });
  it("上書きは決まった鍵だけ・一部だけでよい", () => {
    expect(overridesSchema.parse({ brokerageFee: 900_000 })).toEqual({ brokerageFee: 900_000 });
    expect(() => overridesSchema.parse({ price: 1 })).toThrow();
  });
  it("更新で金額・税率・段2の入力を送れる", () => {
    const v = dealUpdateSchema.parse({ version: 1, price: 30_000_000, deposit: 1_500_000, taxRateBp: 1000, leases: [lease], overrides: {} });
    expect(v).toMatchObject({ price: 30_000_000, deposit: 1_500_000, taxRateBp: 1000 });
    expect(() => dealUpdateSchema.parse({ version: 1, taxRateBp: 10001 })).toThrow();
  });
});

describe("保存済みの JSON を読む", () => {
  it("壊れていれば初期値・段1の初期値(空の配列や空の object)も読める", () => {
    expect(readAssessments([])).toEqual(DEFAULT_ASSESSMENTS);
    expect(readAssessments({ rows: [{ building: 1, land: 2, shareNum: 1, shareDen: 1 }] })).toEqual({ rows: [{ building: 1, land: 2, shareNum: 1, shareDen: 1 }], landRatioBp: 10000 });
    expect(readCosts({})).toEqual(DEFAULT_COSTS);
    expect(readTerms({ taxStart: "04-01" })).toEqual({ ...DEFAULT_TERMS, taxStart: "04-01" });
    expect(readTerms({ taxStart: "07-01" })).toEqual(DEFAULT_TERMS);
    expect(readLeases([lease, { room: 1 }])).toEqual([lease]);
    expect(readLeases({})).toEqual([]);
    expect(readOverrides({ brokerageFee: 1, bad: 2 })).toEqual({ brokerageFee: 1 });
  });
});
```

既存の `src/lib/deals/__tests__/schemas.test.ts` の `describe("取引の設定"` の中に、次を足します(M1)。

```ts
  it("基本の4種別は元の種別を変えられない(M1)", () => {
    const four = [
      { key: "unit", label: "区分マンション", base: "unit" }, { key: "house", label: "戸建", base: "house" },
      { key: "land", label: "土地", base: "land" }, { key: "building", label: "一棟", base: "building" },
    ];
    expect(() => dealSettingsUpdateSchema.parse({ version: 1, propertyKinds: [{ ...four[0], base: "land" }, ...four.slice(1)] })).toThrow();
  });
```

既存の `src/lib/deals/__tests__/deal-item-route.test.ts` の `describe("PATCH /api/deals/[id]"` の中に、次を足します(M6)。

```ts
  it("すでに買取再販の取引に取引態様だけ送っても空のまま(M6)", async () => {
    pm.deal.findUnique.mockResolvedValue({ ...detailRow, businessType: "resale", tradeSide: null });
    await PATCH(json("PATCH", { version: 3, tradeSide: "seller" }), ctx);
    expect(pm.deal.updateMany.mock.calls[0][0].data).toMatchObject({ tradeSide: null });
  });
  it("金額は BigInt で書き、変更履歴に残す", async () => {
    await PATCH(json("PATCH", { version: 3, price: 31_000_000 }), ctx);
    expect(pm.deal.updateMany.mock.calls[0][0].data.price).toBe(BigInt(31_000_000));
    expect(recordChangesInTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      newValues: expect.objectContaining({ price: BigInt(31_000_000) }),
    }));
  });
```

既存の `change-values.test.ts` に次を足します。

```ts
describe("段2の項目", () => {
  it("金額は BigInt・空は null・JSON はそのまま", () => {
    expect(toDealUpdateData({ price: 1000, deposit: null, leases: [] }, "brokerage")).toEqual({ price: BigInt(1000), deposit: null, leases: [] });
  });
  it("金額と税率も変更履歴に残す", () => {
    expect(DEAL_TRACKED_FIELDS).toEqual(expect.arrayContaining(["price", "deposit", "taxRateBp"]));
  });
});
```

- [ ] **Step 2: テストを走らせて、失敗することを確かめる**

Run: `npx vitest run src/lib/deals/__tests__`
Expected: FAIL(inputs が無い・M1/M6/段2の項目が通らない)

- [ ] **Step 3: schemas.ts を直す**

- `const text = ...` を `export const text = ...` にします。
- その下に、`export const yenInt = z.number().int().min(0).max(1_000_000_000_000);` を足します。
- `propertyKindsSchema` の末尾に、次の refine を足します。

```ts
  .refine((ks) => ks.every((k) => !(BASE_PROPERTY_KINDS as readonly string[]).includes(k.key) || k.base === k.key), "基本の4種別の元の種別は変えられません");
```

`export const dealCreateSchema` の直前に、次を足します。

```ts
// ---- 段2(計算)の入力。取引の JSONB 列に入れる(設計 §2.1)。----

export const assessmentsSchema = z.object({
  rows: z.array(z.object({
    building: yenInt, land: yenInt,
    shareNum: z.number().int().positive(), shareDen: z.number().int().positive(),
  }).strict().refine((r) => r.shareNum <= r.shareDen, "持分は分子≦分母")).max(50),
  /** 土地評価額に掛ける割合(借地権など)。1/100 %・初期値 100%。 */
  landRatioBp: z.number().int().min(0).max(10000),
}).strict();
export type Assessments = z.output<typeof assessmentsSchema>;
export const DEFAULT_ASSESSMENTS: Assessments = { rows: [], landRatioBp: 10000 };

const otherCostSchema = z.object({ label: z.string().trim().min(1).max(50), amount: yenInt }).strict();
export const costsSchema = z.object({
  scrivener: z.object({ name: text(100), address: text(300), tel: text(50), staff: text(100) }).strict(),
  registrationFee: yenInt.nullable(),
  cancellationFee: yenInt.nullable(),
  surveyFee: yenInt.nullable(),
  others: z.array(otherCostSchema).max(20),
  /** 低廉な空家等の特例(依頼書 3.1)。 */
  lowCostSpecial: z.boolean(),
}).strict();
export type Costs = z.output<typeof costsSchema>;
export const DEFAULT_COSTS: Costs = {
  scrivener: { name: null, address: null, tel: null, staff: null },
  registrationFee: null, cancellationFee: null, surveyFee: null, others: [], lowCostSpecial: false,
};

const otherSettlementSchema = z.object({
  label: z.string().trim().min(1).max(50), sellerToBuyer: yenInt, buyerToSeller: yenInt,
}).strict();
export const settlementTermsSchema = z.object({
  fixedAssetTax: yenInt.nullable(),
  cityPlanningTax: yenInt.nullable(),
  taxStart: z.enum(["01-01", "04-01"]),
  managementFee: yenInt.nullable(),
  repairReserve: yenInt.nullable(),
  otherMonthly: yenInt.nullable(),
  managementPrepaidMonths: z.number().int().min(0).max(12),
  rentPrepaidMonths: z.number().int().min(0).max(12),
  depositMode: z.enum(["offset", "separate"]),
  others: z.array(otherSettlementSchema).max(20),
}).strict();
export type SettlementTerms = z.output<typeof settlementTermsSchema>;
export const DEFAULT_TERMS: SettlementTerms = {
  fixedAssetTax: null, cityPlanningTax: null, taxStart: "01-01", managementFee: null, repairReserve: null, otherMonthly: null,
  managementPrepaidMonths: 0, rentPrepaidMonths: 0, depositMode: "offset", others: [],
};

export const leaseSchema = z.object({
  room: text(30), tenant: text(100), contractType: z.enum(["ordinary", "fixed_term"]), period: text(100),
  rent: yenInt, commonFee: yenInt, parking: yenInt, other: yenInt, deposit: yenInt,
  arrears: z.boolean(), arrearsAmount: yenInt, manager: text(100),
}).strict();
export type Lease = z.output<typeof leaseSchema>;
export const leasesSchema = z.array(leaseSchema).max(200);

/** 手で直せる計算値の鍵(表示 = 上書き ?? 計算)。 */
export const OVERRIDE_KEYS = [
  "brokerageFee", "buildingPrice", "buildingTax", "settlement.propertyTax", "settlement.management", "settlement.rent",
] as const;
export type OverrideKey = (typeof OVERRIDE_KEYS)[number];
export const overridesSchema = z.partialRecord(z.enum(OVERRIDE_KEYS), yenInt);
export type Overrides = z.output<typeof overridesSchema>;
```

`dealUpdateSchema` の `counterpartyBroker: counterpartyBrokerSchema.optional(),` の次に、次を足します。

```ts
  price: yenInt.nullable().optional(),
  deposit: yenInt.nullable().optional(),
  taxRateBp: z.number().int().min(0).max(10000).optional(),
  assessments: assessmentsSchema.optional(),
  costs: costsSchema.optional(),
  settlementTerms: settlementTermsSchema.optional(),
  leases: leasesSchema.optional(),
  overrides: overridesSchema.optional(),
```

- [ ] **Step 4: 読み込み・更新・表示を足す**

```ts
// src/lib/deals/inputs.ts
import {
  DEFAULT_ASSESSMENTS, DEFAULT_COSTS, DEFAULT_TERMS, OVERRIDE_KEYS, assessmentsSchema, costsSchema, leaseSchema,
  settlementTermsSchema, yenInt, type Assessments, type Costs, type Lease, type Overrides, type SettlementTerms,
} from "./schemas";

const obj = (json: unknown): Record<string, unknown> => (json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {});

/** 保存済みの JSON を読む。足りない項目は初期値で補い、それでも壊れていれば初期値(段1で入れた空の値も読める)。 */
export function readAssessments(json: unknown): Assessments {
  const r = assessmentsSchema.safeParse({ ...DEFAULT_ASSESSMENTS, ...obj(json) });
  return r.success ? r.data : DEFAULT_ASSESSMENTS;
}
export function readCosts(json: unknown): Costs {
  const r = costsSchema.safeParse({ ...DEFAULT_COSTS, ...obj(json) });
  return r.success ? r.data : DEFAULT_COSTS;
}
export function readTerms(json: unknown): SettlementTerms {
  const r = settlementTermsSchema.safeParse({ ...DEFAULT_TERMS, ...obj(json) });
  return r.success ? r.data : DEFAULT_TERMS;
}
/** 賃貸条件は行ごとに読み、壊れた行だけ落とす。 */
export function readLeases(json: unknown): Lease[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((row) => {
    const r = leaseSchema.safeParse(row);
    return r.success ? [r.data] : [];
  });
}
export function readOverrides(json: unknown): Overrides {
  const src = obj(json);
  const out: Overrides = {};
  for (const k of OVERRIDE_KEYS) {
    const r = yenInt.safeParse(src[k]);
    if (r.success) out[k] = r.data;
  }
  return out;
}
```

`src/lib/deals/change-values.ts` は次のように直します。

- `DEAL_TRACKED_FIELDS` の末尾に `"price", "deposit", "taxRateBp"` を足します。
- `SIMPLE_KEYS` に `"taxRateBp", "assessments", "costs", "settlementTerms", "leases", "overrides"` を足します。
- `const DATE_KEYS` の次に `const BIGINT_KEYS = ["price", "deposit"] as const;` を足します。
- `toDealUpdateData` の DATE_KEYS のループの次に、次を足します。

```ts
  for (const k of BIGINT_KEYS) {
    const v = patch[k];
    if (v !== undefined) data[k] = v === null ? null : BigInt(v);
  }
```

`src/lib/deals/view.ts` は次のように直します。

- import に `readAssessments, readCosts, readLeases, readOverrides, readTerms`(`./inputs`)と、`Assessments, Costs, Lease, Overrides, SettlementTerms`(`./schemas`)を足します。
- `DEAL_DETAIL_SELECT` に、`assessments: true, costs: true, settlementTerms: true, leases: true, overrides: true,` を足します。
- `DealView` に、`assessments: Assessments; costs: Costs; settlementTerms: SettlementTerms; leases: Lease[]; overrides: Overrides;` を足します。
- `toDealView` に、`assessments: readAssessments(r.assessments), costs: readCosts(r.costs), settlementTerms: readTerms(r.settlementTerms), leases: readLeases(r.leases), overrides: readOverrides(r.overrides),` を足します。

`src/lib/deals/__tests__/forms.test.ts` の `deal` の定義に、`assessments: DEFAULT_ASSESSMENTS, costs: DEFAULT_COSTS, settlementTerms: DEFAULT_TERMS, leases: [], overrides: {},` を足します。import にも足します(型を満たすため)。

- [ ] **Step 5: テスト・型を走らせる**

```bash
npx vitest run src/lib/deals > /tmp/d2-t4.log 2>&1; echo exit=$?; grep -E "×|Tests " /tmp/d2-t4.log | head
npx tsc --noEmit 2>&1 | head
```
Expected: `exit=0`、tsc の出力なし

- [ ] **Step 6: コミットする**

```bash
git add src/lib/deals
git commit -m "feat(deals): 段2の入力(評価額・費用・精算条件・賃貸条件・上書き)の検証と保存"
```

---

### Task 5: 決済の計算と、取引1件の計算結果

**Files:**
- Create: `src/lib/deals/calc/settlement.ts`, `src/lib/deals/calc/deal-calc.ts`
- Test: `src/lib/deals/calc/__tests__/settlement.test.ts`

**Interfaces:**
- Consumes: Task 1〜4
- Produces:
  - `interface SettlementRow { key: string; label: string; period: string|null; formula: string|null; sellerToBuyer: number; buyerToSeller: number; computed: number|null; overridden: boolean; note: string|null }`
  - `interface SettlementResult { ready: boolean; missing: string[]; rows: SettlementRow[]; depositRow: SettlementRow|null; totalSellerToBuyer: number; totalBuyerToSeller: number; net: {direction: "buyerToSeller"|"sellerToBuyer"|"none"; amount: number}; netLine: string; remaining: number|null; depositOffset: number; paymentAtSettlement: number|null; warnings: string[] }`
  - `settlementResult(input): SettlementResult`
  - `interface DealCalc`
  - `computeDealCalc(deal: DealView, rateRows: RateTableRow[], kinds: PropertyKindDef[], today: string): DealCalc`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/deals/calc/__tests__/settlement.test.ts
import { describe, it, expect } from "vitest";
import { settlementResult } from "../settlement";
import { computeDealCalc } from "../deal-calc";
import { DEFAULT_ASSESSMENTS, DEFAULT_COSTS, DEFAULT_TERMS, EMPTY_BROKER, EMPTY_SNAPSHOT } from "../../schemas";
import { DEFAULT_PROPERTY_KINDS } from "../../constants";
import { INITIAL_RATE_TABLES, type RateTableRow } from "../../rate-tables";
import type { DealView } from "../../view";

const lease = {
  room: "101", tenant: "試験 次郎", contractType: "ordinary" as const, period: null, rent: 80_000, commonFee: 5_000,
  parking: 0, other: 0, deposit: 160_000, arrears: false, arrearsAmount: 0, manager: null,
};
const base = {
  price: 30_000_000, deposit: 1_500_000, kindBase: "unit" as const, hasOc: false, settlementDate: "2026-07-01",
  terms: { ...DEFAULT_TERMS, fixedAssetTax: 100_000, cityPlanningTax: 20_000, managementFee: 20_000, repairReserve: 10_000 },
  leases: [], overrides: {},
};

describe("決済の計算", () => {
  it("決済日が無ければ計算しない", () => {
    const r = settlementResult({ ...base, settlementDate: null });
    expect(r).toMatchObject({ ready: false, missing: ["決済日時"], rows: [] });
  });
  it("固都税(年税額の合計)と管理費等(区分だけ)を買主から売主へ", () => {
    const r = settlementResult(base);
    expect(r.rows.map((x) => x.key)).toEqual(["propertyTax", "management"]);
    expect(r.rows[0]).toMatchObject({ label: "固定資産税・都市計画税", buyerToSeller: 60_493, sellerToBuyer: 0, formula: "120,000円×184日÷365日", period: "2026-07-01〜2026-12-31" });
    expect(r.rows[1]).toMatchObject({ buyerToSeller: 30_000 });
    expect(r.net).toEqual({ direction: "buyerToSeller", amount: 90_493 });
    expect(r.netLine).toBe("買主から売主へ 90,493円");
    expect(r.remaining).toBe(28_500_000);
    expect(r.paymentAtSettlement).toBe(28_590_493);
  });
  it("土地・戸建では管理費の行を出さない", () => {
    expect(settlementResult({ ...base, kindBase: "land" }).rows.map((x) => x.key)).toEqual(["propertyTax"]);
  });
  it("OC: 賃料は売主から買主へ・敷金は相殺ならお支払額から引く", () => {
    const r = settlementResult({ ...base, kindBase: "building", hasOc: true, leases: [lease, { ...lease, room: "102", deposit: 80_000 }] });
    const rent = r.rows.find((x) => x.key === "rent")!;
    expect(rent.sellerToBuyer).toBe(Math.floor((170_000 * 31) / 31));
    expect(r.depositRow).toMatchObject({ sellerToBuyer: 240_000, note: "残代金と相殺" });
    expect(r.depositOffset).toBe(240_000);
    expect(r.paymentAtSettlement).toBe(28_500_000 + (r.totalBuyerToSeller - r.totalSellerToBuyer) - 240_000);
  });
  it("敷金を別途にすればお支払額から引かない", () => {
    const r = settlementResult({ ...base, hasOc: true, leases: [lease], terms: { ...base.terms, depositMode: "separate" } });
    expect(r.depositOffset).toBe(0);
    expect(r.depositRow?.note).toBe("別途授受");
  });
  it("手で直した値を使い、計算の値も持っておく", () => {
    const r = settlementResult({ ...base, overrides: { "settlement.propertyTax": 60_000 } });
    expect(r.rows[0]).toMatchObject({ buyerToSeller: 60_000, computed: 60_493, overridden: true });
  });
  it("その他の自由行を足す・4/1 起算の注意文を出す", () => {
    const r = settlementResult({ ...base, settlementDate: "2027-02-15", terms: { ...base.terms, taxStart: "04-01", others: [{ label: "測量費の負担分", sellerToBuyer: 0, buyerToSeller: 50_000 }] } });
    expect(r.rows.at(-1)).toMatchObject({ label: "測量費の負担分", buyerToSeller: 50_000 });
    expect(r.warnings[0]).toContain("起算日が4月1日");
  });
});

const rateRows: RateTableRow[] = INITIAL_RATE_TABLES.map((t) => ({
  kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
}));
const deal: DealView = {
  id: "d", dealNo: "2026-0001", name: "試験", businessType: "brokerage", tradeSide: "both", status: "considering",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "unit", hasOc: false,
  contractAt: "2026-05-01T01:00:00.000Z", contractPlace: null, settlementAt: "2026-07-01T01:00:00.000Z", settlementPlace: null,
  price: 30_000_000, buildingTax: null, deposit: 1_500_000, taxRateBp: 1000,
  propertySnapshot: EMPTY_SNAPSHOT, counterpartyBroker: EMPTY_BROKER,
  assessments: { rows: [{ building: 10_000_000, land: 20_000_000, shareNum: 1, shareDen: 1 }], landRatioBp: 10000 },
  costs: DEFAULT_COSTS, settlementTerms: base.terms, leases: [], overrides: {},
  version: 1, createdAt: "", updatedAt: "", parties: [],
};

describe("取引1件の計算結果", () => {
  it("手数料・建物価格と消費税・契約書の印紙・精算をまとめる(基準日=契約日)", () => {
    const c = computeDealCalc(deal, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-24");
    expect(c.baseDate).toBe("2026-05-01");
    expect(c.brokerage).toMatchObject({ computedExcl: 960_000, excl: 960_000, incl: 1_056_000, overridden: false });
    expect(c.building).toMatchObject({ computedPrice: 10_000_000, price: 10_000_000, computedTax: 909_090, tax: 909_090 });
    expect(c.contractStamp).toBe(10_000);
    expect(c.settlement.netLine).toBe("買主から売主へ 90,493円");
  });
  it("上書き: 手数料・建物価格(→消費税は建物価格から計算し直す)", () => {
    const c = computeDealCalc({ ...deal, overrides: { brokerageFee: 900_000, buildingPrice: 11_000_000 } }, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-24");
    expect(c.brokerage).toMatchObject({ excl: 900_000, incl: 990_000, overridden: true, computedExcl: 960_000 });
    expect(c.building).toMatchObject({ price: 11_000_000, priceOverridden: true, tax: 1_000_000 });
  });
  it("価格が無ければ手数料などは null・足りないものを並べる", () => {
    const c = computeDealCalc({ ...deal, price: null, contractAt: null, settlementAt: null }, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-24");
    expect(c.baseDate).toBe("2026-10-24");
    expect(c.brokerage).toBeNull();
    expect(c.missing).toEqual(expect.arrayContaining(["売買価格", "決済日時"]));
  });
});
```

- [ ] **Step 2: テストを走らせて、失敗することを確かめる**

Run: `npx vitest run src/lib/deals/calc/__tests__/settlement.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

```ts
// src/lib/deals/calc/settlement.ts
import type { BasePropertyKind } from "../constants";
import type { Lease, Overrides, SettlementTerms } from "../schemas";
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
  const pick = (key: keyof Overrides & string, computed: number) => {
    const o = i.overrides[key as keyof Overrides];
    return { value: o ?? computed, overridden: o !== undefined };
  };

  const annual = sum([i.terms.fixedAssetTax, i.terms.cityPlanningTax]);
  if (annual > 0) {
    const p = prorateAnnualTax(annual, i.terms.taxStart, date);
    if (p.warning) warnings.push(p.warning);
    const v = pick("settlement.propertyTax", p.buyer);
    rows.push({
      key: "propertyTax", label: "固定資産税・都市計画税", period: `${date}〜${p.periodEnd}`, formula: p.formula,
      sellerToBuyer: 0, buyerToSeller: v.value, computed: p.buyer, overridden: v.overridden, note: null,
    });
  }

  const monthly = sum([i.terms.managementFee, i.terms.repairReserve, i.terms.otherMonthly]);
  if (i.kindBase === "unit" && monthly > 0) {
    const p = prorateMonthly(monthly, date, i.terms.managementPrepaidMonths);
    const v = pick("settlement.management", p.total);
    rows.push({
      key: "management", label: "管理費・修繕積立金等", period: null, formula: p.formula,
      sellerToBuyer: 0, buyerToSeller: v.value, computed: p.total, overridden: v.overridden, note: null,
    });
  }

  let depositRow: SettlementRow | null = null;
  if (i.hasOc) {
    const rentMonthly = sum(i.leases.map((l) => l.rent + l.commonFee + l.parking + l.other));
    if (rentMonthly > 0) {
      const p = prorateMonthly(rentMonthly, date, i.terms.rentPrepaidMonths);
      const v = pick("settlement.rent", p.total);
      rows.push({
        key: "rent", label: "賃料・共益費・駐車場代等", period: null, formula: p.formula,
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
```

```ts
// src/lib/deals/calc/deal-calc.ts
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
function table<K extends keyof typeof RATE_CONTENT_SCHEMAS>(rows: RateTableRow[], kind: K, date: string) {
  const hit = pickRateTable(rows, kind, date);
  const r = hit ? RATE_CONTENT_SCHEMAS[kind].safeParse(hit.content) : null;
  return r?.success ? r.data : null;
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
```

この Task は `rate-content.ts`(Task 6)を使います。そのため、Task 6 の Step 3 の `rate-content.ts` を先にここで作ります。中身は Task 6 に書いてあるとおりで、Task 6 ではテストだけを足します。

- [ ] **Step 4: テストを走らせて、通ることを確かめる**

Run: `npx vitest run src/lib/deals`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add src/lib/deals
git commit -m "feat(deals): 決済の計算(精算の行・差引・お支払額)と取引1件の計算結果"
```

---

### Task 6: 税率の表の検証・編集 API・計算 API、後回しにした小さな点 M5

**Files:**
- Create: `src/lib/deals/rate-content.ts`(Task 5 で先に作成済みなら、そのまま使う)
- Create: `src/app/api/deals/[id]/calc/route.ts`、`src/app/api/admin/deal-settings/rate-tables/[id]/route.ts`
- Modify: `src/app/api/admin/deal-settings/rate-tables/route.ts`(POST を足す・GET に updatedAt)
- Modify: `src/app/api/deals/route.ts`(M5: 番号の作り直しを使い切ったら 409)
- Modify: `src/app/(dashboard)/admin/audit-logs/page.tsx`(ラベル)
- Modify: `src/lib/deals/client.ts`(`RateTableView.updatedAt`、`calc`、`createRateTable`、`updateRateTable`、`deleteRateTable`)
- Test: `src/lib/deals/__tests__/rate-content.test.ts`、`src/lib/deals/__tests__/calc-route.test.ts`、`src/lib/deals/__tests__/rate-tables-route.test.ts`、`deals-route.test.ts`(M5 を足す)

**Interfaces:**
- Produces:
  - 検証:
    - `RATE_CONTENT_SCHEMAS: { [K in RateTableKind]: ZodType }`
    - `rateTableInputSchema`(`{kind, validFrom, validTo, content}`。content は kind ごとに検証)
  - 期間: `periodsOverlap(a: {validFrom: string; validTo: string|null}, b): boolean`
  - API:
    - `GET /api/deals/[id]/calc` → `{ calc: DealCalc }`
    - `POST /api/admin/deal-settings/rate-tables` → 201 `{ id }`
    - `PUT /api/admin/deal-settings/rate-tables/[id]`(本文 `{validFrom, validTo, content, updatedAt}`)
    - `DELETE /api/admin/deal-settings/rate-tables/[id]?updatedAt=`
  - 監査の action: `deal_rate_table_create`、`deal_rate_table_update`、`deal_rate_table_delete`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/deals/__tests__/rate-content.test.ts
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
```

```ts
// src/lib/deals/__tests__/calc-route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./route-mocks")).apiHelpersMock());
vi.mock("@/lib/prisma", () => ({
  default: {
    deal: { findUnique: vi.fn(async () => null) },
    dealRateTable: { findMany: vi.fn(async () => []) },
    dealSettings: { findUnique: vi.fn(async () => null) },
  },
}));

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { DEAL_ID, DEAL_PERMS } from "./route-mocks";
import { GET } from "../../../app/api/deals/[id]/calc/route";
import { INITIAL_RATE_TABLES } from "../rate-tables";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as { deal: { findUnique: Fn }; dealRateTable: { findMany: Fn } };
const ctx = { params: Promise.resolve({ id: DEAL_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u", role: "office_staff" });
  (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS);
  pm.dealRateTable.findMany.mockResolvedValue(INITIAL_RATE_TABLES.map((t) => ({
    kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
  })));
});

describe("GET /api/deals/[id]/calc", () => {
  it("取引の計算結果を返す", async () => {
    pm.deal.findUnique.mockResolvedValue({
      id: DEAL_ID, dealNo: "2026-0001", name: "試験", businessType: "brokerage", tradeSide: "both", status: "considering",
      assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "land", hasOc: false,
      contractAt: new Date("2026-05-01T01:00:00Z"), contractPlace: null, settlementAt: null, settlementPlace: null,
      price: BigInt(30_000_000), buildingTax: null, deposit: null, taxRateBp: 1000,
      propertySnapshot: {}, counterpartyBroker: {}, assessments: [], costs: {}, settlementTerms: {}, leases: [], overrides: {},
      version: 1, createdAt: new Date(), updatedAt: new Date(), parties: [],
    });
    const res = await GET(new Request("http://x"), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.calc.brokerage.excl).toBe(960_000);
    expect(body.calc.missing).toContain("決済日時");
  });
  it("無ければ 404・権限が無ければ 403", async () => {
    expect((await GET(new Request("http://x"), ctx)).status).toBe(404);
    (getUserPermissions as Fn).mockResolvedValue([]);
    expect((await GET(new Request("http://x"), ctx)).status).toBe(403);
  });
});
```

```ts
// src/lib/deals/__tests__/rate-tables-route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./route-mocks")).apiHelpersMock());
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/prisma", () => ({
  default: {
    dealRateTable: {
      findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null), create: vi.fn(async () => ({ id: "33333333-3333-4333-8333-333333333333" })),
      updateMany: vi.fn(async () => ({ count: 1 })), deleteMany: vi.fn(async () => ({ count: 1 })),
    },
  },
}));

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { jsonRequest as json } from "./route-mocks";
import { POST } from "../../../app/api/admin/deal-settings/rate-tables/route";
import { PUT, DELETE } from "../../../app/api/admin/deal-settings/rate-tables/[id]/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as { dealRateTable: { findMany: Fn; findUnique: Fn; create: Fn; updateMany: Fn; deleteMany: Fn } };
const ID = "33333333-3333-4333-8333-333333333333";
const ctx = { params: Promise.resolve({ id: ID }) };
const ADMIN = [{ resource: "user_management", action: "write", granted: true }];
const AT = "2026-10-24T00:00:00.000Z";
const existing = (from: string, to: string | null, id = "44444444-4444-4444-8444-444444444444") => ({
  id, kind: "consumption_tax", validFrom: new Date(`${from}T00:00:00Z`), validTo: to ? new Date(`${to}T00:00:00Z`) : null,
});

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u-admin", role: "admin" });
  (getUserPermissions as Fn).mockResolvedValue(ADMIN);
  pm.dealRateTable.updateMany.mockResolvedValue({ count: 1 });
  pm.dealRateTable.deleteMany.mockResolvedValue({ count: 1 });
});

describe("税率の表を足す・直す・消す(管理者)", () => {
  it("足す: 期間が重ならなければ作る・監査は項目名だけ", async () => {
    pm.dealRateTable.findMany.mockResolvedValue([existing("2019-10-01", "2029-12-31")]);
    const res = await POST(json("POST", { kind: "consumption_tax", validFrom: "2030-01-01", validTo: null, content: { rateBp: 1200 } }));
    expect(res.status).toBe(201);
    expect(pm.dealRateTable.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: "consumption_tax", content: { rateBp: 1200 }, updatedById: "u-admin" }) }));
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "deal_rate_table_create", targetTable: "deal_rate_tables" }));
  });
  it("足す: 期間が重なれば 422", async () => {
    pm.dealRateTable.findMany.mockResolvedValue([existing("2019-10-01", null)]);
    const res = await POST(json("POST", { kind: "consumption_tax", validFrom: "2030-01-01", validTo: null, content: { rateBp: 1200 } }));
    expect(res.status).toBe(422);
    expect(pm.dealRateTable.create).not.toHaveBeenCalled();
  });
  it("直す: 自分は重なりの相手にしない・更新日時が合わなければ 409", async () => {
    pm.dealRateTable.findUnique.mockResolvedValue({ ...existing("2019-10-01", null, ID), updatedAt: new Date(AT) });
    pm.dealRateTable.findMany.mockResolvedValue([existing("2019-10-01", null, ID)]);
    const res = await PUT(json("PUT", { validFrom: "2019-10-01", validTo: null, content: { rateBp: 1000 }, updatedAt: AT }), ctx);
    expect(res.status).toBe(200);
    expect(pm.dealRateTable.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: ID, updatedAt: new Date(AT) } }));
    pm.dealRateTable.updateMany.mockResolvedValue({ count: 0 });
    expect((await PUT(json("PUT", { validFrom: "2019-10-01", validTo: null, content: { rateBp: 1000 }, updatedAt: AT }), ctx)).status).toBe(409);
  });
  it("消す: 更新日時を見る・管理者でなければ 403", async () => {
    pm.dealRateTable.findUnique.mockResolvedValue({ ...existing("2019-10-01", null, ID), updatedAt: new Date(AT) });
    const res = await DELETE(new Request(`http://x/api?updatedAt=${encodeURIComponent(AT)}`, { method: "DELETE" }), ctx);
    expect(res.status).toBe(200);
    expect(pm.dealRateTable.deleteMany).toHaveBeenCalledWith({ where: { id: ID, updatedAt: new Date(AT) } });
    (getUserPermissions as Fn).mockResolvedValue([]);
    expect((await DELETE(new Request(`http://x/api?updatedAt=${encodeURIComponent(AT)}`, { method: "DELETE" }), ctx)).status).toBe(403);
  });
});
```

`deals-route.test.ts` の `describe("POST /api/deals"` の中に、次を足します(M5)。

```ts
  it("3回続けて番号がぶつかったら 409(もう一度押せばよい)(M5)", async () => {
    pm.deal.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    const res = await POST(json("POST", { name: "a", businessType: "brokerage" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("DEAL_NO_BUSY");
  });
```

- [ ] **Step 2: テストを走らせて、失敗することを確かめる**

Run: `npx vitest run src/lib/deals/__tests__`
Expected: FAIL(rate-content と route が無い・M5)

- [ ] **Step 3: 実装する**

```ts
// src/lib/deals/rate-content.ts
import { z } from "zod";
import { RATE_TABLE_KINDS, type RateTableKind } from "./rate-tables";

const bp = z.number().int().min(0).max(10000);
const yen = z.number().int().min(0).max(10_000_000_000_000);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** 区分は小さい順・最後の1つだけ上限なし(null)。 */
const ascendingLastNull = (rows: { upTo: number | null }[]) =>
  rows.every((r, i) => (i === rows.length - 1 ? r.upTo === null : r.upTo !== null && (i === 0 || r.upTo > (rows[i - 1].upTo as number))));

const bracketsSchema = z.object({
  brackets: z.array(z.object({ upTo: yen.nullable(), tax: yen }).strict()).min(1).max(30)
    .refine(ascendingLastNull, "金額の区分は小さい順にし、最後だけ上限なしにしてください"),
}).strict();

/** 税率の表の中身(種類ごと)。計算はこの形だけを信じる。 */
export const RATE_CONTENT_SCHEMAS = {
  consumption_tax: z.object({ rateBp: bp }).strict(),
  brokerage_tiers: z.object({
    tiers: z.array(z.object({ upTo: yen.nullable(), rateBp: bp }).strict()).min(1).max(5)
      .refine(ascendingLastNull, "価格の段は小さい順にし、最後だけ上限なしにしてください"),
    lowCostSpecial: z.object({ priceLimit: yen, feeCap: yen }).strict(),
  }).strict(),
  stamp_contract: bracketsSchema,
  stamp_receipt: bracketsSchema,
  capital_gains: z.object({
    long: z.object({ incomeTaxBp: bp, residentTaxBp: bp }).strict(),
    short: z.object({ incomeTaxBp: bp, residentTaxBp: bp }).strict(),
    reconstructionBp: bp,
    longTermYears: z.number().int().min(1).max(50),
    residentialDeduction: yen,
    unknownCostRateBp: bp,
  }).strict(),
} satisfies Record<RateTableKind, z.ZodType>;

export const rateTableInputSchema = z.object({
  kind: z.enum(RATE_TABLE_KINDS),
  validFrom: dateStr,
  validTo: dateStr.nullable(),
  content: z.unknown(),
}).strict()
  .refine((v) => v.validTo === null || v.validTo >= v.validFrom, "終わりの日は始まりの日以降にしてください")
  .refine((v) => RATE_CONTENT_SCHEMAS[v.kind].safeParse(v.content).success, "表の中身が正しくありません");

/** 期間が重なるか(終わりが null = 期限なし)。 */
export function periodsOverlap(
  a: { validFrom: string; validTo: string | null },
  b: { validFrom: string; validTo: string | null },
): boolean {
  const end = (v: string | null) => v ?? "9999-12-31";
  return a.validFrom <= end(b.validTo) && b.validFrom <= end(a.validTo);
}
```

```ts
// src/app/api/deals/[id]/calc/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { requireDeal } from "@/lib/deals/guard";
import { DEAL_DETAIL_SELECT, toDealView } from "@/lib/deals/view";
import { loadDealSettings } from "@/lib/deals/settings-store";
import { computeDealCalc } from "@/lib/deals/calc/deal-calc";
import { jstDateString } from "@/lib/deals/datetime";

type Ctx = { params: Promise<{ id: string }> };

/** 取引1件の計算結果(手数料・按分・印紙・決済の計算)。計算はサーバーの純粋関数だけで行う。 */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    await requireDeal("read");
    const id = z.string().uuid().parse((await ctx.params).id);
    const row = await prisma.deal.findUnique({ where: { id }, select: DEAL_DETAIL_SELECT });
    if (!row) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
    const [rateRows, settings] = await Promise.all([prisma.dealRateTable.findMany(), loadDealSettings()]);
    const calc = computeDealCalc(toDealView(row), rateRows, settings.propertyKinds, jstDateString(new Date()));
    return NextResponse.json({ calc }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
```

`src/app/api/admin/deal-settings/rate-tables/route.ts` は、全体を次にします。

```ts
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireDealAdmin } from "@/lib/deals/guard";
import { periodsOverlap, rateTableInputSchema } from "@/lib/deals/rate-content";

const day = (d: Date) => d.toISOString().slice(0, 10);
const NO_STORE = { "Cache-Control": "no-store" };

/** 税率・税額の表の一覧(管理者)。直すときの楽観ロックに updatedAt を返す。 */
export async function GET() {
  try {
    await requireDealAdmin();
    const rows = await prisma.dealRateTable.findMany({ orderBy: [{ kind: "asc" }, { validFrom: "asc" }] });
    return NextResponse.json(
      {
        tables: rows.map((r) => ({
          id: r.id, kind: r.kind, validFrom: day(r.validFrom), validTo: r.validTo ? day(r.validTo) : null,
          content: r.content, updatedAt: r.updatedAt.toISOString(),
        })),
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    return handleApiError(error);
  }
}

/** 新しい期間の表を足す。同じ種類で期間が重なるものがあれば 422。 */
export async function POST(request: Request) {
  try {
    const session = await requireDealAdmin();
    const body = rateTableInputSchema.parse(await parseJsonBody(request));
    const same = await prisma.dealRateTable.findMany({ where: { kind: body.kind }, select: { id: true, validFrom: true, validTo: true } });
    if (same.some((r) => periodsOverlap(body, { validFrom: day(r.validFrom), validTo: r.validTo ? day(r.validTo) : null }))) {
      throw new ApiError(422, "同じ種類の表と期間が重なっています", "PERIOD_OVERLAP");
    }
    const created = await prisma.dealRateTable.create({
      data: {
        kind: body.kind, validFrom: new Date(`${body.validFrom}T00:00:00Z`),
        validTo: body.validTo ? new Date(`${body.validTo}T00:00:00Z`) : null,
        content: body.content as object, updatedById: session.id,
      },
      select: { id: true },
    });
    await writeAuditLog({
      userId: session.id, action: "deal_rate_table_create", targetTable: "deal_rate_tables", targetId: created.id,
      detail: { fields: ["kind", "validFrom", "validTo", "content"] },
    });
    return NextResponse.json(created, { status: 201, headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
```

```ts
// src/app/api/admin/deal-settings/rate-tables/[id]/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireDealAdmin, DEAL_VERSION_CONFLICT_MESSAGE } from "@/lib/deals/guard";
import { periodsOverlap, RATE_CONTENT_SCHEMAS } from "@/lib/deals/rate-content";
import type { RateTableKind } from "@/lib/deals/rate-tables";

type Ctx = { params: Promise<{ id: string }> };
const day = (d: Date) => d.toISOString().slice(0, 10);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const NO_STORE = { "Cache-Control": "no-store" };

const putSchema = z.object({
  validFrom: dateStr, validTo: dateStr.nullable(), content: z.unknown(), updatedAt: z.string().datetime(),
}).strict().refine((v) => v.validTo === null || v.validTo >= v.validFrom, "終わりの日は始まりの日以降にしてください");

async function current(ctx: Ctx) {
  const id = z.string().uuid().parse((await ctx.params).id);
  const row = await prisma.dealRateTable.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, "表が見つかりません", "NOT_FOUND");
  return row;
}

/** 表を直す(期間・中身)。更新日時が合わなければ 409=ほかの人が先に直した。 */
export async function PUT(request: Request, ctx: Ctx) {
  try {
    const session = await requireDealAdmin();
    const row = await current(ctx);
    const body = putSchema.parse(await parseJsonBody(request));
    const content = RATE_CONTENT_SCHEMAS[row.kind as RateTableKind]?.safeParse(body.content);
    if (!content?.success) throw new ApiError(422, "表の中身が正しくありません", "INVALID_CONTENT");
    const same = await prisma.dealRateTable.findMany({ where: { kind: row.kind }, select: { id: true, validFrom: true, validTo: true } });
    if (same.some((r) => r.id !== row.id && periodsOverlap(body, { validFrom: day(r.validFrom), validTo: r.validTo ? day(r.validTo) : null }))) {
      throw new ApiError(422, "同じ種類の表と期間が重なっています", "PERIOD_OVERLAP");
    }
    const res = await prisma.dealRateTable.updateMany({
      where: { id: row.id, updatedAt: new Date(body.updatedAt) },
      data: {
        validFrom: new Date(`${body.validFrom}T00:00:00Z`), validTo: body.validTo ? new Date(`${body.validTo}T00:00:00Z`) : null,
        content: content.data as object, updatedById: session.id,
      },
    });
    if (res.count === 0) throw new ApiError(409, DEAL_VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
    await writeAuditLog({
      userId: session.id, action: "deal_rate_table_update", targetTable: "deal_rate_tables", targetId: row.id,
      detail: { fields: ["validFrom", "validTo", "content"] },
    });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request, ctx: Ctx) {
  try {
    const session = await requireDealAdmin();
    const row = await current(ctx);
    const updatedAt = z.string().datetime().parse(new URL(request.url).searchParams.get("updatedAt"));
    const res = await prisma.dealRateTable.deleteMany({ where: { id: row.id, updatedAt: new Date(updatedAt) } });
    if (res.count === 0) throw new ApiError(409, DEAL_VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
    await writeAuditLog({
      userId: session.id, action: "deal_rate_table_delete", targetTable: "deal_rate_tables", targetId: row.id, detail: { fields: [] },
    });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
```

`src/app/api/deals/route.ts`(M5)は次のように直します。

```ts
        if (isUniqueViolation(e) && attempt < DEAL_NO_ATTEMPTS) continue;
        if (isUniqueViolation(e)) throw new ApiError(409, "ほかの人が同時に作成しました。もう一度「作成」を押してください。", "DEAL_NO_BUSY");
        throw e;
```

監査のラベル(`audit-logs/page.tsx`)は次のとおりです。

- `ACTION_LABELS` の取引のまとまりに、次の3行を足します。
  - `deal_rate_table_create: "取引の税率の表を追加",`
  - `deal_rate_table_update: "取引の税率の表を変更",`
  - `deal_rate_table_delete: "取引の税率の表を削除",`
- `TARGET_TABLE_LABELS` に、`deal_rate_tables: "取引の税率の表",` を足します。

`src/lib/deals/client.ts` は次のように直します。

- `RateTableView` に `updatedAt: string` を足します。
- import に `import type { DealCalc } from "./calc/deal-calc";` を足します。
- `dealsApi` に次を足します。

```ts
  calc: (id: string) => call<{ calc: DealCalc }>(`/api/deals/${id}/calc`),
  createRateTable: (body: Record<string, unknown>) => call<{ id: string }>("/api/admin/deal-settings/rate-tables", { method: "POST", body }),
  updateRateTable: (id: string, body: Record<string, unknown>) => call<{ ok: true }>(`/api/admin/deal-settings/rate-tables/${id}`, { method: "PUT", body }),
  deleteRateTable: (id: string, updatedAt: string) =>
    call<{ ok: true }>(`/api/admin/deal-settings/rate-tables/${id}?updatedAt=${encodeURIComponent(updatedAt)}`, { method: "DELETE" }),
```

- [ ] **Step 4: テストを走らせて、通ることを確かめる**

```bash
npx vitest run --testTimeout=120000 src/lib/deals "src/app/(dashboard)/__tests__/audit-action-labels-scan.test.ts" > /tmp/d2-t6.log 2>&1; echo exit=$?; grep -E "×|Tests " /tmp/d2-t6.log | head
npx tsc --noEmit 2>&1 | head
```
Expected: `exit=0`、tsc の出力なし

- [ ] **Step 5: コミットする**

```bash
git add src/lib/deals src/app/api "src/app/(dashboard)/admin/audit-logs/page.tsx"
git commit -m "feat(deals): 計算結果の API・税率の表の編集 API・番号の作り直しを使い切ったら 409"
```

---

### Task 7: 画面の金額の入力部品と変換(M2 を含む)

**Files:**
- Create: `src/lib/deals/money-forms.ts`
- Modify: `src/components/deals/form-parts.tsx`
  - YenInput・OverrideField を足す
  - SelectBox に `disabled` と、使えない値の表示を足す(M2)
- Test: `src/lib/deals/__tests__/money-forms.test.ts`、`src/lib/deals/__tests__/form-parts.test.tsx`

**Interfaces:**
- Produces:
  - 金額・率の変換:
    - `parseYen(s: string): number|null`(数字以外・空は null。カンマ・円・空白は無視)
    - `yenText(n: number|null): string`
    - `bpToPercentText(bp: number): string`
    - `percentTextToBp(s: string): number|null`
  - 部品:
    - `YenInput({label, value: string, onChange(v: string)})`(右に「= 1,234円」と出す)
    - `OverrideField({label, computed: number|null, override: number|undefined, onChange(v: number|undefined)})`
  - `SelectBox` の props に `disabled?: boolean` を足す。value が選択肢に無いときは「(使えない値)」の option を足して見せる

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/deals/__tests__/money-forms.test.ts
import { describe, it, expect } from "vitest";
import { bpToPercentText, parseYen, percentTextToBp, yenText } from "../money-forms";

describe("金額・率の入力", () => {
  it("カンマ・円・空白を無視して整数に・読めなければ null", () => {
    expect(parseYen("30,000,000円")).toBe(30_000_000);
    expect(parseYen(" 120000 ")).toBe(120_000);
    expect(parseYen("")).toBeNull();
    expect(parseYen("12.5")).toBeNull();
    expect(parseYen("-1")).toBeNull();
    expect(yenText(1_056_000)).toBe("1,056,000");
    expect(yenText(null)).toBe("");
  });
  it("率は % の文字と 1/100 % の整数を行き来する", () => {
    expect(bpToPercentText(1000)).toBe("10");
    expect(bpToPercentText(850)).toBe("8.5");
    expect(percentTextToBp("10")).toBe(1000);
    expect(percentTextToBp("8.5")).toBe(850);
    expect(percentTextToBp("8.555")).toBeNull();
    expect(percentTextToBp("x")).toBeNull();
  });
});
```

```tsx
// src/lib/deals/__tests__/form-parts.test.tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OverrideField, SelectBox } from "@/components/deals/form-parts";

describe("入力の部品", () => {
  it("選択肢に無い値は「(使えない値)」として見せる(M2)", () => {
    const html = renderToStaticMarkup(<SelectBox label="担当" value="gone" onChange={() => {}} options={[{ value: "a", label: "試験 太郎" }]} allowEmpty />);
    expect(html).toContain('value="gone"');
    expect(html).toContain("(使えない値)");
  });
  it("上書きしていなければ計算の値、上書きしていれば印と「計算に戻す」", () => {
    const plain = renderToStaticMarkup(<OverrideField label="仲介手数料" computed={960000} override={undefined} onChange={() => {}} />);
    expect(plain).toContain("960,000");
    expect(plain).not.toContain("計算に戻す");
    const over = renderToStaticMarkup(<OverrideField label="仲介手数料" computed={960000} override={900000} onChange={() => {}} />);
    expect(over).toContain("手で直した値");
    expect(over).toContain("計算に戻す");
    expect(over).toContain("960,000");
  });
});
```

- [ ] **Step 2: テストを走らせて、失敗することを確かめる**

Run: `npx vitest run src/lib/deals/__tests__/money-forms.test.ts src/lib/deals/__tests__/form-parts.test.tsx`
Expected: FAIL

- [ ] **Step 3: 実装する**

```ts
// src/lib/deals/money-forms.ts
import { yen } from "./calc/format";

/** 金額の入力 → 円の整数。カンマ・円・空白は無視。空・小数・マイナス・数字以外は null。 */
export function parseYen(s: string): number | null {
  const t = s.replace(/[,，円\s]/g, "");
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

export const yenText = (n: number | null) => (n === null ? "" : yen(n));

/** 1/100 % の整数 → 画面の % の文字(1000 → "10"・850 → "8.5")。 */
export const bpToPercentText = (bp: number) => String(bp / 100);

/** 画面の % の文字 → 1/100 % の整数。小数は2桁まで。 */
export function percentTextToBp(s: string): number | null {
  const t = s.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}
```

`src/components/deals/form-parts.tsx` の `SelectBox` を、次に差し替えます。末尾には YenInput・OverrideField を足します(import に `Button` と `RotateCcw` を足す)。

```tsx
export function SelectBox({
  label, value, onChange, options, allowEmpty, disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  /** 空欄を選べる(「未設定」)。 */
  allowEmpty?: boolean;
  disabled?: boolean;
}) {
  // 保存済みの値が選択肢に無い(担当者が無効になった・種別を設定から外した)ときも、
  // 「未設定」と誤って見せず、その値のまま出す(M2)。
  const unknown = value !== "" && !options.some((o) => o.value === value);
  return (
    <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={inputCls}>
      {allowEmpty && <option value="">未設定</option>}
      {unknown && <option value={value}>(使えない値)</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}
```

```tsx
/** 金額の入力欄。右に読み取った金額を3桁区切りで出す(打ち間違いに気づけるように)。 */
export function YenInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const n = parseYen(value);
  return (
    <span className="flex items-center gap-2">
      <input inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className={inputCls} />
      <span className="shrink-0 text-xs tabular-nums text-gray-500">{value.trim() === "" ? "" : n === null ? "数字で入れてください" : `= ${yenText(n)}円`}</span>
    </span>
  );
}

/**
 * 自動計算だが手で直せる欄(設計 §3)。表示 = 上書き ?? 計算。上書きしたら印を付け、「計算に戻す」で消せる。
 */
export function OverrideField({
  label, computed, override, onChange,
}: { label: string; computed: number | null; override: number | undefined; onChange: (v: number | undefined) => void }) {
  const overridden = override !== undefined;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-xs font-medium text-gray-600 dark:text-gray-400">{label}</span>
        <span className="tabular-nums">計算: {computed === null ? "—" : `${yenText(computed)}円`}</span>
        {overridden && <span className="rounded bg-amber-100 px-1.5 text-xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">手で直した値</span>}
      </div>
      <div className="flex items-center gap-2">
        <input
          inputMode="numeric"
          value={overridden ? String(override) : ""}
          placeholder={computed === null ? "" : yenText(computed)}
          onChange={(e) => {
            const v = parseYen(e.target.value);
            onChange(e.target.value.trim() === "" || v === null ? undefined : v);
          }}
          aria-label={`${label}(手で直す)`}
          className={inputCls}
        />
        {overridden && (
          <Button variant="ghost" size="sm" onClick={() => onChange(undefined)}>
            <RotateCcw className="h-4 w-4" />
            計算に戻す
          </Button>
        )}
      </div>
    </div>
  );
}
```

form-parts.tsx の先頭の import に、次を足します。

```tsx
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { parseYen, yenText } from "@/lib/deals/money-forms";
```

- [ ] **Step 4: テストを走らせて、通ることを確かめる**

Run: `npx vitest run src/lib/deals`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add src/lib/deals src/components/deals/form-parts.tsx
git commit -m "feat(deals): 金額の入力部品・上書き欄・使えない値の表示"
```

---

### Task 8: 詳しい画面のタブを6つにし(M3)、金額・費用タブを作る

**Files:**
- Modify: `src/app/(dashboard)/deals/[id]/page.tsx`
- Create: `src/components/deals/deal-money-panel.tsx`
- Modify: `src/lib/deals/__tests__/detail-source.test.ts`

**Interfaces:**
- Consumes: `dealsApi.calc`、`DealCalc`、`OverrideField`、`YenInput`、`parseYen`、`percentTextToBp`、`bpToPercentText`
- Produces:
  - `DealMoneyPanel` の props: `{ deal: DealView; calc: DealCalc | null; onSaved: () => Promise<void> }`
  - 詳しい画面のタブ: 基本・物件・当事者・金額・費用・精算・OC(OC は hasOc のときだけ)
  - パネルは全部描いて、選んでいないタブは `hidden` にする。key はそのパネル自身のデータの JSON にする(M3)

- [ ] **Step 1: 失敗するテストを書く**

`detail-source.test.ts` の最初の it(タブの並び)を、次に差し替えます。下にも it を足します。

```ts
  it("タブは 基本・物件・当事者・金額・費用・精算・OC の順(OC はオーナーチェンジのときだけ)", () => {
    const src = read(PAGE);
    expect(src).toMatch(/\{ key: "basic", label: "基本" \},\s*\{ key: "property", label: "物件" \},\s*\{ key: "parties", label: "当事者" \},\s*\{ key: "money", label: "金額・費用" \},\s*\{ key: "settlement", label: "精算" \},\s*\{ key: "oc", label: "OC" \}/);
    expect(src).toMatch(/deal\.hasOc \|\| t\.key !== "oc"/);
    expect(src).toContain("<Tabs");
    expect(src).toContain("tabPanelProps(");
  });
  it("タブを切り替えても入力が消えない: 全部描いて hidden で隠す・key はそのパネルのデータ(M3)", () => {
    const src = read(PAGE);
    expect(src).toContain('hidden={tab !== "basic"}');
    expect(src).toContain('hidden={tab !== "money"}');
    expect(src).not.toContain("key={deal.version}");
  });
  it("金額・費用タブ: 売買価格・手付金・税率・手数料と建物価格の上書き・費用", () => {
    const src = read("src/components/deals/deal-money-panel.tsx");
    for (const s of ["売買価格", "手付金", "消費税率", "仲介手数料", "低廉な空家等の特例", "建物価格", "建物消費税", "印紙税", "司法書士", "登記費用", "抹消費用", "測量費", "VERSION_CONFLICT"]) {
      expect(src, s).toContain(s);
    }
    expect(src).toContain("<OverrideField");
  });
```

既存の it の `for (const p of PANELS) expect(read(p), p).toContain("VERSION_CONFLICT");` はそのまま残します。

- [ ] **Step 2: テストを走らせて、失敗することを確かめる**

Run: `npx vitest run src/lib/deals/__tests__/detail-source.test.ts`
Expected: FAIL

- [ ] **Step 3: 詳しい画面を直す**

`src/app/(dashboard)/deals/[id]/page.tsx` を、全体で次にします。

```tsx
"use client";

import { use, useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, tabPanelProps } from "@/components/ui/tabs";
import DealBasicPanel from "@/components/deals/deal-basic-panel";
import DealPropertyPanel from "@/components/deals/deal-property-panel";
import DealPartiesPanel from "@/components/deals/deal-parties-panel";
import DealMoneyPanel from "@/components/deals/deal-money-panel";
import DealSettlementPanel from "@/components/deals/deal-settlement-panel";
import DealOcPanel from "@/components/deals/deal-oc-panel";
import { dealsApi, errorText, type DealOptions, type UserOption } from "@/lib/deals/client";
import type { DealView } from "@/lib/deals/view";
import type { DealCalc } from "@/lib/deals/calc/deal-calc";
import { basicFormFromDeal } from "@/lib/deals/forms";
import { DEAL_BUSINESS_TYPE_LABELS, DEAL_STATUS_LABELS } from "@/lib/deals/constants";

// 段5で「書類」を足す(設計 §5)。
const DEAL_TABS = [
  { key: "basic", label: "基本" },
  { key: "property", label: "物件" },
  { key: "parties", label: "当事者" },
  { key: "money", label: "金額・費用" },
  { key: "settlement", label: "精算" },
  { key: "oc", label: "OC" },
] as const;
type DealTabKey = (typeof DEAL_TABS)[number]["key"];

/**
 * 取引の詳しい画面。パネルは全部描いて、選んでいないタブは hidden で隠す(タブを替えても入力が消えない・M3)。
 * 各パネルの key は「そのパネルが表すデータ」の JSON。ほかのパネルの保存で版が変わっても作り直さない=打ちかけが残る。
 */
export default function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<{ deal: DealView; canOpenProperty: boolean } | null>(null);
  const [calc, setCalc] = useState<DealCalc | null>(null);
  const [options, setOptions] = useState<DealOptions | null>(null);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [tab, setTab] = useState<DealTabKey>("basic");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [d, c] = await Promise.all([dealsApi.get(id), dealsApi.calc(id)]);
      setData(d);
      setCalc(c.calc);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [id]);

  useEffect(() => {
    dealsApi.get(id).then(setData).catch((e) => setError(errorText(e)));
    dealsApi.calc(id).then((c) => setCalc(c.calc)).catch(() => {});
    dealsApi.options().then(setOptions).catch(() => {});
    dealsApi.users().then((r) => setUsers(r.data)).catch(() => {});
  }, [id]);

  if (!data) {
    return error ? (
      <p className="p-6 text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>
    ) : (
      <div className="flex items-center gap-2 p-6 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…</div>
    );
  }
  const { deal } = data;
  const tabs = DEAL_TABS.filter((t) => deal.hasOc || t.key !== "oc");
  const active: DealTabKey = tabs.some((t) => t.key === tab) ? tab : "basic";
  const k = (v: unknown) => JSON.stringify(v);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title={deal.name}
        back={{ href: "/deals", to: "取引" }}
        description={`${deal.dealNo} ・ ${DEAL_BUSINESS_TYPE_LABELS[deal.businessType as keyof typeof DEAL_BUSINESS_TYPE_LABELS] ?? deal.businessType} ・ ${DEAL_STATUS_LABELS[deal.status as keyof typeof DEAL_STATUS_LABELS] ?? deal.status}`}
      />
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      <Tabs tabs={tabs} active={active} onChange={setTab} idBase="deal-detail" />
      <div {...tabPanelProps("deal-detail", active)}>
        <div hidden={tab !== "basic"}>
          <DealBasicPanel key={k(basicFormFromDeal(deal))} deal={deal} users={users} kinds={options?.propertyKinds ?? []} onSaved={reload} />
        </div>
        <div hidden={tab !== "property"}>
          <DealPropertyPanel key={k([deal.propertySnapshot, deal.assessments])} deal={deal} canOpenProperty={data.canOpenProperty} onSaved={reload} />
        </div>
        <div hidden={tab !== "parties"}>
          <DealPartiesPanel deal={deal} selfParty={options?.selfParty ?? null} onSaved={reload} />
        </div>
        <div hidden={tab !== "money"}>
          <DealMoneyPanel key={k([deal.price, deal.deposit, deal.taxRateBp, deal.costs, deal.overrides])} deal={deal} calc={calc} onSaved={reload} />
        </div>
        <div hidden={tab !== "settlement"}>
          <DealSettlementPanel key={k([deal.settlementTerms, deal.overrides])} deal={deal} calc={calc} onSaved={reload} />
        </div>
        {deal.hasOc && (
          <div hidden={tab !== "oc"}>
            <DealOcPanel key={k([deal.leases, deal.settlementTerms.depositMode])} deal={deal} calc={calc} onSaved={reload} />
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 金額・費用タブを作る**

```tsx
// src/components/deals/deal-money-panel.tsx
"use client";

import { useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, OverrideField, YenInput, inputCls } from "./form-parts";
import { dealsApi, DealApiError, errorText } from "@/lib/deals/client";
import { bpToPercentText, parseYen, percentTextToBp, yenText } from "@/lib/deals/money-forms";
import type { DealView } from "@/lib/deals/view";
import type { DealCalc } from "@/lib/deals/calc/deal-calc";
import type { Costs, Overrides } from "@/lib/deals/schemas";

const conflictText = (e: unknown) =>
  e instanceof DealApiError && e.code === "VERSION_CONFLICT"
    ? "ほかの人が先に更新しました。画面を読み込み直してから、もう一度入力してください。"
    : errorText(e);
const s = (n: number | null) => (n === null ? "" : String(n));

/** 金額・費用(設計 §5)。計算の値は保存したあとの計算結果(サーバー)を出す。 */
export default function DealMoneyPanel({ deal, calc, onSaved }: { deal: DealView; calc: DealCalc | null; onSaved: () => Promise<void> }) {
  const [price, setPrice] = useState(s(deal.price));
  const [deposit, setDeposit] = useState(s(deal.deposit));
  const [taxRate, setTaxRate] = useState(bpToPercentText(deal.taxRateBp));
  const [costs, setCosts] = useState<Costs>(deal.costs);
  const [fees, setFees] = useState({ registrationFee: s(deal.costs.registrationFee), cancellationFee: s(deal.costs.cancellationFee), surveyFee: s(deal.costs.surveyFee) });
  const [overrides, setOverrides] = useState<Overrides>(deal.overrides);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setOverride = (key: keyof Overrides, v: number | undefined) =>
    setOverrides((o) => {
      const next = { ...o };
      if (v === undefined) delete next[key];
      else next[key] = v;
      return next;
    });
  const scr = (k: keyof Costs["scrivener"], v: string) => setCosts((c) => ({ ...c, scrivener: { ...c.scrivener, [k]: v.trim() === "" ? null : v } }));

  const save = async () => {
    const taxRateBp = percentTextToBp(taxRate);
    if (taxRateBp === null) {
      setError("消費税率は数字で入れてください(例 10)");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await dealsApi.update(deal.id, {
        version: deal.version,
        price: parseYen(price), deposit: parseYen(deposit), taxRateBp,
        costs: {
          ...costs,
          registrationFee: parseYen(fees.registrationFee), cancellationFee: parseYen(fees.cancellationFee), surveyFee: parseYen(fees.surveyFee),
          others: costs.others.filter((o) => o.label.trim() !== ""),
        },
        overrides,
      });
      await onSaved();
    } catch (e) {
      setError(conflictText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      {calc && calc.missing.length > 0 && (
        <p className="text-xs text-gray-500">計算に足りない項目: {calc.missing.join("・")}</p>
      )}

      <section className="grid gap-4 sm:grid-cols-3">
        <Field label="売買価格(税込)"><YenInput label="売買価格" value={price} onChange={setPrice} /></Field>
        <Field label="手付金"><YenInput label="手付金" value={deposit} onChange={setDeposit} /></Field>
        <Field label="消費税率(%)">
          <input inputMode="decimal" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} aria-label="消費税率" className={inputCls} />
        </Field>
        <p className="text-sm sm:col-span-3">残代金(売買価格−手付金): <b className="tabular-nums">{calc?.settlement.remaining === null || calc === null ? "—" : `${yenText(calc.settlement.remaining)}円`}</b></p>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">仲介手数料(上限・税抜)</h3>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={costs.lowCostSpecial} onChange={(e) => setCosts((c) => ({ ...c, lowCostSpecial: e.target.checked }))} />
          低廉な空家等の特例(800万円以下は上限30万円＋税)
        </label>
        <OverrideField label="仲介手数料" computed={calc?.brokerage?.computedExcl ?? null} override={overrides.brokerageFee} onChange={(v) => setOverride("brokerageFee", v)} />
        <p className="text-sm">税込: <b className="tabular-nums">{calc?.brokerage ? `${yenText(calc.brokerage.incl)}円` : "—"}</b></p>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">建物価格と建物消費税(自社が売主のとき)</h3>
        <p className="text-xs text-gray-500">評価額は「物件」タブで入れます。契約書で建物価格を決めているときは、手で直してください。</p>
        <OverrideField label="建物価格(税込)" computed={calc?.building.computedPrice ?? null} override={overrides.buildingPrice} onChange={(v) => setOverride("buildingPrice", v)} />
        <OverrideField label="建物消費税" computed={calc?.building.computedTax ?? null} override={overrides.buildingTax} onChange={(v) => setOverride("buildingTax", v)} />
      </section>

      <p className="text-sm">売買契約書の印紙税(1通): <b className="tabular-nums">{calc?.contractStamp === null || calc === null ? "—" : `${yenText(calc.contractStamp)}円`}</b></p>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">司法書士・費用</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="司法書士(名前)"><input value={costs.scrivener.name ?? ""} onChange={(e) => scr("name", e.target.value)} maxLength={100} aria-label="司法書士の名前" className={inputCls} /></Field>
          <Field label="司法書士(担当)"><input value={costs.scrivener.staff ?? ""} onChange={(e) => scr("staff", e.target.value)} maxLength={100} aria-label="司法書士の担当" className={inputCls} /></Field>
          <Field label="司法書士(住所)"><input value={costs.scrivener.address ?? ""} onChange={(e) => scr("address", e.target.value)} maxLength={300} aria-label="司法書士の住所" className={inputCls} /></Field>
          <Field label="司法書士(電話)"><input value={costs.scrivener.tel ?? ""} onChange={(e) => scr("tel", e.target.value)} maxLength={50} aria-label="司法書士の電話" className={inputCls} /></Field>
          <Field label="登記費用"><YenInput label="登記費用" value={fees.registrationFee} onChange={(v) => setFees((f) => ({ ...f, registrationFee: v }))} /></Field>
          <Field label="抹消費用"><YenInput label="抹消費用" value={fees.cancellationFee} onChange={(v) => setFees((f) => ({ ...f, cancellationFee: v }))} /></Field>
          <Field label="測量費"><YenInput label="測量費" value={fees.surveyFee} onChange={(v) => setFees((f) => ({ ...f, surveyFee: v }))} /></Field>
        </div>
        <ul className="space-y-2">
          {costs.others.map((o, i) => (
            <li key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <Field label="その他の費用(名前)">
                <input value={o.label} onChange={(e) => setCosts((c) => ({ ...c, others: c.others.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) }))} maxLength={50} aria-label="その他の費用の名前" className={inputCls} />
              </Field>
              <Field label="金額">
                <YenInput label="その他の費用の金額" value={String(o.amount)} onChange={(v) => setCosts((c) => ({ ...c, others: c.others.map((x, j) => (j === i ? { ...x, amount: parseYen(v) ?? 0 } : x)) }))} />
              </Field>
              <Button variant="ghost" size="sm" onClick={() => setCosts((c) => ({ ...c, others: c.others.filter((_, j) => j !== i) }))}>
                <Trash2 className="h-4 w-4" />
                消す
              </Button>
            </li>
          ))}
        </ul>
        <Button variant="secondary" size="sm" disabled={costs.others.length >= 20} onClick={() => setCosts((c) => ({ ...c, others: [...c.others, { label: "", amount: 0 }] }))}>
          <Plus className="h-4 w-4" />
          その他の費用を足す
        </Button>
      </section>

      <Button onClick={() => void save()} disabled={saving} loading={saving} loadingLabel="保存中">
        <Save className="h-4 w-4" />
        保存
      </Button>
    </div>
  );
}
```

段1のパネル(基本・物件)の key は、親が持つようになりました。

- [ ] **Step 5: テスト・型を走らせる**

この Task では、精算と OC のパネルはまだありません。そのため、tsc は Task 9 のあとで通します。先にテストだけ走らせます。

```bash
npx vitest run src/lib/deals/__tests__/detail-source.test.ts
```
Expected: 「金額・費用」と M3 の it は PASS

- [ ] **Step 6: コミットする(Task 9 と合わせて型が通る)**

```bash
git add "src/app/(dashboard)/deals/[id]/page.tsx" src/components/deals/deal-money-panel.tsx src/lib/deals/__tests__/detail-source.test.ts
git commit -m "feat(deals): 金額・費用タブ・タブを替えても入力が消えない"
```

---

### Task 9: 精算タブと OC タブ

**Files:**
- Create: `src/components/deals/deal-settlement-panel.tsx`, `src/components/deals/deal-oc-panel.tsx`
- Modify: `src/lib/deals/__tests__/detail-source.test.ts`

**Interfaces:**
- Consumes: `SettlementTerms`、`Lease`、`DealCalc.settlement`、`OverrideField`、`YenInput`
- Produces:
  - `DealSettlementPanel` の props: `{ deal; calc; onSaved }`
  - `DealOcPanel` の props: `{ deal; calc; onSaved }`

- [ ] **Step 1: 失敗するテストを書く**

`detail-source.test.ts` に、次を足します。

```ts
  it("精算タブ: 条件の入力・結果の表(計算期間・計算式・売主→買主・買主→売主)・差引の1行・お支払額・上書き", () => {
    const src = read("src/components/deals/deal-settlement-panel.tsx");
    for (const s of ["固定資産税", "都市計画税", "起算日", "管理費", "修繕積立金", "前払い", "計算期間", "計算式", "売主→買主", "買主→売主", "netLine", "決済時のお支払額", "VERSION_CONFLICT", "<OverrideField"]) {
      expect(src, s).toContain(s);
    }
    expect(src).toMatch(/kindBase === "unit"/);
  });
  it("OC タブ: 部屋ごとの賃貸条件・敷金の相殺/別途", () => {
    const src = read("src/components/deals/deal-oc-panel.tsx");
    for (const s of ["部屋番号", "賃借人", "普通借家", "定期借家", "賃料", "共益費", "駐車場代", "預り敷金", "滞納", "管理会社", "残代金と相殺", "別途授受", "VERSION_CONFLICT"]) {
      expect(src, s).toContain(s);
    }
  });
```

- [ ] **Step 2: テストを走らせて、失敗することを確かめる**

Run: `npx vitest run src/lib/deals/__tests__/detail-source.test.ts`
Expected: FAIL

- [ ] **Step 3: 精算タブを作る**

```tsx
// src/components/deals/deal-settlement-panel.tsx
"use client";

import { useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, OverrideField, SelectBox, YenInput, inputCls } from "./form-parts";
import { dealsApi, DealApiError, errorText } from "@/lib/deals/client";
import { parseYen, yenText } from "@/lib/deals/money-forms";
import type { DealView } from "@/lib/deals/view";
import type { DealCalc } from "@/lib/deals/calc/deal-calc";
import type { Overrides, SettlementTerms } from "@/lib/deals/schemas";

const conflictText = (e: unknown) =>
  e instanceof DealApiError && e.code === "VERSION_CONFLICT"
    ? "ほかの人が先に更新しました。画面を読み込み直してから、もう一度入力してください。"
    : errorText(e);
const s = (n: number | null) => (n === null ? "" : String(n));
const MONEY_KEYS = ["fixedAssetTax", "cityPlanningTax", "managementFee", "repairReserve", "otherMonthly"] as const;
type MoneyKey = (typeof MONEY_KEYS)[number];

/** 精算(依頼書 3.2・4.4)。条件を入れて保存すると、サーバーの決済の計算の結果を表で出す。 */
export default function DealSettlementPanel({ deal, calc, onSaved }: { deal: DealView; calc: DealCalc | null; onSaved: () => Promise<void> }) {
  const [terms, setTerms] = useState<SettlementTerms>(deal.settlementTerms);
  const [money, setMoney] = useState<Record<MoneyKey, string>>(
    Object.fromEntries(MONEY_KEYS.map((k) => [k, s(deal.settlementTerms[k])])) as Record<MoneyKey, string>,
  );
  const [overrides, setOverrides] = useState<Overrides>(deal.overrides);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kindBase = calc?.kindBase ?? null;
  const st = calc?.settlement ?? null;
  const setOverride = (key: keyof Overrides, v: number | undefined) =>
    setOverrides((o) => {
      const next = { ...o };
      if (v === undefined) delete next[key];
      else next[key] = v;
      return next;
    });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next: SettlementTerms = {
        ...terms,
        ...(Object.fromEntries(MONEY_KEYS.map((k) => [k, parseYen(money[k])])) as Record<MoneyKey, number | null>),
        others: terms.others.filter((o) => o.label.trim() !== ""),
      };
      await dealsApi.update(deal.id, { version: deal.version, settlementTerms: next, overrides });
      await onSaved();
    } catch (e) {
      setError(conflictText(e));
    } finally {
      setSaving(false);
    }
  };

  const months = (label: string, value: number, onChange: (n: number) => void) => (
    <Field label={label}>
      <SelectBox label={label} value={String(value)} onChange={(v) => onChange(Number(v))} options={Array.from({ length: 13 }, (_, i) => ({ value: String(i), label: `${i}か月` }))} />
    </Field>
  );

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">固定資産税・都市計画税</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="固定資産税(年税額)"><YenInput label="固定資産税" value={money.fixedAssetTax} onChange={(v) => setMoney((m) => ({ ...m, fixedAssetTax: v }))} /></Field>
          <Field label="都市計画税(年税額)"><YenInput label="都市計画税" value={money.cityPlanningTax} onChange={(v) => setMoney((m) => ({ ...m, cityPlanningTax: v }))} /></Field>
          <Field label="起算日">
            <SelectBox label="起算日" value={terms.taxStart} onChange={(v) => setTerms((t) => ({ ...t, taxStart: v as SettlementTerms["taxStart"] }))} options={[{ value: "01-01", label: "1月1日" }, { value: "04-01", label: "4月1日" }]} />
          </Field>
        </div>
      </section>

      {kindBase === "unit" && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">管理費等(月額)</h3>
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="管理費"><YenInput label="管理費" value={money.managementFee} onChange={(v) => setMoney((m) => ({ ...m, managementFee: v }))} /></Field>
            <Field label="修繕積立金"><YenInput label="修繕積立金" value={money.repairReserve} onChange={(v) => setMoney((m) => ({ ...m, repairReserve: v }))} /></Field>
            <Field label="その他(月額)"><YenInput label="その他の月額" value={money.otherMonthly} onChange={(v) => setMoney((m) => ({ ...m, otherMonthly: v }))} /></Field>
            {months("前払い月数", terms.managementPrepaidMonths, (n) => setTerms((t) => ({ ...t, managementPrepaidMonths: n })))}
          </div>
        </section>
      )}

      {deal.hasOc && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">賃料(OC)</h3>
          <p className="text-xs text-gray-500">部屋ごとの賃料は「OC」タブで入れます。</p>
          <div className="grid gap-4 sm:grid-cols-3">{months("前受け済みの月数", terms.rentPrepaidMonths, (n) => setTerms((t) => ({ ...t, rentPrepaidMonths: n })))}</div>
        </section>
      )}

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">その他の精算(測量費の負担分など)</h3>
        <ul className="space-y-2">
          {terms.others.map((o, i) => (
            <li key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
              <Field label="項目"><input value={o.label} onChange={(e) => setTerms((t) => ({ ...t, others: t.others.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) }))} maxLength={50} aria-label="精算の項目" className={inputCls} /></Field>
              <Field label="売主→買主"><YenInput label="売主→買主" value={String(o.sellerToBuyer)} onChange={(v) => setTerms((t) => ({ ...t, others: t.others.map((x, j) => (j === i ? { ...x, sellerToBuyer: parseYen(v) ?? 0 } : x)) }))} /></Field>
              <Field label="買主→売主"><YenInput label="買主→売主" value={String(o.buyerToSeller)} onChange={(v) => setTerms((t) => ({ ...t, others: t.others.map((x, j) => (j === i ? { ...x, buyerToSeller: parseYen(v) ?? 0 } : x)) }))} /></Field>
              <Button variant="ghost" size="sm" onClick={() => setTerms((t) => ({ ...t, others: t.others.filter((_, j) => j !== i) }))}><Trash2 className="h-4 w-4" />消す</Button>
            </li>
          ))}
        </ul>
        <Button variant="secondary" size="sm" disabled={terms.others.length >= 20} onClick={() => setTerms((t) => ({ ...t, others: [...t.others, { label: "", sellerToBuyer: 0, buyerToSeller: 0 }] }))}>
          <Plus className="h-4 w-4" />
          精算の行を足す
        </Button>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">手で直す(計算の値を変えるときだけ)</h3>
        <OverrideField label="固都税(買主→売主)" computed={st?.rows.find((r) => r.key === "propertyTax")?.computed ?? null} override={overrides["settlement.propertyTax"]} onChange={(v) => setOverride("settlement.propertyTax", v)} />
        {kindBase === "unit" && (
          <OverrideField label="管理費等(買主→売主)" computed={st?.rows.find((r) => r.key === "management")?.computed ?? null} override={overrides["settlement.management"]} onChange={(v) => setOverride("settlement.management", v)} />
        )}
        {deal.hasOc && (
          <OverrideField label="賃料等(売主→買主)" computed={st?.rows.find((r) => r.key === "rent")?.computed ?? null} override={overrides["settlement.rent"]} onChange={(v) => setOverride("settlement.rent", v)} />
        )}
      </section>

      <Button onClick={() => void save()} disabled={saving} loading={saving} loadingLabel="保存中">
        <Save className="h-4 w-4" />
        保存して計算する
      </Button>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">決済の計算(保存した内容で計算)</h3>
        {!st ? (
          <p className="text-sm text-gray-500">計算を読み込んでいます…</p>
        ) : !st.ready ? (
          <p className="text-sm text-gray-500">{st.missing.join("・")}を入れてください(「基本」タブ)。</p>
        ) : (
          <>
            {st.warnings.map((w) => <p key={w} className="text-sm text-amber-700 dark:text-amber-300">{w}</p>)}
            <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                  <tr><th className="px-3 py-2">項目</th><th className="px-3 py-2">計算期間</th><th className="px-3 py-2">計算式</th><th className="px-3 py-2 text-right">売主→買主</th><th className="px-3 py-2 text-right">買主→売主</th></tr>
                </thead>
                <tbody>
                  {[...st.rows, ...(st.depositRow ? [st.depositRow] : [])].map((r) => (
                    <tr key={r.key} className="border-t border-gray-100 dark:border-gray-800">
                      <td className="px-3 py-2">{r.label}{r.overridden && <span className="ml-1 text-xs text-amber-700">(手で直した値)</span>}{r.note && <span className="ml-1 text-xs text-gray-500">({r.note})</span>}</td>
                      <td className="px-3 py-2 tabular-nums">{r.period ?? ""}</td>
                      <td className="px-3 py-2 tabular-nums">{r.formula ?? ""}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.sellerToBuyer ? yenText(r.sellerToBuyer) : ""}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.buyerToSeller ? yenText(r.buyerToSeller) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-sm font-semibold">{st.netLine}</p>
            {st.remaining !== null && st.paymentAtSettlement !== null && (
              <p className="text-sm tabular-nums">
                残代金 {yenText(st.remaining)}円 ＋ 精算金 {st.net.direction === "sellerToBuyer" ? "−" : ""}{yenText(st.net.amount)}円
                {st.depositOffset > 0 && <> − 敷金承継 {yenText(st.depositOffset)}円</>} ＝ 決済時のお支払額 <b>{yenText(st.paymentAtSettlement)}円</b>
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 4: OC タブを作る**

```tsx
// src/components/deals/deal-oc-panel.tsx
"use client";

import { useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, SelectBox, YenInput, inputCls } from "./form-parts";
import { dealsApi, DealApiError, errorText } from "@/lib/deals/client";
import { parseYen, yenText } from "@/lib/deals/money-forms";
import type { DealView } from "@/lib/deals/view";
import type { DealCalc } from "@/lib/deals/calc/deal-calc";
import type { Lease, SettlementTerms } from "@/lib/deals/schemas";

const conflictText = (e: unknown) =>
  e instanceof DealApiError && e.code === "VERSION_CONFLICT"
    ? "ほかの人が先に更新しました。画面を読み込み直してから、もう一度入力してください。"
    : errorText(e);
const EMPTY_LEASE: Lease = {
  room: null, tenant: null, contractType: "ordinary", period: null, rent: 0, commonFee: 0, parking: 0, other: 0,
  deposit: 0, arrears: false, arrearsAmount: 0, manager: null,
};
const MONEY: [keyof Lease, string][] = [["rent", "賃料"], ["commonFee", "共益費"], ["parking", "駐車場代"], ["other", "その他"], ["deposit", "預り敷金(保証金)"]];

/** OC(オーナーチェンジ)の賃貸条件。一棟なら部屋ごとに複数行。 */
export default function DealOcPanel({ deal, calc, onSaved }: { deal: DealView; calc: DealCalc | null; onSaved: () => Promise<void> }) {
  const [leases, setLeases] = useState<Lease[]>(deal.leases);
  const [depositMode, setDepositMode] = useState<SettlementTerms["depositMode"]>(deal.settlementTerms.depositMode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (i: number, patch: Partial<Lease>) => setLeases((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const txt = (v: string) => (v.trim() === "" ? null : v);
  const monthly = leases.reduce((a, l) => a + l.rent + l.commonFee + l.parking + l.other, 0);
  const deposits = leases.reduce((a, l) => a + l.deposit, 0);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await dealsApi.update(deal.id, { version: deal.version, leases, settlementTerms: { ...deal.settlementTerms, depositMode } });
      await onSaved();
    } catch (e) {
      setError(conflictText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      <p className="text-sm tabular-nums">月額の合計 {yenText(monthly)}円 ・ 預り敷金の合計 {yenText(deposits)}円 ・ 精算: {calc?.settlement.depositRow?.note ?? "—"}</p>
      <Field label="敷金の扱い">
        <SelectBox label="敷金の扱い" value={depositMode} onChange={(v) => setDepositMode(v as SettlementTerms["depositMode"])} options={[{ value: "offset", label: "残代金と相殺" }, { value: "separate", label: "別途授受" }]} />
      </Field>
      {leases.map((l, i) => (
        <div key={i} className="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-800">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="部屋番号"><input value={l.room ?? ""} onChange={(e) => set(i, { room: txt(e.target.value) })} maxLength={30} aria-label="部屋番号" className={inputCls} /></Field>
            <Field label="賃借人"><input value={l.tenant ?? ""} onChange={(e) => set(i, { tenant: txt(e.target.value) })} maxLength={100} aria-label="賃借人" className={inputCls} /></Field>
            <Field label="契約形態">
              <SelectBox label="契約形態" value={l.contractType} onChange={(v) => set(i, { contractType: v as Lease["contractType"] })} options={[{ value: "ordinary", label: "普通借家" }, { value: "fixed_term", label: "定期借家" }]} />
            </Field>
            <Field label="契約期間"><input value={l.period ?? ""} onChange={(e) => set(i, { period: txt(e.target.value) })} maxLength={100} aria-label="契約期間" className={inputCls} /></Field>
            {MONEY.map(([k, label]) => (
              <Field key={k} label={label}><YenInput label={label} value={String(l[k])} onChange={(v) => set(i, { [k]: parseYen(v) ?? 0 } as Partial<Lease>)} /></Field>
            ))}
            <Field label="管理会社"><input value={l.manager ?? ""} onChange={(e) => set(i, { manager: txt(e.target.value) })} maxLength={100} aria-label="管理会社" className={inputCls} /></Field>
            <label className="flex items-end gap-2 pb-2 text-sm">
              <input type="checkbox" checked={l.arrears} onChange={(e) => set(i, { arrears: e.target.checked })} />
              滞納あり
            </label>
            {l.arrears && <Field label="滞納の金額"><YenInput label="滞納の金額" value={String(l.arrearsAmount)} onChange={(v) => set(i, { arrearsAmount: parseYen(v) ?? 0 })} /></Field>}
          </div>
          <Button variant="ghost" size="sm" onClick={() => setLeases((ls) => ls.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" />この部屋を消す</Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" disabled={leases.length >= 200} onClick={() => setLeases((ls) => [...ls, EMPTY_LEASE])}>
          <Plus className="h-4 w-4" />
          部屋を足す
        </Button>
        <Button onClick={() => void save()} disabled={saving} loading={saving} loadingLabel="保存中">
          <Save className="h-4 w-4" />
          保存
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: テスト・型・lint を走らせる**

```bash
npx vitest run src/lib/deals > /tmp/d2-t9.log 2>&1; echo exit=$?; grep -E "×|Tests " /tmp/d2-t9.log | head
npx tsc --noEmit 2>&1 | head
npx eslint src/components/deals "src/app/(dashboard)/deals"; echo lint=$?
```
Expected: `exit=0`、tsc の出力なし、`lint=0`

- [ ] **Step 6: コミットする**

```bash
git add src/components/deals src/lib/deals
git commit -m "feat(deals): 精算タブ(条件・決済の計算の表・お支払額)と OC タブ(賃貸条件・敷金)"
```

---

### Task 10: 物件タブの評価額と、後回しにした小さな点 M4

**Files:**
- Create: `src/components/deals/assessments-editor.tsx`
- Modify: `src/components/deals/deal-property-panel.tsx`
  - 評価額の欄を足す
  - 保存に `assessments` を含める
  - 「物件から取り直す」は `canOpenProperty` のときだけ出す(M4)
- Modify: `src/lib/deals/__tests__/detail-source.test.ts`

**Interfaces:**
- Produces:
  - `AssessmentsEditor({ value: Assessments, onChange(v: Assessments) })`
  - 行は 家屋評価額・土地評価額・持分(分子/分母)。下に「土地の割合(%)」を置く

- [ ] **Step 1: 失敗するテストを書く**

`detail-source.test.ts` に、次を足します。

```ts
  it("物件タブ: 評価額(筆ごと・持分・土地の割合)を入れて一緒に保存する", () => {
    const src = read(PANELS[1]);
    expect(src).toContain("<AssessmentsEditor");
    expect(src).toMatch(/assessments,/);
    const ed = read("src/components/deals/assessments-editor.tsx");
    for (const s of ["家屋評価額", "土地評価額", "持分", "土地の割合"]) expect(ed, s).toContain(s);
  });
  it("「物件から取り直す」は物件を見られる人にだけ出す(M4)", () => {
    expect(read(PANELS[1])).toMatch(/\{canOpenProperty && \(\s*<>[\s\S]*物件から取り直す/);
  });
```

- [ ] **Step 2: テストを走らせて、失敗することを確かめる**

Run: `npx vitest run src/lib/deals/__tests__/detail-source.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

```tsx
// src/components/deals/assessments-editor.tsx
"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, YenInput, inputCls } from "./form-parts";
import { bpToPercentText, parseYen, percentTextToBp } from "@/lib/deals/money-forms";
import type { Assessments } from "@/lib/deals/schemas";

/** 固都税の評価額(筆ごと・持分つき)。建物消費税の按分に使う(依頼書 3.4)。 */
export function AssessmentsEditor({ value, onChange }: { value: Assessments; onChange: (v: Assessments) => void }) {
  const setRow = (i: number, patch: Partial<Assessments["rows"][number]>) =>
    onChange({ ...value, rows: value.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">固都税の評価額(筆ごと)</h3>
      <ul className="space-y-2">
        {value.rows.map((r, i) => (
          <li key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_5rem_5rem_auto]">
            <Field label="家屋評価額"><YenInput label="家屋評価額" value={String(r.building)} onChange={(v) => setRow(i, { building: parseYen(v) ?? 0 })} /></Field>
            <Field label="土地評価額"><YenInput label="土地評価額" value={String(r.land)} onChange={(v) => setRow(i, { land: parseYen(v) ?? 0 })} /></Field>
            <Field label="持分(分子)"><input inputMode="numeric" value={r.shareNum} onChange={(e) => setRow(i, { shareNum: Math.max(1, parseYen(e.target.value) ?? 1) })} aria-label="持分(分子)" className={inputCls} /></Field>
            <Field label="持分(分母)"><input inputMode="numeric" value={r.shareDen} onChange={(e) => setRow(i, { shareDen: Math.max(1, parseYen(e.target.value) ?? 1) })} aria-label="持分(分母)" className={inputCls} /></Field>
            <Button variant="ghost" size="sm" onClick={() => onChange({ ...value, rows: value.rows.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" />消す</Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-3">
        <Button variant="secondary" size="sm" disabled={value.rows.length >= 50} onClick={() => onChange({ ...value, rows: [...value.rows, { building: 0, land: 0, shareNum: 1, shareDen: 1 }] })}>
          <Plus className="h-4 w-4" />
          筆を足す
        </Button>
        <Field label="土地の割合(%)" hint="借地権などのとき。ふつうは100">
          <input
            inputMode="decimal"
            defaultValue={bpToPercentText(value.landRatioBp)}
            onBlur={(e) => {
              const bp = percentTextToBp(e.target.value);
              if (bp !== null && bp <= 10000) onChange({ ...value, landRatioBp: bp });
              else e.target.value = bpToPercentText(value.landRatioBp);
            }}
            aria-label="土地の割合"
            className={inputCls}
          />
        </Field>
      </div>
    </section>
  );
}
```

`deal-property-panel.tsx` は、次のように直します。

- import に `import { AssessmentsEditor } from "./assessments-editor";` と、`import type { Assessments } from "@/lib/deals/schemas";` を足します。
- state に `const [assessments, setAssessments] = useState<Assessments>(deal.assessments);` を足します。
- `dirty` を次にします。

```tsx
  const dirty =
    JSON.stringify(snapshotFromForm(form)) !== JSON.stringify(deal.propertySnapshot) ||
    JSON.stringify(assessments) !== JSON.stringify(deal.assessments);
```

- 保存の呼び出しを、`dealsApi.update(deal.id, { version: deal.version, propertySnapshot: snapshotFromForm(form), assessments, })` にします。
- 土地の権利の Field の下(grid の外)、保存ボタンの直前に `<AssessmentsEditor value={assessments} onChange={setAssessments} />` を置きます。
- 物件の行(M4)は、次にします。

```tsx
          {canOpenProperty && (
            <>
              <Link href={`/properties/${deal.propertyId}`} className="text-indigo-700 hover:underline dark:text-indigo-400">物件を開く</Link>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
                <RefreshCw className="h-4 w-4" />
                物件から取り直す
              </Button>
            </>
          )}
```

- 既存のテスト `"物件から取り直す前に確かめる・物件を開くリンクは見られる人だけ"` の `toContain("canOpenProperty &&")` は、そのまま通ります。

- [ ] **Step 4: テスト・型・lint を走らせる**

```bash
npx vitest run src/lib/deals > /tmp/d2-t10.log 2>&1; echo exit=$?; grep -E "×|Tests " /tmp/d2-t10.log | head
npx tsc --noEmit 2>&1 | head
npx eslint src/components/deals; echo lint=$?
```
Expected: `exit=0`、tsc の出力なし、`lint=0`

- [ ] **Step 5: コミットする**

```bash
git add src/components/deals src/lib/deals
git commit -m "feat(deals): 物件タブに固都税の評価額・取り直しは物件を見られる人だけ"
```

---

### Task 11: 取引の設定で税率の表を直せるようにし、基本4種別の元の種別を固定する(M1)

**Files:**
- Create: `src/components/deals/rate-table-editor.tsx`
- Modify: `src/app/(dashboard)/admin/deal-settings/page.tsx`
- Modify: `src/lib/deals/__tests__/settings-page-source.test.ts`

**Interfaces:**
- Consumes:
  - `dealsApi.rateTables` / `createRateTable` / `updateRateTable` / `deleteRateTable`
  - `RATE_TABLE_KINDS`、`RATE_TABLE_KIND_LABELS`
- Produces:
  - `RateTableEditor({ table: RateTableView | null(新規), kind, onDone(): void, onCancel(): void })`
  - 種類ごとの入力:
    - 消費税: 率(%)
    - 仲介手数料: 段(上限・率)+特例
    - 印紙税: 区分(上限・税額)
    - 譲渡所得: 各率と年数・控除

- [ ] **Step 1: 失敗するテストを書く**

`settings-page-source.test.ts` に、次を足します。

```ts
  it("税率の表を直せる: 直す・期間を足す・消す(確認つき)", () => {
    const src = read(PAGE);
    expect(src).toContain("<RateTableEditor");
    expect(src).toContain("期間を足す");
    expect(src).toContain("<ConfirmDialog");
    expect(src).not.toContain("表を直す画面は、計算を入れるときに足します");
    const ed = read("src/components/deals/rate-table-editor.tsx");
    for (const s of ["適用開始", "適用終了", "上限なし", "VERSION_CONFLICT", "PERIOD_OVERLAP"]) expect(ed, s).toContain(s);
  });
  it("基本の4種別は元の種別も変えられない(M1)", () => {
    expect(read(PAGE)).toMatch(/label="元の種別"[^>]*disabled=\{isBase\}/);
  });
```

- [ ] **Step 2: テストを走らせて、失敗することを確かめる**

Run: `npx vitest run src/lib/deals/__tests__/settings-page-source.test.ts`
Expected: FAIL

- [ ] **Step 3: 税率の表の編集部品を作る**

```tsx
// src/components/deals/rate-table-editor.tsx
"use client";

import { useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, inputCls } from "./form-parts";
import { dealsApi, DealApiError, errorText, type RateTableView } from "@/lib/deals/client";
import { bpToPercentText, parseYen, percentTextToBp } from "@/lib/deals/money-forms";
import { RATE_TABLE_KIND_LABELS, type RateTableKind } from "@/lib/deals/rate-tables";

type Row = { upTo: string; value: string };

/**
 * 税率・税額の表を1つ直す・足す(設計 §2.5)。中身は種類ごとの入力欄で直し、送る前に数に直す。
 * 検証(区分の並び・期間の重なり)はサーバーが行い、理由を出す。
 */
export function RateTableEditor({
  table, kind, onDone, onCancel,
}: { table: RateTableView | null; kind: RateTableKind; onDone: () => void; onCancel: () => void }) {
  const c = (table?.content ?? {}) as Record<string, unknown>;
  const [validFrom, setValidFrom] = useState(table?.validFrom ?? "");
  const [validTo, setValidTo] = useState(table?.validTo ?? "");
  const [rate, setRate] = useState(kind === "consumption_tax" ? bpToPercentText(Number(c.rateBp ?? 1000)) : "");
  const [rows, setRows] = useState<Row[]>(() => {
    const list = (kind === "brokerage_tiers" ? c.tiers : c.brackets) as { upTo: number | null; rateBp?: number; tax?: number }[] | undefined;
    return (list ?? [{ upTo: null }]).map((r) => ({
      upTo: r.upTo === null ? "" : String(r.upTo),
      value: kind === "brokerage_tiers" ? bpToPercentText(r.rateBp ?? 0) : String(r.tax ?? 0),
    }));
  });
  const special = (c.lowCostSpecial ?? { priceLimit: 8000000, feeCap: 300000 }) as { priceLimit: number; feeCap: number };
  const [priceLimit, setPriceLimit] = useState(String(special.priceLimit));
  const [feeCap, setFeeCap] = useState(String(special.feeCap));
  const cg = c as { long?: { incomeTaxBp: number; residentTaxBp: number }; short?: { incomeTaxBp: number; residentTaxBp: number }; reconstructionBp?: number; longTermYears?: number; residentialDeduction?: number; unknownCostRateBp?: number };
  const [cgv, setCgv] = useState({
    longIncome: bpToPercentText(cg.long?.incomeTaxBp ?? 1500), longResident: bpToPercentText(cg.long?.residentTaxBp ?? 500),
    shortIncome: bpToPercentText(cg.short?.incomeTaxBp ?? 3000), shortResident: bpToPercentText(cg.short?.residentTaxBp ?? 900),
    reconstruction: bpToPercentText(cg.reconstructionBp ?? 210), years: String(cg.longTermYears ?? 5),
    deduction: String(cg.residentialDeduction ?? 30000000), unknownCost: bpToPercentText(cg.unknownCostRateBp ?? 500),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const content = (): unknown => {
    const pct = (s: string) => percentTextToBp(s);
    if (kind === "consumption_tax") return { rateBp: pct(rate) };
    if (kind === "capital_gains") {
      return {
        long: { incomeTaxBp: pct(cgv.longIncome), residentTaxBp: pct(cgv.longResident) },
        short: { incomeTaxBp: pct(cgv.shortIncome), residentTaxBp: pct(cgv.shortResident) },
        reconstructionBp: pct(cgv.reconstruction), longTermYears: parseYen(cgv.years),
        residentialDeduction: parseYen(cgv.deduction), unknownCostRateBp: pct(cgv.unknownCost),
      };
    }
    const list = rows.map((r, i) => ({
      upTo: i === rows.length - 1 && r.upTo.trim() === "" ? null : parseYen(r.upTo),
      ...(kind === "brokerage_tiers" ? { rateBp: pct(r.value) } : { tax: parseYen(r.value) }),
    }));
    return kind === "brokerage_tiers"
      ? { tiers: list, lowCostSpecial: { priceLimit: parseYen(priceLimit), feeCap: parseYen(feeCap) } }
      : { brackets: list };
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = { validFrom, validTo: validTo || null, content: content() };
      if (table) await dealsApi.updateRateTable(table.id, { ...body, updatedAt: table.updatedAt });
      else await dealsApi.createRateTable({ kind, ...body });
      onDone();
    } catch (e) {
      const code = e instanceof DealApiError ? e.code : "";
      setError(
        code === "VERSION_CONFLICT" ? "ほかの人が先に直しました。画面を読み込み直してください。"
        : code === "PERIOD_OVERLAP" ? "同じ種類の表と期間が重なっています。期間を直してください。"
        : code === "VALIDATION_ERROR" ? "入力に誤りがあります。日付・数字・区分の並び(小さい順・最後だけ上限なし)を確かめてください。"
        : errorText(e),
      );
    } finally {
      setSaving(false);
    }
  };

  const pctField = (label: string, k: keyof typeof cgv) => (
    <Field key={k} label={label}><input inputMode="decimal" value={cgv[k]} onChange={(e) => setCgv((v) => ({ ...v, [k]: e.target.value }))} aria-label={label} className={inputCls} /></Field>
  );

  return (
    <div className="space-y-4 rounded-lg border border-gray-200 p-4 dark:border-gray-800">
      <p className="text-sm font-semibold">{RATE_TABLE_KIND_LABELS[kind]}</p>
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="適用開始"><input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} aria-label="適用開始" className={inputCls} /></Field>
        <Field label="適用終了" hint="空欄なら期限なし"><input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} aria-label="適用終了" className={inputCls} /></Field>
      </div>
      {kind === "consumption_tax" && (
        <Field label="消費税率(%)"><input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} aria-label="消費税率" className={inputCls} /></Field>
      )}
      {kind === "capital_gains" && (
        <div className="grid gap-3 sm:grid-cols-4">
          {pctField("長期 所得税(%)", "longIncome")}
          {pctField("長期 住民税(%)", "longResident")}
          {pctField("短期 所得税(%)", "shortIncome")}
          {pctField("短期 住民税(%)", "shortResident")}
          {pctField("復興特別所得税(所得税に対する%)", "reconstruction")}
          {pctField("取得費が不明のとき(売却価格の%)", "unknownCost")}
          <Field label="長期になる年数(超)"><input inputMode="numeric" value={cgv.years} onChange={(e) => setCgv((v) => ({ ...v, years: e.target.value }))} aria-label="長期になる年数" className={inputCls} /></Field>
          <Field label="居住用の特別控除(円)"><input inputMode="numeric" value={cgv.deduction} onChange={(e) => setCgv((v) => ({ ...v, deduction: e.target.value }))} aria-label="居住用の特別控除" className={inputCls} /></Field>
        </div>
      )}
      {(kind === "brokerage_tiers" || kind === "stamp_contract" || kind === "stamp_receipt") && (
        <>
          <p className="text-xs text-gray-500">金額の区分は小さい順に並べ、最後の行の上限は空欄(上限なし)にします。</p>
          <ul className="space-y-2">
            {rows.map((r, i) => (
              <li key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <Field label={i === rows.length - 1 ? "上限(円以下)・空欄=上限なし" : "上限(円以下)"}>
                  <input inputMode="numeric" value={r.upTo} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, upTo: e.target.value } : x)))} aria-label="上限" className={inputCls} />
                </Field>
                <Field label={kind === "brokerage_tiers" ? "率(%)" : "税額(円)"}>
                  <input inputMode="decimal" value={r.value} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} aria-label={kind === "brokerage_tiers" ? "率" : "税額"} className={inputCls} />
                </Field>
                <Button variant="ghost" size="sm" disabled={rows.length <= 1} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" />消す</Button>
              </li>
            ))}
          </ul>
          <Button variant="secondary" size="sm" onClick={() => setRows((rs) => [...rs.slice(0, -1), { upTo: "", value: "0" }, ...rs.slice(-1)])}>
            <Plus className="h-4 w-4" />
            区分を足す
          </Button>
          {kind === "brokerage_tiers" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="特例の価格の上限(円)"><input inputMode="numeric" value={priceLimit} onChange={(e) => setPriceLimit(e.target.value)} aria-label="特例の価格の上限" className={inputCls} /></Field>
              <Field label="特例の手数料の上限(円・税抜)"><input inputMode="numeric" value={feeCap} onChange={(e) => setFeeCap(e.target.value)} aria-label="特例の手数料の上限" className={inputCls} /></Field>
            </div>
          )}
        </>
      )}
      <div className="flex gap-2">
        <Button onClick={() => void save()} disabled={saving || !validFrom} loading={saving} loadingLabel="保存中"><Save className="h-4 w-4" />保存</Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>やめる</Button>
      </div>
    </div>
  );
}
```

`percentTextToBp` / `parseYen` が null を返したときは、その値が null のまま送られます。サーバーの検証で 422(`VALIDATION_ERROR`)になり、上の文言が出ます。

- [ ] **Step 4: 取引の設定の画面を直す**

`src/app/(dashboard)/admin/deal-settings/page.tsx` は、次のように直します。

- import に、次を足します。
  - `import { ConfirmDialog } from "@/components/ui/confirm-dialog";`
  - `import { RateTableEditor } from "@/components/deals/rate-table-editor";`
  - `RATE_TABLE_KINDS, type RateTableKind`(`@/lib/deals/rate-tables`)
  - lucide の `Pencil`
- state に、次の4行を足します。

```tsx
  const [editing, setEditing] = useState<{ table: RateTableView | null; kind: RateTableKind } | null>(null);
  const [deleting, setDeleting] = useState<RateTableView | null>(null);
  const reloadTables = () => dealsApi.rateTables().then((r) => setTables(r.tables)).catch((e) => setMessage({ kind: "err", text: errorText(e) }));
```

- 元の種別の SelectBox に `disabled={isBase}` を足します(M1)。

```tsx
                  <SelectBox label="元の種別" disabled={isBase} value={k.base} onChange={(v) => setKind(i, { base: v as PropertyKindDef["base"] })} options={optionsOf(BASE_PROPERTY_KIND_LABELS)} />
```

- 「税率・税額の表」の section の、説明の `<p>` と表を、次に差し替えます。

```tsx
        <p className="text-xs text-gray-500">計算では、契約日(なければ決済日)が期間に入る表を使います。制度が変わるときは「期間を足す」で新しい期間の表を足し、古い表には終わりの日を入れます。</p>
        {editing && (
          <RateTableEditor
            table={editing.table}
            kind={editing.kind}
            onDone={() => { setEditing(null); void reloadTables(); }}
            onCancel={() => setEditing(null)}
          />
        )}
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500 dark:bg-gray-900 dark:text-gray-400">
              <tr><th className="px-3 py-2">表</th><th className="px-3 py-2">適用開始</th><th className="px-3 py-2">適用終了</th><th className="px-3 py-2" /></tr>
            </thead>
            <tbody>
              {tables.map((t) => (
                <tr key={t.id} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="px-3 py-2">{RATE_TABLE_KIND_LABELS[t.kind as keyof typeof RATE_TABLE_KIND_LABELS] ?? t.kind}</td>
                  <td className="px-3 py-2 tabular-nums">{t.validFrom}</td>
                  <td className="px-3 py-2 tabular-nums">{t.validTo ?? "期限なし"}</td>
                  <td className="px-3 py-2 text-right">
                    <Button variant="ghost" size="sm" onClick={() => setEditing({ table: t, kind: t.kind as RateTableKind })}><Pencil className="h-4 w-4" />直す</Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleting(t)}><Trash2 className="h-4 w-4" />消す</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap gap-2">
          {RATE_TABLE_KINDS.map((kind) => (
            <Button key={kind} variant="secondary" size="sm" onClick={() => {
              const latest = [...tables].filter((t) => t.kind === kind).sort((a, b) => (a.validFrom < b.validFrom ? 1 : -1))[0];
              setEditing({ table: latest ? { ...latest, id: "", validFrom: "", validTo: null } : null, kind });
            }}>
              <Plus className="h-4 w-4" />
              {RATE_TABLE_KIND_LABELS[kind]}の期間を足す
            </Button>
          ))}
        </div>
        {deleting && (
          <ConfirmDialog
            title="この表を消しますか？"
            message={`${RATE_TABLE_KIND_LABELS[deleting.kind as keyof typeof RATE_TABLE_KIND_LABELS] ?? deleting.kind}(${deleting.validFrom}〜${deleting.validTo ?? "期限なし"})を消します。この期間の計算は表が無い扱いになります。`}
            onConfirm={() => {
              const t = deleting;
              setDeleting(null);
              dealsApi.deleteRateTable(t.id, t.updatedAt).then(() => reloadTables()).catch((e) => setMessage({ kind: "err", text: errorText(e) }));
            }}
            onCancel={() => setDeleting(null)}
          />
        )}
```

`RateTableEditor` は、`table.id` が空(「期間を足す」で今の表を写したもの)のときに、新しく作る扱いにします。部品の `save` の `if (table)` を `if (table?.id)` に直してください。

- [ ] **Step 5: テスト・型・lint を走らせる**

```bash
npx vitest run --testTimeout=120000 src/lib/deals src/components/layout > /tmp/d2-t11.log 2>&1; echo exit=$?; grep -E "×|Tests " /tmp/d2-t11.log | head
npx tsc --noEmit 2>&1 | head
npx eslint src/components/deals "src/app/(dashboard)/admin/deal-settings"; echo lint=$?
```
Expected: `exit=0`、tsc の出力なし、`lint=0`

- [ ] **Step 6: コミットする**

```bash
git add src/components/deals "src/app/(dashboard)/admin/deal-settings" src/lib/deals
git commit -m "feat(deals): 取引の設定で税率の表を直す・期間を足す・消す・基本4種別の元の種別を固定"
```

---

### Task 12: 使い方ガイドの更新と全部の確認

**Files:**
- Modify: `public/docs/guide.html`(🤝取引の feat ブロック)
- Modify: `public/docs/manual.html`(`id="deals"` の節)

- [ ] **Step 1: 使い方ガイドとマニュアルを直す**

マニュアルの `id="deals"` の節について:

- 「いまは入力の土台までです」を「いまは入力と計算までです(書類の出力はこれから)」に直します。
- ol に、次の3つを足します。
  - **金額・費用**: 売買価格・手付金・消費税率。仲介手数料の上限は自動で計算し、低廉な空家等の特例を選べます。建物価格と建物消費税は、物件タブの評価額から按分します。売買契約書の印紙税、司法書士と費用も入れます。計算の値は手で直せ、「計算に戻す」で戻せます。
  - **精算**: 固定資産税・都市計画税(起算日 1/1 か 4/1)、管理費等(区分だけ)、賃料(OCだけ)、その他を入れて「保存して計算する」。次のものが出ます。
    - 決済日の前日までを売主、決済日からを買主の負担とした日割りの表(計算期間・計算式つき)
    - 「買主から売主へ ○円」の1行
    - 「残代金+精算金−敷金承継=決済時のお支払額」
  - **OC**(オーナーチェンジのときだけ): 部屋ごとの賃料・共益費・駐車場代・敷金・滞納・管理会社。敷金は「残代金と相殺」か「別途授受」を選べます。
- 管理者の段落の「税率・税額の表は、いまは見るだけです」を、次に直します。
  - 「税率・税額の表は、制度が変わったら『期間を足す』で新しい期間を足し、古い表に終わりの日を入れます(計算は契約日が入る期間の表を使います)」

ガイドの 🤝取引の feat ブロックは、次のように直します。

- 「いまは入力の土台までです」を「いまは入力と計算までです」に直します。
- li を1つ足します。
  - 「金額・費用/精算/OC のタブで、仲介手数料・建物消費税・固都税と管理費の日割り・賃料と敷金の精算を自動で計算(手で直して『計算に戻す』もできます)」

- [ ] **Step 2: 全部の確認(どれも終了コードで判定する)**

```bash
npx tsc --noEmit > /tmp/g-tsc.log 2>&1; echo tsc=$?
npx vitest run --testTimeout=120000 > /tmp/g-test.log 2>&1; echo test=$?; tail -6 /tmp/g-test.log
npx eslint src/lib/deals src/app/api/deals src/app/api/admin/deal-settings "src/app/(dashboard)/deals" "src/app/(dashboard)/admin/deal-settings" src/components/deals > /tmp/g-lint.log 2>&1; echo lint=$?
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build > /tmp/g-build.log 2>&1; echo build=$?; grep -n "deals/\[id\]/calc\|rate-tables/\[id\]" /tmp/g-build.log
```
Expected:
- `tsc=0`、`test=0`、`lint=0`、`build=0`
- build のルートの一覧に `/api/deals/[id]/calc` と `/api/admin/deal-settings/rate-tables/[id]` が出る

- [ ] **Step 3: コミットする**

```bash
git add public/docs
git commit -m "docs: 使い方ガイドとマニュアルに取引の計算(金額・費用/精算/OC・税率の表)を追加"
```

- [ ] **Step 4: PR の本文に入れるもの(ship スキル)**

- **計算の決まり**: 各関数の端数処理と、依頼書の例3つがテストで通っていること
- **読み替えた点**: 次の3つ
  - 建物消費税の列(`building_tax`)は使わず、上書きは `overrides` に入れた
  - 精算の合計は敷金を除き、お支払額で敷金を引く
  - 税率の表の編集は、楽観ロックを updatedAt で行う
- **DB の変更なし**(migration なし)
- **後回しにしていた小さな点 M1〜M6 を直したこと**
- **実際の画面で確かめる手順**:
  1. 取引の「金額・費用」で売買価格 3,000万円・税率 10 を保存 → 仲介手数料の計算が 960,000円・税込 1,056,000円
  2. 仲介手数料に 900,000 と入れて保存 →「手で直した値」の印 →「計算に戻す」→ 保存で 960,000円に戻る
  3. 物件タブで、家屋 1,000万・土地 2,000万・持分 1/1 を保存 → 金額・費用の建物価格 1,000万円・建物消費税 909,090円
  4. 基本で決済日時を 2026-07-01 に、精算で固都税 100,000+20,000・1月1日起算を「保存して計算する」→ 買主→売主 60,493円・計算式「120,000円×184日÷365日」
  5. 区分マンションの取引で、管理費 20,000・修繕積立金 10,000 を足す → 管理費の行が出て、「買主から売主へ ○円」の1行とお支払額が出る
  6. 基本で OC を入れて保存 → OC タブが出る → 部屋を足して賃料・敷金を入れて保存 → 精算に賃料(売主→買主)と敷金の承継(残代金と相殺)が出る
  7. どれかのタブで入力の途中にほかのタブへ移って戻る → 入力が残っている
  8. 管理者で「取引の設定」→ 消費税率の「期間を足す」→ 2030-01-01〜・12 を保存 → 表に行が増える。今の表と期間が重なると「期間が重なっています」と出る
  9. 決済日を 2027-02-15、起算日を 4月1日にする →「起算日が4月1日のため…」の注意が出る
