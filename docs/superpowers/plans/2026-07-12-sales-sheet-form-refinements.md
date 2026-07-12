# 販売図面 作成フォーム改善（坪単価/その他自由入力/報酬）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 販売図面の作成ダイアログを3点改善する — ①売土地の「坪/㎡単価」を「坪単価」に統一し土地面積から自動計算（小数第1位・手動上書き可）、②「その他」を持つ選択欄すべてで自由入力、③報酬を新選択肢＋自由入力（コンボボックス）。

**Architecture:** 既存の宣言的 field-model（`SheetField`）駆動ダイアログ（`SalesSheetCreateButton.tsx` の `FieldModelWidget`/`FieldModelForm`）＋ ビルダー（`build-document.ts`）＋ 行組み（`sheet-rows.ts`）を拡張。坪単価は新規純関数、その他自由入力は純関数の値ロジック＋ウィジェット分岐、報酬は新 widget 種別 `combo`（datalist）。サーバ zod は既に string/array 許容のため**スキーマ変更なし**。

**Tech Stack:** TypeScript / Next.js / Vitest（env=node・`renderToStaticMarkup`＋文字列assert、クリック等の対話は対象外＝レビュー担保）。

## Global Constraints
- 既存の element 種別・二重レンダラ（`SalesSheetRenderer.tsx`/`render-html.ts`）は無改修。
- サーバ zod（`sales-sheets/new/route.ts`）は変更しない（`compensation`=`z.string().max(200)`、multiselect=`z.array(z.string().max(100))` で既に自由文字列を許容）。
- 数値・単価はすべて**文字列**で扱う（既存踏襲・JS number へ恒久変換しない）。
- HTTP本番ゆえ `crypto.randomUUID` 不使用（本PRでは新規ID生成なし）。
- 対話UI（チェック→入力欄出現 等）は SSR 構造テスト＋レビューで担保（jsdom無・リポ規約）。
- TDD。フル `npx vitest run` 緑・`tsc --noEmit`=0・`eslint 変更ファイル`=0・`npm run build` 緑を完了条件とする。

---

## Task 1: 坪単価（自動計算＋上書き・売土地）

**Files:** Create `src/lib/sales-sheet/tsubo.ts` + `src/lib/sales-sheet/__tests__/tsubo.test.ts`; Modify `src/lib/sales-sheet/build-document.ts`, `src/lib/sales-sheet/field-model.ts`, `src/components/sales-sheet/SalesSheetCreateButton.tsx`; Test `src/lib/sales-sheet/__tests__/build-land.test.ts`.

**Interfaces (Produces):** `SQM_PER_TSUBO`, `parseNumeric(s)`, `computeTsuboUnitPrice(price, landArea)`。

- [ ] **Step 1: 失敗テスト `tsubo.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { SQM_PER_TSUBO, parseNumeric, computeTsuboUnitPrice } from "../tsubo";

describe("tsubo", () => {
  it("1坪=400/121㎡", () => { expect(SQM_PER_TSUBO).toBeCloseTo(3.305785, 5); });
  it("parseNumeric はカンマ/㎡等を除去", () => {
    expect(parseNumeric("3,480")).toBe(3480);
    expect(parseNumeric("150.5㎡")).toBe(150.5);
    expect(parseNumeric("")).toBeNull();
    expect(parseNumeric("　")).toBeNull();
    expect(parseNumeric(undefined)).toBeNull();
  });
  it("坪単価=価格÷(面積÷坪換算)・小数第1位", () => {
    // 3000万 / (150㎡ / 3.305785=45.375坪) = 66.11.. → "66.1"
    expect(computeTsuboUnitPrice("3000", "150")).toBe("66.1");
    expect(computeTsuboUnitPrice("3,480", "150.5㎡")).toBe(computeTsuboUnitPrice("3480", "150.5"));
  });
  it("面積0/空/無効は空文字", () => {
    expect(computeTsuboUnitPrice("3000", "0")).toBe("");
    expect(computeTsuboUnitPrice("3000", "")).toBe("");
    expect(computeTsuboUnitPrice("", "150")).toBe("");
  });
});
```

- [ ] **Step 2: 失敗確認** — `npx vitest run src/lib/sales-sheet/__tests__/tsubo.test.ts`（Cannot find module）。
- [ ] **Step 3: `tsubo.ts` 実装**

```ts
/** 1坪 = 400/121 ㎡（計量法・約3.305785㎡）。 */
export const SQM_PER_TSUBO = 400 / 121;

/** "3,480" / "150.5㎡" 等の数値文字列を number へ。非数字（カンマ/㎡/空白）除去。無効/空は null。 */
export function parseNumeric(s?: string | null): number | null {
  if (typeof s !== "string") return null;
  const cleaned = s.replace(/[^0-9.]/g, "");
  if (cleaned === "" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** 坪単価(万円/坪)=価格(万円)÷(土地面積㎡÷SQM_PER_TSUBO)。小数第1位の文字列。算出不可は ""。 */
export function computeTsuboUnitPrice(priceManYen?: string | null, landAreaSqm?: string | null): string {
  const price = parseNumeric(priceManYen);
  const area = parseNumeric(landAreaSqm);
  if (price === null || area === null || area <= 0) return "";
  const unit = price / (area / SQM_PER_TSUBO);
  if (!Number.isFinite(unit)) return "";
  return (Math.round(unit * 10) / 10).toFixed(1);
}
```

- [ ] **Step 4: GREEN 確認**。
- [ ] **Step 5: ビルダー結線** — `build-document.ts`：先頭で `import { computeTsuboUnitPrice } from "./tsubo";`。`buildLandValues`（`unitPrice: o.unitPrice` の箇所）を
  `unitPrice: o.unitPrice && o.unitPrice.trim() !== "" ? o.unitPrice : computeTsuboUnitPrice(o.price, o.landArea),`
  へ（上書き優先・空欄なら自動）。**マンションの `buildMansionValues.unitPrice` は変更しない**（㎡単価のまま）。
- [ ] **Step 6: ラベル変更** — `field-model.ts` の LAND `unitPrice` の `label: "坪/㎡単価"` → `label: "坪単価"`。
- [ ] **Step 7: ダイアログのライブ自動値プレースホルダ** — `SalesSheetCreateButton.tsx`：`FieldModelForm` 内で、land の `unitPrice`（number widget）に、現在の `values.price`・`values.landArea` から `computeTsuboUnitPrice` した文字列を **placeholder** として渡す（空でなければ `"自動: {v}万円"`）。number widget（`FieldModelWidget`）に `placeholder?: string` を通し、`<input>` に `placeholder` を付与。値が入っていれば上書き、空欄なら送信されず＝ビルダーが自動計算（Step5）。
- [ ] **Step 8: `build-land.test.ts` 追加**：
  - `unitPrice` 未指定 → 自動計算（`landArea`/`price` から。行 `坪単価` が算出値＋`万円`）。
  - `unitPrice` 指定 → その値（上書き）。
  - `landArea` 空 → `坪単価` 行は空。
  - 行ラベルが「坪単価」であること。
- [ ] **Step 9: フル `npx vitest run` 緑・tsc0・eslint0**。
- [ ] **Step 10: commit** `feat(sales-sheet): 坪単価を土地面積から自動計算(上書き可)`。

---

## Task 2: 「その他」で自由入力（select/multiselect 共通）

**Files:** Create `src/lib/sales-sheet/other-input.ts` + `src/lib/sales-sheet/__tests__/other-input.test.ts`; Modify `src/components/sales-sheet/SalesSheetCreateButton.tsx`.

**設計:** options に `"その他"` を含む欄で、「その他」を選ぶ/チェックすると自由入力欄を出す。**値の表現＝options外の文字列＝自由入力値**（select は単一文字列、multiselect は配列の options外要素）。テキスト空の「その他」状態は `"その他"` リテラルを値/配列に保持（モード保持）。sheet-rows は無改修で `formatValue` がそのまま表示（select=値、multiselect=`" / "` 連結）。zod 無改修（自由文字列許容済）。

**Interfaces (Produces):** `OTHER_OPTION`, `hasOtherOption(options)`, `selectOtherState(value,options)`, `multiOtherState(arr,options)`, `setMultiFreeText(arr,options,text)`, `setSelectFreeText(text)`。

- [ ] **Step 1: 失敗テスト `other-input.test.ts`**（純関数のみ検証）

```ts
import { describe, it, expect } from "vitest";
import {
  OTHER_OPTION, hasOtherOption, selectOtherState, multiOtherState, setMultiFreeText,
} from "../other-input";

const OPTS = ["宅地", "田", "その他"] as const;

describe("other-input", () => {
  it("hasOtherOption", () => {
    expect(hasOtherOption(OPTS)).toBe(true);
    expect(hasOtherOption(["宅地"])).toBe(false);
  });
  describe("select", () => {
    it("options内=通常", () => { expect(selectOtherState("宅地", OPTS)).toEqual({ isOther: false, freeText: "" }); });
    it("その他リテラル=モード・テキスト空", () => { expect(selectOtherState("その他", OPTS)).toEqual({ isOther: true, freeText: "" }); });
    it("options外の非空=その他・テキスト有", () => { expect(selectOtherState("原野", OPTS)).toEqual({ isOther: true, freeText: "原野" }); });
    it("空=通常", () => { expect(selectOtherState("", OPTS)).toEqual({ isOther: false, freeText: "" }); });
  });
  describe("multiselect", () => {
    it("options外要素=自由入力値・その他モード", () => {
      expect(multiOtherState(["宅地", "原野"], OPTS)).toEqual({ isOther: true, freeText: "原野", optionSelections: ["宅地"] });
    });
    it("その他リテラル=モード・テキスト空", () => {
      expect(multiOtherState(["宅地", "その他"], OPTS)).toEqual({ isOther: true, freeText: "", optionSelections: ["宅地"] });
    });
    it("その他なし=通常", () => {
      expect(multiOtherState(["宅地", "田"], OPTS)).toEqual({ isOther: false, freeText: "", optionSelections: ["宅地", "田"] });
    });
    it("setMultiFreeText: テキスト有→options選択＋テキスト", () => {
      expect(setMultiFreeText(["宅地", "その他"], OPTS, "原野")).toEqual(["宅地", "原野"]);
    });
    it("setMultiFreeText: 空→その他リテラルへ戻す", () => {
      expect(setMultiFreeText(["宅地", "原野"], OPTS, "")).toEqual(["宅地", "その他"]);
    });
  });
});
```

- [ ] **Step 2: 失敗確認**。
- [ ] **Step 3: `other-input.ts` 実装**

```ts
export const OTHER_OPTION = "その他";

export function hasOtherOption(options?: readonly string[]): boolean {
  return !!options && options.includes(OTHER_OPTION);
}

/** select: value が options 外（非空）or「その他」なら その他モード。freeText は options外の実値。 */
export function selectOtherState(value: string, options: readonly string[]): { isOther: boolean; freeText: string } {
  const inOptions = options.includes(value);
  const isOther = value === OTHER_OPTION || (value !== "" && !inOptions);
  return { isOther, freeText: isOther && value !== OTHER_OPTION ? value : "" };
}

/** multiselect: options外の要素＝自由入力値。 */
export function multiOtherState(arr: string[], options: readonly string[]): { isOther: boolean; freeText: string; optionSelections: string[] } {
  const optionSelections = arr.filter((x) => options.includes(x) && x !== OTHER_OPTION);
  const freeItem = arr.find((x) => !options.includes(x));
  return { isOther: arr.includes(OTHER_OPTION) || freeItem !== undefined, freeText: freeItem ?? "", optionSelections };
}

/** multiselect の自由入力テキストを反映（options選択は保持、その他部分をテキスト or 「その他」に）。 */
export function setMultiFreeText(arr: string[], options: readonly string[], text: string): string[] {
  const base = arr.filter((x) => options.includes(x) && x !== OTHER_OPTION);
  return [...base, text.trim() !== "" ? text : OTHER_OPTION];
}
```

- [ ] **Step 4: GREEN 確認**。
- [ ] **Step 5: ウィジェット結線（`FieldModelWidget`）**
  - **select 分岐**：`hasOtherOption(field.options)` の時、`selectOtherState(value, field.options)` を使う。`<select>` の value は `isOther ? "その他" : value`。onChange：`"その他"`選択→`onChange("その他")`、他→`onChange(opt)`。`isOther` の時、直下に text `<input aria-label={\`${field.label}（その他）\`}>` を出し value=`freeText`、onChange=`(e)=>onChange(e.target.value.trim()===""?"その他":e.target.value)`。
  - **multiselect 分岐**：`hasOtherOption` の時、`multiOtherState` を使い、「その他」チェックボックスは `checked={isOther}`・onChange で check→`[...optionSelections,"その他"]`／uncheck→`optionSelections` のみ。`isOther` の時 text 入力を出し value=`freeText`・onChange=`(e)=>onChange(setMultiFreeText(value, field.options, e.target.value))`。他の option チェックボックスは従来どおり（ただし「その他」は上記特別扱い）。
  - options に「その他」が無い欄は**従来の挙動のまま**（分岐で `hasOtherOption` false）。
- [ ] **Step 6: SSR 構造テスト**（`SalesSheetCreateButton` 系 or 新規 `other-input-widget.test.tsx`）：`renderToStaticMarkup` で、その他を持つ欄の value を「その他モード」にした時に text 入力（`aria-label` にラベル＋「その他」）が出ることを構造 assert。純関数分岐の値ロジックは Step1 で担保。
- [ ] **Step 7: フル緑・tsc0・eslint0**。
- [ ] **Step 8: commit** `feat(sales-sheet): 「その他」選択で自由入力欄を出す(select/multiselect)`。

---

## Task 3: 報酬（コンボボックス＋新選択肢）

**Files:** Modify `src/lib/sales-sheet/option-master.ts`, `src/lib/sales-sheet/field-model.ts`, `src/components/sales-sheet/SalesSheetCreateButton.tsx`; Test `src/lib/sales-sheet/__tests__/field-model.test.ts`（or option-master test）.

- [ ] **Step 1: 失敗テスト** — `field-model`/`option-master` テストに：`COMPENSATION` が `["税込3%","税別3%","税込3%+6万円","税別3%+6万円"]` であること、各種別の `compensation` フィールドの `widget === "combo"` であること。
- [ ] **Step 2: 失敗確認**。
- [ ] **Step 3: option-master** — `COMPENSATION = ["税込3%","税別3%","税込3%+6万円","税別3%+6万円"] as const;`（旧値を置換）。
- [ ] **Step 4: widget 種別追加** — `field-model.ts` の `FieldWidget` に `"combo"` を追加。4種別（MANSION/LAND/HOUSE/BUILDING）の `compensation` の `widget: "select"` → `widget: "combo"`（`options: M.COMPENSATION` 維持）。
- [ ] **Step 5: `FieldModelWidget` に combo 分岐** — `field.widget === "combo"` の時：`<input list={listId} value={value} onChange={(e)=>onChange(e.target.value)} />` ＋ `<datalist id={listId}>{(field.options??[]).map(o=><option key={o} value={o}/>)}</datalist>`（listId は `field.key` から決定的に）。値は自由文字列。単位表示は不要（compensation に unit 無）。
- [ ] **Step 6: SSR 構造テスト** — 報酬欄が `<datalist>` を伴う `<input list>` として描画されることを構造 assert。
- [ ] **Step 7: フル緑・tsc0・eslint0・build**。
- [ ] **Step 8: commit** `feat(sales-sheet): 報酬を新選択肢＋自由入力(コンボボックス)に`。

---

## 実装後（コーディネータ）
- 最終 whole-branch review（opus）→ 実在指摘修正 → push → PR（base=main・#271/#272は既にmain）→ @codex（codex-triage）→ clean → **ユーザーマージ**。
- **PR-B（写真ローカルアップロード・④）は別worktree/別PR**（本PR後）。

## スコープ外
写真ローカルアップロード（④＝PR-B）。マンション㎡単価の坪単価化。戸建/一棟への坪単価追加。表セル背景色。
