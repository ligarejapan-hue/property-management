# 販売図面 自社様式化 F1(売マンション) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 売マンションの販売図面ひな型を御社マイソク様式(全項目・正しい入力方式・条件付き行・複数選択の併記)に作り直し、他種別へ横展開できる共通機構(選択肢マスタ・入力方式モデル・行生成純ロジック)を整備する。

**Architecture:** 宣言的な「フィールド定義(field-model)」＋「選択肢マスタ(option-master)」を新設し、そこから ①スペック表の行を組む純ロジック(sheet-rows: 単位付与・条件スキップ・複数選択の併記) を作る。既存 `build-document.ts` の `buildSaleMansionDocument` を、この行生成＋レイアウト要素(キャッチ帯/写真/セールスポイント/間取り枠/会社フッター)で作り直す。作成ダイアログ(`SalesSheetCreateButton.tsx`)と route の override schema を field-model 駆動に拡張する。ドキュメント部品は既存の text/image/table/shape/qr のみ(新規 element 型なし)。

**Tech Stack:** Next.js(App Router)/ React client component / TypeScript / Zod / vitest(env=node) / 既存 sales-sheet ドキュメントモデル(mm 絶対配置・A4横)。

## Global Constraints

- **既存ドキュメント部品のみ使用**(`text`/`image`/`table`/`shape`/`qr`/`badge`)。新規 element 型・schema 変更なし。`document-schema.ts` は不変。
- **schema/migration/新規依存の追加なし**(F1は物件データ変更なし。価格・交通・面積等は作成ダイアログの手入力)。
- **決め事(実装の正)**: 価格=万円・数値・単位固定 / 消費税=課税・不課税の選択(課税時のみ「うち消費税」行) / 借地料・想定利回り=あり・なしで行の表示切替 / 地目・接道状況・地域地区・都市計画・用途地域=複数選択(チェック)で図面へ**併記**(区切り" / ") / プルダウン選択肢は御社Excel「物件情報項目リスト」準拠。
- **レイアウト**: キャッチ=上部横帯(写真・間取りの上/右スペック表の上には乗せない)、左=写真＋セールスポイント(◆)＋QR、中=間取り枠、右=スペック表、下=会社フッター。
- **二重レンダラparity厳守**: `SalesSheetRenderer.tsx` と `render-html.ts` は別実装。要素の使い方を変えたら両方＋parityテストを更新。
- **座標(mm)は実サンプル(西荻リリエンハイム407)と突き合わせて調整**(A4横 297×210)。溢れはフォント/改行で吸収。
- 全ゲート: `tsc` 0 / full `vitest run` 緑 / `next build` / eslint 差分0。commit末尾に co-author + session 行。
- worktree: `property-management-worktrees/sales-sheet-mansion-template` / branch: `feat/sales-sheet-mansion-template`。

---

### Task 1: 選択肢マスタ `option-master.ts`(純・定数)

**Files:**
- Create: `src/lib/sales-sheet/option-master.ts`
- Test: `src/lib/sales-sheet/__tests__/option-master.test.ts`

**Interfaces:**
- Produces: 各選択肢を `readonly string[]` で export。少なくとも `PROPERTY_TYPE_MANSION`, `LAND_RIGHT`, `USE_DISTRICT`, `BUILDING_STRUCTURE`, `AREA_METHOD_MANSION`, `BALCONY_DIRECTION`, `PARKING_MANSION`, `MANAGEMENT_UNION`, `MANAGEMENT_FORM`, `MANAGER_STATUS`, `OCCUPANCY`, `DELIVERY_TIMING`, `LAND_CATEGORY`, `TERRAIN`, `CITY_PLANNING`, `AREA_ZONE`, `ROAD_KIND`, `ROAD_POSITION`, `TRANSACTION_TYPE`, `COMPENSATION`, `AD_TYPE`, `TAX`(課税/不課税), `PRESENCE`(あり/なし)。

- [ ] **Step 1: Write the failing test**

`__tests__/option-master.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import * as M from "../option-master";

describe("option-master", () => {
  it("御社Excel準拠の選択肢を持つ", () => {
    expect(M.USE_DISTRICT).toContain("第一種低層住居専用地域");
    expect(M.USE_DISTRICT).toContain("近隣商業地域");
    expect(M.USE_DISTRICT.length).toBe(13);
    expect(M.BUILDING_STRUCTURE).toEqual([
      "木造","ブロック","鉄骨造","RC","SRC","PC","HPC","軽量鉄骨","その他",
    ]);
    expect(M.AREA_METHOD_MANSION).toEqual(["壁芯","内法"]);
    expect(M.MANAGEMENT_FORM).toEqual(["自主管理","一部委託","全部委託"]);
    expect(M.MANAGER_STATUS).toEqual(["常駐","日勤","巡回"]);
    expect(M.PARKING_MANSION).toEqual(["空有","空無","近隣確保","無"]);
    expect(M.TAX).toEqual(["課税","不課税"]);
    expect(M.PRESENCE).toEqual(["あり","なし"]);
    expect(M.LAND_CATEGORY).toContain("宅地");
    expect(M.CITY_PLANNING).toContain("市街化区域");
    expect(M.AREA_ZONE).toContain("防火");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "C:/Users/issin/Desktop/Claude/property-management-worktrees/sales-sheet-mansion-template" && npx vitest run src/lib/sales-sheet/__tests__/option-master.test.ts`
Expected: FAIL(`Cannot find module '../option-master'`)

- [ ] **Step 3: Write minimal implementation**

`src/lib/sales-sheet/option-master.ts`:
```ts
/**
 * 販売図面の選択肢マスタ。御社Excel「物件情報項目リスト」準拠。
 * F1は売マンションで使う分。他種別の追加分はF2で足す。
 */
export const PROPERTY_TYPE_MANSION = [
  "新築マンション","中古マンション","新築タウンハウス","中古タウンハウス",
  "新築リゾート","中古リゾート","その他",
] as const;
export const LAND_RIGHT = [
  "所有権","（旧法）地上権","（旧法）賃借権",
  "普通借地権（地上権）","定期借地権（地上権）",
  "普通借地権（賃借権）","定期借地権（賃借権）",
] as const;
export const USE_DISTRICT = [
  "第一種低層住居専用地域","第二種低層住居専用地域",
  "第一種中高層住居専用地域","第二種中高層住居専用地域",
  "第一種住居地域","第二種住居地域","準住居地域",
  "近隣商業地域","商業地域","準工業地域","工業地域","工業専用地域","無指定",
] as const;
export const BUILDING_STRUCTURE = ["木造","ブロック","鉄骨造","RC","SRC","PC","HPC","軽量鉄骨","その他"] as const;
export const AREA_METHOD_MANSION = ["壁芯","内法"] as const;
export const BALCONY_DIRECTION = ["北","北東","東","南東","南","南西","西","北西"] as const;
export const PARKING_MANSION = ["空有","空無","近隣確保","無"] as const;
export const MANAGEMENT_UNION = ["有","無"] as const;
export const MANAGEMENT_FORM = ["自主管理","一部委託","全部委託"] as const;
export const MANAGER_STATUS = ["常駐","日勤","巡回"] as const;
export const OCCUPANCY = ["居住中","空家","賃貸中","未完成"] as const;
export const DELIVERY_TIMING = ["即時","相談","期日指定","予定"] as const;
export const LAND_CATEGORY = ["宅地","田","畑","山林","雑種地","その他"] as const;
export const TERRAIN = ["平坦","高台","低地","ひな段","傾斜地","その他"] as const;
export const CITY_PLANNING = ["市街化区域","市街化調整区域","未線引区域","都市計画区域外","準都市"] as const;
export const AREA_ZONE = ["防火","準防火","高度","高度利用","風致","文教","その他"] as const;
export const ROAD_KIND = ["公道","私道"] as const;
export const ROAD_POSITION = ["有","無"] as const;
export const TRANSACTION_TYPE = ["売主","代理","専属専任","専任","一般媒介"] as const;
export const COMPENSATION = ["分かれ","当方不払","当方片手","代理折半","相談"] as const;
export const AD_TYPE = ["広告可","一部可ネット","一部可新聞チラシ","広告可要連絡","不可"] as const;
export const TAX = ["課税","不課税"] as const;
export const PRESENCE = ["あり","なし"] as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "C:/Users/issin/Desktop/Claude/property-management-worktrees/sales-sheet-mansion-template" && npx vitest run src/lib/sales-sheet/__tests__/option-master.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/issin/Desktop/Claude/property-management-worktrees/sales-sheet-mansion-template" && git add src/lib/sales-sheet/option-master.ts src/lib/sales-sheet/__tests__/option-master.test.ts && git commit -m "$(cat <<'EOF'
feat(sales-sheet): 選択肢マスタ(御社Excel準拠)

売マンションで使うプルダウン選択肢を定数化。他種別はF2で追加。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PCtd5pRJdLHnBF9QrciQZc
EOF
)"
```

---

### Task 2: 入力方式モデル `field-model.ts`(純・宣言的定義)

**Files:**
- Create: `src/lib/sales-sheet/field-model.ts`
- Test: `src/lib/sales-sheet/__tests__/field-model.test.ts`

**Interfaces:**
- Consumes: `option-master.ts` の選択肢。
- Produces:
  - `type FieldWidget = "select"|"multiselect"|"toggle"|"text"|"number"`
  - `interface SheetField { key; label; widget; section; options?; unit?; autoFrom?; controlOnly?; showWhen? }`
    - `showWhen?: { field: string; equals: string }` — 条件付き表示(該当時のみ行を出す)
    - `controlOnly?: boolean` — 作成ダイアログにのみ出し、スペック表の行にはしない(消費税の課税/不課税・借地料有無 等の制御用)
    - `autoFrom?: string` — 物件データの自動反映元キー
  - `const MANSION_FIELDS: readonly SheetField[]` — 売マンションの全フィールド(セクション順)

- [ ] **Step 1: Write the failing test**

`__tests__/field-model.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { MANSION_FIELDS, type SheetField } from "../field-model";
import { USE_DISTRICT, TAX } from "../option-master";

const byKey = (k: string): SheetField | undefined => MANSION_FIELDS.find((f) => f.key === k);

describe("MANSION_FIELDS", () => {
  it("価格は number・万円固定", () => {
    const price = byKey("price");
    expect(price?.widget).toBe("number");
    expect(price?.unit).toBe("万円");
  });
  it("用途地域は multiselect・選択肢マスタ・自動反映元zoningDistrict", () => {
    const y = byKey("useDistrict");
    expect(y?.widget).toBe("multiselect");
    expect(y?.options).toEqual(USE_DISTRICT);
    expect(y?.autoFrom).toBe("zoningDistrict");
  });
  it("消費税はselect(課税/不課税)・controlOnly(表の行にしない)", () => {
    const t = byKey("tax");
    expect(t?.widget).toBe("select");
    expect(t?.options).toEqual(TAX);
    expect(t?.controlOnly).toBe(true);
  });
  it("うち消費税は税=課税のときだけ表示", () => {
    const s = byKey("taxAmount");
    expect(s?.showWhen).toEqual({ field: "tax", equals: "課税" });
    expect(s?.unit).toBe("万円");
  });
  it("複数選択の5項目はすべてmultiselect", () => {
    for (const k of ["landCategory","road","areaZone","cityPlanning","useDistrict"]) {
      expect(byKey(k)?.widget, k).toBe("multiselect");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "C:/Users/issin/Desktop/Claude/property-management-worktrees/sales-sheet-mansion-template" && npx vitest run src/lib/sales-sheet/__tests__/field-model.test.ts`
Expected: FAIL(`Cannot find module '../field-model'`)

- [ ] **Step 3: Write minimal implementation**

`src/lib/sales-sheet/field-model.ts`(セクション順・売マンション。`section` は "価格"/"所在"/"土地"/"建物"/"設備"/"会社"):
```ts
import * as M from "./option-master";

export type FieldWidget = "select" | "multiselect" | "toggle" | "text" | "number";

export interface SheetField {
  key: string;
  label: string;
  widget: FieldWidget;
  section: string;
  options?: readonly string[];
  unit?: string;
  autoFrom?: string;      // 物件データ自動反映元
  controlOnly?: boolean;  // ダイアログのみ(表の行にしない)
  showWhen?: { field: string; equals: string };
}

export const MANSION_FIELDS: readonly SheetField[] = [
  // 価格・費用
  { key: "propertyType", label: "物件種目", widget: "select", section: "価格", options: M.PROPERTY_TYPE_MANSION, autoFrom: "propertyType" },
  { key: "buildingName", label: "建物名称", widget: "text", section: "価格", autoFrom: "buildingName" },
  { key: "price", label: "価格", widget: "number", section: "価格", unit: "万円" },
  { key: "unitPrice", label: "㎡単価", widget: "number", section: "価格", unit: "万円" },
  { key: "tax", label: "消費税", widget: "select", section: "価格", options: M.TAX, controlOnly: true },
  { key: "taxAmount", label: "うち消費税", widget: "number", section: "価格", unit: "万円", showWhen: { field: "tax", equals: "課税" } },
  { key: "managementFee", label: "管理費", widget: "number", section: "価格", unit: "円/月", autoFrom: "managementFee" },
  { key: "repairFee", label: "修繕積立金", widget: "number", section: "価格", unit: "円/月", autoFrom: "repairReserveFee" },
  // 所在・交通
  { key: "address", label: "所在地", widget: "text", section: "所在", autoFrom: "address" },
  { key: "access", label: "交通", widget: "text", section: "所在" },
  // 土地・権利
  { key: "siteArea", label: "敷地面積", widget: "number", section: "土地", unit: "㎡" },
  { key: "siteRightRatio", label: "敷地権割合共有持分", widget: "text", section: "土地" },
  { key: "landRight", label: "土地権利", widget: "select", section: "土地", options: M.LAND_RIGHT },
  { key: "useDistrict", label: "用途地域", widget: "multiselect", section: "土地", options: M.USE_DISTRICT, autoFrom: "zoningDistrict" },
  // 建物
  { key: "areaMethod", label: "面積計測方式", widget: "select", section: "建物", options: M.AREA_METHOD_MANSION, controlOnly: true },
  { key: "exclusiveArea", label: "専有面積", widget: "number", section: "建物", unit: "㎡", autoFrom: "exclusiveArea" },
  { key: "balconyArea", label: "バルコニー面積", widget: "number", section: "建物", unit: "㎡", autoFrom: "balconyArea" },
  { key: "balconyDir", label: "バルコニー向き", widget: "select", section: "建物", options: M.BALCONY_DIRECTION, autoFrom: "orientation" },
  { key: "layout", label: "間取り", widget: "text", section: "建物", autoFrom: "layoutType" },
  { key: "structure", label: "建物構造", widget: "select", section: "建物", options: M.BUILDING_STRUCTURE, autoFrom: "structureType" },
  { key: "floorNo", label: "所在階", widget: "number", section: "建物", unit: "階", autoFrom: "floorNo" },
  { key: "totalFloors", label: "地上階", widget: "number", section: "建物", unit: "階", autoFrom: "totalFloors" },
  { key: "basementFloors", label: "地下階", widget: "number", section: "建物", unit: "階" },
  { key: "builtYearMonth", label: "築年月", widget: "text", section: "建物", autoFrom: "builtYear" },
  { key: "totalUnits", label: "総戸数", widget: "number", section: "建物", unit: "戸", autoFrom: "totalUnits" },
  { key: "parking", label: "駐車場", widget: "select", section: "建物", options: M.PARKING_MANSION },
  { key: "parkingFee", label: "駐車場月額", widget: "number", section: "建物", unit: "円/月" },
  // 設備・現況・管理
  { key: "equipment", label: "設備・条件", widget: "text", section: "設備" },
  { key: "legalRestriction", label: "その他法令上の制限", widget: "text", section: "設備" },
  { key: "managementUnion", label: "管理組合", widget: "select", section: "設備", options: M.MANAGEMENT_UNION },
  { key: "managementForm", label: "管理形態", widget: "select", section: "設備", options: M.MANAGEMENT_FORM },
  { key: "managerStatus", label: "管理人状況", widget: "select", section: "設備", options: M.MANAGER_STATUS },
  { key: "managementCompany", label: "管理会社", widget: "text", section: "設備", autoFrom: "managementCompany" },
  { key: "developer", label: "分譲会社", widget: "text", section: "設備" },
  { key: "builder", label: "施工会社", widget: "text", section: "設備" },
  { key: "occupancy", label: "現況", widget: "select", section: "設備", options: M.OCCUPANCY, autoFrom: "occupancyStatus" },
  { key: "delivery", label: "引渡時期", widget: "select", section: "設備", options: M.DELIVERY_TIMING },
  { key: "remarks", label: "備考", widget: "text", section: "設備" },
];
```
(注: 上記5つの複数選択のうち、マンションは `useDistrict` のみ該当。地目/接道/地域地区/都市計画は土地・戸建・住宅以外で使う=F2。テストの "landCategory/road/areaZone/cityPlanning" 参照はF2で有効化するため、Step1のテストからそれらの行を削り `useDistrict` のみに絞ること。)

- [ ] **Step 4: 実装に合わせテストを是正して PASS**

Step1のテスト「複数選択の5項目」を、マンションに実在する `useDistrict` のみの検証に直す(他4キーはF2)。
Run: `... npx vitest run src/lib/sales-sheet/__tests__/field-model.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/issin/Desktop/Claude/property-management-worktrees/sales-sheet-mansion-template" && git add src/lib/sales-sheet/field-model.ts src/lib/sales-sheet/__tests__/field-model.test.ts && git commit -m "$(cat <<'EOF'
feat(sales-sheet): 入力方式モデル(売マンションのフィールド定義)

widget/選択肢/単位/自動反映元/条件付き表示 を宣言的に定義。ダイアログと
図面ビルダーが同じ定義を読む土台。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PCtd5pRJdLHnBF9QrciQZc
EOF
)"
```

---

### Task 3: 行生成 純ロジック `sheet-rows.ts`

**Files:**
- Create: `src/lib/sales-sheet/sheet-rows.ts`
- Test: `src/lib/sales-sheet/__tests__/sheet-rows.test.ts`

**Interfaces:**
- Consumes: `SheetField`(field-model)。
- Produces:
  - `type SheetValue = string | string[] | undefined`(text/select/number=string、multiselect=string[])
  - `type SheetValues = Record<string, SheetValue>`
  - `buildSheetRows(fields: readonly SheetField[], values: SheetValues): { label: string; value: string }[]`
    - `controlOnly` の行は出さない
    - `showWhen` 条件を満たさない行は出さない
    - `multiselect` は選択配列を `" / "` で併記
    - `number` の `unit` は値の末尾に付ける(値が空なら空文字・単位も付けない)
    - それ以外は文字列そのまま(空は "")

- [ ] **Step 1: Write the failing test**

`__tests__/sheet-rows.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildSheetRows, type SheetValues } from "../sheet-rows";
import type { SheetField } from "../field-model";

const fields: SheetField[] = [
  { key: "price", label: "価格", widget: "number", section: "価格", unit: "万円" },
  { key: "tax", label: "消費税", widget: "select", section: "価格", controlOnly: true },
  { key: "taxAmount", label: "うち消費税", widget: "number", section: "価格", unit: "万円", showWhen: { field: "tax", equals: "課税" } },
  { key: "useDistrict", label: "用途地域", widget: "multiselect", section: "土地" },
  { key: "remarks", label: "備考", widget: "text", section: "設備" },
];

it("number は単位付与、multiselect は併記、controlOnly は除外", () => {
  const values: SheetValues = {
    price: "6590", tax: "課税", taxAmount: "120",
    useDistrict: ["第一種住居地域", "近隣商業地域"], remarks: "角部屋",
  };
  const rows = buildSheetRows(fields, values);
  expect(rows).toEqual([
    { label: "価格", value: "6590万円" },
    { label: "うち消費税", value: "120万円" },
    { label: "用途地域", value: "第一種住居地域 / 近隣商業地域" },
    { label: "備考", value: "角部屋" },
  ]);
});

it("不課税なら うち消費税 行を出さない", () => {
  const rows = buildSheetRows(fields, { price: "4780", tax: "不課税" });
  expect(rows.map((r) => r.label)).not.toContain("うち消費税");
});

it("空値は空文字・単位を付けない", () => {
  const rows = buildSheetRows(fields, {});
  expect(rows.find((r) => r.label === "価格")?.value).toBe("");
  expect(rows.find((r) => r.label === "用途地域")?.value).toBe("");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `... npx vitest run src/lib/sales-sheet/__tests__/sheet-rows.test.ts`
Expected: FAIL(module not found)

- [ ] **Step 3: Write minimal implementation**

`src/lib/sales-sheet/sheet-rows.ts`:
```ts
import type { SheetField } from "./field-model";

export type SheetValue = string | string[] | undefined;
export type SheetValues = Record<string, SheetValue>;

function formatValue(field: SheetField, v: SheetValue): string {
  if (field.widget === "multiselect") {
    return Array.isArray(v) ? v.filter(Boolean).join(" / ") : "";
  }
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return "";
  return field.unit ? `${s}${field.unit}` : s;
}

export function buildSheetRows(
  fields: readonly SheetField[],
  values: SheetValues,
): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  for (const f of fields) {
    if (f.controlOnly) continue;
    if (f.showWhen) {
      const ctrl = values[f.showWhen.field];
      if ((typeof ctrl === "string" ? ctrl : "") !== f.showWhen.equals) continue;
    }
    rows.push({ label: f.label, value: formatValue(f, values[f.key]) });
  }
  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `... npx vitest run src/lib/sales-sheet/__tests__/sheet-rows.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/issin/Desktop/Claude/property-management-worktrees/sales-sheet-mansion-template" && git add src/lib/sales-sheet/sheet-rows.ts src/lib/sales-sheet/__tests__/sheet-rows.test.ts && git commit -m "$(cat <<'EOF'
feat(sales-sheet): スペック表 行生成の純ロジック

フィールド定義＋値から表の行を生成(単位付与・条件付き表示スキップ・
複数選択の併記・controlOnly除外)。TDDで境界を固定。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PCtd5pRJdLHnBF9QrciQZc
EOF
)"
```

---

### Task 4: 売マンション ビルダー作り直し `build-document.ts`

**Files:**
- Modify: `src/lib/sales-sheet/build-document.ts`(`buildSaleMansionDocument` を作り直し・`SaleMansionInput`/`SaleMansionOverrides` を拡張)
- Test: `src/lib/sales-sheet/__tests__/build-mansion.test.ts`(新規)

**Interfaces:**
- Consumes: `MANSION_FIELDS`(field-model)、`buildSheetRows`(sheet-rows)、既存の element 構築/`baseSheet` 系。
- Produces: `buildSaleMansionDocument(input)` が、キャッチ帯(shape+text)・写真・セールスポイント(text)・間取り枠(image プレースホルダは任意)・**全項目のスペック表**・会社フッターを含む `SalesSheetDocument` を返す。

**設計メモ(実装者向け):**
- 既存 `build-document.ts` を読むこと(`row()`, `baseSheet()`, `photoElements()`, `COMPANY`, `NAVY/RED/FONT`, formatter 群, element の作り方が全てそこにある)。
- `SaleMansionInput.overrides` を **field-model の手入力キーを網羅**する形へ拡張(price, unitPrice, tax, taxAmount, access, siteArea, siteRightRatio, landRight, useDistrict(string[]), areaMethod, basementFloars→basementFloors, builtYearMonth, parking, parkingFee, equipment, legalRestriction, managementUnion, managementForm, managerStatus, developer, builder, delivery, remarks, transactionType, compensation, adType, staff, license特記…)。`property`/`building` に自動反映元(managementCompany, totalUnits を追加)を足す。
- **行の組み立ては `buildSheetRows(MANSION_FIELDS, values)` に委譲**。`values` は「自動反映(property/building/photos由来)」を初期に入れ、`overrides` で上書きした Record。用途地域は `zoningDistrict` を配列先頭に入れ、overrides の追加選択を足す。
- **レイアウト**(既存 `baseSheet` を土台に拡張、座標は実サンプルで調整):
  - キャッチ帯: `shape`(rect・NAVY・上部横帯 例 x10 y6 w180 h16)＋`text`(キャッチ・白/濃紺・上部)。**右スペック表(x150〜)には重ねない**。
  - スペック表: `table`(右・x150 付近・全行)。行が多いので `fontSizePt` を下げ `h` を拡大。
  - 写真: 既存 `photoElements`(左)。セールスポイント: `text`(◆区切り・左下)。
  - 会社フッター: 既存 `company` text を、免許/連絡先を含む下部帯へ拡張(F1は `COMPANY` 定数ベース＋手入力の取引態様/担当/特記を追記)。
- **条件付き行/併記は sheet-rows が担うのでビルダーは値を渡すだけ**。

- [ ] **Step 1: Write the failing test**（要点のみ・実装者が肉付け）

`__tests__/build-mansion.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildSaleMansionDocument } from "../build-document";

const base = {
  property: { address: "東京都杉並区西荻北1-4-3", zoningDistrict: "第一種中高層住居専用地域",
    exclusiveArea: "67.21", layoutType: "3LDK", occupancyStatus: "vacant" },
  building: { name: "西荻リリエンハイム", totalFloors: 7, builtYear: 1972, structureType: "RC" },
  photos: [{ fileUrl: "/uploads/a.jpg" }],
};

it("スペック表に主要行が入り、キャッチ帯要素を含む", () => {
  const doc = buildSaleMansionDocument({ ...base, overrides: { price: "6590", tax: "不課税", catchCopy: "北東角部屋" } });
  const table = doc.elements.find((e) => e.type === "table");
  const labels = table && table.type === "table" ? table.rows.map((r) => r.label) : [];
  expect(labels).toContain("用途地域");
  expect(labels).toContain("専有面積");
  expect(labels).not.toContain("うち消費税"); // 不課税
  // キャッチ帯(shape or text)が存在
  expect(doc.elements.some((e) => e.type === "shape")).toBe(true);
  expect(doc.elements.some((e) => e.type === "text" && e.content.includes("北東角部屋"))).toBe(true);
});

it("課税ならうち消費税行が出る", () => {
  const doc = buildSaleMansionDocument({ ...base, overrides: { price: "6590", tax: "課税", taxAmount: "300" } });
  const table = doc.elements.find((e) => e.type === "table");
  const labels = table && table.type === "table" ? table.rows.map((r) => r.label) : [];
  expect(labels).toContain("うち消費税");
});
```

- [ ] **Step 2: RED を確認**(`... npx vitest run src/lib/sales-sheet/__tests__/build-mansion.test.ts` → 失敗)
- [ ] **Step 3: `buildSaleMansionDocument` を作り直す**(上記設計メモに沿って。既存の他ビルダーは壊さない。`SaleMansionInput`/`Overrides` 拡張・自動反映値の Record 化・`buildSheetRows` 委譲・キャッチ帯/フッター要素追加。)
- [ ] **Step 4: GREEN 確認 ＋ 既存 sales-sheet テストが緑**（`... npx vitest run src/lib/sales-sheet` フル）
- [ ] **Step 5: Commit**（`feat(sales-sheet): 売マンション図面を自社様式に作り直し` ＋ trailer）

---

### Task 5: 作成ダイアログ＋route を field-model 駆動に

**Files:**
- Modify: `src/components/sales-sheet/SalesSheetCreateButton.tsx`(マンションの `FIELD_SETS` を field-model 由来の widget 描画へ)
- Modify: `src/app/api/properties/[id]/sales-sheets/new/route.ts`(マンションの override schema を拡張・追加の自動反映 select・`buildSaleMansionDocument` へ受け渡し)
- Test: `src/components/sales-sheet/__tests__/mansion-dialog.test.tsx`(SSR 構造)

**設計メモ:**
- 既存 `SalesSheetCreateButton.tsx`(FIELD_SETS 18-74・buildCreateRequest・dialog 99-192)と `new/route.ts`(override schema 28-70・seedPhotos・builder 呼び出し 156-235)を読むこと。
- ダイアログ: マンション種別のとき `MANSION_FIELDS` を読み、`controlOnly` 含む手入力/選択フィールドを widget 別に描画(select=`<select>`、multiselect=チェック群、number=単位表示付き `<input>`、text=`<input>`、`showWhen` 未達は非表示)。`autoFrom` があるものは初期値を自動反映値で埋める。
- route: マンションの override を field-model の手入力キーに合わせて Zod で受ける(multiselect=string[]、他=string 任意)。`property` select に `building.managementCompany`/`totalUnits` を追加取得。
- env=node のため SSR 構造テストのみ(widget が出るか・単位表示・初期値)。クリック/state はレビューで担保。

- [ ] **Step 1: SSR テストを書く**（ダイアログが select/checkbox/number(単位) を描画・showWhen 初期非表示 をアサート）
- [ ] **Step 2: RED 確認**
- [ ] **Step 3: 実装**（ダイアログの field-model 駆動化＋route schema 拡張。他種別の既存挙動は不変に保つ）
- [ ] **Step 4: `tsc` 0 ＋ フル `vitest run` 緑 ＋ 変更ファイル eslint 差分0**
- [ ] **Step 5: Commit**

---

### Task 6: 二重レンダラ parity ＋ 全ゲート ＋ 提出前レビュー ＋ PR

**Files:**
- Verify/Modify: `src/lib/sales-sheet/render-html.ts` と `src/components/sales-sheet/SalesSheetRenderer.tsx`（新規要素の使い方があれば両方＋parityテスト更新。今回は既存 element 型のみのため多くは変更不要のはず=parityテストで確認）

- [ ] **Step 1: フルゲート** — `npx tsc --noEmit` / `npx vitest run`(フル) / `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build` / `npx eslint <変更ファイル>`。parity テスト(`render-html-parity.test.ts` 系)が緑であること。
- [ ] **Step 2: 提出前レビュー** — `git add -A` 後 `feature-dev:code-reviewer`(sonnet) に staged diff を。ホットスポット: **二重レンダラparity**(SalesSheetRenderer と render-html)、保存境界(`assertSavableDocument`)、画像認可(写真 src)、条件付き行/併記の正しさ、他種別ビルダー(土地/戸建/一棟)の非回帰、テスト妥当性。指摘は新commitで対応。
- [ ] **Step 3: push & PR** — `git push -u origin feat/sales-sheet-mansion-template` → `gh pr create --title "feat(sales-sheet): 売マンション図面を自社マイソク様式に作り込み(F1)" --body "<平易な日本語: Summary/実装/テスト/セキュリティ>"`(末尾 🤖 行)。
- [ ] **Step 4: @codex 起動** — `gh pr comment <PR> --body "@codex review"`。以降は codex-triage スキル。マージはユーザー。

---

## Self-Review(計画作成者による点検)

- **Spec coverage**: 選択肢マスタ(T1)/入力方式モデル(T2)/行生成:条件・併記・単位(T3)/マンション版面:レイアウト・全項目(T4)/ダイアログ・route の field-model 駆動(T5)/parity・ゲート・PR(T6) = 設計書F1の各要素に対応。F2-4 はスコープ外(設計書に道筋)。
- **Placeholder scan**: T1-3 は完全コード。T4-5 は「大規模な既存ファイル改修＋実サンプル合わせのレイアウト」のため、**インターフェース・値・テスト期待値・既存コード参照・設計メモを具体化**し、逐語コードは pure ロジック(T1-3)に集中。座標調整は実装時に実サンプルと突き合わせる旨を明記(仕様の性質上、mm 座標は事前確定不可)。
- **Type consistency**: `SheetField`/`FieldWidget`/`buildSheetRows`/`SheetValues`/`MANSION_FIELDS`/`option-master` の export 名を T 間で一致。`buildSaleMansionDocument` は既存シグネチャを拡張(overrides 追加)し他ビルダーと非干渉。
- **既知の割り切り**: 用途地域の複数選択は「自動1つ＋手動追加」(データは単一)。会社情報はハードコード据置(F4で設定化)。地図/QR自動生成・面積按分は後フェーズ。
