# 取込トップ(import/page.tsx) ダークモード PR1 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 取込トップ画面（`import/page.tsx`）と取込切替（`import-switcher.tsx`）に `dark:` 変種を追加し、ダークモードで読める配色にする（ライト表示は不変）。

**Architecture:** 段階1で導入済みの `@custom-variant dark (&:where(.dark, .dark *))` 配下で効く `dark:` 変種を、既存クラスに「追加」するだけ。新依存・新仕組み・挙動変更なし。配色は配色正本 `deliverables/22A/22H-dark-mode-phase2-impl-ref.md` のマッピング表に従う。

**Tech Stack:** Next.js (App Router) / Tailwind / vitest（node環境・jsdom無し→source-assertionテスト）。

**Spec:** `docs/superpowers/specs/2026-06-23-import-dark-mode-design.md`
**Base:** `origin/main` `99d4859` / branch `feat/dark-mode-import`
**Scope外（確認済）:** `import/owners/page.tsx` は `redirect("/import")` のみ＝UIなし＝**変更不要**。PR2(jobs/[jobId])・PR3(registry-pdf)は別計画。

## Global Constraints（全タスク共通・spec/ref からverbatim）
- **add-only**: 既存クラスは削除/置換しない。`dark:` 変種を追加するのみ。**ライト表示は絶対に変えない**。
- **配色マッピング（面/文字/枠線/入力欄）**:
  - `bg-white`→`dark:bg-gray-900` / `bg-gray-50`→`dark:bg-gray-800/50`（淡面。区切りヘッダは `dark:bg-gray-900` でも可）/ `bg-gray-100`→`dark:bg-gray-800` / `bg-gray-300`→`dark:bg-gray-700`
  - `hover:bg-gray-50`→`dark:hover:bg-gray-800` / `hover:bg-gray-100`→`dark:hover:bg-gray-700` / `hover:bg-gray-200`→`dark:hover:bg-gray-700`
  - `text-gray-900`/`-800`→`dark:text-gray-100` / `text-gray-700`→`dark:text-gray-200` / `text-gray-600`→`dark:text-gray-300` / `text-gray-500`→`dark:text-gray-400` / `text-gray-400`→`dark:text-gray-500` / `text-gray-300`→`dark:text-gray-600`
  - `border-gray-200`→`dark:border-gray-800` / `border-gray-300`→`dark:border-gray-700` / `border-gray-100`→`dark:border-gray-800` / `hover:border-gray-400`→`dark:hover:border-gray-600` / `hover:border-gray-300`→`dark:hover:border-gray-600`
  - `divide-gray-100`/`-200`→`dark:divide-gray-800`
  - 入力欄(`<input>/<select>/<textarea>`): `bg-white`→`dark:bg-gray-900`・`text-gray-900`→`dark:text-gray-100`・`border-gray-300`→`dark:border-gray-700`。focus ring系(`focus:ring-*`/`ring-indigo-500`/`border-indigo-500`)は**そのまま**で可。
- **色付きメッセージ panel（情報/警告/成功/エラー）は同PRで dark化**（暗背景で文字が沈むのを防ぐ＝@codex P2 先回り）。box の `bg-{c}-50 text-{c}-700/800/900 border-{c}-200` に追加:
  - blue(情報): `dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-400/20`
  - amber(警告): `dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-400/25`
  - green/emerald(成功): `dark:bg-green-500/10 dark:text-green-300 dark:border-green-400/20`
  - red(エラー): `dark:bg-red-500/10 dark:text-red-300 dark:border-red-400/20`
  - panel内の見出し/集計の濃色文字(`text-{c}-800/900`)も `dark:text-{c}-300` を付ける。
- **アクティブ/選択タブの accent**: `text-indigo-700`(+`border-indigo-600/500`) の active 分岐に `dark:text-indigo-400`(+`dark:border-indigo-400`) を**追加**（非active分岐だけでなく active 分岐にも）。暗面の accent リンク/ID(`text-indigo-600`等)→`dark:text-indigo-400`＋hover `dark:hover:text-indigo-300`。
- **据え置き（触らない）**:
  - **色ロック分類タグ**: orphan(orange)/address_null(yellow)/duplicate(purple/violet)。`import/page.tsx` に `bg-orange-100 text-orange-800`(各1)・`text-yellow-700/600` あり→**取込エラー分類が status-badge.tsx の色ロック集合と同色/同義なら触らない**。独立した単発の装飾色なら ref に従い dark化。**迷ったら触らず、テストにも含めない**。
  - solid 色付きボタン(`bg-indigo-600 text-white`/`bg-green-600`/`hover:bg-indigo-700`等)＝白文字で暗背景でも可読→**据え置き**。
  - `StatusBadge`/`badgeIntentClass` 経由の表示（3箇所）＝コンポーネント側で段階2a済→**この画面では触らない**。
- **挙動・DOM構造・ロジック・`data-pii-protected`(1箇所)等の属性は一切変えない＝クラス文字列のみ**。条件分岐で付くクラスはその分岐内で `dark:` も付ける。
- **ゲート**: `npx vitest run`（全green）/ `npx tsc --noEmit`（0）/ `npx eslint <変更ファイル>`（変更分0）/ `npm run build`（OK）。既存テストを弱めない/壊さない。`not.toContain` 対象語をテスト名・コメントに書かない。

---

### Task 1: import-switcher.tsx（取込切替・小さく先行してパターン確立）

**Files:**
- Modify: `src/components/import/import-switcher.tsx`（59行・active=`text-indigo-700`/`border-indigo-600`、neutral=`text-gray-500`/`hover:text-gray-700`/`hover:border-gray-300`/`border-gray-200`）
- Test: `src/components/import/__tests__/import-switcher-dark.test.ts`

**Interfaces:** Consumes: なし（独立）。Produces: なし。

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "import-switcher.tsx"), "utf8");

describe("import-switcher.tsx dark: 配色", () => {
  it("アクティブタブ文字に dark:text-indigo-400 がある", () => {
    expect(src).toContain("dark:text-indigo-400");
  });
  it("アクティブタブ枠線に dark:border-indigo-400 がある", () => {
    expect(src).toContain("dark:border-indigo-400");
  });
  it("薄文字に dark:text-gray-400 がある", () => {
    expect(src).toContain("dark:text-gray-400");
  });
  it("ライト側 text-indigo-700 は残っている", () => {
    expect(src).toContain("text-indigo-700");
  });
  it("ライト側 border-gray-200 は残っている", () => {
    expect(src).toContain("border-gray-200");
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run src/components/import/__tests__/import-switcher-dark.test.ts`
Expected: FAIL（`dark:text-indigo-400` 等がまだ無い）

- [ ] **Step 3: マッピングに従い dark: を追加**

`import-switcher.tsx` の各 className に Global Constraints のマッピングで `dark:` を追加:
- active タブ: `text-indigo-700`→ +`dark:text-indigo-400`、`border-indigo-600`→ +`dark:border-indigo-400`
- `text-gray-500`→ +`dark:text-gray-400`、`hover:text-gray-700`→ +`dark:hover:text-gray-300`、`hover:border-gray-300`→ +`dark:hover:border-gray-600`、`border-gray-200`→ +`dark:border-gray-800`
- 既存クラスは消さない。動き・条件分岐は不変。

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx vitest run src/components/import/__tests__/import-switcher-dark.test.ts`
Expected: PASS

- [ ] **Step 5: ゲート**

Run: `npx tsc --noEmit` (0) / `npx eslint src/components/import/import-switcher.tsx src/components/import/__tests__/import-switcher-dark.test.ts`（0）
Expected: エラー0

- [ ] **Step 6: コミット**

```bash
git add src/components/import/import-switcher.tsx src/components/import/__tests__/import-switcher-dark.test.ts
git commit -m "feat(dark): 取込切替(import-switcher) ダークモード対応"
```

---

### Task 2: import/page.tsx（取込トップ本体・大きなsweep）

**Files:**
- Modify: `src/app/(dashboard)/import/page.tsx`（2,608行）
- Test: `src/app/(dashboard)/import/__tests__/page-dark.test.ts`

**Interfaces:** Consumes: なし。Produces: なし。

**Sweep対象の内訳（profile）:** neutral面/文字/枠線 多数 / 入力欄15 / activeタブ12 / 色付きpanel（blue=情報・amber=警告・green=成功・red=エラー）/ StatusBadge3（触らない）/ `data-pii-protected`1（属性は触らない・周辺クラスのみ）。

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "page.tsx"), "utf8");

describe("import/page.tsx dark: 配色", () => {
  // 面
  it("カード/パネル面に dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("淡面に dark:bg-gray-800/50 または dark:bg-gray-800 がある", () => {
    expect(src.includes("dark:bg-gray-800/50") || src.includes("dark:bg-gray-800")).toBe(true);
  });
  it("行/ボタンhoverに dark:hover:bg-gray-800 がある", () => {
    expect(src).toContain("dark:hover:bg-gray-800");
  });
  // 文字
  it("本文に dark:text-gray-100 がある", () => { expect(src).toContain("dark:text-gray-100"); });
  it("本文に dark:text-gray-200 がある", () => { expect(src).toContain("dark:text-gray-200"); });
  it("本文に dark:text-gray-300 がある", () => { expect(src).toContain("dark:text-gray-300"); });
  it("薄文字に dark:text-gray-400 がある", () => { expect(src).toContain("dark:text-gray-400"); });
  // 枠線
  it("枠線に dark:border-gray-800 がある", () => { expect(src).toContain("dark:border-gray-800"); });
  it("枠線に dark:border-gray-700 がある", () => { expect(src).toContain("dark:border-gray-700"); });
  it("区切りに dark:divide-gray-800 がある", () => { expect(src).toContain("dark:divide-gray-800"); });
  // accent: アクティブタブ
  it("アクティブタブに dark:text-indigo-400 がある", () => { expect(src).toContain("dark:text-indigo-400"); });
  it("アクティブタブ枠線に dark:border-indigo-400 がある", () => { expect(src).toContain("dark:border-indigo-400"); });
  // accent: 色付きメッセージpanel（情報/警告/成功/エラー）
  it("情報panel(blue)に dark:text-blue-300 がある", () => { expect(src).toContain("dark:text-blue-300"); });
  it("警告panel(amber)に dark:text-amber-300 がある", () => { expect(src).toContain("dark:text-amber-300"); });
  it("成功panel(green)に dark:text-green-300 がある", () => { expect(src).toContain("dark:text-green-300"); });
  it("エラーpanel(red)に dark:text-red-300 がある", () => { expect(src).toContain("dark:text-red-300"); });
  it("色付きpanel地に dark:bg-blue-500/10 がある", () => { expect(src).toContain("dark:bg-blue-500/10"); });
  // ライト不変ガード
  it("ライト bg-white は残っている", () => { expect(src).toContain("bg-white"); });
  it("ライト text-gray-600 は残っている", () => { expect(src).toContain("text-gray-600"); });
  it("ライト border-gray-300 は残っている", () => { expect(src).toContain("border-gray-300"); });
  it("ライト hover:bg-gray-50 は残っている", () => { expect(src).toContain("hover:bg-gray-50"); });
  it("ライト text-blue-700 は残っている", () => { expect(src).toContain("text-blue-700"); });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run "src/app/(dashboard)/import/__tests__/page-dark.test.ts"`
Expected: FAIL（dark系がまだ無い・ライト不変ガードのみ pass）

- [ ] **Step 3: dark: sweep を適用**

`import/page.tsx` を上から通読し、Global Constraints のマッピングで全 className に `dark:` を追加:
1. neutral 面/文字/枠線/hover/divide/入力欄＝マッピング機械適用。
2. activeタブ（12箇所の `border-indigo`+`text-indigo-[567]00`）＝active分岐にも `dark:text-indigo-400`+`dark:border-indigo-400`。
3. 色付きメッセージpanel（blue/amber/green/red）＝box に `dark:bg-{c}-500/10 dark:text-{c}-300 dark:border-{c}-400/20`、見出し濃色文字に `dark:text-{c}-300`。
4. **触らない**: StatusBadge/badgeIntentClass(3)・solid色付きボタン・focus ring/border・`data-pii-protected` 属性。
5. **色ロック判定**: `bg-orange-100 text-orange-800`/`text-yellow-700/-600` が取込エラー分類タグ（orphan/address_null 相当）なら**触らない**（テストにも含めない）。独立装飾なら ref で dark化。
6. 既存クラスは1つも削除/置換しない。条件分岐で付くクラスは分岐内で `dark:` も。

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx vitest run "src/app/(dashboard)/import/__tests__/page-dark.test.ts"`
Expected: PASS（全it green）

- [ ] **Step 5: フルゲート**

Run:
```bash
npx vitest run
npx tsc --noEmit
npx eslint "src/app/(dashboard)/import/page.tsx" "src/app/(dashboard)/import/__tests__/page-dark.test.ts"
npm run build
```
Expected: vitest 全green / tsc 0 / eslint 変更分0 / build OK

- [ ] **Step 6: コミット**

```bash
git add "src/app/(dashboard)/import/page.tsx" "src/app/(dashboard)/import/__tests__/page-dark.test.ts"
git commit -m "feat(dark): 取込トップ(import/page) ダークモード対応"
```

---

## 完了後
- PR1 = branch `feat/dark-mode-import`（Task1+Task2）。投稿前に codex プレレビュー（ホットスポット=色ロック判定・accent panel・ライト不変）→ PR作成。@codex 自動レビューは上限リセット後にqueue→指摘は自分で対応→自分で再レビュー起動。**マージはユーザー**。
- PR2（jobs/[jobId] 1,802行）・PR3（registry-pdf 1,395行）は PR1 マージ後、各 `origin/main` 最新から別worktree/別計画で同パターン実施。

## Self-Review（spec照合・実施済）
- spec 3画面のうち PR1（取込トップ）を網羅。owners stub=no-op 確認済で scope除外を明記。
- placeholder無し（テスト全文・マッピング全値・コマンド・期待値を記載）。
- 型/シグネチャ無し（クラス文字列のみの作業）＝命名不整合リスク無。
- 色ロック・PII属性・StatusBadge の据え置きを Global Constraints と各 Step に明記。
