# 販売図面「取引情報」パネル Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 販売図面エディタに「取引情報」パネルを追加し、会社帯の物件別6項目(取引態様/広告/報酬/担当者/取引士/特記事項)を作成後もまとめて編集できるようにする。

**Architecture:** 帯要素を唯一の正とする。`footer-band.ts` の取引テーブル生成部を純関数 `buildFooterTransactionElements` に切り出し、`buildFooterBand`(作成時)と新 reducer `editFooterData`(編集時)で共有する。パネルは `readFooterData` で現在値を復元し、「適用」で `editFooterData` を dispatch して帯の取引部分だけ再生成する。

**Tech Stack:** TypeScript / React (Next.js App Router) / Zod / Vitest(env=node)。既存の sales-sheet エディタ(editor-document.ts reducers・ElementPanel/EditorToolbar/SalesSheetEditor)。

## Global Constraints

- 新規依存の追加・`prisma/schema.prisma`・DB migration・document スキーマ変更は **禁止**(このプランでは行わない)。
- 新しい element 種別を追加しない(二重レンダラ `SalesSheetRenderer.tsx` / `render-html.ts` は無改修)。
- reducer は純関数・不変。変更が無ければ **同一 state 参照**を返す(既存 editor-document.ts の規約)。document は常に `parseSalesSheetDocument` を通る形を保つ。
- 幾何(x/y/w/h)は常に正数(document-schema 準拠・保存 422 回避)。既存 `clampRect`/`MIN_DIM_MM` を流用。
- UI テストは env=node のため `renderToStaticMarkup` + ソース文字列 assert。クリック/state 遷移の単体テストは書かない(自明変更 + レビューで担保)。
- 「緑」宣言前にフル `npx vitest run`・`tsc --noEmit`・eslint(変更分)・`npm run build` を通す。
- HTTP 本番のため `crypto.randomUUID` 禁止(このプランでは ID 生成不要だが原則)。

## ファイル構成

- **Modify** `src/lib/sales-sheet/footer-band.ts` — 取引テーブル生成を `buildFooterTransactionElements` に切り出し、列座標ヘルパ `footerColumnGeometry`・行ラベル共有定数・`readFooterData`・`footerDataEqual` を追加。
- **Modify** `src/lib/sales-sheet/editor-document.ts` — reducer `editFooterData` を追加。
- **Create** `src/components/sales-sheet/editor/TransactionInfoDialog.tsx` — 6項目の編集モーダル(制御コンポーネント)。
- **Modify** `src/components/sales-sheet/editor/EditorToolbar.tsx` — 「取引情報」ボタン(`onOpenTransactionInfo`)。
- **Modify** `src/components/sales-sheet/editor/SalesSheetEditor.tsx` — 開閉 state・ダイアログ描画・`editFooterData` dispatch。
- **Test** `src/lib/sales-sheet/__tests__/footer-transaction.test.ts`(新規)、既存 `footer-band.test.ts`(parity 確認)、`src/lib/sales-sheet/__tests__/editor-document-footer-data.test.ts`(新規)、`src/components/sales-sheet/editor/__tests__/transaction-info-dialog.test.tsx`(新規)、`src/components/sales-sheet/editor/__tests__/editor-toolbar.test.tsx`(既存に追記)。

---

### Task 1: `buildFooterTransactionElements` 切り出し + `readFooterData` + `footerDataEqual`

**Files:**
- Modify: `src/lib/sales-sheet/footer-band.ts`
- Test: `src/lib/sales-sheet/__tests__/footer-transaction.test.ts` (create)

**Interfaces:**
- Produces:
  - `interface FooterBandData`(既存・再利用)。
  - `footerColumnGeometry(footer: Rect): { companyW: number; termsW: number; staffW: number; companyX0: number; termsX0: number; staffX0: number }`
  - `buildFooterTransactionElements(footer: Rect, data: FooterBandData): SalesSheetElement[]` — 返す要素は `footer-terms-table`(常時)、値があれば `footer-divider-staff` + `footer-staff-table`。
  - `readFooterData(elements: SalesSheetElement[]): FooterBandData` — 既存帯テーブルから6値を復元(欠けは "")。
  - `footerDataEqual(a: FooterBandData, b: FooterBandData): boolean` — undefined と "" を同一視して6項目を比較。
- Consumes: 既存 `footer-band.ts` の module 定数(`COMPANY_W_RATIO`/`TERMS_W_RATIO`/`PAD_MM`/`GAP_MM`/`DIVIDER_W_MM`/`FONT_PT`/`NAVY`/`TABLE_BORDER_COLOR`)、`clampRect`/`mkDivider`/`pickRows`、`Rect`(layout-engine)。

- [ ] **Step 1: 失敗するテストを書く**

Create `src/lib/sales-sheet/__tests__/footer-transaction.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  buildFooterTransactionElements,
  footerColumnGeometry,
  readFooterData,
  footerDataEqual,
  buildFooterBand,
  type FooterBandData,
} from "../footer-band";
import type { Rect } from "../layout-engine";
import type { TableElement } from "../document-schema";

const FOOTER: Rect = { x: 10, y: 180, w: 277, h: 24 };

const FULL: FooterBandData = {
  transactionType: "専任",
  adType: "不可",
  compensation: "税込3%",
  staff: "山田",
  agent: "佐藤",
  specialNotes: "即入居可",
};

function byId(els: { id: string }[], id: string) {
  return els.find((e) => e.id === id);
}

describe("footerColumnGeometry", () => {
  it("会社55% / 取引16% / 担当=残り で3分割する", () => {
    const g = footerColumnGeometry(FOOTER);
    expect(g.companyW).toBe(Math.round(277 * 0.55));
    expect(g.termsW).toBe(Math.round(277 * 0.16));
    expect(g.staffW).toBe(277 - g.companyW - g.termsW);
    expect(g.termsX0).toBe(10 + g.companyW);
    expect(g.staffX0).toBe(10 + g.companyW + g.termsW);
  });
});

describe("buildFooterTransactionElements", () => {
  it("全項目ありなら 取引条件表 + 担当区切り線 + 担当表 を出す", () => {
    const els = buildFooterTransactionElements(FOOTER, FULL);
    expect(byId(els, "footer-terms-table")).toBeDefined();
    expect(byId(els, "footer-divider-staff")).toBeDefined();
    expect(byId(els, "footer-staff-table")).toBeDefined();
    const terms = byId(els, "footer-terms-table") as TableElement;
    expect(terms.rows).toEqual([
      { label: "取引態様", value: "専任" },
      { label: "広告", value: "不可" },
      { label: "報酬", value: "税込3%" },
    ]);
  });

  it("担当系が全空なら担当表と担当区切り線を省く", () => {
    const els = buildFooterTransactionElements(FOOTER, {
      transactionType: "専任",
    });
    expect(byId(els, "footer-terms-table")).toBeDefined();
    expect(byId(els, "footer-staff-table")).toBeUndefined();
    expect(byId(els, "footer-divider-staff")).toBeUndefined();
  });

  it("幾何は帯内・w/h は正数", () => {
    const els = buildFooterTransactionElements(FOOTER, FULL);
    for (const e of els) {
      expect(e.w).toBeGreaterThan(0);
      expect(e.h).toBeGreaterThan(0);
      expect(e.x).toBeGreaterThanOrEqual(FOOTER.x);
      expect(e.y).toBeGreaterThanOrEqual(FOOTER.y);
    }
  });
});

describe("buildFooterBand parity", () => {
  it("buildFooterBand の取引系要素は buildFooterTransactionElements と一致する", () => {
    const band = buildFooterBand(FOOTER, FULL);
    const tx = buildFooterTransactionElements(FOOTER, FULL);
    const ids = ["footer-terms-table", "footer-divider-staff", "footer-staff-table"];
    for (const id of ids) {
      expect(byId(band, id)).toEqual(byId(tx, id));
    }
  });
});

describe("readFooterData", () => {
  it("帯テーブルから6値を復元する", () => {
    const band = buildFooterBand(FOOTER, FULL);
    expect(readFooterData(band)).toEqual(FULL);
  });

  it("担当表が無い帯では担当系は空文字で返す", () => {
    const band = buildFooterBand(FOOTER, { transactionType: "専任" });
    const d = readFooterData(band);
    expect(d.transactionType).toBe("専任");
    expect(d.staff).toBe("");
    expect(d.agent).toBe("");
    expect(d.specialNotes).toBe("");
  });
});

describe("footerDataEqual", () => {
  it("undefined と '' を同一視する", () => {
    expect(footerDataEqual({ transactionType: "専任" }, { transactionType: "専任", staff: "" })).toBe(true);
  });
  it("値が違えば false", () => {
    expect(footerDataEqual({ transactionType: "専任" }, { transactionType: "一般媒介" })).toBe(false);
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/footer-transaction.test.ts`
Expected: FAIL(`buildFooterTransactionElements`/`footerColumnGeometry`/`readFooterData`/`footerDataEqual` が export されていない)。

- [ ] **Step 3: `footer-band.ts` をリファクタして関数を追加**

`footer-band.ts` の `buildFooterBand` 冒頭(現状の `companyW`/`termsW`/`staffW`/`companyX0`/`termsX0`/`staffX0` 計算)を、新ヘルパ呼び出しに置き換える。既存の `pickRows` 定義の直後・`buildFooterBand` の直前に、次の順(ラベル定数 → 列幾何 → 取引ビルダー → 復元 → 等価判定)で追加:

```ts
/** 帯テーブルの行ラベル。生成(buildFooterTransactionElements)と復元(readFooterData)で共有。 */
const TERMS_LABELS = { transactionType: "取引態様", adType: "広告", compensation: "報酬" } as const;
const STAFF_LABELS = { staff: "担当", agent: "取引士", specialNotes: "特記事項" } as const;

/** 会社帯の横3分割(会社/取引条件/担当)の列幾何。buildFooterBand と
 *  buildFooterTransactionElements が同じ座標計算を共有する(見た目のズレ防止)。 */
export function footerColumnGeometry(footer: Rect): {
  companyW: number;
  termsW: number;
  staffW: number;
  companyX0: number;
  termsX0: number;
  staffX0: number;
} {
  const companyW = Math.round(footer.w * COMPANY_W_RATIO);
  const termsW = Math.round(footer.w * TERMS_W_RATIO);
  const staffW = footer.w - companyW - termsW;
  return {
    companyW,
    termsW,
    staffW,
    companyX0: footer.x,
    termsX0: footer.x + companyW,
    staffX0: footer.x + companyW + termsW,
  };
}

/** 帯の取引条件テーブル/担当テーブル(+担当区切り線)を組む。物件別の
 *  FooterBandData だけに依存する部分(作成時=buildFooterBand・編集時=editFooterData 共有)。
 *  会社ブロック・帯外枠・「会社|取引」区切り線は含まない(それらは常在・データ非依存)。 */
export function buildFooterTransactionElements(footer: Rect, data: FooterBandData): SalesSheetElement[] {
  const { termsW, staffW, termsX0, staffX0 } = footerColumnGeometry(footer);
  const hasStaff = !!(data.staff || data.agent || data.specialNotes);
  const elements: SalesSheetElement[] = [];

  const termsRows = pickRows([
    [TERMS_LABELS.transactionType, data.transactionType],
    [TERMS_LABELS.adType, data.adType],
    [TERMS_LABELS.compensation, data.compensation],
  ]);
  elements.push({
    id: "footer-terms-table",
    type: "table",
    ...clampRect(
      { x: termsX0 + GAP_MM, y: footer.y + PAD_MM, w: termsW - GAP_MM * 2, h: footer.h - PAD_MM * 2 },
      footer,
    ),
    z: 2,
    rows: termsRows.length > 0 ? termsRows : [{ label: "", value: "" }],
    style: { fontSizePt: FONT_PT.table, labelColor: NAVY, borderColor: TABLE_BORDER_COLOR },
  });

  if (hasStaff) {
    elements.push(
      mkDivider(
        "footer-divider-staff",
        clampRect({ x: staffX0, y: footer.y + PAD_MM, w: DIVIDER_W_MM, h: footer.h - PAD_MM * 2 }, footer),
      ),
    );
    const staffRows = pickRows([
      [STAFF_LABELS.staff, data.staff],
      [STAFF_LABELS.agent, data.agent],
      [STAFF_LABELS.specialNotes, data.specialNotes],
    ]);
    elements.push({
      id: "footer-staff-table",
      type: "table",
      ...clampRect(
        { x: staffX0 + GAP_MM, y: footer.y + PAD_MM, w: staffW - GAP_MM * 2, h: footer.h - PAD_MM * 2 },
        footer,
      ),
      z: 2,
      rows: staffRows,
      style: { fontSizePt: FONT_PT.table, labelColor: NAVY, borderColor: TABLE_BORDER_COLOR },
    });
  }

  return elements;
}

/** document の帯テーブルから現在の6値を復元する(欠け・省略は "")。 */
export function readFooterData(elements: SalesSheetElement[]): FooterBandData {
  const terms = elements.find((e) => e.id === "footer-terms-table" && e.type === "table");
  const staff = elements.find((e) => e.id === "footer-staff-table" && e.type === "table");
  const read = (el: SalesSheetElement | undefined, label: string): string => {
    if (!el || el.type !== "table") return "";
    return el.rows.find((r) => r.label === label)?.value ?? "";
  };
  return {
    transactionType: read(terms, TERMS_LABELS.transactionType),
    adType: read(terms, TERMS_LABELS.adType),
    compensation: read(terms, TERMS_LABELS.compensation),
    staff: read(staff, STAFF_LABELS.staff),
    agent: read(staff, STAFF_LABELS.agent),
    specialNotes: read(staff, STAFF_LABELS.specialNotes),
  };
}

/** 6項目の等価判定(undefined と "" を同一視)。editFooterData の no-op 判定に使う。 */
export function footerDataEqual(a: FooterBandData, b: FooterBandData): boolean {
  const keys: (keyof FooterBandData)[] = [
    "transactionType",
    "adType",
    "compensation",
    "staff",
    "agent",
    "specialNotes",
  ];
  return keys.every((k) => (a[k] ?? "") === (b[k] ?? ""));
}
```

次に `buildFooterBand` 本体を、列幾何ヘルパと取引ビルダーを使う形へ置き換える。冒頭の列計算(現状の `companyW`/`termsW`/`staffW`/`companyX0`/`termsX0`/`staffX0`/`hasStaff` の7宣言=lines 139-147 相当)を丸ごと削除し、次の1行に置き換える:

```ts
export function buildFooterBand(footer: Rect, data: FooterBandData): SalesSheetElement[] {
  const { companyX0, termsX0 } = footerColumnGeometry(footer);
```
(会社ブロックは `companyX0`(=footer.x + PAD_MM の基点)を、`footer-divider-terms` と会社グリッド右端は `termsX0` を使う。`termsW`/`staffW`/`staffX0`/`hasStaff` は取引部分へ移ったため buildFooterBand では不要=destructure しない。)

`buildFooterBand` 末尾の「取引条件テーブル」「担当テーブル」ブロック(現状の `const termsRows = pickRows([...])` から `if (hasStaff) { ... }` の閉じ括弧まで)を丸ごと削除し、`footer-divider-terms` を push した直後に次の1行を置く:

```ts
  elements.push(...buildFooterTransactionElements(footer, data));

  return elements;
```

`tsc --noEmit`(noUnusedLocals)と eslint で未使用ローカルが残っていないことを確認する。

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/footer-transaction.test.ts`
Expected: PASS(全 describe)。

- [ ] **Step 5: 既存 footer-band テストの parity を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/footer-band.test.ts`
Expected: PASS(切り出しは挙動不変=既存の帯テストが無改修で緑)。落ちた場合はリファクタで出力が変わっている=Step 3 を見直す。

- [ ] **Step 6: コミット**

```bash
git add src/lib/sales-sheet/footer-band.ts src/lib/sales-sheet/__tests__/footer-transaction.test.ts
git commit -m "refactor(sales-sheet): 帯の取引部分を buildFooterTransactionElements へ切り出し + readFooterData/footerDataEqual"
```

---

### Task 2: reducer `editFooterData`

**Files:**
- Modify: `src/lib/sales-sheet/editor-document.ts`
- Test: `src/lib/sales-sheet/__tests__/editor-document-footer-data.test.ts` (create)

**Interfaces:**
- Consumes: `buildFooterTransactionElements` / `readFooterData` / `footerDataEqual` / `FooterBandData`(Task 1)。既存 `EditorState`。
- Produces: `editFooterData(state: EditorState, data: FooterBandData): EditorState` — 帯の取引部分を `data` で再生成。会社帯外枠(`footer-band`)が無ければ no-op。現状値と等価(footerDataEqual)なら同一参照。変更時 dirty=true。要素順は `footer-divider-terms` の直後に挿入して保つ。

- [ ] **Step 1: 失敗するテストを書く**

Create `src/lib/sales-sheet/__tests__/editor-document-footer-data.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { editFooterData } from "../editor-document";
import type { EditorState } from "../editor-document";
import { buildFooterBand, readFooterData, type FooterBandData } from "../footer-band";
import { A4_LANDSCAPE, parseSalesSheetDocument } from "../document-schema";
import type { Rect } from "../layout-engine";

const FOOTER: Rect = { x: 10, y: 180, w: 277, h: 24 };

function stateWith(data: FooterBandData): EditorState {
  const elements = buildFooterBand(FOOTER, data);
  return {
    document: { page: A4_LANDSCAPE, theme: { fontFamily: "sans-serif", accentColor: "#15324f" }, elements },
    selectedId: null,
    dirty: false,
  };
}

describe("editFooterData", () => {
  it("値を変えると取引表に反映され dirty=true・document は parse 可能", () => {
    const s0 = stateWith({ transactionType: "専任" });
    const s1 = editFooterData(s0, { transactionType: "一般媒介", compensation: "税込3%" });
    expect(s1).not.toBe(s0);
    expect(s1.dirty).toBe(true);
    expect(() => parseSalesSheetDocument(s1.document)).not.toThrow();
    expect(readFooterData(s1.document.elements)).toMatchObject({
      transactionType: "一般媒介",
      compensation: "税込3%",
    });
  });

  it("作成時に空だった担当を後から入れると担当表が復活する", () => {
    const s0 = stateWith({ transactionType: "専任" });
    expect(s0.document.elements.find((e) => e.id === "footer-staff-table")).toBeUndefined();
    const s1 = editFooterData(s0, { transactionType: "専任", staff: "山田" });
    expect(s1.document.elements.find((e) => e.id === "footer-staff-table")).toBeDefined();
    expect(readFooterData(s1.document.elements).staff).toBe("山田");
  });

  it("担当を全て消すと担当表が消える", () => {
    const s0 = stateWith({ transactionType: "専任", staff: "山田" });
    const s1 = editFooterData(s0, { transactionType: "専任", staff: "" });
    expect(s1.document.elements.find((e) => e.id === "footer-staff-table")).toBeUndefined();
  });

  it("現状と等価な値なら no-op(同一参照)", () => {
    const s0 = stateWith({ transactionType: "専任", staff: "山田" });
    const s1 = editFooterData(s0, { transactionType: "専任", staff: "山田", adType: "" });
    expect(s1).toBe(s0);
  });

  it("footer-band 外枠が無い document では no-op(同一参照)", () => {
    const s0 = stateWith({ transactionType: "専任" });
    const stripped: EditorState = {
      ...s0,
      document: {
        ...s0.document,
        elements: s0.document.elements.filter((e) => e.id !== "footer-band"),
      },
    };
    const s1 = editFooterData(stripped, { transactionType: "一般媒介" });
    expect(s1).toBe(stripped);
  });

  it("要素順: 取引表は footer-divider-terms の直後に来る", () => {
    const s0 = stateWith({ transactionType: "専任" });
    const s1 = editFooterData(s0, { transactionType: "一般媒介" });
    const ids = s1.document.elements.map((e) => e.id);
    expect(ids.indexOf("footer-terms-table")).toBe(ids.indexOf("footer-divider-terms") + 1);
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/editor-document-footer-data.test.ts`
Expected: FAIL(`editFooterData` が export されていない)。

- [ ] **Step 3: reducer を実装**

`editor-document.ts` の import(現状 `import { buildFooterBand } from "./footer-band";`)を差し替え:

```ts
import {
  buildFooterBand,
  buildFooterTransactionElements,
  readFooterData,
  footerDataEqual,
  type FooterBandData,
} from "./footer-band";
```

reducer 群の末尾(概要表編集の下・自動レイアウトの前あたり)に追加:

```ts
/**
 * 会社帯の物件別6項目(取引態様/広告/報酬/担当者/取引士/特記事項)をまとめて更新する。
 * - 帯外枠 footer-band の矩形を帯領域として、取引条件/担当テーブル(+担当区切り線)だけを
 *   buildFooterTransactionElements で再生成し、既存の取引系要素と差し替える。
 * - 会社ブロック・写真・他要素・footer-divider-terms は不変。
 * - footer-band が無い document(壊れた図面)では no-op(同一参照)。
 * - 現状の6値(readFooterData)と等価(footerDataEqual)なら no-op(同一参照)＝手動配置も保持。
 * - 要素順は footer-divider-terms の直後へ挿入して保つ。変更時 dirty=true。
 */
export function editFooterData(state: EditorState, data: FooterBandData): EditorState {
  const { document } = state;
  const band = document.elements.find((e) => e.id === "footer-band");
  if (!band) return state;
  if (footerDataEqual(readFooterData(document.elements), data)) return state;

  const footer = { x: band.x, y: band.y, w: band.w, h: band.h };
  const regenerated = buildFooterTransactionElements(footer, data);
  const TX_IDS = new Set(["footer-terms-table", "footer-divider-staff", "footer-staff-table"]);

  const elements: SalesSheetElement[] = [];
  let inserted = false;
  for (const el of document.elements) {
    if (TX_IDS.has(el.id)) continue;
    elements.push(el);
    if (el.id === "footer-divider-terms") {
      elements.push(...regenerated);
      inserted = true;
    }
  }
  if (!inserted) elements.push(...regenerated);

  return { ...state, dirty: true, document: { ...document, elements } };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/editor-document-footer-data.test.ts`
Expected: PASS(全 6 ケース)。

- [ ] **Step 5: コミット**

```bash
git add src/lib/sales-sheet/editor-document.ts src/lib/sales-sheet/__tests__/editor-document-footer-data.test.ts
git commit -m "feat(sales-sheet): editFooterData reducer で帯の取引6項目を一括編集"
```

---

### Task 3: `TransactionInfoDialog` コンポーネント

**Files:**
- Create: `src/components/sales-sheet/editor/TransactionInfoDialog.tsx`
- Test: `src/components/sales-sheet/editor/__tests__/transaction-info-dialog.test.tsx` (create)

**Interfaces:**
- Consumes: `FooterBandData`(footer-band)、option-master `TRANSACTION_TYPE`/`AD_TYPE`/`COMPENSATION`。
- Produces: `TransactionInfoDialog({ open, initial, onApply, onClose }: { open: boolean; initial: FooterBandData; onApply: (data: FooterBandData) => void; onClose: () => void })` — 6項目フォーム。取引態様/広告=select、報酬=combo(datalist)、担当者/取引士/特記事項=text。「適用」で `onApply(現在値)`、「キャンセル」で `onClose`。

- [ ] **Step 1: 失敗するテストを書く**

Create `src/components/sales-sheet/editor/__tests__/transaction-info-dialog.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TransactionInfoDialog } from "../TransactionInfoDialog";

const initial = {
  transactionType: "専任",
  adType: "不可",
  compensation: "税込3%",
  staff: "山田",
  agent: "佐藤",
  specialNotes: "即入居可",
};

describe("TransactionInfoDialog", () => {
  it("open=false では何も描画しない", () => {
    const html = renderToStaticMarkup(
      <TransactionInfoDialog open={false} initial={initial} onApply={() => {}} onClose={() => {}} />,
    );
    expect(html).toBe("");
  });

  it("open=true で6項目のラベルと現在値を描画する", () => {
    const html = renderToStaticMarkup(
      <TransactionInfoDialog open initial={initial} onApply={() => {}} onClose={() => {}} />,
    );
    for (const label of ["取引態様", "広告", "報酬", "担当者", "取引士", "特記事項"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("山田");
    expect(html).toContain("佐藤");
    // combo(datalist)の候補と select の選択肢が出る
    expect(html).toContain("専属専任");
    expect(html).toContain("税込3%+6万円");
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run src/components/sales-sheet/editor/__tests__/transaction-info-dialog.test.tsx`
Expected: FAIL(`TransactionInfoDialog` module が無い)。

- [ ] **Step 3: コンポーネントを実装**

Create `src/components/sales-sheet/editor/TransactionInfoDialog.tsx`:

```tsx
"use client";

import { useState } from "react";
import type { FooterBandData } from "@/lib/sales-sheet/footer-band";
import { TRANSACTION_TYPE, AD_TYPE, COMPENSATION } from "@/lib/sales-sheet/option-master";

/**
 * 会社帯の物件別6項目(取引態様/広告/報酬/担当者/取引士/特記事項)を
 * まとめて編集するモーダル。開いた時点の initial を初期値とし、「適用」で
 * onApply(現在値) を1回だけ呼ぶ(帯の取引部分の再生成は親の editFooterData 側)。
 */
export function TransactionInfoDialog({
  open,
  initial,
  onApply,
  onClose,
}: {
  open: boolean;
  initial: FooterBandData;
  onApply: (data: FooterBandData) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<FooterBandData>(initial);
  if (!open) return null;

  const set = (patch: Partial<FooterBandData>) => setValues((v) => ({ ...v, ...patch }));
  const labelCls = "w-24 shrink-0 text-sm text-gray-700 dark:text-gray-300";
  const fieldCls =
    "flex-1 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-[380px] rounded-lg bg-white p-5 shadow-xl dark:bg-neutral-800" data-transaction-info-dialog>
        <h2 className="mb-3 text-base font-bold text-gray-900 dark:text-gray-100">取引情報</h2>
        <p className="mb-3 text-xs text-neutral-500 dark:text-neutral-400">
          物件ごとに変わる項目です。空欄にすると図面の帯からその行は消えます。
        </p>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <label htmlFor="tx-transaction-type" className={labelCls}>取引態様</label>
            <select
              id="tx-transaction-type"
              aria-label="取引態様"
              value={values.transactionType ?? ""}
              onChange={(e) => set({ transactionType: e.target.value })}
              className={fieldCls}
            >
              <option value="">選択してください</option>
              {TRANSACTION_TYPE.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="tx-ad-type" className={labelCls}>広告</label>
            <select
              id="tx-ad-type"
              aria-label="広告"
              value={values.adType ?? ""}
              onChange={(e) => set({ adType: e.target.value })}
              className={fieldCls}
            >
              <option value="">選択してください</option>
              {AD_TYPE.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="tx-compensation" className={labelCls}>報酬</label>
            <input
              id="tx-compensation"
              aria-label="報酬"
              list="tx-compensation-list"
              value={values.compensation ?? ""}
              onChange={(e) => set({ compensation: e.target.value })}
              className={fieldCls}
            />
            <datalist id="tx-compensation-list">
              {COMPENSATION.map((o) => (
                <option key={o} value={o} />
              ))}
            </datalist>
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="tx-staff" className={labelCls}>担当者</label>
            <input
              id="tx-staff"
              aria-label="担当者"
              value={values.staff ?? ""}
              onChange={(e) => set({ staff: e.target.value })}
              className={fieldCls}
            />
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="tx-agent" className={labelCls}>取引士</label>
            <input
              id="tx-agent"
              aria-label="取引士"
              value={values.agent ?? ""}
              onChange={(e) => set({ agent: e.target.value })}
              className={fieldCls}
            />
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="tx-special-notes" className={labelCls}>特記事項</label>
            <input
              id="tx-special-notes"
              aria-label="特記事項"
              value={values.specialNotes ?? ""}
              onChange={(e) => set({ specialNotes: e.target.value })}
              className={fieldCls}
            />
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-neutral-700"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={() => onApply(values)}
            className="rounded bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            適用
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/components/sales-sheet/editor/__tests__/transaction-info-dialog.test.tsx`
Expected: PASS(2 ケース)。

- [ ] **Step 5: コミット**

```bash
git add src/components/sales-sheet/editor/TransactionInfoDialog.tsx src/components/sales-sheet/editor/__tests__/transaction-info-dialog.test.tsx
git commit -m "feat(sales-sheet): 取引情報の編集モーダル TransactionInfoDialog"
```

---

### Task 4: エディタへ結線(ツールバーボタン + SalesSheetEditor)

**Files:**
- Modify: `src/components/sales-sheet/editor/EditorToolbar.tsx`
- Modify: `src/components/sales-sheet/editor/SalesSheetEditor.tsx`
- Test: `src/components/sales-sheet/editor/__tests__/editor-toolbar.test.tsx` (append)

**Interfaces:**
- Consumes: `editFooterData`(Task 2)、`readFooterData`(Task 1)、`TransactionInfoDialog`(Task 3)。
- Produces: `EditorToolbarProps.onOpenTransactionInfo: () => void`(新規)。SalesSheetEditor に取引情報ダイアログの開閉 state。

- [ ] **Step 1: EditorToolbar のテストを追記(失敗する)**

`src/components/sales-sheet/editor/__tests__/editor-toolbar.test.tsx` に追記(既存の describe 内、または新規 it)。既存テストが `onExport` 等の必須 props を渡してレンダリングしているので、それに倣い `onOpenTransactionInfo={() => {}}` を足してボタンの存在を確認する:

```tsx
it("「取引情報」ボタンを描画する", () => {
  const html = renderToStaticMarkup(
    <EditorToolbar
      dirty={false}
      onSave={async () => {}}
      onExport={async () => {}}
      onDelete={async () => {}}
      onAddPhoto={() => {}}
      onAutoArrange={() => {}}
      onAutoBalance={() => {}}
      onAddBadge={() => {}}
      onAddQr={() => {}}
      onOpenTransactionInfo={() => {}}
    />,
  );
  expect(html).toContain("取引情報");
  expect(html).toContain('data-toolbar-transaction-info');
});
```

(既存テストがヘルパで props を生成している場合は、そのヘルパに `onOpenTransactionInfo: () => {}` を追加し、既存レンダリング結果に対して上記 2 つの `expect` を追記する。)

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run src/components/sales-sheet/editor/__tests__/editor-toolbar.test.tsx`
Expected: FAIL(型: `onOpenTransactionInfo` が Props に無い / DOM に「取引情報」ボタンが無い)。

- [ ] **Step 3: EditorToolbar にボタンを追加**

`EditorToolbarProps` に prop を追加:

```ts
  /** 会社帯の物件別6項目(取引情報)の編集モーダルを開く。 */
  onOpenTransactionInfo: () => void;
```

関数引数の分割代入に `onOpenTransactionInfo` を追加し、「QRを追加」ボタンの直後(PDF出力の前)にボタンを置く:

```tsx
      <button
        type="button"
        data-toolbar-transaction-info
        onClick={onOpenTransactionInfo}
        disabled={busy}
        className="rounded px-3 py-1.5 text-sm border border-neutral-300 dark:border-zinc-600 hover:bg-neutral-100 dark:hover:bg-zinc-700 disabled:opacity-50 dark:text-neutral-200"
      >
        取引情報
      </button>
```

**既存テストの型崩れ防止**: `onOpenTransactionInfo` は必須 prop のため、`editor-toolbar.test.tsx` 内の既存 `<EditorToolbar .../>`(9箇所)全ての props に `onOpenTransactionInfo={() => {}}` を追加する(多くは `onAddQr={() => {}}` を含むので同じ要領で1行足す)。vitest は型チェックしないためレンダリング系テストは足さなくても緑になるが、漏れは Step 6 の `tsc --noEmit` で顕在化する=必ず全箇所足すこと。

- [ ] **Step 4: EditorToolbar テストが通ることを確認**

Run: `npx vitest run src/components/sales-sheet/editor/__tests__/editor-toolbar.test.tsx`
Expected: PASS。

- [ ] **Step 5: SalesSheetEditor に結線**

import に追加(既存の editor-document import ブロックへ `editFooterData`、footer-band から `readFooterData`、ローカルの TransactionInfoDialog):

```tsx
import { editFooterData } from "@/lib/sales-sheet/editor-document";
import { readFooterData } from "@/lib/sales-sheet/footer-band";
import { TransactionInfoDialog } from "./TransactionInfoDialog";
```
(`editFooterData` は既存の `import { ... } from "@/lib/sales-sheet/editor-document"` に足してよい。)

開閉 state を追加(既存 `useState` 群の近く):

```tsx
  const [txInfoOpen, setTxInfoOpen] = useState(false);
```

`EditorToolbar` に prop を渡す(既存の `onAutoBalance` 等の並び):

```tsx
        onOpenTransactionInfo={() => setTxInfoOpen(true)}
```

ダイアログを描画する(既存の PhotoGalleryPanel を描いている辺り・ツールバー/キャンバスの外側の JSX 末尾)。開いている時だけマウントし、その時点の現在値を初期値にする:

```tsx
      {txInfoOpen && (
        <TransactionInfoDialog
          open
          initial={readFooterData(editorState.document.elements)}
          onClose={() => setTxInfoOpen(false)}
          onApply={(data) => {
            setEditorState((prev) => editFooterData(prev, data));
            setTxInfoOpen(false);
          }}
        />
      )}
```

- [ ] **Step 6: 型・lint・関連テストを確認**

Run: `npx tsc --noEmit`
Expected: 0 エラー。

Run: `npx vitest run src/components/sales-sheet/editor src/lib/sales-sheet`
Expected: PASS(エディタ+ sales-sheet lib の全テスト)。

- [ ] **Step 7: コミット**

```bash
git add src/components/sales-sheet/editor/EditorToolbar.tsx src/components/sales-sheet/editor/SalesSheetEditor.tsx src/components/sales-sheet/editor/__tests__/editor-toolbar.test.tsx
git commit -m "feat(sales-sheet): エディタに「取引情報」ボタンとモーダルを結線"
```

---

### Task 5: 全ゲート + 提出前レビュー

**Files:** なし(検証のみ)

- [ ] **Step 1: フルスイート**

Run: `npx vitest run`
Expected: 全 PASS(既存 + 新規)。件数は着手時の baseline より新規テスト分だけ増える。

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: 0。

- [ ] **Step 3: eslint(変更ファイルのみ)**

Run: `npx eslint src/lib/sales-sheet/footer-band.ts src/lib/sales-sheet/editor-document.ts src/components/sales-sheet/editor/TransactionInfoDialog.tsx src/components/sales-sheet/editor/EditorToolbar.tsx src/components/sales-sheet/editor/SalesSheetEditor.tsx`
Expected: 0 error(既存 baseline の warning があれば `git stash` で切り分け)。

- [ ] **Step 4: build**

Run: `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build`
Expected: Compiled successfully。

- [ ] **Step 5: 提出前レビュー**

`feature-dev:code-reviewer` に staged diff をレビューさせる。ホットスポット指定: (1) 二重レンダラ parity(帯要素は table/text/shape のみで新種別なし=無改修で正しいか) (2) reducer 純粋性・no-op 規約・document が parse 可能か (3) `readFooterData`/`footerDataEqual` のラベル一致の堅牢性 (4) 認可・PII(取引情報に生 PII/秘匿値をログ・監査へ出していないか=本 UI はクライアント内 state のみで送信は既存 save 経路)。

## Self-Review(記入済み)

**Spec coverage:**
- 「専用UI(ツールバー→モーダル・6項目)」= Task 3 + Task 4。✓
- 「編集内容を帯へ即時反映・空→復活/入力→消滅」= Task 2(editFooterData)+ Task 1(buildFooterTransactionElements の pickRows/hasStaff)。✓
- 「作成時・作成後どちらでも同じUI」= Task 4(エディタ内で常時開ける)。✓
- 「帯要素を唯一の正・スキーマ変更なし」= Task 1/2(readFooterData 復元・metadata 追加なし)。✓
- 「footer-band 計算共有」= Task 1(footerColumnGeometry / buildFooterTransactionElements を buildFooterBand と共有)。✓
- 「footer-band 欠如で no-op」= Task 2 テスト。✓
- 「会社ブロック不変」= Task 2(TX_IDS のみ差し替え・footer-divider-terms/会社要素は保持)。✓
- 「割り切り(適用で取引表が定位置へ)」= Task 2(値変更時のみ再生成=等価なら no-op で位置保持。spec より緩和=値を変えた時だけ定位置化)。✓ 実装挙動が spec の割り切りより良い方向のため許容。
- テスト方針 = 各 Task の TDD + Task 5 フルゲート。✓

**Placeholder scan:** なし(全 step に実コード/実コマンド)。

**Type consistency:** `FooterBandData`(footer-band 既存)/`buildFooterTransactionElements(footer, data)`/`readFooterData(elements)`/`footerDataEqual(a,b)`/`editFooterData(state, data)`/`onOpenTransactionInfo: () => void`/`TransactionInfoDialog({open, initial, onApply, onClose})` は全 Task で一致。option-master の `TRANSACTION_TYPE`/`AD_TYPE`/`COMPENSATION` は実在(確認済)。
