# 販売図面 レイアウト最適化エンジン（機能A）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development（推奨）or superpowers:executing-plans でタスク毎に実装。ステップは `- [ ]` で追跡。設計書=`docs/superpowers/specs/2026-07-10-sales-sheet-layout-polish-design.md`。基盤=[[sales-sheet-editor]]/[[sales-sheet-jisha-format]]。

**Goal:** 販売図面を内容（写真枚数・項目行数・文字サイズ）に応じて自動でバランス配置する共有ロジックを作り、作成時・「レイアウト自動調整」ボタン・文字サイズ変更時の3箇所で走らせる。

**Architecture:** 純関数 `computeSpecSheetLayout(input)→レイアウト矩形群` を新設。(1)ビルダー `buildSpecSheetDocument` が作成時に使用、(2)エディタ純reducer `autoBalanceLayout(state)` がボタン/文字変更時に既存テンプレ要素へ再適用。写真の敷詰めは既存 `packPhotoCells` を再利用。要素の id/type は不変＝二重レンダラ・保存境界に影響なし。

**Tech Stack:** TypeScript / 純関数 / vitest（env=node・`renderToStaticMarkup`）。座標系=A4横 mm（297×210・`A4_LANDSCAPE`）。

## Global Constraints（設計書の正・各タスクに暗黙適用）
- **既存 element 種別のみ**（text/image/table/shape）。新規 schema/element/依存/migration/env なし。
- 二重レンダラ（`SalesSheetRenderer.tsx`/`render-html.ts`）は**無改修**。既存 parity テスト緑。
- 出力の**要素 id は不変**（`catch-band`/`catch-copy`/`heading`/`price`/`overview`/`sales-points`/`company`/`company-details`/`floor-plan`/写真=`image`要素）。保存境界 `assertSavableDocument`（A4/幾何/z≥0/画像50/512KB）を必ず通す。
- `autoBalanceLayout` は**既知 id/種別のテンプレ要素のみ**を動かし、ユーザーが手で足した独自要素は不動。no-op は同一 state 参照（既存 reducer 規約）。
- HTTP本番ゆえ `crypto.randomUUID` 不使用（新規 id 生成はしない＝既存要素の幾何のみ更新）。
- 「緑」宣言はフル `npx vitest run`＋`tsc --noEmit`＋変更ファイル eslint＋`npm run build`（[[run-full-test-suite-not-targeted]]）。

## File Structure
- **Create** `src/lib/sales-sheet/layout-engine.ts` — `SpecSheetLayoutInput`/`SpecSheetLayout` 型 ＋ 純関数 `computeSpecSheetLayout`。写真敷詰めは `editor-document.ts` の `packPhotoCells` を export して再利用（現在 private → export 化）。
- **Modify** `src/lib/sales-sheet/editor-document.ts` — `packPhotoCells`（＋`PhotoCell`）を export。`autoBalanceLayout(state)` reducer を追加。
- **Modify** `src/lib/sales-sheet/build-document.ts` — `buildSpecSheetDocument` 内の固定座標を `computeSpecSheetLayout` の算出値に差し替え（出力の要素構成・id・style 種別は不変）。
- **Modify** `src/components/sales-sheet/editor/EditorToolbar.tsx` — `onAutoBalance` prop ＋「レイアウト自動調整」ボタン（`data-toolbar-auto-balance`）。
- **Modify** `src/components/sales-sheet/editor/SalesSheetEditor.tsx` — `handleAutoBalance`（`autoBalanceLayout` 呼び出し）＋ dispatcher の `editText` ケースで `patch.fontSizePt` 変更時に続けて `autoBalanceLayout` を適用。
- **Tests** `src/lib/sales-sheet/__tests__/layout-engine.test.ts`（新）/ `editor-document-autobalance.test.ts`（新）/ 既存 `build-*.test.ts`（非回帰）/ `editor-toolbar.test.tsx`（ボタン）/ `sales-sheet-editor.test.tsx` 相当（dispatcher・存在すれば）。

---

### Task 1: `computeSpecSheetLayout` 純関数（コアアルゴリズム）

**Files:**
- Create: `src/lib/sales-sheet/layout-engine.ts`
- Modify: `src/lib/sales-sheet/editor-document.ts`（`packPhotoCells`/`PhotoCell` を `export`・実装は不変）
- Test: `src/lib/sales-sheet/__tests__/layout-engine.test.ts`

**Interfaces（Produces）:**
```ts
export interface SpecSheetLayoutInput {
  photoCount: number;          // 0..3（テンプレは最大3）
  specRowCount: number;        // スペック表の行数
  hasFloorPlan: boolean;
  footerHeight: number;        // 下部帯の高さmm（機能B前は既定=DEFAULT_FOOTER_H）
  overviewFontPt?: number;     // 概要表フォント上書き（②文字変更時に渡す・省略=自動)
}
export interface Rect { x: number; y: number; w: number; h: number; }
export interface SpecSheetLayout {
  catchBand: Rect; catchCopy: Rect; heading: Rect; price: Rect;
  overview: Rect & { fontSizePt: number };
  salesPoints: Rect; company: Rect; companyDetails: Rect;
  floorPlan: Rect | null;
  photoArea: Rect;             // 写真ゾーン全体
  photoSlots: Rect[];          // 各写真の絶対座標（photoCount 個・packPhotoCells由来）
}
export function computeSpecSheetLayout(input: SpecSheetLayoutInput): SpecSheetLayout;
```

**設計メモ（アルゴリズム）:** A4横=297×210。上部キャッチ帯 y8..24 固定。メイン領域＝ y=26 〜 `mainBottom=210-footerHeight-2`。左右分割 `splitX` は写真枚数で決める＝**写真少→表広く・写真多→写真広く**：
- `splitX = lerp(84, 145, clamp(photoCount/3,0,1))`（0枚→左域極小で表を x10..287 フル幅、3枚→写真 x10..~140／表 x150..287）。gap=6。
- `overview.x = splitX+5`、`overview.w = 287-(splitX+5)`、`overview.y=26`、`overview.h=mainBottom-26`。
- `overview.fontSizePt = overviewFontPt ?? clamp(overview.h / max(1,specRowCount) / 1.6, 5, 9)`（行が多い→小さく詰める・少→大きく埋める）。
- `photoArea = { x:10, y:46, w: max(0, splitX-10-gap), h: mainBottom-46 }`（0枚なら w=0）。`photoSlots = packPhotoCells(photoCount, photoArea.w, photoArea.h)` を絶対座標へオフセット。
- `heading/price` は左上（x10 y26/y33 w=splitX-16）。`salesPoints` は写真域下端。`company/companyDetails` は `mainBottom` 以下（帯領域）。`floorPlan` は `hasFloorPlan` 時のみキャッチ帯下右（現行 x108 y26 w32 h18 踏襲）。
- **不変条件**（テストで固定）: 全 Rect が 0≤x, x+w≤297, 0≤y, y+h≤210 に収まる／overview と photoArea が重ならない（`overview.x ≥ photoArea.x+photoArea.w`）／company 系は `mainBottom` 以上／fontSizePt∈[5,9]。

- [ ] **Step 1: 失敗テストを書く** `layout-engine.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { computeSpecSheetLayout } from "../layout-engine";
const A4W = 297, A4H = 210;
const base = { photoCount: 3, specRowCount: 30, hasFloorPlan: false, footerHeight: 24 };
const within = (r: {x:number;y:number;w:number;h:number}) =>
  r.x >= 0 && r.y >= 0 && r.x + r.w <= A4W + 0.01 && r.y + r.h <= A4H + 0.01;

describe("computeSpecSheetLayout", () => {
  it("全要素がA4内、overviewと写真域が重ならない", () => {
    const L = computeSpecSheetLayout(base);
    for (const r of [L.catchBand, L.heading, L.price, L.overview, L.photoArea, L.company, L.companyDetails]) {
      expect(within(r), JSON.stringify(r)).toBe(true);
    }
    expect(L.overview.x).toBeGreaterThanOrEqual(L.photoArea.x + L.photoArea.w);
  });
  it("写真が少ないほど概要表が広い（写真0枚は表がほぼ全幅）", () => {
    const few = computeSpecSheetLayout({ ...base, photoCount: 0 });
    const many = computeSpecSheetLayout({ ...base, photoCount: 3 });
    expect(few.overview.w).toBeGreaterThan(many.overview.w);
    expect(few.photoArea.w).toBe(0);
  });
  it("行数が多いほど概要表フォントが小さい（5..9 pt）", () => {
    const dense = computeSpecSheetLayout({ ...base, specRowCount: 45 });
    const sparse = computeSpecSheetLayout({ ...base, specRowCount: 8 });
    expect(dense.overview.fontSizePt).toBeLessThanOrEqual(sparse.overview.fontSizePt);
    expect(dense.overview.fontSizePt).toBeGreaterThanOrEqual(5);
    expect(sparse.overview.fontSizePt).toBeLessThanOrEqual(9);
  });
  it("footerHeightを大きくするとメイン領域(overview.h)が縮む", () => {
    const tall = computeSpecSheetLayout({ ...base, footerHeight: 40 });
    expect(tall.overview.h).toBeLessThan(computeSpecSheetLayout(base).overview.h);
  });
  it("photoSlots は photoCount 個・各セルが photoArea 内", () => {
    const L = computeSpecSheetLayout({ ...base, photoCount: 2 });
    expect(L.photoSlots).toHaveLength(2);
    for (const s of L.photoSlots) {
      expect(s.x).toBeGreaterThanOrEqual(L.photoArea.x - 0.01);
      expect(s.x + s.w).toBeLessThanOrEqual(L.photoArea.x + L.photoArea.w + 0.01);
    }
  });
});
```

- [ ] **Step 2: RED確認** `cd <worktree>; npx vitest run src/lib/sales-sheet/__tests__/layout-engine.test.ts` → FAIL（`computeSpecSheetLayout` 未定義）。
- [ ] **Step 3: `packPhotoCells`/`PhotoCell` を export** — `editor-document.ts` の `function packPhotoCells`→`export function packPhotoCells`、`interface PhotoCell`→`export interface PhotoCell`（実装不変）。
- [ ] **Step 4: `layout-engine.ts` 実装** — 上記「設計メモ」の規則を純関数で実装（`lerp`/`clamp` はローカル・`packPhotoCells` を import して photoSlots を絶対座標化）。定数（メイン上端26・キャッチ帯・splitX端点84/145・gap6・fontSize域5-9・写真ゾーンy46）は module 定数に。
- [ ] **Step 5: GREEN確認** 同コマンド → PASS。`npx tsc --noEmit`=0。
- [ ] **Step 6: Commit** `feat(sales-sheet): レイアウト最適化の純関数 computeSpecSheetLayout` ＋ co-author/session 行。

---

### Task 2: `buildSpecSheetDocument` をエンジン駆動へ

**Files:**
- Modify: `src/lib/sales-sheet/build-document.ts`（`buildSpecSheetDocument` の固定座標→`computeSpecSheetLayout` 算出値）
- Test: 既存 `src/lib/sales-sheet/__tests__/build-{mansion,land,house,building}.test.ts` ＋ `spec-sheet-document.test.ts`

**Interfaces（Consumes）:** Task1 `computeSpecSheetLayout` / `SpecSheetLayout`。

**設計メモ:** `buildSpecSheetDocument(parts)` 先頭で `const L = computeSpecSheetLayout({ photoCount: (parts.photos??[]).slice(0,3).length, specRowCount: parts.rows.length, hasFloorPlan: !!parts.floorPlanImage?.fileUrl, footerHeight: DEFAULT_FOOTER_H })`。各要素の x/y/w/h を `L.*` から取る（`overview` は `L.overview` ＋ `fontSizePt: L.overview.fontSizePt`）。写真は `photoElements` を `L.photoSlots` を使う版に変更（`photoElements(parts.photos, L.photoSlots)`）。**出力の id/type/style 種別・theme は不変。** `DEFAULT_FOOTER_H`（現行 company y195/details y201 相当＝約22mm）を module 定数に。

- [ ] **Step 1: 既存 build テストを緑のまま維持できる形か確認（RED回避）** — 既存 build-*.test.ts は行内容・id・"うち消費税"等の**存在**を見る緩いassertが中心（座標厳密一致は無い想定）。座標を厳密固定している箇所があれば**不変条件（存在・重なり無し）へ更新**するテスト修正を先に入れる（該当箇所を grep：`x: 150`/`y: 195` 等）。
- [ ] **Step 2: 実装** — 上記設計メモどおり `buildSpecSheetDocument` を書き換え。`photoElements` 署名変更（slots 受け取り）。
- [ ] **Step 3: GREEN** `npx vitest run src/lib/sales-sheet`＝緑（mansion/land/house/building 非回帰）。`tsc`=0。
- [ ] **Step 4: パリティ** `npx vitest run src/lib/sales-sheet/__tests__/render-html-parity.test.ts src/components/sales-sheet/__tests__/SalesSheetRenderer.test.tsx`＝緑（レンダラ無改修）。
- [ ] **Step 5: Commit** `feat(sales-sheet): 作成時のレイアウトを最適化エンジン駆動に`。

---

### Task 3: `autoBalanceLayout` reducer（エディタ・ボタン/文字変更の中核）

**Files:**
- Modify: `src/lib/sales-sheet/editor-document.ts`（`autoBalanceLayout(state): EditorState` 追加）
- Test: `src/lib/sales-sheet/__tests__/editor-document-autobalance.test.ts`（新）

**Interfaces:** Consumes Task1。Produces `export function autoBalanceLayout(state: EditorState): EditorState`。

**設計メモ（`autoArrangePhotos` を一般化）:** document 要素を id/type で役割判定（`overview`=table / `company`/`company-details`/`heading`/`price`/`catch-band`/`catch-copy`/`sales-points`/`floor-plan`=各id / `image`要素=写真配列）。`computeSpecSheetLayout({ photoCount: 画像要素数, specRowCount: overview.rows.length, hasFloorPlan: floor-plan有無, footerHeight: DEFAULT_FOOTER_H, overviewFontPt: 現 overview.style.fontSizePt })` を計算し、各既知要素の幾何を `L.*` へ更新（overview は fontSizePt も）。写真は配列順に `L.photoSlots` へ。**未知 id の要素は不動。** 変更が無ければ同一参照（`autoArrangePhotos` と同じ changed 判定）。変更あれば dirty=true。

- [ ] **Step 1: 失敗テスト** — `buildSaleHouseDocument` 等で作った document を `EditorState` に包み、写真枠を手でズラした状態から `autoBalanceLayout` で overview/photo が算出値に戻ること・未知idの独自text要素が不動・no-opで同一参照・dirtyを検証（`editor-document-autolayout.test.ts` の書式を踏襲）。
- [ ] **Step 2: RED確認**。
- [ ] **Step 3: 実装**（上記設計メモ）。
- [ ] **Step 4: GREEN** ＋ `tsc`=0。
- [ ] **Step 5: Commit** `feat(sales-sheet): エディタのレイアウト自動調整 reducer autoBalanceLayout`。

---

### Task 4: 「レイアウト自動調整」ボタン ＋ SalesSheetEditor 配線

**Files:**
- Modify: `src/components/sales-sheet/editor/EditorToolbar.tsx`（`onAutoBalance` prop＋ボタン `data-toolbar-auto-balance` "レイアウト自動調整"・`onAutoArrange` の隣）
- Modify: `src/components/sales-sheet/editor/SalesSheetEditor.tsx`（`handleAutoBalance = () => setEditorState((prev) => autoBalanceLayout(prev))`・`<EditorToolbar ... onAutoBalance={handleAutoBalance} />`・import 追加）
- Test: `src/components/sales-sheet/editor/__tests__/editor-toolbar.test.tsx`（ボタン存在・"自動整列ボタンを持つ" と同書式）

- [ ] **Step 1: 失敗テスト** — toolbar が `data-toolbar-auto-balance` と "レイアウト自動調整" を描画する（`onAutoBalance={()=>{}}` を渡す・renderToStaticMarkup）。
- [ ] **Step 2: RED**。
- [ ] **Step 3: 実装** — `EditorToolbarProps` に `onAutoBalance: () => void` 追加・`onAutoArrange` ボタン直後に同型ボタン。`SalesSheetEditor` に handler＋import＋prop 配線。
- [ ] **Step 4: GREEN** ＋ `tsc`=0＋`eslint`。
- [ ] **Step 5: Commit** `feat(sales-sheet): 「レイアウト自動調整」ボタンを追加`。

---

### Task 5: 文字サイズ変更→周りも連動再バランス（②）

**Files:**
- Modify: `src/components/sales-sheet/editor/SalesSheetEditor.tsx`（dispatcher の `editText` ケース）
- Test: `SalesSheetEditor` の change 適用を検証するユニット（既存があれば追記／無ければ dispatcher 相当関数を切り出してテスト）

**設計メモ:** 現行 `case "editText": return editText(prev, id, change.patch);` を、フォントサイズ変更時のみ連動させる：
```ts
case "editText": {
  const next = editText(prev, id, change.patch);
  // ②: 文字サイズ変更は枠バランスへ波及（周りも連動再バランス）。他の text 変更(内容/色)は据え置き。
  return change.patch.fontSizePt !== undefined ? autoBalanceLayout(next) : next;
}
```
- [ ] **Step 1: 失敗テスト** — fontSizePt を変える editText 相当の change を適用すると、overview 等の幾何も再バランスされる（内容だけの変更では再バランスしない）ことを検証。※dispatcher が component 内クロージャなら、`applyChange(state, change)` を純関数として切り出してから import してテスト（jsdom 非依存）。
- [ ] **Step 2: RED**。
- [ ] **Step 3: 実装**（上記＋必要なら applyChange 切り出し）。
- [ ] **Step 4: GREEN** ＋ `tsc`=0。
- [ ] **Step 5: Commit** `feat(sales-sheet): 文字サイズ変更で枠を連動再バランス`。

---

### Task 6: フルゲート＋プレレビュー＋PR＋@codex

- [ ] `npx tsc --noEmit`=0 / **フル** `npx vitest run` 緑 / `npx eslint <変更ファイル>`=0 / `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build`。
- [ ] `verify` スキルでエディタを起動し、作成時の自動配置・ボタン・文字変更連動を実挙動で確認（要ログイン画面は launch 検証まで）。
- [ ] `git add -A`→ `feature-dev:code-reviewer` プレレビュー（ホットスポット=保存境界 `assertSavableDocument`／二重レンダラparity／未知id不動／no-op同一参照／幾何の重なり・A4逸脱／font域5-9）。
- [ ] push → PR（base=main・平易日本語 Summary/実装/テスト/セキュリティ・🤖行）→ 自分で `@codex review`。**マージはユーザー**。

## Self-Review（計画↔設計書）
- **カバレッジ:** ①作成時自動=Task2・ボタン=Task4・文字変更連動=Task5・比例配分の中核=Task1・エディタ再適用=Task3。②=Task5＋Task3。③(帯)=**本計画対象外**（機能B・別計画）。footerHeight は当面 `DEFAULT_FOOTER_H` 固定で機能Bと接続。
- **プレースホルダ:** 無し（各タスクに実テスト/署名/設計メモ）。アルゴリズム定数は Task1 の TDD で確定（域は不変条件で固定）。
- **型整合:** `SpecSheetLayout`/`Rect`/`SpecSheetLayoutInput`（Task1）を Task2/3 が Consume。`autoBalanceLayout`（Task3）を Task4/5 が使用。`packPhotoCells` export（Task1 Step3）を layout-engine が使用。
- **注意:** build-*.test.ts が座標を厳密固定している場合は Task2 Step1 で不変条件へ更新（存在・重なり無しを検証する形へ）。
