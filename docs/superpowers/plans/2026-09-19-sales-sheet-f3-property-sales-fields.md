# 販売図面 F3(物件に「販売」の欄)実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 販売図面の作成画面で入れた値(価格・交通・面積・築年月ほか)を物件(区分は棟)の正式なデータとして保存し、次に図面を作るときは自動で入るようにする。

**Architecture:** 読み取り(文字→数値/年月/選択肢)と対応表(図面の項目→保存先)を純関数に切り出し、図面作成 API のトランザクションの中で「変わった欄だけ」を物件・棟へ書く。画面は物件編集に「販売」区分、棟編集に2欄、作成ダイアログにチェックと注意、エディタ上部に結果の知らせを足す。

**Tech Stack:** Next.js(App Router)/ Prisma + PostgreSQL / zod / vitest(env=node・UIは renderToStaticMarkup)

**Spec:** `docs/superpowers/specs/2026-09-19-sales-sheet-f3-property-sales-fields-design.md`

## Global Constraints

- 物件へ保存できるのは `property:write` を持つ人だけ。`field_staff` は既存の `canAccessPropertyRecord` の範囲のみ(仕様書 §6.2)。
- 図面で空にした欄は物件の値を消さない。「空 = 変更なし」(§6.1)。
- 読み取れない値(「応談」「築15年」など)はその欄だけ保存しない。図面の表示は入力のまま(§6.1・§8)。
- 物件(棟)を他の人が先に更新していたら物件・棟には保存せず、図面だけ作る(§6.1)。
- エディタ(作成後の編集画面)からは物件へ書き戻さない(§7)。
- 棟へ保存するのは区分マンションだけ。一棟は物件に保存する(§4.4)。
- migration は列の追加のみ。既存データを書き換えない。enum は増やさない(§4.5)。
- 変更履歴は `ChangeLog` に1欄1行(`targetTable` = `properties` / `buildings`、`source` = `manual`)(§6)。
- テストは vitest。UI は `renderToStaticMarkup` + 文字列 assert(このリポの既定)。
- 作業場所: worktree `property-management-worktrees/sales-sheet-f3` / branch `feat/sales-sheet-f3`。push は `git push -u origin feat/sales-sheet-f3`。

---

### Task 1: 値の読み取り(純関数)

**Files:**
- Create: `src/lib/sales-sheet/property-writeback/parse-values.ts`
- Test: `src/lib/sales-sheet/property-writeback/__tests__/parse-values.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `parseNumeric(raw: string | undefined): number | null`
  - `parseBuiltYearMonth(raw: string | undefined): { year: number; month: number | null } | null`
  - `pickOption(raw: string | undefined, options: readonly string[]): string | null`

- [ ] **Step 1: Write the failing test**

`src/lib/sales-sheet/property-writeback/__tests__/parse-values.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseNumeric, parseBuiltYearMonth, pickOption } from "../parse-values";

describe("parseNumeric", () => {
  it("素の数字", () => {
    expect(parseNumeric("3480")).toBe(3480);
    expect(parseNumeric("125.30")).toBe(125.3);
  });
  it("全角・カンマ・前後の空白", () => {
    expect(parseNumeric("１２００")).toBe(1200);
    expect(parseNumeric(" 1,200 ")).toBe(1200);
    expect(parseNumeric("１，２００")).toBe(1200);
  });
  it("末尾の単位は落とす", () => {
    expect(parseNumeric("3,480万円")).toBe(3480);
    expect(parseNumeric("125.30㎡")).toBe(125.3);
    expect(parseNumeric("8.5%")).toBe(8.5);
    expect(parseNumeric("8.5％")).toBe(8.5);
    expect(parseNumeric("5階")).toBe(5);
    expect(parseNumeric("24戸")).toBe(24);
  });
  it("数量でない値は読み取れない", () => {
    expect(parseNumeric("応談")).toBeNull();
    expect(parseNumeric("なし")).toBeNull();
    expect(parseNumeric("")).toBeNull();
    expect(parseNumeric(undefined)).toBeNull();
    expect(parseNumeric("1,0,0")).toBeNull();
    expect(parseNumeric("-5")).toBeNull();
  });
});

describe("parseBuiltYearMonth", () => {
  it("西暦", () => {
    expect(parseBuiltYearMonth("2008年3月")).toEqual({ year: 2008, month: 3 });
    expect(parseBuiltYearMonth("2008/3")).toEqual({ year: 2008, month: 3 });
    expect(parseBuiltYearMonth("2008-03")).toEqual({ year: 2008, month: 3 });
    expect(parseBuiltYearMonth("2008年3月1日")).toEqual({ year: 2008, month: 3 });
    expect(parseBuiltYearMonth("2008年")).toEqual({ year: 2008, month: null });
  });
  it("和暦", () => {
    expect(parseBuiltYearMonth("平成20年3月")).toEqual({ year: 2008, month: 3 });
    expect(parseBuiltYearMonth("昭和58年")).toEqual({ year: 1983, month: null });
    expect(parseBuiltYearMonth("令和2年5月")).toEqual({ year: 2020, month: 5 });
  });
  it("全角も読める", () => {
    expect(parseBuiltYearMonth("２００８年３月")).toEqual({ year: 2008, month: 3 });
  });
  it("月が範囲外なら月なし", () => {
    expect(parseBuiltYearMonth("2008年13月")).toEqual({ year: 2008, month: null });
    expect(parseBuiltYearMonth("2008年0月")).toEqual({ year: 2008, month: null });
  });
  it("読み取れない書き方", () => {
    expect(parseBuiltYearMonth("築15年")).toBeNull();
    expect(parseBuiltYearMonth("新築")).toBeNull();
    expect(parseBuiltYearMonth("")).toBeNull();
    expect(parseBuiltYearMonth(undefined)).toBeNull();
  });
});

describe("pickOption", () => {
  const OPTS = ["公簿", "実測"] as const;
  it("選択肢にある値だけ通す", () => {
    expect(pickOption("実測", OPTS)).toBe("実測");
    expect(pickOption(" 公簿 ", OPTS)).toBe("公簿");
  });
  it("選択肢に無い値・空は null", () => {
    expect(pickOption("だいたい", OPTS)).toBeNull();
    expect(pickOption("", OPTS)).toBeNull();
    expect(pickOption(undefined, OPTS)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/sales-sheet/property-writeback/__tests__/parse-values.test.ts`
Expected: FAIL(`Failed to resolve import "../parse-values"`)

- [ ] **Step 3: Write minimal implementation**

`src/lib/sales-sheet/property-writeback/parse-values.ts`:

```ts
/**
 * 図面の自由入力を、物件へ保存できる形へ読み取る純関数群(仕様書 §8)。
 * 読み取れない値は null を返し、呼び出し側はその欄を保存しない(図面の表示は入力のまま)。
 */

/** 全角数字・全角ピリオド・全角カンマを半角へ。 */
function toHalfWidth(s: string): string {
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/．/g, ".")
    .replace(/，/g, ",");
}

/** 末尾に付きうる単位(長いものから削る)。 */
const UNIT_SUFFIXES = ["万円/年", "円/月", "万円", "㎡", "%", "％", "階", "戸", "円"];

export function parseNumeric(raw: string | undefined): number | null {
  if (typeof raw !== "string") return null;
  let s = toHalfWidth(raw).trim();
  if (!s) return null;
  for (const u of UNIT_SUFFIXES) {
    if (s.endsWith(u)) {
      s = s.slice(0, -u.length).trim();
      break;
    }
  }
  s = s.replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 元号 → 元年の前年(和暦N年 = base + N)。 */
const ERA_BASE: Record<string, number> = { 明治: 1867, 大正: 1911, 昭和: 1925, 平成: 1988, 令和: 2018 };

export function parseBuiltYearMonth(
  raw: string | undefined,
): { year: number; month: number | null } | null {
  if (typeof raw !== "string") return null;
  const s = toHalfWidth(raw).trim();
  if (!s) return null;

  const era = /^(明治|大正|昭和|平成|令和)\s*(\d{1,2})年\s*(?:(\d{1,2})月)?/.exec(s);
  if (era) {
    const year = ERA_BASE[era[1]] + Number(era[2]);
    return { year, month: monthOrNull(era[3]) };
  }

  const ad = /^(\d{4})\s*(?:年|\/|-)?\s*(?:(\d{1,2})\s*(?:月|\/|-)?)?/.exec(s);
  if (ad && /^\d{4}/.test(s)) {
    return { year: Number(ad[1]), month: monthOrNull(ad[2]) };
  }
  return null;
}

function monthOrNull(v: string | undefined): number | null {
  if (v === undefined) return null;
  const m = Number(v);
  return Number.isInteger(m) && m >= 1 && m <= 12 ? m : null;
}

export function pickOption(raw: string | undefined, options: readonly string[]): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  return options.includes(s) ? s : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/sales-sheet/property-writeback/__tests__/parse-values.test.ts`
Expected: PASS(全件)

- [ ] **Step 5: Commit**

```bash
git add src/lib/sales-sheet/property-writeback/parse-values.ts src/lib/sales-sheet/property-writeback/__tests__/parse-values.test.ts
git commit -m "feat(sales-sheet): 図面の入力を物件へ保存できる形に読み取る純関数(F3 Task1)"
```

---

### Task 2: 図面の項目 → 保存先の対応(純関数)

**Files:**
- Create: `src/lib/sales-sheet/property-writeback/build-writeback.ts`
- Test: `src/lib/sales-sheet/property-writeback/__tests__/build-writeback.test.ts`

**Interfaces:**
- Consumes: Task 1 の `parseNumeric` / `parseBuiltYearMonth` / `pickOption`、`salesSheetTemplateKindFor` の戻り値型 `SalesSheetTemplateKind`
- Produces:
  - `type WritebackCurrent = { property: Record<string, unknown>; building: Record<string, unknown> | null }`
  - `type WritebackResult = { property: Record<string, string | number | null>; building: Record<string, string | number | null>; unreadable: string[] }`
  - `buildWriteback(input: { kind: SalesSheetTemplateKind; values: Record<string, string | undefined>; current: WritebackCurrent }): WritebackResult`

**注意:** `property` / `building` には**今の値と違う欄だけ**入れる。`unreadable` には読み取れなかった項目の**日本語ラベル**を入れる(画面の知らせに使う)。

- [ ] **Step 1: Write the failing test**

`src/lib/sales-sheet/property-writeback/__tests__/build-writeback.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildWriteback } from "../build-writeback";

const emptyCurrent = { property: {}, building: null };

describe("buildWriteback — 土地", () => {
  it("価格・交通・土地面積・計測方式を物件へ", () => {
    const r = buildWriteback({
      kind: "land",
      values: { price: "3480", access: "○○線 徒歩8分", landArea: "125.30", areaMethod: "実測" },
      current: emptyCurrent,
    });
    expect(r.property).toEqual({
      salePrice: 3480,
      access: "○○線 徒歩8分",
      landArea: 125.3,
      landAreaMethod: "実測",
    });
    expect(r.building).toEqual({});
    expect(r.unreadable).toEqual([]);
  });

  it("今の値と同じ欄は入れない", () => {
    const r = buildWriteback({
      kind: "land",
      values: { price: "3480", access: "○○線 徒歩8分" },
      current: { property: { salePrice: 3480, access: "○○線 徒歩8分" }, building: null },
    });
    expect(r.property).toEqual({});
  });

  it("空欄は変更なし(消さない)", () => {
    const r = buildWriteback({
      kind: "land",
      values: { price: "", access: "   " },
      current: { property: { salePrice: 3480 }, building: null },
    });
    expect(r.property).toEqual({});
  });

  it("読み取れない値は保存せずラベルを返す", () => {
    const r = buildWriteback({
      kind: "land",
      values: { price: "応談", areaMethod: "だいたい" },
      current: emptyCurrent,
    });
    expect(r.property).toEqual({});
    expect(r.unreadable).toEqual(["価格", "面積計測方式"]);
  });
});

describe("buildWriteback — 戸建", () => {
  it("築年月は年と月に分ける", () => {
    const r = buildWriteback({
      kind: "house",
      values: { builtYearMonth: "平成20年3月", structure: "木造", aboveFloors: "2", parking: "有" },
      current: emptyCurrent,
    });
    expect(r.property).toEqual({
      builtYear: 2008,
      builtMonth: 3,
      structureType: "木造",
      aboveFloors: 2,
      parking: "有",
    });
  });

  it("読み取れない築年月は保存しない", () => {
    const r = buildWriteback({
      kind: "house",
      values: { builtYearMonth: "築15年" },
      current: emptyCurrent,
    });
    expect(r.property).toEqual({});
    expect(r.unreadable).toEqual(["築年月"]);
  });
});

describe("buildWriteback — 区分マンション", () => {
  it("部屋の欄は物件・棟の欄は棟へ", () => {
    const r = buildWriteback({
      kind: "mansion",
      values: {
        price: "6590",
        exclusiveArea: "67.21",
        managementFee: "12800",
        structure: "RC",
        totalFloors: "11",
        totalUnits: "48",
        builtYearMonth: "2008年3月",
      },
      current: { property: {}, building: {} },
    });
    expect(r.property).toEqual({ salePrice: 6590, exclusiveArea: 67.21, managementFee: 12800 });
    expect(r.building).toEqual({
      structureType: "RC",
      totalFloors: 11,
      totalUnits: 48,
      builtYear: 2008,
      builtMonth: 3,
    });
  });

  it("棟が無い区分では棟の欄を捨てる", () => {
    const r = buildWriteback({
      kind: "mansion",
      values: { price: "6590", structure: "RC" },
      current: { property: {}, building: null },
    });
    expect(r.property).toEqual({ salePrice: 6590 });
    expect(r.building).toEqual({});
  });
});

describe("buildWriteback — 一棟", () => {
  it("棟には書かず物件へ(総戸数・利回り・満室想定収入を含む)", () => {
    const r = buildWriteback({
      kind: "building",
      values: { totalUnits: "24", grossYield: "8.5", expectedIncome: "9800", structure: "RC" },
      current: { property: {}, building: {} },
    });
    expect(r.property).toEqual({
      totalUnits: 24,
      grossYield: 8.5,
      expectedIncome: 9800,
      structureType: "RC",
    });
    expect(r.building).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/sales-sheet/property-writeback/__tests__/build-writeback.test.ts`
Expected: FAIL(`Failed to resolve import "../build-writeback"`)

- [ ] **Step 3: Write minimal implementation**

`src/lib/sales-sheet/property-writeback/build-writeback.ts`:

```ts
import type { SalesSheetTemplateKind } from "../template-kind";
import * as M from "../option-master";
import { parseNumeric, parseBuiltYearMonth, pickOption } from "./parse-values";

export type WritebackCurrent = {
  property: Record<string, unknown>;
  building: Record<string, unknown> | null;
};
export type WritebackResult = {
  property: Record<string, string | number | null>;
  building: Record<string, string | number | null>;
  unreadable: string[];
};

/** 図面の項目1つを、どこの列へどう読み取って保存するかの定義。 */
type Rule = {
  /** 図面の項目(field-model の key) */
  key: string;
  /** 画面に出す日本語ラベル */
  label: string;
  /** 保存先 */
  to: "property" | "building";
  /** 列名 */
  column: string;
  /** 読み取り方 */
  as: "number" | "text" | { option: readonly string[] };
};

const PRICE = (opts: readonly string[]): Rule[] => [
  { key: "price", label: "価格", to: "property", column: "salePrice", as: "number" },
  { key: "tax", label: "消費税", to: "property", column: "saleTaxType", as: { option: opts } },
  { key: "taxAmount", label: "うち消費税", to: "property", column: "saleTaxAmount", as: "number" },
];
const ACCESS: Rule = { key: "access", label: "交通", to: "property", column: "access", as: "text" };
const LAND: Rule[] = [
  { key: "landArea", label: "土地面積", to: "property", column: "landArea", as: "number" },
  { key: "areaMethod", label: "面積計測方式", to: "property", column: "landAreaMethod", as: { option: M.AREA_METHOD_LAND } },
];

/** 築年月は1項目から2列(年・月)へ入るため、規則表とは別に扱う。 */
const BUILT_LABEL = "築年月";

const RULES: Record<SalesSheetTemplateKind, Rule[]> = {
  land: [{ key: "price", label: "価格", to: "property", column: "salePrice", as: "number" }, ACCESS, ...LAND],
  mansion: [
    ...PRICE(M.TAX),
    ACCESS,
    { key: "parking", label: "駐車場", to: "property", column: "parking", as: { option: M.PARKING_MANSION } },
    { key: "exclusiveArea", label: "専有面積", to: "property", column: "exclusiveArea", as: "number" },
    { key: "balconyArea", label: "バルコニー面積", to: "property", column: "balconyArea", as: "number" },
    { key: "layout", label: "間取り", to: "property", column: "layoutType", as: "text" },
    { key: "balconyDir", label: "バルコニー向き", to: "property", column: "orientation", as: "text" },
    { key: "floorNo", label: "所在階", to: "property", column: "floorNo", as: "number" },
    { key: "managementFee", label: "管理費", to: "property", column: "managementFee", as: "number" },
    { key: "repairFee", label: "修繕積立金", to: "property", column: "repairReserveFee", as: "number" },
    { key: "structure", label: "建物構造", to: "building", column: "structureType", as: { option: M.BUILDING_STRUCTURE } },
    { key: "totalFloors", label: "地上階", to: "building", column: "totalFloors", as: "number" },
    { key: "basementFloors", label: "地下階", to: "building", column: "basementFloors", as: "number" },
    { key: "totalUnits", label: "総戸数", to: "building", column: "totalUnits", as: "number" },
  ],
  house: [
    ...PRICE(M.TAX),
    ACCESS,
    ...LAND,
    { key: "buildingArea", label: "建物面積", to: "property", column: "totalFloorArea", as: "number" },
    { key: "structure", label: "建物構造", to: "property", column: "structureType", as: { option: M.BUILDING_STRUCTURE } },
    { key: "aboveFloors", label: "地上階", to: "property", column: "aboveFloors", as: "number" },
    { key: "basementFloors", label: "地下階", to: "property", column: "basementFloors", as: "number" },
    { key: "parking", label: "駐車場", to: "property", column: "parking", as: { option: M.PARKING_HOUSE } },
  ],
  building: [
    ...PRICE(M.TAX),
    ACCESS,
    ...LAND,
    { key: "totalFloorArea", label: "延床面積", to: "property", column: "totalFloorArea", as: "number" },
    { key: "structure", label: "構造", to: "property", column: "structureType", as: { option: M.BUILDING_STRUCTURE } },
    { key: "aboveFloors", label: "地上階", to: "property", column: "aboveFloors", as: "number" },
    { key: "basementFloors", label: "地下階", to: "property", column: "basementFloors", as: "number" },
    { key: "parking", label: "駐車場", to: "property", column: "parking", as: { option: M.PARKING_HOUSE } },
    { key: "totalUnits", label: "総戸数", to: "property", column: "totalUnits", as: "number" },
    { key: "grossYield", label: "想定利回り", to: "property", column: "grossYield", as: "number" },
    { key: "expectedIncome", label: "満室想定収入", to: "property", column: "expectedIncome", as: "number" },
  ],
};

/** 築年月の保存先(区分だけ棟)。 */
const BUILT_TARGET: Record<SalesSheetTemplateKind, "property" | "building" | null> = {
  land: null,
  mansion: "building",
  house: "property",
  building: "property",
};

/** 今の値と同じなら保存しない(Decimal や Date は toString で比べる)。 */
function same(current: unknown, next: string | number): boolean {
  if (current === null || current === undefined) return false;
  return String(current) === String(next);
}

export function buildWriteback(input: {
  kind: SalesSheetTemplateKind;
  values: Record<string, string | undefined>;
  current: WritebackCurrent;
}): WritebackResult {
  const { kind, values, current } = input;
  const out: WritebackResult = { property: {}, building: {}, unreadable: [] };
  const hasBuilding = current.building !== null;

  for (const rule of RULES[kind]) {
    const raw = values[rule.key];
    if (typeof raw !== "string" || raw.trim() === "") continue; // 空は変更なし
    if (rule.to === "building" && !hasBuilding) continue;

    let next: string | number | null;
    if (rule.as === "number") next = parseNumeric(raw);
    else if (rule.as === "text") next = raw.trim();
    else next = pickOption(raw, rule.as.option);

    if (next === null) {
      out.unreadable.push(rule.label);
      continue;
    }
    const currentBag = rule.to === "property" ? current.property : (current.building ?? {});
    if (same(currentBag[rule.column], next)) continue;
    const bag = rule.to === "property" ? out.property : out.building;
    bag[rule.column] = next;
  }

  // 築年月(1項目 → 年・月の2列)
  const builtTarget = BUILT_TARGET[kind];
  const builtRaw = values.builtYearMonth;
  if (builtTarget && typeof builtRaw === "string" && builtRaw.trim() !== "") {
    if (builtTarget === "building" && !hasBuilding) {
      // 棟が無い区分は保存先が無いので何もしない
    } else {
      const parsed = parseBuiltYearMonth(builtRaw);
      if (parsed === null) {
        out.unreadable.push(BUILT_LABEL);
      } else {
        const currentBag = builtTarget === "property" ? current.property : (current.building ?? {});
        const bag = builtTarget === "property" ? out.property : out.building;
        if (!same(currentBag.builtYear, parsed.year)) bag.builtYear = parsed.year;
        if (parsed.month !== null && !same(currentBag.builtMonth, parsed.month)) {
          bag.builtMonth = parsed.month;
        }
      }
    }
  }

  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/sales-sheet/property-writeback/__tests__/build-writeback.test.ts`
Expected: PASS(全件)

- [ ] **Step 5: Commit**

```bash
git add src/lib/sales-sheet/property-writeback/build-writeback.ts src/lib/sales-sheet/property-writeback/__tests__/build-writeback.test.ts
git commit -m "feat(sales-sheet): 図面の項目から物件・棟への保存内容を組み立てる純関数(F3 Task2)"
```

---

### Task 3: データベースに列を足す

**Files:**
- Modify: `prisma/schema.prisma`(`model Property` / `model Building`)
- Create: `prisma/migrations/<timestamp>_add_property_sales_fields/migration.sql`(`prisma migrate dev` が生成)
- Test: `src/lib/sales-sheet/property-writeback/__tests__/schema-columns.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `Property.salePrice` `saleTaxType` `saleTaxAmount` `access` `landArea` `landAreaMethod` `totalFloorArea` `builtYear` `builtMonth` `structureType` `aboveFloors` `basementFloors` `parking` `totalUnits` `grossYield` `expectedIncome` / `Building.builtMonth` `basementFloors`

- [ ] **Step 1: Write the failing test**

`src/lib/sales-sheet/property-writeback/__tests__/schema-columns.test.ts`(schema.prisma を読んで列の宣言を固定する。DB 接続は不要):

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const schema = readFileSync("prisma/schema.prisma", "utf8");
const model = (name: string): string => {
  const m = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
  if (!m) throw new Error(`model ${name} が見つからない`);
  return m[1];
};

describe("F3 で足す列(物件)", () => {
  const property = model("Property");
  it.each([
    ["salePrice", "Decimal?", "sale_price"],
    ["saleTaxType", "String?", "sale_tax_type"],
    ["saleTaxAmount", "Decimal?", "sale_tax_amount"],
    ["access", "String?", "access"],
    ["landArea", "Decimal?", "land_area"],
    ["landAreaMethod", "String?", "land_area_method"],
    ["totalFloorArea", "Decimal?", "total_floor_area"],
    ["builtYear", "Int?", "built_year"],
    ["builtMonth", "Int?", "built_month"],
    ["structureType", "String?", "structure_type"],
    ["aboveFloors", "Int?", "above_floors"],
    ["basementFloors", "Int?", "basement_floors"],
    ["parking", "String?", "parking"],
    ["totalUnits", "Int?", "total_units"],
    ["grossYield", "Decimal?", "gross_yield"],
    ["expectedIncome", "Decimal?", "expected_income"],
  ])("%s は %s で @map(%s)", (field, type, column) => {
    const line = property.split("\n").find((l) => new RegExp(`^\\s*${field}\\s`).test(l));
    expect(line, `${field} の宣言が無い`).toBeTruthy();
    expect(line).toContain(type);
    expect(line).toContain(`@map("${column}")`);
  });
});

describe("F3 で足す列(棟)", () => {
  const building = model("Building");
  it.each([
    ["builtMonth", "Int?", "built_month"],
    ["basementFloors", "Int?", "basement_floors"],
  ])("%s は %s で @map(%s)", (field, type, column) => {
    const line = building.split("\n").find((l) => new RegExp(`^\\s*${field}\\s`).test(l));
    expect(line, `${field} の宣言が無い`).toBeTruthy();
    expect(line).toContain(type);
    expect(line).toContain(`@map("${column}")`);
  });
});

describe("migration は列の追加だけ", () => {
  it("DROP や型変更を含まない", () => {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const dir = readdirSync("prisma/migrations").find((d) => d.endsWith("_add_property_sales_fields"));
    expect(dir, "migration ディレクトリが無い").toBeTruthy();
    const sql = readFileSync(`prisma/migrations/${dir}/migration.sql`, "utf8");
    expect(sql).toMatch(/ALTER TABLE/);
    expect(sql).not.toMatch(/DROP/i);
    expect(sql).not.toMatch(/ALTER COLUMN/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/sales-sheet/property-writeback/__tests__/schema-columns.test.ts`
Expected: FAIL(`salePrice の宣言が無い`)

- [ ] **Step 3: Write minimal implementation**

`prisma/schema.prisma` の `model Property` に、`ownershipShareNote` の次の行から追記:

```prisma
  // --- 販売図面 F3: 販売条件(図面の作成画面から保存する・仕様書 §4.1) ---
  salePrice                Decimal?          @map("sale_price") @db.Decimal(12, 1)
  saleTaxType              String?           @map("sale_tax_type")
  saleTaxAmount            Decimal?          @map("sale_tax_amount") @db.Decimal(12, 1)
  access                   String?
  landArea                 Decimal?          @map("land_area") @db.Decimal(10, 2)
  landAreaMethod           String?           @map("land_area_method")
  totalFloorArea           Decimal?          @map("total_floor_area") @db.Decimal(10, 2)
  builtYear                Int?              @map("built_year")
  builtMonth               Int?              @map("built_month")
  structureType            String?           @map("structure_type")
  aboveFloors              Int?              @map("above_floors")
  basementFloors           Int?              @map("basement_floors")
  parking                  String?
  totalUnits               Int?              @map("total_units")
  grossYield               Decimal?          @map("gross_yield") @db.Decimal(5, 2)
  expectedIncome           Decimal?          @map("expected_income") @db.Decimal(12, 1)
```

`model Building` の `builtYear` の次の行に追記:

```prisma
  builtMonth          Int?      @map("built_month")
  basementFloors      Int?      @map("basement_floors")
```

⚠ `access` と `parking` は Prisma のフィールド名と列名が同じなので `@map` は不要だが、テストが `@map` を求めているため明示する:

```prisma
  access                   String?           @map("access")
  parking                  String?           @map("parking")
```

migration を作る(ローカルDBが必要・`docs` のローカル環境手順を参照):

```bash
npx prisma migrate dev --name add_property_sales_fields
npx prisma generate
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/sales-sheet/property-writeback/__tests__/schema-columns.test.ts`
Expected: PASS(全件)

Run: `npx tsc --noEmit`
Expected: エラーなし(生成された型が使える)

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/sales-sheet/property-writeback/__tests__/schema-columns.test.ts
git commit -m "feat(db): 物件と棟に販売条件の列を足す(F3 Task3・列の追加のみ)"
```

---

### Task 4: 図面作成 API で物件・棟へ保存する

**Files:**
- Create: `src/lib/sales-sheet/property-writeback/apply-writeback.ts`
- Modify: `src/app/api/properties/[id]/sales-sheets/new/route.ts`
- Test: `src/app/api/properties/[id]/sales-sheets/new/__tests__/writeback.test.ts`

**Interfaces:**
- Consumes: Task 2 の `buildWriteback` / `WritebackResult`
- Produces:
  - `applyWriteback(tx, args: { propertyId: string; buildingId: string | null; result: WritebackResult; userId: string }): Promise<void>` — 列の更新 + `ChangeLog` の追記
  - API 応答に `propertyWriteback` を足す:
    `{ saved: string[]; unreadable: string[]; conflict: boolean }`(`saved` は日本語ラベル)

**受け取る本文の追加:** `saveToProperty?: boolean`(既定 true)、`propertyVersion?: number`、`buildingVersion?: number`

- [ ] **Step 1: Write the failing test**

`src/app/api/properties/[id]/sales-sheets/new/__tests__/writeback.test.ts`

**下ごしらえ:** 同じフォルダの `route.test.ts` の**1〜158行目**(`vi.mock("@/lib/api-helpers")` / `@/lib/permissions` / `@/lib/property-access` / `@/lib/prisma` / `@/lib/sales-sheet/design-service` / `@/lib/sales-sheet/authorize-document-images` / `@/lib/audit` と `const pm = prisma as unknown as PrismaMock`)を**そのまま写して**冒頭に置く。そのうえで、この計画で使う次の名前を足す:

```ts
const updateMock = pm.property.update as unknown as Mock;
const buildingUpdateMock = pm.building.update as unknown as Mock;
const changeLogCreateManyMock = pm.changeLog.createMany as unknown as Mock;
const propertyFindMock = pm.property.findUnique as unknown as Mock;
const designCreateMock = pm.salesSheetDesign.create as unknown as Mock;
const baseProperty = { id: "11111111-1111-1111-1111-111111111111", propertyType: "land", address: "東京都…", version: 1, building: null, createdBy: "u1", assignedTo: "u1" };
const baseMansion = { ...baseProperty, propertyType: "apartment_unit" };
```

⚠ `prisma` の mock に `building.update` / `changeLog.createMany` / `$queryRaw` / `$transaction`(コールバックへ `pm` をそのまま渡す)が無ければ足すこと。

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// 既存の route.test.ts と同じ mock 構成(prisma・セッション・権限)を使う。
// ここでは writeback の呼ばれ方だけを見る。
import { POST } from "../route";

const ctx = { params: Promise.resolve({ id: "11111111-1111-1111-1111-111111111111" }) };
const req = (body: unknown) =>
  new Request("http://localhost:3000/api/properties/x/sales-sheets/new", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /sales-sheets/new — 物件への保存", () => {
  beforeEach(() => vi.clearAllMocks());

  it("既定(チェックON)で変わった欄だけ物件を更新し、変更履歴を1欄1行残す", async () => {
    const res = await POST(req({ price: "3480", access: "○○線 徒歩8分" }), ctx);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.propertyWriteback).toEqual({ saved: ["価格", "交通"], unreadable: [], conflict: false });
    // property.update は1回・ChangeLog は2行
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(changeLogCreateManyMock.mock.calls[0][0].data).toHaveLength(2);
  });

  it("チェックOFFなら物件を更新しない", async () => {
    const res = await POST(req({ price: "3480", saveToProperty: false }), ctx);
    expect(res.status).toBe(201);
    expect(updateMock).not.toHaveBeenCalled();
    expect((await res.json()).propertyWriteback).toEqual({ saved: [], unreadable: [], conflict: false });
  });

  it("読み取れない値は保存せず知らせに出す", async () => {
    const res = await POST(req({ price: "応談" }), ctx);
    const json = await res.json();
    expect(json.propertyWriteback.saved).toEqual([]);
    expect(json.propertyWriteback.unreadable).toEqual(["価格"]);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("他の人が先に更新していたら物件は保存せず図面は作る", async () => {
    // 現在の version は 5、画面が持っていたのは 4
    propertyFindMock.mockResolvedValueOnce({ ...baseProperty, version: 5 });
    const res = await POST(req({ price: "3480", propertyVersion: 4 }), ctx);
    expect(res.status).toBe(201);
    expect(updateMock).not.toHaveBeenCalled();
    expect((await res.json()).propertyWriteback.conflict).toBe(true);
  });

  it("区分は棟へ保存する", async () => {
    propertyFindMock.mockResolvedValueOnce({ ...baseMansion, building: { id: "b1", version: 1 } });
    const res = await POST(req({ structure: "RC", totalUnits: "48" }), ctx);
    expect(res.status).toBe(201);
    expect(buildingUpdateMock).toHaveBeenCalledTimes(1);
    expect(buildingUpdateMock.mock.calls[0][0].data).toEqual({ structureType: "RC", totalUnits: 48 });
  });

  it("保存の途中で失敗したら図面も作らない", async () => {
    updateMock.mockRejectedValueOnce(new Error("db down"));
    const res = await POST(req({ price: "3480" }), ctx);
    expect(res.status).toBe(500);
    expect(designCreateMock).not.toHaveBeenCalled(); // 同じトランザクションのため巻き戻る
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "src/app/api/properties/[id]/sales-sheets/new/__tests__/writeback.test.ts"`
Expected: FAIL(`propertyWriteback` が応答に無い)

- [ ] **Step 3: Write minimal implementation**

`src/lib/sales-sheet/property-writeback/apply-writeback.ts`:

```ts
import type { Prisma } from "@prisma/client";
import type { WritebackResult } from "./build-writeback";

/**
 * 物件・棟の列を更新し、変更履歴(ChangeLog)を1欄1行残す(仕様書 §6)。
 * 呼び出し側のトランザクションの中で使う。行のロックは呼び出し側で済ませておくこと。
 */
export async function applyWriteback(
  tx: Prisma.TransactionClient,
  args: {
    propertyId: string;
    buildingId: string | null;
    result: WritebackResult;
    before: { property: Record<string, unknown>; building: Record<string, unknown> | null };
    userId: string;
  },
): Promise<void> {
  const logs: Prisma.ChangeLogCreateManyInput[] = [];

  const propertyData = args.result.property;
  if (Object.keys(propertyData).length > 0) {
    await tx.property.update({
      where: { id: args.propertyId },
      data: { ...propertyData, version: { increment: 1 } },
    });
    for (const [field, value] of Object.entries(propertyData)) {
      logs.push({
        targetTable: "properties",
        targetId: args.propertyId,
        fieldName: field,
        oldValue: toLogValue(args.before.property[field]),
        newValue: toLogValue(value),
        source: "manual",
        changedBy: args.userId,
      });
    }
  }

  const buildingData = args.result.building;
  if (args.buildingId && Object.keys(buildingData).length > 0) {
    await tx.building.update({
      where: { id: args.buildingId },
      data: { ...buildingData, version: { increment: 1 } },
    });
    for (const [field, value] of Object.entries(buildingData)) {
      logs.push({
        targetTable: "buildings",
        targetId: args.buildingId,
        fieldName: field,
        oldValue: toLogValue(args.before.building?.[field]),
        newValue: toLogValue(value),
        source: "manual",
        changedBy: args.userId,
      });
    }
  }

  if (logs.length > 0) await tx.changeLog.createMany({ data: logs });
}

function toLogValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}
```

`route.ts` の変更点:

1. 物件の取得に、足した列と `version`・`building.id`・`building.version`・棟の列を加える(`select` に追記)。
2. `parseJsonBody` の後に、保存の指示を読む:

```ts
const saveToProperty = body?.saveToProperty !== false; // 既定ON
const propertyVersion = typeof body?.propertyVersion === "number" ? body.propertyVersion : null;
const buildingVersion = typeof body?.buildingVersion === "number" ? body.buildingVersion : null;
```

3. `createDesign(...)` を、次のトランザクションに置き換える:

```ts
const { design, writeback } = await prisma.$transaction(async (tx) => {
  // 親の行を先にロックする(物件配下を書き換えるときの既存の決まり)
  await tx.$queryRaw`SELECT id FROM properties WHERE id = ${id}::uuid FOR UPDATE`;
  if (property.building?.id) {
    await tx.$queryRaw`SELECT id FROM buildings WHERE id = ${property.building.id}::uuid FOR UPDATE`;
  }

  const created = await createDesign(
    { propertyId: id, document, userId: session.id, templateId },
    tx,
  );

  if (!saveToProperty) {
    return { design: created, writeback: { saved: [], unreadable: [], conflict: false } };
  }

  const conflict =
    (propertyVersion !== null && propertyVersion !== property.version) ||
    (buildingVersion !== null && property.building !== null && buildingVersion !== property.building.version);
  if (conflict) {
    return { design: created, writeback: { saved: [], unreadable: [], conflict: true } };
  }

  const result = buildWriteback({
    kind,
    values: body as Record<string, string | undefined>,
    current: { property, building: property.building ?? null },
  });
  await applyWriteback(tx, {
    propertyId: id,
    buildingId: property.building?.id ?? null,
    result,
    before: { property, building: property.building ?? null },
    userId: session.id,
  });
  return {
    design: created,
    writeback: { saved: labelsOf(kind, result), unreadable: result.unreadable, conflict: false },
  };
});
```

4. 応答を変える:

```ts
return NextResponse.json({ id: design.id, propertyWriteback: writeback }, { status: 201 });
```

5. `labelsOf` は `build-writeback.ts` から export する小関数(保存した列名 → 日本語ラベル):

```ts
export function labelsOf(kind: SalesSheetTemplateKind, result: WritebackResult): string[] {
  const out: string[] = [];
  for (const rule of RULES[kind]) {
    const bag = rule.to === "property" ? result.property : result.building;
    if (rule.column in bag) out.push(rule.label);
  }
  const builtBag = BUILT_TARGET[kind] === "building" ? result.building : result.property;
  if ("builtYear" in builtBag || "builtMonth" in builtBag) out.push(BUILT_LABEL);
  return out;
}
```

6. `createDesign` がトランザクションを受け取れるよう、`src/lib/sales-sheet/design-service.ts` の引数に省略可能な `tx?: Prisma.TransactionClient` を足し、内部の `prisma` を `tx ?? prisma` にする。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run "src/app/api/properties/[id]/sales-sheets/new"`
Expected: PASS(既存の route.test.ts も含めて緑)

- [ ] **Step 5: Commit**

```bash
git add src/lib/sales-sheet/property-writeback/apply-writeback.ts src/lib/sales-sheet/property-writeback/build-writeback.ts src/lib/sales-sheet/design-service.ts "src/app/api/properties/[id]/sales-sheets/new"
git commit -m "feat(sales-sheet): 図面作成時に物件・棟へ保存する(F3 Task4・同一トランザクション/変更履歴つき)"
```

---

### Task 5: 作成ダイアログに「物件にも保存する」を足す

**Files:**
- Modify: `src/components/sales-sheet/SalesSheetCreateButton.tsx`
- Test: `src/components/sales-sheet/__tests__/create-button-writeback.test.tsx`

**Interfaces:**
- Consumes: Task 4 の API 応答 `propertyWriteback`
- Produces: 作成後に `sessionStorage` へ `sales-sheet-writeback:<design id>` を残す(Task 6 が読む)

- [ ] **Step 1: Write the failing test**

`src/components/sales-sheet/__tests__/create-button-writeback.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SalesSheetCreateDialog } from "../SalesSheetCreateButton";

const base = {
  propertyId: "p1",
  kind: "mansion" as const,
  onClose: () => {},
  property: { version: 3, buildingName: "○○マンション", buildingUnitCount: 5, buildingVersion: 2 },
};

describe("作成ダイアログ — 物件にも保存する", () => {
  it("チェックは既定でON", () => {
    const html = renderToStaticMarkup(<SalesSheetCreateDialog {...base} />);
    expect(html).toContain("入れた値を物件にも保存する");
    expect(html).toMatch(/type="checkbox"[^>]*checked/);
  });

  it("区分で棟の項目を変えたときだけ、棟に反映される旨を出す", () => {
    const changed = renderToStaticMarkup(
      <SalesSheetCreateDialog {...base} initialValues={{ structure: "RC" }} />,
    );
    expect(changed).toContain("同じ棟の 5部屋");
    const untouched = renderToStaticMarkup(<SalesSheetCreateDialog {...base} />);
    expect(untouched).not.toContain("同じ棟の");
  });

  it("土地では棟の注意を出さない", () => {
    const html = renderToStaticMarkup(
      <SalesSheetCreateDialog {...base} kind="land" initialValues={{ price: "3480" }} />,
    );
    expect(html).not.toContain("同じ棟の");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/sales-sheet/__tests__/create-button-writeback.test.tsx`
Expected: FAIL(`SalesSheetCreateDialog` が export されていない / 文言が無い)

- [ ] **Step 3: Write minimal implementation**

1. ダイアログ部分を `export function SalesSheetCreateDialog(...)` として切り出す(テストから描画できるようにする)。
2. 状態を足す: `const [saveToProperty, setSaveToProperty] = useState(true);`
3. 入力欄の下、ボタンの上に置く:

```tsx
<label className="mt-3 flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
  <input
    type="checkbox"
    checked={saveToProperty}
    onChange={(e) => setSaveToProperty(e.target.checked)}
    className="h-4 w-4"
  />
  入れた値を物件にも保存する
</label>
{saveToProperty && kind === "mansion" && buildingFieldTouched && property.buildingUnitCount > 1 && (
  <p className="mt-1 pl-6 text-xs text-gray-600 dark:text-gray-400">
    構造・築年月などは棟「{property.buildingName}」の値です。同じ棟の {property.buildingUnitCount}部屋 にも反映されます。
  </p>
)}
```

`buildingFieldTouched` は、棟へ行く項目のどれかが入力されているか:

```tsx
const BUILDING_KEYS = ["structure", "totalFloors", "basementFloors", "totalUnits", "builtYearMonth"];
const buildingFieldTouched = BUILDING_KEYS.some((k) => (values[k] ?? "").trim() !== "");
```

4. **ダイアログに渡す物件の情報を増やす。** `GET /api/properties/[id]`(`src/app/api/properties/[id]/route.ts`)の `select` に次を足す(棟の部屋数=同じ棟に属する物件数):

```ts
version: true,
building: {
  select: {
    id: true,
    name: true,
    version: true,
    _count: { select: { properties: true } },
  },
},
```

呼び出し側(ダイアログを開く画面)は、その値を `property={{ version, buildingName: building?.name ?? "", buildingUnitCount: building?._count.properties ?? 0, buildingVersion: building?.version ?? null }}` の形で渡す。

5. `create()` の送信本文に足す:

```ts
body: JSON.stringify({
  ...values,
  saveToProperty,
  propertyVersion: property.version,
  buildingVersion: property.buildingVersion ?? undefined,
}),
```

6. 応答を受けたら、エディタへ移る前に知らせを残す:

```ts
const json = await res.json();
try {
  sessionStorage.setItem(`sales-sheet-writeback:${json.id}`, JSON.stringify(json.propertyWriteback));
} catch {
  // プライベートウィンドウ等では保存できない。知らせが出ないだけで作成は成功している。
}
router.push(`/sales-sheets/${json.id}`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/sales-sheet/__tests__/create-button-writeback.test.tsx`
Expected: PASS(3件)

- [ ] **Step 5: Commit**

```bash
git add src/components/sales-sheet/SalesSheetCreateButton.tsx src/components/sales-sheet/__tests__/create-button-writeback.test.tsx
git commit -m "feat(sales-sheet): 作成ダイアログに「物件にも保存する」と棟への反映の注意(F3 Task5)"
```

---

### Task 6: エディタ上部に保存結果を知らせる

**Files:**
- Create: `src/components/sales-sheet/editor/WritebackNotice.tsx`
- Modify: `src/components/sales-sheet/editor/SalesSheetEditor.tsx`
- Test: `src/components/sales-sheet/editor/__tests__/writeback-notice.test.tsx`

**Interfaces:**
- Consumes: Task 5 が `sessionStorage` に残した `{ saved: string[]; unreadable: string[]; conflict: boolean }`
- Produces: `WritebackNotice({ designId }: { designId: string })`

- [ ] **Step 1: Write the failing test**

`src/components/sales-sheet/editor/__tests__/writeback-notice.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { writebackMessages } from "../WritebackNotice";

describe("writebackMessages — 知らせの文言", () => {
  it("保存できた項目を並べる", () => {
    expect(writebackMessages({ saved: ["価格", "交通"], unreadable: [], conflict: false })).toEqual([
      "価格・交通を物件に保存しました",
    ]);
  });
  it("他の人が先に更新していたとき", () => {
    expect(writebackMessages({ saved: [], unreadable: [], conflict: true })).toEqual([
      "他の人が先に物件を更新していたため、物件には保存していません(図面は作成済みです)",
    ]);
  });
  it("読み取れなかった項目", () => {
    expect(writebackMessages({ saved: ["交通"], unreadable: ["価格", "築年月"], conflict: false })).toEqual([
      "交通を物件に保存しました",
      "価格・築年月は数値や年月として読み取れなかったため、物件には保存していません",
    ]);
  });
  it("何も無ければ空", () => {
    expect(writebackMessages({ saved: [], unreadable: [], conflict: false })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/sales-sheet/editor/__tests__/writeback-notice.test.tsx`
Expected: FAIL(`Failed to resolve import "../WritebackNotice"`)

- [ ] **Step 3: Write minimal implementation**

`src/components/sales-sheet/editor/WritebackNotice.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";

export type WritebackSummary = { saved: string[]; unreadable: string[]; conflict: boolean };

/** 知らせの文言(純関数・テストで固定する)。 */
export function writebackMessages(s: WritebackSummary): string[] {
  const out: string[] = [];
  if (s.saved.length > 0) out.push(`${s.saved.join("・")}を物件に保存しました`);
  if (s.conflict) {
    out.push("他の人が先に物件を更新していたため、物件には保存していません(図面は作成済みです)");
  }
  if (s.unreadable.length > 0) {
    out.push(`${s.unreadable.join("・")}は数値や年月として読み取れなかったため、物件には保存していません`);
  }
  return out;
}

export function WritebackNotice({ designId }: { designId: string }): React.ReactElement | null {
  const [messages, setMessages] = useState<string[]>([]);
  useEffect(() => {
    const key = `sales-sheet-writeback:${designId}`;
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return;
      sessionStorage.removeItem(key); // 一度だけ出す
      setMessages(writebackMessages(JSON.parse(raw) as WritebackSummary));
    } catch {
      // 読めないときは何も出さない
    }
  }, [designId]);

  if (messages.length === 0) return null;
  return (
    <div className="mb-2 rounded border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:border-blue-500 dark:bg-blue-900/30 dark:text-blue-100">
      <div className="flex items-start justify-between gap-2">
        <ul className="list-none space-y-0.5">
          {messages.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
        <button type="button" onClick={() => setMessages([])} className="shrink-0 text-xs underline">
          閉じる
        </button>
      </div>
    </div>
  );
}
```

`SalesSheetEditor.tsx` の一番外側の描画の先頭(ツールバーの上)に差し込む:

```tsx
<WritebackNotice designId={initial.designId} />
```

⚠ `initial` に図面の id が無ければ、props に `designId` を足して呼び出し元(エディタのページ)から渡す。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/sales-sheet/editor/__tests__/writeback-notice.test.tsx`
Expected: PASS(4件)

- [ ] **Step 5: Commit**

```bash
git add src/components/sales-sheet/editor/WritebackNotice.tsx src/components/sales-sheet/editor/SalesSheetEditor.tsx src/components/sales-sheet/editor/__tests__/writeback-notice.test.tsx
git commit -m "feat(sales-sheet): 作成後に物件への保存結果をエディタ上部で知らせる(F3 Task6)"
```

---

### Task 7: 物件編集画面に「販売」区分を足す

**Files:**
- Modify: `src/components/properties/property-edit-form.tsx`
- Test: `src/components/properties/__tests__/property-edit-sales-section.test.tsx`

**Interfaces:**
- Consumes: Task 3 の列
- Produces: なし(画面のみ)

- [ ] **Step 1: Write the failing test**

`src/components/properties/__tests__/property-edit-sales-section.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { salesFieldsFor } from "../property-edit-form";

describe("salesFieldsFor — 種別ごとに出す欄", () => {
  it("土地", () => {
    expect(salesFieldsFor("land").map((f) => f.key)).toEqual([
      "salePrice", "access", "landArea", "landAreaMethod",
    ]);
  });
  it("戸建", () => {
    expect(salesFieldsFor("house").map((f) => f.key)).toContain("totalFloorArea");
    expect(salesFieldsFor("house").map((f) => f.key)).toContain("builtYear");
    expect(salesFieldsFor("house").map((f) => f.key)).not.toContain("grossYield");
  });
  it("一棟は収益の欄も出す", () => {
    const keys = salesFieldsFor("apartment_building").map((f) => f.key);
    expect(keys).toContain("grossYield");
    expect(keys).toContain("expectedIncome");
    expect(keys).toContain("totalUnits");
  });
  it("区分は部屋の欄を出し、棟の欄は出さない", () => {
    const keys = salesFieldsFor("apartment_unit").map((f) => f.key);
    expect(keys).toContain("exclusiveArea");
    expect(keys).toContain("managementFee");
    expect(keys).not.toContain("structureType");
    expect(keys).not.toContain("totalUnits");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/properties/__tests__/property-edit-sales-section.test.tsx`
Expected: FAIL(`salesFieldsFor` が export されていない)

- [ ] **Step 3: Write minimal implementation**

`property-edit-form.tsx` に追記(既存の `FieldSpec` の形に合わせる):

```tsx
/** 「販売」区分に出す欄(物件の種別ごと)。仕様書 §5.1。 */
export function salesFieldsFor(propertyType: string): FieldSpec[] {
  const price: FieldSpec[] = [
    { key: "salePrice", label: "価格(万円)", type: "number", section: "販売" },
  ];
  const tax: FieldSpec[] = [
    { key: "saleTaxType", label: "消費税", type: "text", section: "販売" },
    { key: "saleTaxAmount", label: "うち消費税(万円)", type: "number", section: "販売" },
  ];
  const access: FieldSpec[] = [{ key: "access", label: "交通", type: "text", section: "販売" }];
  const land: FieldSpec[] = [
    { key: "landArea", label: "土地面積(㎡)", type: "number", section: "販売" },
    { key: "landAreaMethod", label: "面積計測方式", type: "text", section: "販売" },
  ];
  const buildingBody: FieldSpec[] = [
    { key: "totalFloorArea", label: "建物面積(延べ・㎡)", type: "number", section: "販売" },
    { key: "builtYear", label: "築年", type: "number", section: "販売" },
    { key: "builtMonth", label: "築月", type: "number", section: "販売" },
    { key: "structureType", label: "構造", type: "text", section: "販売" },
    { key: "aboveFloors", label: "地上階", type: "number", section: "販売" },
    { key: "basementFloors", label: "地下階", type: "number", section: "販売" },
    { key: "parking", label: "駐車場", type: "text", section: "販売" },
  ];
  switch (propertyType) {
    case "land":
      return [...price, ...access, ...land];
    case "house":
      return [...price, ...tax, ...access, ...land, ...buildingBody];
    case "apartment_building":
    case "apartment_block":
      return [
        ...price, ...tax, ...access, ...land, ...buildingBody,
        { key: "totalUnits", label: "総戸数", type: "number", section: "販売" },
        { key: "grossYield", label: "想定利回り(%)", type: "number", section: "販売" },
        { key: "expectedIncome", label: "満室想定収入(万円/年)", type: "number", section: "販売" },
      ];
    case "apartment_unit":
    case "unit":
      return [
        ...price, ...tax, ...access,
        { key: "exclusiveArea", label: "専有面積(㎡)", type: "number", section: "販売" },
        { key: "balconyArea", label: "バルコニー面積(㎡)", type: "number", section: "販売" },
        { key: "layoutType", label: "間取り", type: "text", section: "販売" },
        { key: "orientation", label: "向き", type: "text", section: "販売" },
        { key: "floorNo", label: "所在階", type: "number", section: "販売" },
        { key: "managementFee", label: "管理費(円/月)", type: "number", section: "販売" },
        { key: "repairReserveFee", label: "修繕積立金(円/月)", type: "number", section: "販売" },
        { key: "parking", label: "駐車場", type: "text", section: "販売" },
      ];
    default:
      return [];
  }
}
```

区分マンションのときだけ、「販売」区分の末尾に棟の値を読み取り専用で出す:

```tsx
{isMansionUnit && building && (
  <div className="mt-3 rounded border border-neutral-200 p-2 text-sm dark:border-neutral-700">
    <p className="mb-1 font-semibold">棟の項目(この画面では変更できません)</p>
    <p>構造 {building.structureType ?? "—"} / 地上階 {building.totalFloors ?? "—"} / 地下階 {building.basementFloors ?? "—"} / 総戸数 {building.totalUnits ?? "—"} / 築年月 {building.builtYear ?? "—"}年{building.builtMonth ?? "—"}月</p>
    <a href={`/buildings/${building.id}/edit`} className="text-blue-600 underline dark:text-blue-400">棟の画面で直す</a>
  </div>
)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/properties/__tests__/property-edit-sales-section.test.tsx`
Expected: PASS(4件)

- [ ] **Step 5: Commit**

```bash
git add src/components/properties/property-edit-form.tsx src/components/properties/__tests__/property-edit-sales-section.test.tsx
git commit -m "feat(properties): 物件編集画面に「販売」区分を足す(F3 Task7)"
```

---

### Task 8: 棟編集画面に「築月」「地下階」を足す

**Files:**
- Modify: `src/app/(dashboard)/buildings/[id]/page.tsx`(棟の詳細画面に編集フォームが直接書かれている。**176行目付近**=編集開始時の初期値、**219行目付近**=PATCH の本文、**310行目付近**=入力欄の定義、**389行目付近**=表示)
- Modify: `src/app/api/buildings/[id]/route.ts`(受け取る項目に2つ足す)
- Create: `src/app/api/buildings/[id]/__tests__/route-sales-fields.test.ts`(同フォルダの `unit-list-owner-visibility.test.ts` の mock の作り方に合わせる)

**Interfaces:**
- Consumes: Task 3 の `Building.builtMonth` / `Building.basementFloors`
- Produces: なし

- [ ] **Step 1: Write the failing test**

```ts
it("築月・地下階を更新できる", async () => {
  const res = await PATCH(
    new Request("http://localhost:3000/api/buildings/b1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ builtMonth: 3, basementFloors: 1 }),
    }),
    { params: Promise.resolve({ id: "b1" }) },
  );
  expect(res.status).toBe(200);
  expect(buildingUpdateMock.mock.calls[0][0].data).toMatchObject({ builtMonth: 3, basementFloors: 1 });
});

it("月は1〜12だけ受け付ける", async () => {
  const res = await PATCH(
    new Request("http://localhost:3000/api/buildings/b1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ builtMonth: 13 }),
    }),
    { params: Promise.resolve({ id: "b1" }) },
  );
  expect(res.status).toBe(422);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "src/app/api/buildings/[id]"`
Expected: FAIL(`builtMonth` が無視される / 422 にならない)

- [ ] **Step 3: Write minimal implementation**

`route.ts` の zod スキーマに足す:

```ts
builtMonth: z.number().int().min(1).max(12).nullable().optional(),
basementFloors: z.number().int().min(0).max(20).nullable().optional(),
```

`src/app/(dashboard)/buildings/[id]/page.tsx` の4か所を直す(既存の `totalFloors` と同じ書き方をなぞる):

1. 型(41行目付近)に `builtMonth: number | null;` と `basementFloors: number | null;` を足す
2. 編集開始時の初期値(176行目付近)に
   `builtMonth: building.builtMonth?.toString() ?? "", basementFloors: building.basementFloors?.toString() ?? "",`
3. PATCH の本文(219行目付近)に
   `builtMonth: editForm.builtMonth ? Number(editForm.builtMonth) : null, basementFloors: editForm.basementFloors ? Number(editForm.basementFloors) : null,`
4. 入力欄の定義(310行目付近の配列)に
   `{ key: "builtMonth", label: "築月", type: "number" },` を `builtYear` の直後へ、
   `{ key: "basementFloors", label: "地下階", type: "number" },` を `totalFloors` の直後へ
5. 表示(389行目付近)に `<InfoField label="地下階" value={building.basementFloors ? `${building.basementFloors}階` : null} />` を足し、築年の表示に月を添える

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run "src/app/api/buildings/[id]"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/buildings/[id]" src/components/buildings
git commit -m "feat(buildings): 棟に築月・地下階の欄を足す(F3 Task8)"
```

---

### Task 9: 仕上げ(全体の確認と提出前レビュー)

**Files:**
- Modify: なし(直しが出たら該当ファイル)

- [ ] **Step 1: 全ゲートを通す**

```bash
npx tsc --noEmit
npx vitest run
npx eslint $(git diff --name-only origin/main...HEAD | grep -E "\.(ts|tsx)$")
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build
```
Expected: 型0件・テスト全件緑・lint 0件・ビルド成功

- [ ] **Step 2: 提出前レビュー**

`git add -A` の後、`feature-dev:code-reviewer`(sonnet)に staged diff をレビューさせる。観点を明示する: 認可(`property:write` と `canAccessPropertyRecord` を棟の更新でも外していないか)/ トランザクションとロックの順序 / version の食い違いの扱い / 空欄で値を消していないか / `ChangeLog` に生の個人情報を入れていないか / 区分と一棟の保存先の取り違え / テストが実装をなぞっただけになっていないか。

- [ ] **Step 3: PR を出して外部レビューへ**

```bash
git push -u origin feat/sales-sheet-f3
gh pr create --title "feat(sales-sheet): 物件に「販売」の欄を作り、図面の入力を物件へ保存する(F3)" --body-file <本文>
gh pr comment <PR番号> --body "@codex review"
```

本文には、仕様書の要点(§2 の発注者判断・§4 のデータ・§6 の保存の流れ)と、**データベースの変更が入ること**、反映時に `prisma migrate deploy` が要ることを書く。

- [ ] **Step 4: レビュー対応 → マージ(発注者)→ 反映(別承認)**

指摘は1件ずつ実コードで確かめてから直す(残像は根拠を記録して除外)。マージは発注者。本番反映は `vps-deploy` スキルに従い、**migration の適用を含む**ことを伝えてから行う。
