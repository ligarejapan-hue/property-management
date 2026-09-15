# 販売図面 消費者向けひな型(第①段) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新規作成の販売図面を「整理型(案3)×紺・罫線なし・主要/詳細の2表・電話を大きく」に作り替え、3列(中央に間取り図)の動きを廃止し、旧ひな型の図面では自動機能を止める。

**Architecture:** 図面は従来どおり「要素の配列(JSON)」。新しい座標計算 `computeConsumerLayout`(layout-engine)と新しい会社帯 `buildConsumerFooterBand`(footer-band)をビルダーとエディタで共有する。表の見た目は任意の3指定(線なし/1行おき色/余白)を両レンダラ共通の `tableCellStyle` で描く。新旧は `theme.template` で判定する。

**Tech Stack:** TypeScript / Next.js 16 / React / zod / vitest(`npx vitest run`) / eslint(`npx eslint`) / tsc(`npx tsc --noEmit`)

**Spec:** `docs/superpowers/specs/2026-09-15-sales-sheet-consumer-restyle-design.md`

## Global Constraints

- 作業場所: worktree `C:\Users\issin\Desktop\Claude\property-management-worktrees\sales-sheet-consumer-restyle`(branch `feat/sales-sheet-consumer-restyle`)。main の作業ツリーでは作業しない。
- migration・依存追加・env 追加は禁止。
- 色: 紺 `#1f3a5f` / 価格 `#b7281e` / 淡紺 `#eef2f7` / 本文 `#1a1a1a` / 補足 `#555555` / 白 `#ffffff`。
- 書体: `"BIZ UDPGothic","Yu Gothic UI","Meiryo",sans-serif`。
- 文字: キャッチ16pt太 / 物件名14pt太 / 価格32pt太 / 主要表12pt(下限11) / 詳細表10pt(下限8) / ポイント10.5pt太 / 電話19pt太。
- ひな型の目印: `theme.template = "consumer-2026-09"`。付いていない図面=旧ひな型。
- 旧ひな型では 写真を自動整列 / レイアウト自動調整 / 写真追加時の整列 / 取引情報の帯再生成 / 地図QRの追加 を無効(何も変えない=同一参照)。手での編集・PDF出力は可。
- 既存の要素 id `overview` / `footer-band` / `footer-terms-table` / `footer-staff-table` / `floor-plan` / `map-qr` と取引表の行ラベルは変えない。
- `crypto.randomUUID` は使わない(本番HTTP)。id は既存 `safeRandomId`。
- コードは Write/Edit で書く(bash heredoc で生成しない)。コミット前に `git diff --stat` で `Bin` が無いことを確認。
- 各タスクの終わりに、そのタスクのテストに加えて `npx tsc --noEmit` を通す。最終タスクでフル `npx vitest run`・eslint・`npm run build`。
- コミットメッセージ末尾:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_019gPXuxoirXhHRtTPPpXWnQ
  ```

## File Map

| ファイル | 役割 | タスク |
|---|---|---|
| `src/lib/sales-sheet/document-schema.ts` | 表の任意3指定・`theme.template`・`isConsumerTemplate` | 1 |
| `src/lib/sales-sheet/table-cell-style.ts`(新) | 表セルの見た目を1か所で決める(両レンダラ共通) | 1 |
| `src/lib/sales-sheet/render-html.ts` / `src/components/sales-sheet/SalesSheetRenderer.tsx` | `tableCellStyle` を使う | 1 |
| `src/lib/sales-sheet/sheet-rows.ts` | `formatValue` を export | 2 |
| `src/lib/sales-sheet/main-detail-rows.ts`(新) | 主要8行/詳細行の振り分け | 2 |
| `src/lib/sales-sheet/consumer-theme.ts`(新) | 色・書体の定数 | 3 |
| `src/lib/sales-sheet/layout-engine.ts` | `computeConsumerLayout` 追加(旧計算は Task 8 で削除) | 3, 8 |
| `src/lib/sales-sheet/footer-band.ts` | `buildConsumerFooterBand` 追加(旧は Task 8 で削除) | 4, 8 |
| `src/lib/sales-sheet/build-document.ts` | `buildSpecSheetDocument` を新紙面へ | 5 |
| `src/lib/sales-sheet/editor-document.ts` | 3列廃止・旧ひな型no-op・`findTableOverflows` | 6 |
| `src/components/sales-sheet/editor/{SalesSheetEditor,EditorToolbar,ElementPanel}.tsx` | 画面の配線 | 7 |
| `scripts/sales-sheet-consumer-preview.ts`(新) | 実寸PNGの目視確認 | 9 |

---

### Task 1: 表の任意3指定とひな型の目印

**Files:**
- Modify: `src/lib/sales-sheet/document-schema.ts:47-59`(table style)、`:105-108`(theme)
- Create: `src/lib/sales-sheet/table-cell-style.ts`
- Modify: `src/lib/sales-sheet/render-html.ts:86-104`
- Modify: `src/components/sales-sheet/SalesSheetRenderer.tsx:65-92`
- Test: `src/lib/sales-sheet/__tests__/document-schema.test.ts`(追記)、`src/lib/sales-sheet/__tests__/table-cell-style.test.ts`(新)、`src/lib/sales-sheet/__tests__/render-html-parity.test.ts`(追記)

**Interfaces:**
- Produces: `CONSUMER_TEMPLATE: "consumer-2026-09"`、`isConsumerTemplate(doc: { theme: { template?: string } }): boolean`、table `style.borderless?: boolean` / `style.stripeColor?: string` / `style.cellPaddingMm?: number`、`tableCellStyle(style: TableElement["style"], rowIndex: number): { border: string | null; padding: string; background: string | null }`

- [ ] **Step 1: 失敗するテストを書く**

`document-schema.test.ts` の先頭の import に `CONSUMER_TEMPLATE, isConsumerTemplate` を足し(`from "../document-schema"` の既存 import に並べる)、末尾に追記:

```ts
describe("表の任意指定とひな型の目印(消費者向けひな型)", () => {
  const base = { page: A4_LANDSCAPE, theme: { fontFamily: "sans-serif", accentColor: "#1f3a5f" } };
  const table = (style: Record<string, unknown>) => ({
    ...base,
    elements: [{ id: "t", type: "table", x: 0, y: 0, w: 50, h: 20, z: 1, rows: [], style }],
  });

  it("borderless / stripeColor / cellPaddingMm を受理する", () => {
    const doc = parseSalesSheetDocument(table({ borderless: true, stripeColor: "#eef2f7", cellPaddingMm: 1.2 }));
    const el = doc.elements[0];
    expect(el.type === "table" && el.style).toMatchObject({ borderless: true, stripeColor: "#eef2f7", cellPaddingMm: 1.2 });
  });
  it("危険な stripeColor を拒否する", () => {
    expect(() => parseSalesSheetDocument(table({ stripeColor: "url(http://x/)" }))).toThrow();
  });
  it("負の cellPaddingMm を拒否する", () => {
    expect(() => parseSalesSheetDocument(table({ cellPaddingMm: -1 }))).toThrow();
  });
  it("theme.template は consumer-2026-09 だけ受理し、無くても通る", () => {
    expect(parseSalesSheetDocument({ ...base, theme: { ...base.theme, template: CONSUMER_TEMPLATE }, elements: [] }).theme.template).toBe("consumer-2026-09");
    expect(() => parseSalesSheetDocument({ ...base, theme: { ...base.theme, template: "other" }, elements: [] })).toThrow();
    expect(parseSalesSheetDocument({ ...base, elements: [] }).theme.template).toBeUndefined();
  });
  it("isConsumerTemplate は目印の有無を返す", () => {
    expect(isConsumerTemplate({ theme: { template: CONSUMER_TEMPLATE } })).toBe(true);
    expect(isConsumerTemplate({ theme: {} })).toBe(false);
  });
});
```

新規 `table-cell-style.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { tableCellStyle } from "../table-cell-style";

describe("tableCellStyle", () => {
  it("未指定は従来どおり(罫線 #cccccc・余白 0.5mm 1mm・背景なし)", () => {
    expect(tableCellStyle({}, 0)).toEqual({ border: "0.2mm solid #cccccc", padding: "0.5mm 1mm", background: null });
  });
  it("borderColor を罫線に使う", () => {
    expect(tableCellStyle({ borderColor: "#999999" }, 0).border).toBe("0.2mm solid #999999");
  });
  it("borderless は罫線を出さない", () => {
    expect(tableCellStyle({ borderless: true }, 0).border).toBeNull();
  });
  it("stripeColor は偶数行(2,4,…行目=index 1,3,…)だけ", () => {
    expect(tableCellStyle({ stripeColor: "#eef2f7" }, 0).background).toBeNull();
    expect(tableCellStyle({ stripeColor: "#eef2f7" }, 1).background).toBe("#eef2f7");
    expect(tableCellStyle({ stripeColor: "#eef2f7" }, 2).background).toBeNull();
  });
  it("cellPaddingMm は上下=値・左右=値×1.2", () => {
    expect(tableCellStyle({ cellPaddingMm: 1.2 }, 0).padding).toBe("1.2mm 1.44mm");
    expect(tableCellStyle({ cellPaddingMm: 0 }, 0).padding).toBe("0mm 0mm");
  });
});
```

`render-html-parity.test.ts` の末尾に追記:

```ts
describe("パリティ: 線なし・1行おき色の表(消費者向けひな型)", () => {
  const doc = parseSalesSheetDocument({
    page: A4_LANDSCAPE,
    theme: { fontFamily: "sans-serif", accentColor: "#1f3a5f" },
    elements: [{
      id: "t", type: "table", x: 0, y: 0, w: 100, h: 30, z: 1,
      rows: [{ label: "交通", value: "徒歩6分" }, { label: "間取り", value: "4LDK" }],
      style: { borderless: true, stripeColor: "#eef2f7", cellPaddingMm: 1.2 },
    }],
  });
  const serializer = renderDocumentToHtml(doc);
  const react = renderToStaticMarkup(createElement(SalesSheetRenderer, { document: doc }));
  for (const signal of ["#eef2f7", "1.2mm 1.44mm", "徒歩6分"]) {
    it(`両レンダラが "${signal}" を含む`, () => {
      expect(serializer).toContain(signal);
      expect(react).toContain(signal);
    });
  }
  it("両レンダラとも罫線を出さない", () => {
    expect(serializer).not.toContain("0.2mm solid");
    expect(react).not.toContain("0.2mm solid");
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/document-schema.test.ts src/lib/sales-sheet/__tests__/table-cell-style.test.ts src/lib/sales-sheet/__tests__/render-html-parity.test.ts`
Expected: FAIL(`CONSUMER_TEMPLATE` 未定義 / `table-cell-style` が無い / 罫線が出る)

- [ ] **Step 3: schema を実装**

`document-schema.ts` の table style を置き換え:

```ts
  style: z
    .object({
      fontSizePt: z.number().positive().optional(),
      labelColor: z.string().refine(isCssColor, "unsafe color").optional(),
      valueColor: z.string().refine(isCssColor, "unsafe color").optional(),
      borderColor: z.string().refine(isCssColor, "unsafe color").optional(),
      /** 罫線を出さない(消費者向けひな型)。未指定=従来どおり罫線あり。 */
      borderless: z.boolean().optional(),
      /** 偶数行(2,4,…行目)のセル背景色。 */
      stripeColor: z.string().refine(isCssColor, "unsafe color").optional(),
      /** セル余白(mm)。上下=値・左右=値×1.2。未指定=0.5mm 1mm。 */
      cellPaddingMm: z.number().nonnegative().optional(),
    })
    .default({}),
```

theme を置き換え:

```ts
/** 消費者向けひな型(2026-09)で作った図面の目印。無い図面は旧ひな型。 */
export const CONSUMER_TEMPLATE = "consumer-2026-09" as const;

export const themeSchema = z.object({
  fontFamily: z.string().refine(isSafeFontFamily, "unsafe font-family"),
  accentColor: z.string().refine(isCssColor, "unsafe color"),
  template: z.literal(CONSUMER_TEMPLATE).optional(),
});
```

ファイル末尾(`parseSalesSheetDocument` の後)に追加:

```ts
/** 消費者向けひな型で作った図面か(自動整列などの新しい計算が使えるか)。 */
export function isConsumerTemplate(doc: { theme: { template?: string } }): boolean {
  return doc.theme.template === CONSUMER_TEMPLATE;
}
```

- [ ] **Step 4: `table-cell-style.ts` を作る**

```ts
import type { TableElement } from "./document-schema";
import { sanitizeCssValue } from "./css-safety";

export interface TableCellStyle {
  border: string | null;
  padding: string;
  background: string | null;
}

/**
 * 表セル1つ分の見た目。render-html.ts と SalesSheetRenderer.tsx の両方がこれを使い、
 * PDF と編集画面の見た目がずれないようにする。未指定時は従来の出力と同一。
 */
export function tableCellStyle(style: TableElement["style"], rowIndex: number): TableCellStyle {
  const border = style.borderless
    ? null
    : `0.2mm solid ${sanitizeCssValue(style.borderColor ?? "#cccccc")}`;
  const padding =
    style.cellPaddingMm !== undefined
      ? `${style.cellPaddingMm}mm ${Math.round(style.cellPaddingMm * 1.2 * 1000) / 1000}mm`
      : "0.5mm 1mm";
  const background =
    style.stripeColor && rowIndex % 2 === 1 ? sanitizeCssValue(style.stripeColor) : null;
  return { border, padding, background };
}
```

- [ ] **Step 5: 両レンダラを置き換える**

`render-html.ts` の table 分岐を置き換え(罫線以外の出力順は従来と同じ):

```ts
  if (el.type === "table") {
    const s = el.style;
    const safeLabelColor = s.labelColor ? sanitizeCssValue(s.labelColor) : null;
    const safeValueColor = s.valueColor ? sanitizeCssValue(s.valueColor) : null;
    const tableStyle = inlineStyle({
      ...boxStyle(el),
      "border-collapse": "collapse",
      "table-layout": "fixed",
      "font-size": s.fontSizePt ? `${s.fontSizePt}pt` : null,
    });
    const rows = el.rows.map((r, i) => {
      const c = tableCellStyle(s, i);
      const tdLabelStyle = inlineStyle({ border: c.border, color: safeLabelColor, padding: c.padding, width: "32%", "font-weight": "600", "vertical-align": "top", background: c.background });
      const tdValueStyle = inlineStyle({ border: c.border, color: safeValueColor, padding: c.padding, "vertical-align": "top", background: c.background });
      return `<tr><td style="${esc(tdLabelStyle)}">${esc(r.label)}</td><td style="${esc(tdValueStyle)}">${esc(r.value)}</td></tr>`;
    }).join("");
    return `<table style="${esc(tableStyle)}"><tbody>${rows}</tbody></table>`;
  }
```

先頭 import に `import { tableCellStyle } from "./table-cell-style";` を追加。

`SalesSheetRenderer.tsx` の `TableEl` を置き換え:

```tsx
function TableEl({ el }: { el: TableElement }) {
  const s = el.style;
  const safeLabelColor = s.labelColor ? sanitizeCssValue(s.labelColor) : undefined;
  const safeValueColor = s.valueColor ? sanitizeCssValue(s.valueColor) : undefined;
  return (
    <table
      style={{
        ...boxStyle(el),
        borderCollapse: "collapse",
        tableLayout: "fixed",
        fontSize: s.fontSizePt ? `${s.fontSizePt}pt` : undefined,
      }}
    >
      <tbody>
        {el.rows.map((r, i) => {
          const c = tableCellStyle(s, i);
          const border = c.border ?? undefined;
          const background = c.background ?? undefined;
          return (
            <tr key={i}>
              <td style={{ border, color: safeLabelColor, padding: c.padding, width: "32%", fontWeight: 600, verticalAlign: "top", background }}>
                {r.label}
              </td>
              <td style={{ border, color: safeValueColor, padding: c.padding, verticalAlign: "top", background }}>
                {r.value}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
```

import に `import { tableCellStyle } from "@/lib/sales-sheet/table-cell-style";` を追加。

- [ ] **Step 6: 合格を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/document-schema.test.ts src/lib/sales-sheet/__tests__/table-cell-style.test.ts src/lib/sales-sheet/__tests__/render-html-parity.test.ts src/lib/sales-sheet/__tests__/render-html.test.ts src/components/sales-sheet/__tests__/SalesSheetRenderer.test.tsx && npx tsc --noEmit`
Expected: すべて PASS(既存の table borderColor 拒否テストも PASS)・tsc 0

- [ ] **Step 7: Commit**

```bash
git add src/lib/sales-sheet/document-schema.ts src/lib/sales-sheet/table-cell-style.ts src/lib/sales-sheet/render-html.ts src/components/sales-sheet/SalesSheetRenderer.tsx src/lib/sales-sheet/__tests__/document-schema.test.ts src/lib/sales-sheet/__tests__/table-cell-style.test.ts src/lib/sales-sheet/__tests__/render-html-parity.test.ts
git commit -m "feat(sales-sheet): 表の線なし/1行おき色/余白の指定とひな型の目印"
```

---

### Task 2: 主要8行と詳細行の振り分け

**Files:**
- Modify: `src/lib/sales-sheet/sheet-rows.ts:12`(`function formatValue` → `export function formatValue`)
- Create: `src/lib/sales-sheet/main-detail-rows.ts`
- Test: `src/lib/sales-sheet/__tests__/main-detail-rows.test.ts`(新)

**Interfaces:**
- Consumes: `formatValue(field: SheetField, v: SheetValue): string`(sheet-rows)、`MANSION_FIELDS/LAND_FIELDS/HOUSE_FIELDS/BUILDING_FIELDS`(field-model)
- Produces: `type SheetKind = "mansion" | "land" | "house" | "building"`、`interface SheetRow { label: string; value: string }`、`MAIN_ROW_SPECS`、`splitMainDetailRows(kind: SheetKind, fields: readonly SheetField[], values: SheetValues): { main: SheetRow[]; detail: SheetRow[] }`、`splitDetailColumns(rows: SheetRow[]): { left: SheetRow[]; right: SheetRow[] }`

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { describe, it, expect } from "vitest";
import { MAIN_ROW_SPECS, splitMainDetailRows, splitDetailColumns, type SheetKind } from "../main-detail-rows";
import { MANSION_FIELDS, LAND_FIELDS, HOUSE_FIELDS, BUILDING_FIELDS } from "../field-model";

const FIELDS: Record<SheetKind, typeof HOUSE_FIELDS> = {
  mansion: MANSION_FIELDS, land: LAND_FIELDS, house: HOUSE_FIELDS, building: BUILDING_FIELDS,
};

describe("MAIN_ROW_SPECS", () => {
  it.each(["mansion", "land", "house", "building"] as const)("%s: 8行・参照キーはすべて field-model に存在", (kind) => {
    expect(MAIN_ROW_SPECS[kind]).toHaveLength(8);
    const keys = new Set(FIELDS[kind].map((f) => f.key));
    for (const spec of MAIN_ROW_SPECS[kind]) for (const part of spec.parts) expect(keys.has(part.key)).toBe(true);
  });
});

describe("splitMainDetailRows", () => {
  it("戸建: 主要8行の順番・まとめ行の連結", () => {
    const { main } = splitMainDetailRows("house", HOUSE_FIELDS, {
      access: "西武池袋線「富士見台」駅 徒歩6分", layout: "4LDK", landArea: "100.12㎡（公簿）",
      buildingArea: "98.54", builtYearMonth: "2008年3月", structure: "木造", aboveFloors: "2",
      parking: "有", occupancy: "居住中", delivery: "相談",
    });
    expect(main.map((r) => r.label)).toEqual(["交通", "間取り", "土地面積", "建物面積", "築年月", "構造・階数", "駐車場", "現況・引渡"]);
    expect(main.find((r) => r.label === "建物面積")?.value).toBe("98.54㎡");
    expect(main.find((r) => r.label === "構造・階数")?.value).toBe("木造 / 地上2階");
    expect(main.find((r) => r.label === "現況・引渡")?.value).toBe("居住中 / 引渡 相談");
  });
  it("主要表は値が空でも8行とも残す", () => {
    const { main } = splitMainDetailRows("mansion", MANSION_FIELDS, {});
    expect(main).toHaveLength(8);
    expect(main.every((r) => r.value === "")).toBe(true);
  });
  it("区分: 管理費・修繕積立金と所在階・階数", () => {
    const { main } = splitMainDetailRows("mansion", MANSION_FIELDS, { managementFee: "12800", repairFee: "15600", floorNo: "5", totalFloors: "11" });
    expect(main.find((r) => r.label === "管理費・修繕積立金")?.value).toBe("管理費 12800円/月 / 修繕 15600円/月");
    expect(main.find((r) => r.label === "所在階・階数")?.value).toBe("5階 / 地上11階");
  });
  it("詳細: 主要・価格・物件種目・建物名称・会社の項目を出さず、空行を出さない", () => {
    const { detail } = splitMainDetailRows("mansion", MANSION_FIELDS, {
      price: "3980", propertyType: "中古マンション", buildingName: "平和台パーク", access: "徒歩5分",
      address: "東京都練馬区平和台一丁目", remarks: "", staff: "山田",
    });
    expect(detail).toEqual([{ label: "所在地", value: "東京都練馬区平和台一丁目" }]);
  });
  it("詳細: つながる項目を1行にまとめ、先頭の項目の位置に置く", () => {
    const { detail } = splitMainDetailRows("house", HOUSE_FIELDS, {
      address: "東京都練馬区富士見台二丁目", floor1Area: "50", floor2Area: "48.5",
      coverageRatio: "60", floorRatio: "200", roadKind: "公道", roadWidth: "5.0", roadDirections: ["東"],
    });
    expect(detail).toEqual([
      { label: "所在地", value: "東京都練馬区富士見台二丁目" },
      { label: "各階面積", value: "1階 50㎡ / 2階 48.5㎡" },
      { label: "接道", value: "東 / 公道 / 幅員5.0m" },
      { label: "建蔽率/容積率", value: "60％ / 200％" },
    ]);
  });
  it("詳細: うち消費税は課税のときだけ", () => {
    expect(splitMainDetailRows("house", HOUSE_FIELDS, { tax: "課税", taxAmount: "180" }).detail).toContainEqual({ label: "うち消費税", value: "180万円" });
    expect(splitMainDetailRows("house", HOUSE_FIELDS, { tax: "非課税", taxAmount: "180" }).detail).toEqual([]);
  });
  it("土地: 接道・建蔽率は主要に入り、詳細に重ねて出さない", () => {
    const { main, detail } = splitMainDetailRows("land", LAND_FIELDS, { roadKind: "公道", roadWidth: "4", coverageRatio: "60", floorRatio: "200" });
    expect(main.find((r) => r.label === "接道")?.value).toBe("公道 / 幅員4m");
    expect(detail.map((r) => r.label)).not.toContain("接道");
    expect(detail.map((r) => r.label)).not.toContain("建蔽率/容積率");
  });
});

describe("splitDetailColumns", () => {
  it("前半を左、後半を右(奇数は左が1行多い)", () => {
    const rows = [1, 2, 3, 4, 5].map((n) => ({ label: `L${n}`, value: `${n}` }));
    const { left, right } = splitDetailColumns(rows);
    expect(left.map((r) => r.label)).toEqual(["L1", "L2", "L3"]);
    expect(right.map((r) => r.label)).toEqual(["L4", "L5"]);
  });
  it("0行は両方空", () => {
    expect(splitDetailColumns([])).toEqual({ left: [], right: [] });
  });
});
```

注: 「接道」の field-model 上の並びは 接道種別→接道幅員→接道方向。まとめ行は先頭の項目(接道種別)の位置に出るため、各階面積の後・建蔽率の前になる。

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/main-detail-rows.test.ts`
Expected: FAIL(モジュールが無い)

- [ ] **Step 3: 実装**

`sheet-rows.ts` 12行目の `function formatValue` を `export function formatValue` に変える。

`main-detail-rows.ts`:

```ts
import type { SheetField } from "./field-model";
import { formatValue, type SheetValues } from "./sheet-rows";

/** 販売図面の種別(ビルダーと同じ4種)。 */
export type SheetKind = "mansion" | "land" | "house" | "building";
export interface SheetRow {
  label: string;
  value: string;
}
interface RowPart {
  key: string;
  /** 値の前に付ける語(例: "地上" → "地上2階")。 */
  prefix?: string;
}
export interface RowSpec {
  label: string;
  parts: readonly RowPart[];
}

const part = (key: string, prefix?: string): RowPart => (prefix ? { key, prefix } : { key });

/** 種別ごとの主要8行(この順・空でも行を残す)。仕様書 §4.3。 */
export const MAIN_ROW_SPECS: Record<SheetKind, readonly RowSpec[]> = {
  house: [
    { label: "交通", parts: [part("access")] },
    { label: "間取り", parts: [part("layout")] },
    { label: "土地面積", parts: [part("landArea")] },
    { label: "建物面積", parts: [part("buildingArea")] },
    { label: "築年月", parts: [part("builtYearMonth")] },
    { label: "構造・階数", parts: [part("structure"), part("aboveFloors", "地上")] },
    { label: "駐車場", parts: [part("parking")] },
    { label: "現況・引渡", parts: [part("occupancy"), part("delivery", "引渡 ")] },
  ],
  mansion: [
    { label: "交通", parts: [part("access")] },
    { label: "間取り", parts: [part("layout")] },
    { label: "専有面積", parts: [part("exclusiveArea")] },
    { label: "バルコニー", parts: [part("balconyArea"), part("balconyDir")] },
    { label: "築年月", parts: [part("builtYearMonth")] },
    { label: "所在階・階数", parts: [part("floorNo"), part("totalFloors", "地上")] },
    { label: "管理費・修繕積立金", parts: [part("managementFee", "管理費 "), part("repairFee", "修繕 ")] },
    { label: "現況・引渡", parts: [part("occupancy"), part("delivery", "引渡 ")] },
  ],
  building: [
    { label: "交通", parts: [part("access")] },
    { label: "想定利回り", parts: [part("grossYield")] },
    { label: "満室想定収入", parts: [part("expectedIncome")] },
    { label: "総戸数", parts: [part("totalUnits")] },
    { label: "土地面積", parts: [part("landArea")] },
    { label: "延床面積", parts: [part("totalFloorArea")] },
    { label: "築年月", parts: [part("builtYearMonth")] },
    { label: "構造・階数", parts: [part("structure"), part("aboveFloors", "地上")] },
  ],
  land: [
    { label: "交通", parts: [part("access")] },
    { label: "土地面積", parts: [part("landArea")] },
    { label: "坪単価", parts: [part("unitPrice")] },
    { label: "用途地域", parts: [part("useDistrict")] },
    { label: "建蔽率・容積率", parts: [part("coverageRatio"), part("floorRatio")] },
    { label: "接道", parts: [part("roadDirections"), part("roadKind"), part("roadWidth", "幅員")] },
    { label: "地目", parts: [part("landCategory")] },
    { label: "現況・引渡", parts: [part("occupancy"), part("delivery", "引渡 ")] },
  ],
};

/** 詳細表で1行にまとめる組。field-model の並びで最初に現れた項目の位置に出す。 */
export const DETAIL_GROUPS: readonly RowSpec[] = [
  { label: "建蔽率/容積率", parts: [part("coverageRatio"), part("floorRatio")] },
  { label: "接道", parts: [part("roadDirections"), part("roadKind"), part("roadWidth", "幅員")] },
  { label: "各階面積", parts: [part("floor1Area", "1階 "), part("floor2Area", "2階 "), part("floor3Area", "3階 ")] },
];

/** 詳細表に出さない項目(価格・物件種目・物件名は紙面の別の場所に出る)。 */
const DETAIL_EXCLUDED_KEYS: ReadonlySet<string> = new Set(["price", "propertyType", "buildingName"]);

function isShown(f: SheetField, values: SheetValues): boolean {
  if (f.controlOnly || f.section === "会社") return false;
  if (f.showWhen) {
    const ctrl = values[f.showWhen.field];
    if ((typeof ctrl === "string" ? ctrl : "") !== f.showWhen.equals) return false;
  }
  return true;
}

function joinParts(parts: readonly RowPart[], byKey: Map<string, SheetField>, values: SheetValues): string {
  return parts
    .map((p) => {
      const f = byKey.get(p.key);
      if (!f || !isShown(f, values)) return "";
      const v = formatValue(f, values[p.key]);
      return v ? `${p.prefix ?? ""}${v}` : "";
    })
    .filter(Boolean)
    .join(" / ");
}

/**
 * 表示項目を「主要8行」と「詳細行」に振り分ける純関数(仕様書 §4.3)。
 * - 主要: MAIN_ROW_SPECS の順。空でも行を残す(作成後に編集画面で埋められる)。
 * - 詳細: 主要・DETAIL_EXCLUDED_KEYS・会社・非表示を除き、field-model の順。空行は出さない。
 */
export function splitMainDetailRows(
  kind: SheetKind,
  fields: readonly SheetField[],
  values: SheetValues,
): { main: SheetRow[]; detail: SheetRow[] } {
  const byKey = new Map(fields.map((f) => [f.key, f] as const));
  const specs = MAIN_ROW_SPECS[kind];
  const main = specs.map((s) => ({ label: s.label, value: joinParts(s.parts, byKey, values) }));
  const usedInMain = new Set(specs.flatMap((s) => s.parts.map((p) => p.key)));

  const groupOf = new Map<string, RowSpec>();
  for (const g of DETAIL_GROUPS) for (const p of g.parts) groupOf.set(p.key, g);
  const emittedGroups = new Set<RowSpec>();

  const detail: SheetRow[] = [];
  for (const f of fields) {
    if (usedInMain.has(f.key) || DETAIL_EXCLUDED_KEYS.has(f.key) || !isShown(f, values)) continue;
    const group = groupOf.get(f.key);
    if (group) {
      if (emittedGroups.has(group)) continue;
      emittedGroups.add(group);
      const value = joinParts(group.parts.filter((p) => !usedInMain.has(p.key)), byKey, values);
      if (value) detail.push({ label: group.label, value });
      continue;
    }
    const value = formatValue(f, values[f.key]);
    if (value) detail.push({ label: f.label, value });
  }
  return { main, detail };
}

/** 詳細行を左右2列に分ける(奇数は左が1行多い)。 */
export function splitDetailColumns(rows: SheetRow[]): { left: SheetRow[]; right: SheetRow[] } {
  const half = Math.ceil(rows.length / 2);
  return { left: rows.slice(0, half), right: rows.slice(half) };
}
```

- [ ] **Step 4: 合格を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/main-detail-rows.test.ts src/lib/sales-sheet/__tests__/sheet-rows.test.ts && npx tsc --noEmit`
Expected: PASS・tsc 0。値の書式(例「60％」の全角)が期待と違って落ちた場合は、field-model の `unit` を正としてテスト期待値側を合わせる(実装の書式は変えない)。

- [ ] **Step 5: Commit**

```bash
git add src/lib/sales-sheet/sheet-rows.ts src/lib/sales-sheet/main-detail-rows.ts src/lib/sales-sheet/__tests__/main-detail-rows.test.ts
git commit -m "feat(sales-sheet): 主要8行と詳細行の振り分け"
```

---

### Task 3: 色・書体の定数と新しい座標計算

**Files:**
- Create: `src/lib/sales-sheet/consumer-theme.ts`
- Modify: `src/lib/sales-sheet/layout-engine.ts`(末尾に追加。既存の `computeSpecSheetLayout` は Task 8 まで残す)
- Test: `src/lib/sales-sheet/__tests__/consumer-layout.test.ts`(新)

**Interfaces:**
- Produces: `CONSUMER_COLORS`、`CONSUMER_FONT_FAMILY`、`PT_TO_MM`、`MAIN_TABLE_FONT_PT = { start: 12, min: 11 }`、`DETAIL_TABLE_FONT_PT = { start: 10, min: 8 }`、`MAIN_TABLE_PAD_MM = 1.2`、`DETAIL_TABLE_PAD_MM = 0.8`、`CONSUMER_PHOTO_ZONE: Rect`、`CONSUMER_FOOTER: Rect`、`CONSUMER_MAP_QR_SLOT: Rect`、`tableRowHeightMm(fontPt: number, padMm: number): number`、`computeConsumerLayout(input: { mainRowCount: number; detailRowCount: number }): ConsumerLayout`

```ts
export interface ConsumerLayout {
  catchBand: Rect; catchCopy: Rect; kindTag: Rect; heading: Rect; price: Rect;
  mainTable: Rect & { fontSizePt: number };
  detailLeft: Rect; detailRight: Rect; detailFontSizePt: number;
  salesPointsBand: Rect; salesPoints: Rect; footer: Rect; photoZone: Rect; mapQrSlot: Rect;
  /** 詳細表が下限の文字でも入りきらない見込み。 */
  overflow: boolean;
}
```

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { describe, it, expect } from "vitest";
import {
  computeConsumerLayout, tableRowHeightMm, type Rect,
  CONSUMER_PHOTO_ZONE, CONSUMER_FOOTER, CONSUMER_MAP_QR_SLOT,
} from "../layout-engine";

const W = 297, H = 210;
const inside = (r: Rect) => r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= W + 1e-6 && r.y + r.h <= H + 1e-6;
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const contains = (outer: Rect, r: Rect) => r.x >= outer.x && r.y >= outer.y && r.x + r.w <= outer.x + outer.w + 1e-6 && r.y + r.h <= outer.y + outer.h + 1e-6;

describe("tableRowHeightMm", () => {
  it("行高 = 文字(mm)×1.35 + 上下余白", () => {
    expect(tableRowHeightMm(12, 1.2)).toBeCloseTo(8.115, 3);
  });
});

describe("computeConsumerLayout", () => {
  for (const detailRowCount of [0, 1, 12, 20, 26, 40]) {
    it(`詳細${detailRowCount}行: 用紙内・正の寸法・重なりなし`, () => {
      const L = computeConsumerLayout({ mainRowCount: 8, detailRowCount });
      const all = [L.catchBand, L.catchCopy, L.kindTag, L.heading, L.price, L.mainTable, L.detailLeft, L.detailRight, L.salesPointsBand, L.salesPoints, L.footer, L.photoZone, L.mapQrSlot];
      for (const r of all) expect(inside(r)).toBe(true);
      expect(overlaps(L.catchCopy, L.kindTag)).toBe(false);
      for (const r of [L.heading, L.price, L.mainTable, L.detailLeft, L.detailRight, L.salesPointsBand, L.footer]) {
        expect(overlaps(L.photoZone, r)).toBe(false);
      }
      expect(overlaps(L.heading, L.price)).toBe(false);
      expect(overlaps(L.price, L.mainTable)).toBe(false);
      expect(overlaps(L.mainTable, L.detailLeft)).toBe(false);
      expect(overlaps(L.mainTable, L.detailRight)).toBe(false);
      expect(overlaps(L.detailLeft, L.detailRight)).toBe(false);
      expect(overlaps(L.detailLeft, L.salesPointsBand)).toBe(false);
      expect(overlaps(L.salesPointsBand, L.footer)).toBe(false);
      expect(contains(L.salesPointsBand, L.salesPoints)).toBe(true);
      expect(contains(L.footer, L.mapQrSlot)).toBe(true);
      expect(L.mainTable.fontSizePt).toBeGreaterThanOrEqual(11);
      expect(L.detailFontSizePt).toBeGreaterThanOrEqual(8);
    });
  }
  it("詳細0行/12行は最大の文字(12pt/10pt)で入る", () => {
    expect(computeConsumerLayout({ mainRowCount: 8, detailRowCount: 0 })).toMatchObject({ overflow: false, detailFontSizePt: 10, mainTable: { fontSizePt: 12 } });
    expect(computeConsumerLayout({ mainRowCount: 8, detailRowCount: 12 })).toMatchObject({ overflow: false, detailFontSizePt: 10, mainTable: { fontSizePt: 12 } });
  });
  it("詳細20行は主要12ptのまま詳細を8.5ptまで縮めて入る", () => {
    expect(computeConsumerLayout({ mainRowCount: 8, detailRowCount: 20 })).toMatchObject({ overflow: false, detailFontSizePt: 8.5, mainTable: { fontSizePt: 12 } });
  });
  it("詳細26行は下限でも入らず overflow(主要11pt・詳細8pt)", () => {
    expect(computeConsumerLayout({ mainRowCount: 8, detailRowCount: 26 })).toMatchObject({ overflow: true, detailFontSizePt: 8, mainTable: { fontSizePt: 11 } });
  });
  it("詳細の左右は同じ高さ・同じ幅で横に並ぶ", () => {
    const L = computeConsumerLayout({ mainRowCount: 8, detailRowCount: 12 });
    expect(L.detailLeft.y).toBe(L.detailRight.y);
    expect(L.detailLeft.h).toBe(L.detailRight.h);
    expect(L.detailLeft.w).toBeCloseTo(L.detailRight.w, 6);
    expect(L.detailRight.x).toBeGreaterThan(L.detailLeft.x + L.detailLeft.w);
  });
  it("写真枠・会社帯・地図QR枠は定数と同じ", () => {
    const L = computeConsumerLayout({ mainRowCount: 8, detailRowCount: 5 });
    expect(L.photoZone).toEqual(CONSUMER_PHOTO_ZONE);
    expect(L.footer).toEqual(CONSUMER_FOOTER);
    expect(L.mapQrSlot).toEqual(CONSUMER_MAP_QR_SLOT);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/consumer-layout.test.ts`
Expected: FAIL(`computeConsumerLayout` が無い)

- [ ] **Step 3: `consumer-theme.ts` を作る**

```ts
/** 消費者向けひな型(2026-09・案3「整理型」×紺)の色と書体。仕様書 §3.1。 */
export const CONSUMER_COLORS = {
  navy: "#1f3a5f",
  price: "#b7281e",
  soft: "#eef2f7",
  ink: "#1a1a1a",
  muted: "#555555",
  white: "#ffffff",
} as const;

/** 本番サーバーは fonts-morisawa-bizud-gothic を導入して BIZ UDPGothic で描く。未導入でも後ろの予備で描ける。 */
export const CONSUMER_FONT_FAMILY = '"BIZ UDPGothic","Yu Gothic UI","Meiryo",sans-serif';
```

- [ ] **Step 4: `layout-engine.ts` の末尾に追加**

```ts
// ---------------------------------------------------------------------------
// 消費者向けひな型(2026-09・案3「整理型」)の紙面。仕様書 §3 / §4.4。
// ビルダー(build-document)とエディタ(editor-document)が同じ値を使う。
// ---------------------------------------------------------------------------

/** pt → mm。 */
export const PT_TO_MM = 25.4 / 72;
/** 表の行高の見積もりに使う行間。 */
const CONSUMER_LINE_HEIGHT = 1.35;
export const MAIN_TABLE_FONT_PT = { start: 12, min: 11 } as const;
export const DETAIL_TABLE_FONT_PT = { start: 10, min: 8 } as const;
export const MAIN_TABLE_PAD_MM = 1.2;
export const DETAIL_TABLE_PAD_MM = 0.8;
const FONT_STEP_PT = 0.5;
/** 表の最小高さ(mm)。schema は正の寸法を要求し、エディタの最小要素サイズと同じ。 */
const MIN_TABLE_H_MM = 5;

const RIGHT_X_MM = 136;
const RIGHT_W_MM = 154;
const TABLE_TOP_MM = 43.5;
const TABLE_GAP_MM = 2.5;
const RIGHT_BOTTOM_MM = 167.5;
const DETAIL_COL_GAP_MM = 3;

export const CONSUMER_PHOTO_ZONE: Rect = { x: 7, y: 19.5, w: 124, h: 148 };
export const CONSUMER_FOOTER: Rect = { x: 7, y: 185, w: 283, h: 25 };
/** 地図QRの置き場(会社帯の右端)。 */
export const CONSUMER_MAP_QR_SLOT: Rect = { x: 269, y: 187, w: 20, h: 20 };

export interface ConsumerLayout {
  catchBand: Rect;
  catchCopy: Rect;
  kindTag: Rect;
  heading: Rect;
  price: Rect;
  mainTable: Rect & { fontSizePt: number };
  detailLeft: Rect;
  detailRight: Rect;
  detailFontSizePt: number;
  salesPointsBand: Rect;
  salesPoints: Rect;
  footer: Rect;
  photoZone: Rect;
  mapQrSlot: Rect;
  /** 詳細表が下限の文字でも入りきらない見込み。 */
  overflow: boolean;
}

/** 表1行の高さの見積もり(mm)= 文字×行間 + 上下余白。 */
export function tableRowHeightMm(fontPt: number, padMm: number): number {
  return fontPt * PT_TO_MM * CONSUMER_LINE_HEIGHT + padMm * 2;
}

function fontSteps(start: number, min: number): number[] {
  const out: number[] = [];
  for (let pt = start; pt >= min - 1e-9; pt -= FONT_STEP_PT) out.push(Math.round(pt * 10) / 10);
  return out;
}

/** 主要表をなるべく大きく保ち、詳細表を枠に入る最大の文字にする。入らなければ下限+overflow。 */
function chooseTableFonts(
  mainRows: number,
  perColumn: number,
): { mainPt: number; detailPt: number; overflow: boolean } {
  const areaH = RIGHT_BOTTOM_MM - TABLE_TOP_MM;
  for (const mainPt of fontSteps(MAIN_TABLE_FONT_PT.start, MAIN_TABLE_FONT_PT.min)) {
    const avail = areaH - mainRows * tableRowHeightMm(mainPt, MAIN_TABLE_PAD_MM) - TABLE_GAP_MM;
    if (avail < 0) continue;
    if (perColumn === 0) return { mainPt, detailPt: DETAIL_TABLE_FONT_PT.start, overflow: false };
    for (const detailPt of fontSteps(DETAIL_TABLE_FONT_PT.start, DETAIL_TABLE_FONT_PT.min)) {
      if (perColumn * tableRowHeightMm(detailPt, DETAIL_TABLE_PAD_MM) <= avail + 1e-9) {
        return { mainPt, detailPt, overflow: false };
      }
    }
  }
  return { mainPt: MAIN_TABLE_FONT_PT.min, detailPt: DETAIL_TABLE_FONT_PT.min, overflow: true };
}

/** 消費者向けひな型の紙面(A4横)を、主要表・詳細表の行数から決定的に計算する純関数。 */
export function computeConsumerLayout(input: { mainRowCount: number; detailRowCount: number }): ConsumerLayout {
  const mainRows = Math.max(0, input.mainRowCount);
  const perColumn = Math.ceil(Math.max(0, input.detailRowCount) / 2);
  const fonts = chooseTableFonts(mainRows, perColumn);

  const mainH = Math.max(MIN_TABLE_H_MM, mainRows * tableRowHeightMm(fonts.mainPt, MAIN_TABLE_PAD_MM));
  const detailY = TABLE_TOP_MM + mainH + TABLE_GAP_MM;
  const detailH = Math.max(MIN_TABLE_H_MM, RIGHT_BOTTOM_MM - detailY);
  const detailW = (RIGHT_W_MM - DETAIL_COL_GAP_MM) / 2;

  return {
    catchBand: { x: 0, y: 0, w: 297, h: 16 },
    catchCopy: { x: 9, y: 0, w: 220, h: 16 },
    kindTag: { x: 232, y: 0, w: 56, h: 16 },
    heading: { x: RIGHT_X_MM, y: 19.5, w: RIGHT_W_MM, h: 8 },
    price: { x: RIGHT_X_MM, y: 28, w: RIGHT_W_MM, h: 14 },
    mainTable: { x: RIGHT_X_MM, y: TABLE_TOP_MM, w: RIGHT_W_MM, h: mainH, fontSizePt: fonts.mainPt },
    detailLeft: { x: RIGHT_X_MM, y: detailY, w: detailW, h: detailH },
    detailRight: { x: RIGHT_X_MM + detailW + DETAIL_COL_GAP_MM, y: detailY, w: detailW, h: detailH },
    detailFontSizePt: fonts.detailPt,
    salesPointsBand: { x: 7, y: 170, w: 283, h: 12 },
    salesPoints: { x: 11, y: 170, w: 275, h: 12 },
    footer: { ...CONSUMER_FOOTER },
    photoZone: { ...CONSUMER_PHOTO_ZONE },
    mapQrSlot: { ...CONSUMER_MAP_QR_SLOT },
    overflow: fonts.overflow,
  };
}
```

- [ ] **Step 5: 合格を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/consumer-layout.test.ts src/lib/sales-sheet/__tests__/layout-engine.test.ts && npx tsc --noEmit`
Expected: PASS(既存の layout-engine.test はまだ旧計算を検証しており、そのまま PASS)・tsc 0

- [ ] **Step 6: Commit**

```bash
git add src/lib/sales-sheet/consumer-theme.ts src/lib/sales-sheet/layout-engine.ts src/lib/sales-sheet/__tests__/consumer-layout.test.ts
git commit -m "feat(sales-sheet): 消費者向けひな型の座標計算と色・書体の定数"
```

---

### Task 4: 新しい会社帯

**Files:**
- Modify: `src/lib/sales-sheet/footer-band.ts`(末尾に追加。旧 `buildFooterBand` 等は Task 8 まで残す)
- Test: `src/lib/sales-sheet/__tests__/footer-band-consumer.test.ts`(新)

**Interfaces:**
- Consumes: `CONSUMER_COLORS`(consumer-theme)、`CONSUMER_FOOTER`(layout-engine)、既存 `pickRows` / `clampRect` / `TERMS_LABELS` / `STAFF_LABELS` / `readFooterData`
- Produces: `CONSUMER_TEL_CTA = "内覧のご希望・ご質問はお電話で"`、`buildConsumerFooterTransactionElements(footer: Rect, data: FooterBandData): SalesSheetElement[]`、`buildConsumerFooterBand(footer: Rect, data: FooterBandData, company?: CompanyProfile): SalesSheetElement[]`

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { describe, it, expect } from "vitest";
import {
  buildConsumerFooterBand,
  buildConsumerFooterTransactionElements,
  readFooterData,
  CONSUMER_TEL_CTA,
  type FooterBandData,
} from "../footer-band";
import { CONSUMER_FOOTER, type Rect } from "../layout-engine";
import { COMPANY_INFO } from "../company-info";
import type { SalesSheetElement } from "../document-schema";

const FULL: FooterBandData = { transactionType: "専任", adType: "不可", compensation: "税込3%", staff: "山田", agent: "佐藤", specialNotes: "即入居可" };
const byId = (els: SalesSheetElement[], id: string) => els.find((e) => e.id === id);
const inside = (outer: Rect, r: Rect) => r.x >= outer.x - 1e-6 && r.y >= outer.y - 1e-6 && r.x + r.w <= outer.x + outer.w + 1e-6 && r.y + r.h <= outer.y + outer.h + 1e-6;

describe("buildConsumerFooterBand", () => {
  it("全要素が会社帯の中・正の寸法", () => {
    for (const el of buildConsumerFooterBand(CONSUMER_FOOTER, FULL)) {
      expect(el.w).toBeGreaterThan(0);
      expect(el.h).toBeGreaterThan(0);
      expect(inside(CONSUMER_FOOTER, el)).toBe(true);
    }
  });
  it("帯の外枠は白塗り・線なし、縦の区切り線は作らない", () => {
    const els = buildConsumerFooterBand(CONSUMER_FOOTER, FULL);
    expect(byId(els, "footer-band")).toMatchObject({ type: "shape", shape: "rect", fill: "#ffffff" });
    expect(byId(els, "footer-band")).not.toHaveProperty("stroke");
    expect(els.some((e) => e.id.startsWith("footer-divider"))).toBe(false);
  });
  it("会社情報と電話番号(19pt・右寄せ)を出す", () => {
    const els = buildConsumerFooterBand(CONSUMER_FOOTER, {});
    expect(byId(els, "footer-name-ja")).toMatchObject({ content: COMPANY_INFO.nameJa });
    expect(byId(els, "footer-tel-cta")).toMatchObject({ content: CONSUMER_TEL_CTA });
    expect(byId(els, "footer-tel-number")).toMatchObject({ content: COMPANY_INFO.tel, style: { fontSizePt: 19, bold: true, align: "right" } });
  });
  it("取引表は線なし・6値を読み戻せる", () => {
    const els = buildConsumerFooterBand(CONSUMER_FOOTER, FULL);
    expect(byId(els, "footer-terms-table")).toMatchObject({ type: "table", style: { borderless: true } });
    expect(byId(els, "footer-staff-table")).toMatchObject({ type: "table", style: { borderless: true } });
    expect(readFooterData(els)).toEqual(FULL);
  });
  it("担当の値が無ければ担当表を出さない", () => {
    const els = buildConsumerFooterTransactionElements(CONSUMER_FOOTER, { transactionType: "仲介" });
    expect(byId(els, "footer-terms-table")).toBeDefined();
    expect(byId(els, "footer-staff-table")).toBeUndefined();
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/footer-band-consumer.test.ts`
Expected: FAIL(`buildConsumerFooterBand` が無い)

- [ ] **Step 3: `footer-band.ts` の末尾に追加**

先頭 import に `import { CONSUMER_COLORS } from "./consumer-theme";` を追加。

```ts
// ---------------------------------------------------------------------------
// 消費者向けひな型(2026-09)の会社帯。仕様書 §4.6。
// 左から 会社ブロック(105mm) / 取引6項目(表2つ) / 電話(72mm)。右端22mmは地図QRの置き場。
// 帯の外枠 footer-band は取引情報パネルが帯の位置を復元するため残す(白・線なし)。
// ---------------------------------------------------------------------------

export const CONSUMER_TEL_CTA = "内覧のご希望・ご質問はお電話で";

const CONSUMER_COMPANY_W_MM = 105;
const CONSUMER_TERMS_X_MM = 108;
const CONSUMER_STAFF_X_MM = 147;
const CONSUMER_TX_TABLE_W_MM = 36;
const CONSUMER_TEL_X_MM = 186;
const CONSUMER_TEL_W_MM = 72;
const CONSUMER_LINE_H_MM = 3.8;

function consumerText(
  id: string,
  rect: Rect,
  content: string,
  fontSizePt: number,
  opts: { bold?: boolean; color?: string; align?: "left" | "center" | "right"; lineHeight?: number } = {},
): SalesSheetElement {
  return {
    id,
    type: "text",
    ...rect,
    z: 2,
    content,
    style: {
      fontSizePt,
      color: opts.color ?? CONSUMER_COLORS.ink,
      bold: opts.bold ?? false,
      ...(opts.align ? { align: opts.align } : {}),
      ...(opts.lineHeight ? { lineHeight: opts.lineHeight } : {}),
    },
  };
}

/** 取引条件/担当の表(線なし)。作成時と取引情報パネルの再生成で共有する。 */
export function buildConsumerFooterTransactionElements(footer: Rect, data: FooterBandData): SalesSheetElement[] {
  const hasStaff = !!(data.staff || data.agent || data.specialNotes);
  const tableStyle = { fontSizePt: 7.5, labelColor: CONSUMER_COLORS.navy, valueColor: CONSUMER_COLORS.ink, borderless: true, cellPaddingMm: 0.4 };
  const termsRows = pickRows([
    [TERMS_LABELS.transactionType, data.transactionType],
    [TERMS_LABELS.adType, data.adType],
    [TERMS_LABELS.compensation, data.compensation],
  ]);
  const elements: SalesSheetElement[] = [
    {
      id: "footer-terms-table",
      type: "table",
      ...clampRect({ x: footer.x + CONSUMER_TERMS_X_MM, y: footer.y + 2, w: CONSUMER_TX_TABLE_W_MM, h: footer.h - 4 }, footer),
      z: 2,
      rows: termsRows.length > 0 ? termsRows : [{ label: "", value: "" }],
      style: tableStyle,
    },
  ];
  if (hasStaff) {
    elements.push({
      id: "footer-staff-table",
      type: "table",
      ...clampRect({ x: footer.x + CONSUMER_STAFF_X_MM, y: footer.y + 2, w: CONSUMER_TX_TABLE_W_MM, h: footer.h - 4 }, footer),
      z: 2,
      rows: pickRows([
        [STAFF_LABELS.staff, data.staff],
        [STAFF_LABELS.agent, data.agent],
        [STAFF_LABELS.specialNotes, data.specialNotes],
      ]),
      style: { ...tableStyle },
    });
  }
  return elements;
}

export function buildConsumerFooterBand(
  footer: Rect,
  data: FooterBandData,
  company: CompanyProfile = COMPANY_INFO,
): SalesSheetElement[] {
  const { x, y } = footer;
  const line = (i: number): number => y + 7 + CONSUMER_LINE_H_MM * i;
  const halfW = CONSUMER_COMPANY_W_MM / 2;
  return [
    { id: "footer-band", type: "shape", ...clampRect({ x, y, w: footer.w, h: footer.h }, footer), z: 1, shape: "rect", fill: CONSUMER_COLORS.white },
    consumerText("footer-name-ja", clampRect({ x, y: y + 1, w: CONSUMER_COMPANY_W_MM, h: 6 }, footer), company.nameJa, 10, { bold: true, color: CONSUMER_COLORS.navy }),
    consumerText("footer-license", clampRect({ x, y: line(0), w: CONSUMER_COMPANY_W_MM, h: CONSUMER_LINE_H_MM }, footer), company.license, 7),
    consumerText("footer-address", clampRect({ x, y: line(1), w: CONSUMER_COMPANY_W_MM, h: CONSUMER_LINE_H_MM }, footer), `所在地 ${company.address}`, 7),
    consumerText("footer-contact", clampRect({ x, y: line(2), w: CONSUMER_COMPANY_W_MM, h: CONSUMER_LINE_H_MM }, footer), `TEL ${company.tel}　FAX ${company.fax}`, 7),
    consumerText("footer-email", clampRect({ x, y: line(3), w: halfW, h: CONSUMER_LINE_H_MM }, footer), `Email ${company.email}`, 7),
    consumerText("footer-hp", clampRect({ x: x + halfW, y: line(3), w: halfW, h: CONSUMER_LINE_H_MM }, footer), `HP ${company.hp}`, 7),
    // 最下行(y+22.2〜25)は第③段の規約行のために空けておく。
    ...buildConsumerFooterTransactionElements(footer, data),
    consumerText("footer-tel-cta", clampRect({ x: x + CONSUMER_TEL_X_MM, y: y + 2, w: CONSUMER_TEL_W_MM, h: 5 }, footer), CONSUMER_TEL_CTA, 8, { bold: true, color: CONSUMER_COLORS.navy, align: "right" }),
    consumerText("footer-tel-number", clampRect({ x: x + CONSUMER_TEL_X_MM, y: y + 7, w: CONSUMER_TEL_W_MM, h: 10 }, footer), company.tel, 19, { bold: true, color: CONSUMER_COLORS.navy, align: "right", lineHeight: 1.2 }),
  ];
}
```

注: `CompanyProfile` の各値が `string | null` 型ならコンパイルエラーになる。その場合は既存 `buildFooterBand` と同じ扱い(既存コードが素のまま使っているので型は string のはず)を tsc で確認し、エラー時のみ `?? ""` を付ける。

- [ ] **Step 4: 合格を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/footer-band-consumer.test.ts src/lib/sales-sheet/__tests__/footer-band.test.ts src/lib/sales-sheet/__tests__/footer-transaction.test.ts && npx tsc --noEmit`
Expected: PASS・tsc 0

- [ ] **Step 5: Commit**

```bash
git add src/lib/sales-sheet/footer-band.ts src/lib/sales-sheet/__tests__/footer-band-consumer.test.ts
git commit -m "feat(sales-sheet): 消費者向けひな型の会社帯(線なし・電話を大きく)"
```

---

### Task 5: 新しい紙面で図面を作る(ビルダーの切替)

**Files:**
- Modify: `src/lib/sales-sheet/build-document.ts`(import・`SpecSheetParts`・`buildSpecSheetDocument`・`photoElements` 削除・4種別ビルダー)
- Test: `src/lib/sales-sheet/__tests__/spec-sheet-document.test.ts`(全面書き換え)、`build-mansion.test.ts` / `build-house.test.ts` / `build-building.test.ts` / `build-land.test.ts`(ヘルパーとレイアウト検証の置き換え)

**Interfaces:**
- Consumes: Task 1 `CONSUMER_TEMPLATE`、Task 2 `splitMainDetailRows` / `splitDetailColumns` / `SheetRow`、Task 3 `computeConsumerLayout` / `MAIN_TABLE_PAD_MM` / `DETAIL_TABLE_PAD_MM` / `packPhotoCells` / `CONSUMER_COLORS` / `CONSUMER_FONT_FAMILY`、Task 4 `buildConsumerFooterBand`
- Produces:

```ts
export interface SpecSheetParts {
  heading: string;
  priceText: string;
  /** キャッチ帯右の物件種目(例: 中古戸建)。 */
  kindLabel: string;
  /** 主要表(8行・空行も残す)。 */
  mainRows: SheetRow[];
  /** 詳細表(空行なし・左右2列に分けて置く)。 */
  detailRows: SheetRow[];
  photos?: { fileUrl: string }[];
  catchCopy?: string;
  salesPoints?: string[];
  footer?: FooterBandData;
  company?: CompanyProfile;
  floorPlanImage?: { fileUrl: string } | null;
}
```
要素 id: `catch-band` / `catch-copy` / `kind-tag` / `heading` / `price` / `overview` / `overview-detail-a` / `overview-detail-b` / `sales-points-band` / `sales-points` / 会社帯 `footer-*` / `photo-1` / `floor-plan` / `photo-2` / `photo-3`(この配列順)。

- [ ] **Step 1: `spec-sheet-document.test.ts` を全面書き換え(失敗するテスト)**

```ts
import { describe, it, expect } from "vitest";
import { buildSpecSheetDocument, type SpecSheetParts } from "../build-document";
import { salesSheetDocumentSchema, isConsumerTemplate, type SalesSheetElement } from "../document-schema";
import { computeConsumerLayout, CONSUMER_PHOTO_ZONE, type Rect } from "../layout-engine";
import { buildConsumerFooterBand } from "../footer-band";
import { CONSUMER_FONT_FAMILY } from "../consumer-theme";

const rows = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ label: `${prefix}${i + 1}`, value: `値${i + 1}` }));
const base: SpecSheetParts = {
  heading: "練馬区富士見台二丁目 中古戸建",
  priceText: "6980万円",
  kindLabel: "中古戸建",
  mainRows: rows("主要", 8),
  detailRows: rows("詳細", 5),
};
const byId = (els: SalesSheetElement[], id: string) => els.find((e) => e.id === id);
const geom = (r: Rect) => ({ x: r.x, y: r.y, w: r.w, h: r.h });
const inside = (outer: Rect, r: Rect) => r.x >= outer.x - 1e-6 && r.y >= outer.y - 1e-6 && r.x + r.w <= outer.x + outer.w + 1e-6 && r.y + r.h <= outer.y + outer.h + 1e-6;
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

describe("buildSpecSheetDocument(消費者向けひな型)", () => {
  it("theme に目印・書体・紺を入れる", () => {
    const doc = buildSpecSheetDocument(base);
    expect(isConsumerTemplate(doc)).toBe(true);
    expect(doc.theme).toEqual({ fontFamily: CONSUMER_FONT_FAMILY, accentColor: "#1f3a5f", template: "consumer-2026-09" });
  });

  it("各要素が computeConsumerLayout の位置に置かれる", () => {
    const doc = buildSpecSheetDocument(base);
    const L = computeConsumerLayout({ mainRowCount: 8, detailRowCount: 5 });
    const expected: [string, Rect][] = [
      ["catch-band", L.catchBand], ["catch-copy", L.catchCopy], ["kind-tag", L.kindTag], ["heading", L.heading],
      ["price", L.price], ["overview", L.mainTable], ["overview-detail-a", L.detailLeft], ["overview-detail-b", L.detailRight],
      ["sales-points-band", L.salesPointsBand], ["sales-points", L.salesPoints],
    ];
    for (const [id, r] of expected) expect(byId(doc.elements, id)).toMatchObject(geom(r));
    expect(byId(doc.elements, "overview")).toMatchObject({ style: { fontSizePt: L.mainTable.fontSizePt } });
    expect(byId(doc.elements, "overview-detail-a")).toMatchObject({ style: { fontSizePt: L.detailFontSizePt } });
  });

  it("文字と色(紺帯・白いキャッチ・赤い価格・物件種目)", () => {
    const doc = buildSpecSheetDocument({ ...base, catchCopy: "駅徒歩6分" });
    expect(byId(doc.elements, "catch-band")).toMatchObject({ type: "shape", fill: "#1f3a5f" });
    expect(byId(doc.elements, "catch-copy")).toMatchObject({ content: "駅徒歩6分", style: { fontSizePt: 16, bold: true, color: "#ffffff" } });
    expect(byId(doc.elements, "kind-tag")).toMatchObject({ content: "中古戸建", style: { color: "#ffffff", align: "right" } });
    expect(byId(doc.elements, "heading")).toMatchObject({ style: { fontSizePt: 14, bold: true, color: "#1f3a5f" } });
    expect(byId(doc.elements, "price")).toMatchObject({ content: "6980万円", style: { fontSizePt: 32, bold: true, color: "#b7281e" } });
  });

  it("主要表=8行・線なし・1行おき淡紺 / 詳細表=左右に分割・線なし・色なし", () => {
    const doc = buildSpecSheetDocument(base);
    expect(byId(doc.elements, "overview")).toMatchObject({ rows: base.mainRows, style: { borderless: true, stripeColor: "#eef2f7", cellPaddingMm: 1.2 } });
    const a = byId(doc.elements, "overview-detail-a");
    const b = byId(doc.elements, "overview-detail-b");
    expect(a).toMatchObject({ rows: base.detailRows.slice(0, 3), style: { borderless: true, cellPaddingMm: 0.8 } });
    expect(b).toMatchObject({ rows: base.detailRows.slice(3) });
    expect(a?.type === "table" && a.style.stripeColor).toBeFalsy();
  });

  it("ポイントは見出し付きで最大3つ・無ければ空", () => {
    const doc = buildSpecSheetDocument({ ...base, salesPoints: ["南向き", " ", "外壁塗装済", "学校近い", "4つ目"] });
    expect(byId(doc.elements, "sales-points")).toMatchObject({ content: "おすすめポイント　◆南向き　◆外壁塗装済　◆学校近い" });
    expect(byId(buildSpecSheetDocument(base).elements, "sales-points")).toMatchObject({ content: "" });
    expect(byId(doc.elements, "sales-points-band")).toMatchObject({ type: "shape", fill: "#eef2f7" });
  });

  it("会社帯は buildConsumerFooterBand と同じ", () => {
    const footer = { transactionType: "専任媒介", staff: "山田" };
    const doc = buildSpecSheetDocument({ ...base, footer });
    const L = computeConsumerLayout({ mainRowCount: 8, detailRowCount: 5 });
    for (const el of buildConsumerFooterBand(L.footer, footer)) expect(byId(doc.elements, el.id)).toEqual(el);
  });

  for (const photoCount of [0, 1, 3]) {
    for (const withPlan of [false, true]) {
      it(`写真${photoCount}枚・間取り図${withPlan ? "あり" : "なし"}: 写真枠内・重ならない・並び順`, () => {
        const doc = buildSpecSheetDocument({
          ...base,
          photos: Array.from({ length: photoCount }, (_, i) => ({ fileUrl: `/uploads/p${i}.jpg` })),
          floorPlanImage: withPlan ? { fileUrl: "/uploads/plan.png" } : null,
        });
        const images = doc.elements.filter((e) => e.type === "image");
        const expectedIds = Array.from({ length: photoCount }, (_, i) => `photo-${i + 1}`);
        if (withPlan) expectedIds.splice(Math.min(1, expectedIds.length), 0, "floor-plan");
        expect(images.map((e) => e.id)).toEqual(expectedIds);
        for (const img of images) {
          expect(inside(CONSUMER_PHOTO_ZONE, img)).toBe(true);
          expect(img.type === "image" && img.fit).toBe("contain");
        }
        for (let i = 0; i < images.length; i++) for (let j = i + 1; j < images.length; j++) expect(overlaps(images[i], images[j])).toBe(false);
        expect(salesSheetDocumentSchema.safeParse(doc).success).toBe(true);
      });
    }
  }

  for (const n of [0, 12, 26]) {
    it(`詳細${n}行でも保存できる(schema)`, () => {
      expect(salesSheetDocumentSchema.safeParse(buildSpecSheetDocument({ ...base, detailRows: rows("詳細", n) })).success).toBe(true);
    });
  }
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/spec-sheet-document.test.ts`
Expected: FAIL(型エラー/`kind-tag` が無い)

- [ ] **Step 3: `build-document.ts` を実装**

import を置き換え(16〜17行目):

```ts
import {
  computeConsumerLayout,
  packPhotoCells,
  MAIN_TABLE_PAD_MM,
  DETAIL_TABLE_PAD_MM,
  type Rect,
} from "./layout-engine";
import { buildConsumerFooterBand, type FooterBandData } from "./footer-band";
import { splitMainDetailRows, splitDetailColumns, type SheetRow } from "./main-detail-rows";
import { CONSUMER_COLORS, CONSUMER_FONT_FAMILY } from "./consumer-theme";
```

`A4_LANDSCAPE` の import に `CONSUMER_TEMPLATE` を足す。`buildSheetRows` の import は使わなくなったら消す(`type SheetValues` は残す)。44〜46行目の `NAVY` / `RED` / `FONT` 定数と `photoElements` 関数(147〜168行目)を削除。

`SpecSheetParts` を Interfaces の定義に置き換え、`buildSpecSheetDocument` を次に置き換える:

```ts
/** ポイントは3つまで(4つ目以降は出さない)。仕様書 §4.5。 */
const SALES_POINTS_MAX = 3;

/** 写真(最大3枚)と間取り図を写真枠へ初期配置する。間取り図は代表写真の次。 */
function photoAndFloorPlanElements(
  photos: { fileUrl: string }[] | undefined,
  floorPlanImage: { fileUrl: string } | null | undefined,
  zone: Rect,
): SalesSheetElement[] {
  const items: { id: string; src: string; alt: string; radiusMm?: number }[] = (photos ?? [])
    .slice(0, 3)
    .map((ph, i) => ({ id: `photo-${i + 1}`, src: ph.fileUrl, alt: "物件写真", radiusMm: 2 }));
  if (floorPlanImage?.fileUrl) {
    items.splice(Math.min(1, items.length), 0, { id: "floor-plan", src: floorPlanImage.fileUrl, alt: "間取り図" });
  }
  const cells = packPhotoCells(items.length, zone.w, zone.h);
  return items.map((it, i) => ({
    id: it.id,
    type: "image" as const,
    x: zone.x + cells[i].x,
    y: zone.y + cells[i].y,
    w: cells[i].w,
    h: cells[i].h,
    z: 1,
    src: it.src,
    fit: "contain" as const,
    alt: it.alt,
    ...(it.radiusMm ? { radiusMm: it.radiusMm } : {}),
  }));
}

/** 物件種目の入力があればそれ、無ければ種別の既定名。 */
function kindLabelOf(values: SheetValues, fallback: string): string {
  const v = values.propertyType;
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

/**
 * 消費者向けひな型(2026-09・案3「整理型」×紺)の紙面を種別非依存に組む純関数。
 * 座標と表の文字サイズは computeConsumerLayout(エディタと共有)が決める。仕様書 §3 / §4.5。
 */
export function buildSpecSheetDocument(parts: SpecSheetParts): SalesSheetDocument {
  const L = computeConsumerLayout({ mainRowCount: parts.mainRows.length, detailRowCount: parts.detailRows.length });
  const { left, right } = splitDetailColumns(parts.detailRows);
  const points = (parts.salesPoints ?? []).map((s) => s.trim()).filter(Boolean).slice(0, SALES_POINTS_MAX);
  const salesPointsText = points.length > 0 ? ["おすすめポイント", ...points.map((s) => `◆${s}`)].join("　") : "";
  const C = CONSUMER_COLORS;
  const g = (r: Rect) => ({ x: r.x, y: r.y, w: r.w, h: r.h });
  const detailStyle = { fontSizePt: L.detailFontSizePt, labelColor: C.muted, valueColor: C.ink, borderless: true, cellPaddingMm: DETAIL_TABLE_PAD_MM };

  const elements: SalesSheetElement[] = [
    { id: "catch-band", type: "shape", ...g(L.catchBand), z: 1, shape: "rect", fill: C.navy },
    // lineHeight は帯の高さ÷文字の高さ=1行を帯の縦中央に置く。
    { id: "catch-copy", type: "text", ...g(L.catchCopy), z: 2, content: parts.catchCopy ?? "",
      style: { fontSizePt: 16, bold: true, color: C.white, lineHeight: 2.8 } },
    { id: "kind-tag", type: "text", ...g(L.kindTag), z: 2, content: parts.kindLabel,
      style: { fontSizePt: 9, bold: true, color: C.white, align: "right", lineHeight: 5 } },
    { id: "heading", type: "text", ...g(L.heading), z: 2, content: parts.heading,
      style: { fontSizePt: 14, bold: true, color: C.navy } },
    { id: "price", type: "text", ...g(L.price), z: 2, content: parts.priceText,
      style: { fontSizePt: 32, bold: true, color: C.price, lineHeight: 1 } },
    { id: "overview", type: "table", ...g(L.mainTable), z: 1, rows: parts.mainRows,
      style: { fontSizePt: L.mainTable.fontSizePt, labelColor: C.navy, valueColor: C.ink, borderless: true, stripeColor: C.soft, cellPaddingMm: MAIN_TABLE_PAD_MM } },
    { id: "overview-detail-a", type: "table", ...g(L.detailLeft), z: 1, rows: left, style: detailStyle },
    { id: "overview-detail-b", type: "table", ...g(L.detailRight), z: 1, rows: right, style: { ...detailStyle } },
    { id: "sales-points-band", type: "shape", ...g(L.salesPointsBand), z: 1, shape: "rect", fill: C.soft },
    { id: "sales-points", type: "text", ...g(L.salesPoints), z: 2, content: salesPointsText,
      style: { fontSizePt: 10.5, bold: true, color: C.navy, lineHeight: 3.2 } },
    ...buildConsumerFooterBand(L.footer, parts.footer ?? {}, parts.company),
    ...photoAndFloorPlanElements(parts.photos, parts.floorPlanImage, L.photoZone),
  ];

  return {
    page: A4_LANDSCAPE,
    theme: { fontFamily: CONSUMER_FONT_FAMILY, accentColor: C.navy, template: CONSUMER_TEMPLATE },
    elements,
  };
}
```

4種別ビルダーの `rows` を振り分けに変える(値の組み立て関数は触らない):

```ts
// buildSaleMansionDocument
  const values = buildMansionValues(input);
  const { main, detail } = splitMainDetailRows("mansion", MANSION_SPEC_FIELDS, values);
  ...
  return buildSpecSheetDocument({
    heading,
    priceText,
    kindLabel: kindLabelOf(values, "マンション"),
    mainRows: main,
    detailRows: detail,
    photos: input.photos,
    // 以下(catchCopy / salesPoints / footer / floorPlanImage / company)は従来どおり
  });
```

- `buildSaleLandDocument`: `splitMainDetailRows("land", LAND_SPEC_FIELDS, values)`・`kindLabel: kindLabelOf(values, "売土地")`
- `buildSaleHouseDocument`: `splitMainDetailRows("house", HOUSE_SPEC_FIELDS, values)`・`kindLabel: kindLabelOf(values, "売戸建")`
- `buildSaleBuildingDocument`: `splitMainDetailRows("building", BUILDING_SPEC_FIELDS, values)`・`kindLabel: kindLabelOf(values, heading)`

各ビルダーの `const rows = buildSheetRows(...)` 行と `rows,` 引数は削除する。

- [ ] **Step 4: 4種別のビルダーテストを新しい紙面に合わせる**

(a) 4ファイルとも `tableLabels` を「全部の表のラベル」に置き換える(`tableRow` は既に全表を走査しているので変更不要):

```ts
const tableLabels = (doc: { elements: unknown[] }): string[] =>
  (doc.elements as { type: string; rows?: { label: string; value: string }[] }[])
    .filter((el) => el.type === "table" && !(el as { id?: string }).id?.startsWith("footer-"))
    .flatMap((el) => (el.rows ?? []).map((row) => row.label));
```

(b) 帯の色の期待値 `fill: "#15324f"` を `fill: "#1f3a5f"` に置き換える(house:60 / building:62 / land:58)。

(c) `build-mansion.test.ts` の「レイアウト: catch-band/heading/…」テスト(247〜350行目)と 5〜6行目の `computeSpecSheetLayout` / `buildFooterBand` import を削除し、次のテストに置き換える(座標の詳細は spec-sheet-document.test.ts が担う):

```ts
  it("新しい紙面で組まれる(物件名・価格・物件種目・主要表)", () => {
    const doc = buildSaleMansionDocument({
      ...base,
      overrides: { price: "6590", propertyType: "中古マンション", catchCopy: "北東角部屋", salesPoints: ["リノベ済"], transactionType: "専任媒介" },
    });
    expect(doc.theme.template).toBe("consumer-2026-09");
    expect(findEl(doc, "heading")).toMatchObject({ content: "西荻リリエンハイム" });
    expect(findEl(doc, "price")).toMatchObject({ content: "6590万円", style: { color: "#b7281e" } });
    expect(findEl(doc, "kind-tag")).toMatchObject({ content: "中古マンション" });
    expect(findEl(doc, "sales-points")).toMatchObject({ content: "おすすめポイント　◆リノベ済" });
    const overview = findEl(doc, "overview") as { rows: { label: string }[] };
    expect(overview.rows.map((r) => r.label)).toEqual(["交通", "間取り", "専有面積", "バルコニー", "築年月", "所在階・階数", "管理費・修繕積立金", "現況・引渡"]);
    expect(findEl(doc, "footer-staff-table")).toBeUndefined();
  });
```

(d) `build-house.test.ts` の「概要表フォントは行数に応じてエンジンが決める」テスト(299〜353行目)の期待2行を次に置き換える(入力はそのまま):

```ts
    const ov = findEl(doc, "overview") as { style?: { fontSizePt?: number } } | undefined;
    const da = findEl(doc, "overview-detail-a") as { style?: { fontSizePt?: number } } | undefined;
    expect(ov?.style?.fontSizePt).toBeGreaterThanOrEqual(11);
    expect(ov?.style?.fontSizePt).toBeLessThanOrEqual(12);
    expect(da?.style?.fontSizePt).toBeGreaterThanOrEqual(8);
    expect(da?.style?.fontSizePt).toBeLessThanOrEqual(10);
```

テスト名も「表の文字は主要11〜12pt・詳細8〜10ptに収まる」に変える。

(e) ここまでで残る失敗は、次の規則で直す(実装は変えない):
- **値が空の項目のラベルが `tableLabels` に含まれることを期待している** → その項目が主要8行(`MAIN_ROW_SPECS`)に含まれるならまとめ後のラベル(例「構造・階数」)に書き換え、含まれないなら `not.toContain` に変える(詳細は空行を出さないため)。
- **個別ラベル(例「建蔽率」「接道幅員」「1階面積」)を期待している** → まとめ後のラベル「建蔽率/容積率」「接道」「各階面積」(土地は主要の「建蔽率・容積率」「接道」)に書き換え、`tableRow` の期待値を「 / 」連結後の値に直す。
- **「価格」「物件種目」「建物名称」を表に期待している** → 表には出さない仕様なので `not.toContain` に変え、`price` / `kind-tag` / `heading` 要素の content で確認する。

- [ ] **Step 5: 合格を確認**

Run: `npx vitest run src/lib/sales-sheet src/components/sales-sheet && npx tsc --noEmit`
Expected: `spec-sheet-document` と `build-*` は PASS。**この時点で落ちてよいのは editor-document 系(autolayout / autobalance / floor-plan / map-qr / footer-data)と layout-engine.test のうち `computeSpecSheetLayout` を使う既存テストだけ**(Task 6・8 で直す)。それ以外が落ちたら直す。落ちたテスト名を控えておく。

- [ ] **Step 6: Commit**

```bash
git add src/lib/sales-sheet/build-document.ts src/lib/sales-sheet/__tests__/spec-sheet-document.test.ts src/lib/sales-sheet/__tests__/build-mansion.test.ts src/lib/sales-sheet/__tests__/build-house.test.ts src/lib/sales-sheet/__tests__/build-building.test.ts src/lib/sales-sheet/__tests__/build-land.test.ts
git commit -m "feat(sales-sheet): 新規図面を消費者向けひな型(整理型×紺)で作る"
```

---

### Task 6: エディタの計算(3列廃止・旧ひな型の停止・入りきらない表の検知)

**Files:**
- Modify: `src/lib/sales-sheet/editor-document.ts`
- Test(書き換え): `editor-document-floor-plan.test.ts`(全面)、`map-qr.test.ts`(エディタ部分)、`editor-document-footer-data.test.ts`(全面)、`editor-document-autobalance.test.ts`(全面)、`editor-document-autolayout.test.ts`(一部)
- Test(新): `editor-document-consumer-template.test.ts`

**Interfaces:**
- Consumes: `isConsumerTemplate`、`computeConsumerLayout` / `CONSUMER_PHOTO_ZONE` / `CONSUMER_MAP_QR_SLOT` / `packPhotoCells` / `PHOTO_GAP_MM`、`buildConsumerFooterTransactionElements`
- Produces(変更後の公開関数):
  - `autoArrangePhotos(state, opts?: { appendedId?: string; aspects?: Record<string, number> }): EditorState` — 旧ひな型/A4横以外は同一参照。`floor-plan` も整列対象。
  - `setAsFloorPlan(state, id, demotedId, aspects?)` / `unsetFloorPlan(state, newId, aspects?)` — id 付け替え+整列のみ。
  - `addMapQrElement(state, params: { address: string }): EditorState` — 会社帯右端の枠へ。旧ひな型は同一参照。
  - `autoBalanceLayout(state): EditorState` — 旧ひな型は同一参照。
  - `editFooterData(state, data)` — 旧ひな型は同一参照。
  - `findTableOverflows(doc: SalesSheetDocument): string[]` — 新規。
  - **削除**: `deleteMapQr` / `positionMapQrInState` / `commitFloorPlanGeometry`(と内部の `positionMapQr` / `defaultFloorPlanRect` / `snapOverviewInPlace` / `TEMPLATE_ELEMENT_IDS` / `PHOTO_ZONE_*` / `MAP_QR_GAP_MM` / `MAP_QR_RESERVE_H_MM`)

- [ ] **Step 1: 新しい振る舞いのテストを書く(失敗する)**

共通の作り方(各テストファイルで使う):

```ts
const SRC = "/uploads/properties/a/1.jpg";
function makeState(elements: unknown[], template: boolean = true): EditorState {
  const document = parseSalesSheetDocument({
    page: A4_LANDSCAPE,
    theme: { fontFamily: "sans-serif", accentColor: "#1f3a5f", ...(template ? { template: "consumer-2026-09" } : {}) },
    elements,
  });
  return { document, selectedId: null, dirty: false };
}
const img = (n: number, over: Record<string, unknown> = {}) => ({
  id: `img-${n}`, type: "image", x: 140, y: 60, w: 90, h: 60, z: n, src: SRC, fit: "cover", ...over,
});
const insideZone = (r: { x: number; y: number; w: number; h: number }) =>
  r.x >= CONSUMER_PHOTO_ZONE.x - 1e-6 && r.y >= CONSUMER_PHOTO_ZONE.y - 1e-6 &&
  r.x + r.w <= CONSUMER_PHOTO_ZONE.x + CONSUMER_PHOTO_ZONE.w + 1e-6 && r.y + r.h <= CONSUMER_PHOTO_ZONE.y + CONSUMER_PHOTO_ZONE.h + 1e-6;
```

新規 `editor-document-consumer-template.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  type EditorState, autoArrangePhotos, autoBalanceLayout, addMapQrElement, editFooterData,
  setAsFloorPlan, findTableOverflows, MAP_QR_ID,
} from "../editor-document";
import { parseSalesSheetDocument, A4_LANDSCAPE } from "../document-schema";
import { CONSUMER_PHOTO_ZONE, CONSUMER_MAP_QR_SLOT, CONSUMER_FOOTER } from "../layout-engine";
import { buildConsumerFooterBand, readFooterData } from "../footer-band";
import { buildSaleHouseDocument } from "../build-document";
// ここに「共通の作り方」の makeState / img / insideZone / SRC を置く

describe("旧ひな型(theme.template なし)では自動機能が何も変えない", () => {
  const legacy = () => makeState([img(1), img(2), { id: "overview", type: "table", x: 188, y: 26, w: 99, h: 150, z: 1, rows: [], style: {} }], false);
  it("autoArrangePhotos", () => { const s = legacy(); expect(autoArrangePhotos(s)).toBe(s); });
  it("autoBalanceLayout", () => { const s = legacy(); expect(autoBalanceLayout(s)).toBe(s); });
  it("addMapQrElement", () => { const s = legacy(); expect(addMapQrElement(s, { address: "東京都練馬区" })).toBe(s); });
  it("editFooterData", () => {
    const s = makeState(buildConsumerFooterBand(CONSUMER_FOOTER, { transactionType: "仲介" }), false);
    expect(editFooterData(s, { transactionType: "専任" })).toBe(s);
  });
  it("setAsFloorPlan は id を付け替えるが並べ直さない", () => {
    const s = legacy();
    const next = setAsFloorPlan({ ...s, selectedId: "img-1" }, "img-1", "demoted");
    const fp = next.document.elements.find((e) => e.id === "floor-plan");
    expect(fp).toMatchObject({ x: 140, y: 60, w: 90, h: 60 });
  });
  it("findTableOverflows は空", () => {
    expect(findTableOverflows(legacy().document)).toEqual([]);
  });
});

describe("新ひな型", () => {
  it("autoArrangePhotos: 間取り図も写真枠に並ぶ・重ならない", () => {
    const s = makeState([img(1), { ...img(2), id: "floor-plan" }, img(3)]);
    const next = autoArrangePhotos(s, { aspects: { "img-1": 1.5, "floor-plan": 1, "img-3": 0.75 } });
    const images = next.document.elements.filter((e) => e.type === "image");
    expect(images).toHaveLength(3);
    for (const r of images) expect(insideZone(r)).toBe(true);
    expect(next.document.elements.find((e) => e.id === "floor-plan")?.type === "image").toBe(true);
    expect(autoArrangePhotos(next, { aspects: { "img-1": 1.5, "floor-plan": 1, "img-3": 0.75 } })).toBe(next);
  });
  it("addMapQrElement: 会社帯右端の枠に置き、写真は動かさない", () => {
    const s = makeState([img(1)]);
    const next = addMapQrElement(s, { address: "東京都練馬区富士見台2-1" });
    expect(next.document.elements.find((e) => e.id === MAP_QR_ID)).toMatchObject({ type: "qr", ...CONSUMER_MAP_QR_SLOT });
    expect(next.document.elements.find((e) => e.id === "img-1")).toEqual(s.document.elements[0]);
    expect(next.selectedId).toBe(MAP_QR_ID);
  });
  it("editFooterData: 取引表だけ作り直し、6値を読み戻せる", () => {
    const s = makeState(buildConsumerFooterBand(CONSUMER_FOOTER, { transactionType: "仲介" }));
    const next = editFooterData(s, { transactionType: "専任", staff: "山田" });
    expect(readFooterData(next.document.elements)).toMatchObject({ transactionType: "専任", staff: "山田" });
    expect(next.document.elements.find((e) => e.id === "footer-staff-table")).toMatchObject({ style: { borderless: true } });
    expect(() => parseSalesSheetDocument(next.document)).not.toThrow();
  });
  it("findTableOverflows: 作成直後の図面(戸建・項目少なめ)はあふれない", () => {
    const doc = buildSaleHouseDocument({ property: { address: "東京都練馬区富士見台2-1", layoutType: "4LDK" }, overrides: { access: "徒歩6分", structure: "木造" } });
    expect(findTableOverflows(doc)).toEqual([]);
  });
  it("findTableOverflows: 行が枠より多い詳細表を返す", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ label: `項目${i}`, value: "値" }));
    const doc = makeState([{ id: "overview-detail-a", type: "table", x: 136, y: 110, w: 75.5, h: 20, z: 1, rows, style: { fontSizePt: 8, borderless: true, cellPaddingMm: 0.8 } }]).document;
    expect(findTableOverflows(doc)).toEqual(["overview-detail-a"]);
  });
});
```

`editor-document-floor-plan.test.ts` を全面置き換え:

```ts
import { describe, it, expect } from "vitest";
import { type EditorState, setAsFloorPlan, unsetFloorPlan, autoArrangePhotos } from "../editor-document";
import { parseSalesSheetDocument, salesSheetDocumentSchema, A4_LANDSCAPE } from "../document-schema";
import { CONSUMER_PHOTO_ZONE } from "../layout-engine";
// ここに「共通の作り方」の makeState / img / insideZone / SRC を置く
const ids = (s: EditorState) => s.document.elements.filter((e) => e.type === "image").map((e) => e.id);

describe("setAsFloorPlan / unsetFloorPlan(間取り図は写真の仲間)", () => {
  it("選んだ写真が floor-plan になり、写真枠に並び直る", () => {
    const s = makeState([img(1), img(2)]);
    const next = setAsFloorPlan({ ...s, selectedId: "img-2" }, "img-2", "demoted", { "img-1": 1.5, "img-2": 1 });
    expect(ids(next)).toEqual(["img-1", "floor-plan"]);
    expect(next.selectedId).toBe("floor-plan");
    expect(next.dirty).toBe(true);
    for (const e of next.document.elements) expect(insideZone(e)).toBe(true);
    const fp = next.document.elements.find((e) => e.id === "floor-plan");
    expect(fp?.type === "image" && fp.fit).toBe("contain");
    // 実寸比は新しい id に引き継がれる(1:1 のまま並ぶ)
    expect(fp && fp.w / fp.h).toBeCloseTo(1, 3);
    expect(salesSheetDocumentSchema.safeParse(next.document).success).toBe(true);
  });
  it("既存の間取り図は demotedId の写真に戻る(常に1枚)", () => {
    const s = makeState([{ ...img(1), id: "floor-plan" }, img(2)]);
    const next = setAsFloorPlan(s, "img-2", "demoted", { "floor-plan": 0.7, "img-2": 1.5 });
    expect(ids(next).sort()).toEqual(["demoted", "floor-plan"]);
    const demoted = next.document.elements.find((e) => e.id === "demoted");
    expect(demoted && demoted.w / demoted.h).toBeCloseTo(0.7, 3);
  });
  it("写真でない id・floor-plan 自身は何もしない", () => {
    const s = makeState([{ id: "t", type: "text", x: 0, y: 0, w: 10, h: 10, z: 1, content: "x" }, { ...img(1), id: "floor-plan" }]);
    expect(setAsFloorPlan(s, "t", "d")).toBe(s);
    expect(setAsFloorPlan(s, "floor-plan", "d")).toBe(s);
    expect(setAsFloorPlan(s, "none", "d")).toBe(s);
  });
  it("unsetFloorPlan は newId の写真に戻し、実寸比を引き継ぐ", () => {
    const s = makeState([{ ...img(1), id: "floor-plan" }]);
    const next = unsetFloorPlan(s, "back", { "floor-plan": 0.8 });
    expect(ids(next)).toEqual(["back"]);
    expect(next.selectedId).toBe("back");
    const back = next.document.elements[0];
    expect(back.w / back.h).toBeCloseTo(0.8, 3);
    expect(unsetFloorPlan(makeState([img(1)]), "x")).toEqual(makeState([img(1)]));
  });
  it("整列済みへの再整列は同一参照", () => {
    const s = setAsFloorPlan(makeState([img(1), img(2)]), "img-2", "d", { "img-1": 1.5, "img-2": 1 });
    expect(autoArrangePhotos(s, { aspects: { "img-1": 1.5, "floor-plan": 1 } })).toBe(s);
  });
});
```

`map-qr.test.ts`: `describe("buildMapsSearchUrl", …)` はそのまま残し、それ以外の describe と不要な import(`autoBalanceLayout` / `setAsFloorPlan` / `unsetFloorPlan` / `deleteMapQr` / `floorPlan` ヘルパー)を削除して、次を追加:

```ts
describe("addMapQrElement(会社帯右端の枠)", () => {
  // makeState は theme に template: "consumer-2026-09" を入れる形に置き換える
  it("住所からQRを作り、枠の位置・大きさで置く(中身=マップURL)", () => {
    const next = addMapQrElement(makeState([]), { address: "東京都練馬区富士見台2-1" });
    const qr = qrOf(next);
    expect(qr).toMatchObject({ id: MAP_QR_ID, ...CONSUMER_MAP_QR_SLOT });
    expect(qr?.content).toBe(buildMapsSearchUrl("東京都練馬区富士見台2-1"));
    expect(salesSheetDocumentSchema.safeParse(next.document).success).toBe(true);
  });
  it("2回目は置き換え(1枚だけ)", () => {
    const once = addMapQrElement(makeState([]), { address: "東京都練馬区" });
    const twice = addMapQrElement(once, { address: "東京都杉並区" });
    expect(twice.document.elements.filter((e) => e.id === MAP_QR_ID)).toHaveLength(1);
  });
  it("住所が空なら何もしない", () => {
    const s = makeState([]);
    expect(addMapQrElement(s, { address: "  " })).toBe(s);
  });
});
```

(`CONSUMER_MAP_QR_SLOT` を `../layout-engine` から import)

`editor-document-footer-data.test.ts`: `stateWith` を次に置き換え、`buildFooterBand` と `FOOTER` を `buildConsumerFooterBand` / `CONSUMER_FOOTER` に置き換える。既存テストのうち `footer-divider-*` を期待しているものは、区切り線が無い新しい帯に合わせて削除する。

```ts
import { buildConsumerFooterBand, readFooterData, type FooterBandData } from "../footer-band";
import { CONSUMER_FOOTER } from "../layout-engine";

function stateWith(data: FooterBandData): EditorState {
  const elements = buildConsumerFooterBand(CONSUMER_FOOTER, data);
  return {
    document: { page: A4_LANDSCAPE, theme: { fontFamily: "sans-serif", accentColor: "#1f3a5f", template: "consumer-2026-09" }, elements },
    selectedId: null,
    dirty: false,
  };
}
```

`editor-document-autobalance.test.ts` を全面置き換え:

```ts
import { describe, it, expect } from "vitest";
import { type EditorState, autoBalanceLayout } from "../editor-document";
import { buildSaleHouseDocument } from "../build-document";
import { computeConsumerLayout, CONSUMER_PHOTO_ZONE, CONSUMER_MAP_QR_SLOT } from "../layout-engine";
import { salesSheetDocumentSchema, A4_PORTRAIT, type SalesSheetElement } from "../document-schema";

const houseDoc = () => buildSaleHouseDocument({
  property: { address: "東京都杉並区西荻北1-4-3", layoutType: "3LDK", buildingCoverageRatio: "60", floorAreaRatio: "200", roadType: "公道", roadWidth: "4.0" },
  photos: [{ fileUrl: "/uploads/1.jpg" }, { fileUrl: "/uploads/2.jpg" }],
  floorPlanImage: { fileUrl: "/uploads/plan.png" },
  overrides: { access: "徒歩6分", remarks: "南向き" },
});
const stateOf = (document = houseDoc()): EditorState => ({ document, selectedId: null, dirty: false });
const byId = (s: EditorState, id: string) => s.document.elements.find((e) => e.id === id) as SalesSheetElement;
const moved = (s: EditorState, id: string, dx: number): EditorState => ({
  ...s,
  document: { ...s.document, elements: s.document.elements.map((e) => (e.id === id ? { ...e, x: e.x + dx } : e)) },
});

describe("autoBalanceLayout(新ひな型)", () => {
  it("作成直後の図面は同一参照(バランス済み)", () => {
    const s = stateOf();
    expect(autoBalanceLayout(s)).toBe(s);
  });
  it("手で動かした定型項目・表・写真を標準の位置へ戻す", () => {
    const s0 = stateOf();
    const s = ["heading", "overview", "overview-detail-b", "sales-points-band", "photo-1", "floor-plan"].reduce((acc, id) => moved(acc, id, 3), s0);
    const next = autoBalanceLayout(s);
    for (const id of ["heading", "overview", "overview-detail-b", "sales-points-band", "photo-1", "floor-plan"]) {
      expect(byId(next, id)).toMatchObject({ x: byId(s0, id).x, y: byId(s0, id).y, w: byId(s0, id).w, h: byId(s0, id).h });
    }
    expect(next.dirty).toBe(true);
    expect(salesSheetDocumentSchema.safeParse(next.document).success).toBe(true);
  });
  it("表の行数が変わったら文字サイズを計算し直す", () => {
    const s0 = stateOf();
    const rows = Array.from({ length: 13 }, (_, i) => ({ label: `L${i}`, value: "v" }));
    const s: EditorState = { ...s0, document: { ...s0.document, elements: s0.document.elements.map((e) =>
      e.type === "table" && (e.id === "overview-detail-a" || e.id === "overview-detail-b") ? { ...e, rows } : e) } };
    const next = autoBalanceLayout(s);
    const L = computeConsumerLayout({ mainRowCount: 8, detailRowCount: 26 });
    expect(byId(next, "overview-detail-a")).toMatchObject({ style: { fontSizePt: L.detailFontSizePt } });
    expect(byId(next, "overview")).toMatchObject({ style: { fontSizePt: L.mainTable.fontSizePt } });
  });
  it("地図QRは枠へ戻し、利用者が足した文字と会社帯は動かさない", () => {
    const s0 = stateOf();
    const extra = { id: "my-note", type: "text" as const, x: 150, y: 150, w: 30, h: 8, z: 5, content: "メモ", style: {} };
    const qr = { id: "map-qr", type: "qr" as const, x: 10, y: 10, w: 20, h: 20, z: 6, dataUrl: "data:image/png;base64,AAAA" };
    const s = moved({ ...s0, document: { ...s0.document, elements: [...s0.document.elements, extra, qr] } }, "footer-name-ja", 2);
    const next = autoBalanceLayout(s);
    expect(byId(next, "map-qr")).toMatchObject(CONSUMER_MAP_QR_SLOT);
    expect(byId(next, "my-note")).toBe(byId(s, "my-note"));
    expect(byId(next, "footer-name-ja")).toBe(byId(s, "footer-name-ja"));
  });
  it("写真と間取り図は写真枠の中", () => {
    const next = autoBalanceLayout(moved(stateOf(), "photo-2", 100));
    for (const e of next.document.elements.filter((el) => el.type === "image")) {
      expect(e.x + e.w).toBeLessThanOrEqual(CONSUMER_PHOTO_ZONE.x + CONSUMER_PHOTO_ZONE.w + 1e-6);
    }
  });
  it("A4縦では何もしない", () => {
    const s0 = stateOf();
    const s: EditorState = { ...s0, document: { ...s0.document, page: A4_PORTRAIT } };
    expect(autoBalanceLayout(s)).toBe(s);
  });
});
```

`editor-document-autolayout.test.ts`:
- `makeDoc` の theme を `{ fontFamily: "sans-serif", accentColor: "#1f4e79", template: "consumer-2026-09" }` にする。
- 次の7テストを削除(3列・概要表スナップ前提): 「overview があるときは写真ゾーン右端=177…」「overview が定位置より左…」「A4縦でも overview スナップは用紙内…」「間取り図(floor-plan)は中央列・不動…」「間取り図が広すぎて写真ゾーン(左)が潰れている…」「間取り図の左端を左へ動かすと…」、および A4縦を前提にした期待が他にあればそれも「A4縦は同一参照」に変える。
- 「ゾーン内・重なりなし(混在比5枚)」「多数(12枚)でも正のサイズ・ゾーン内・非重複」のゾーン判定を `CONSUMER_PHOTO_ZONE`(x7 y19.5 w124 h148)に置き換える(`../layout-engine` から import)。
- 次を追加:

```ts
  it("A4縦の図面では何もしない", () => {
    const s = makeState([imageEl(1), imageEl(2)], A4_PORTRAIT);
    expect(autoArrangePhotos(s)).toBe(s);
  });
```

(`A4_PORTRAIT` を import)

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/editor-document-consumer-template.test.ts src/lib/sales-sheet/__tests__/editor-document-floor-plan.test.ts src/lib/sales-sheet/__tests__/map-qr.test.ts src/lib/sales-sheet/__tests__/editor-document-footer-data.test.ts src/lib/sales-sheet/__tests__/editor-document-autobalance.test.ts src/lib/sales-sheet/__tests__/editor-document-autolayout.test.ts`
Expected: FAIL(`findTableOverflows` が無い・位置が旧計算)

- [ ] **Step 3: import を置き換える**

`editor-document.ts` 20〜45行目:

```ts
import {
  computeConsumerLayout,
  packPhotoCells,
  CONSUMER_PHOTO_ZONE,
  CONSUMER_MAP_QR_SLOT,
  PHOTO_GAP_MM,
  type Rect,
} from "./layout-engine";
import { packMosaic } from "./mosaic-pack";
import {
  buildConsumerFooterTransactionElements,
  readFooterData,
  footerDataEqual,
  type FooterBandData,
} from "./footer-band";
import {
  A4_LANDSCAPE,
  isConsumerTemplate,
  type SalesSheetDocument,
  type SalesSheetElement,
  type TextElement,
  type ImageElement,
  type BadgeElement,
  type QrElement,
  type TableElement,
} from "./document-schema";
```

- [ ] **Step 4: 地図QRを置き換える**

545〜723行目(`MAP_QR_ID` 定義から `deleteMapQr` の終わりまで)を次に置き換える:

```ts
/** 地図QR(物件の場所の Google マップ QR)の固定 id。1枚のみ。 */
export const MAP_QR_ID = "map-qr";

/**
 * 物件の住所から Google マップ検索の QR を作り、会社帯右端の枠(CONSUMER_MAP_QR_SLOT)に置く。
 * - 旧ひな型では何もしない(枠が旧会社帯と重なるため)。住所空/生成不能も同一参照。
 * - 既存の地図QRは置き換え(1枚)。写真や間取り図は動かさない。z=最前面・自動選択・dirty。
 */
export function addMapQrElement(state: EditorState, params: { address: string }): EditorState {
  const { document } = state;
  if (!isConsumerTemplate(document)) return state;
  const url = buildMapsSearchUrl(params.address);
  if (url === null) return state;
  const dataUrl = generateQrDataUrl(url);
  if (dataUrl === null) return state;
  const base = document.elements.filter((e) => e.id !== MAP_QR_ID);
  const z = base.length ? Math.max(...base.map((e) => e.z)) + 1 : 1;
  const slot = CONSUMER_MAP_QR_SLOT;
  const mapQrEl: QrElement = { id: MAP_QR_ID, type: "qr", x: slot.x, y: slot.y, w: slot.w, h: slot.h, z, dataUrl, content: url };
  return {
    ...state,
    dirty: true,
    selectedId: MAP_QR_ID,
    document: { ...document, elements: [...base, mapQrEl] },
  };
}
```

- [ ] **Step 5: `editFooterData` を置き換える**

```ts
/**
 * 会社帯の物件別6項目をまとめて更新する(取引条件/担当の表だけ作り直す)。
 * - 旧ひな型・footer-band の無い図面・値が同じときは同一参照。
 * - 作り直した表は、元の取引表があった位置(配列順)に入れる。
 */
export function editFooterData(state: EditorState, data: FooterBandData): EditorState {
  const { document } = state;
  if (!isConsumerTemplate(document)) return state;
  const band = document.elements.find((e) => e.id === "footer-band");
  if (!band) return state;
  if (footerDataEqual(readFooterData(document.elements), data)) return state;

  const regenerated = buildConsumerFooterTransactionElements({ x: band.x, y: band.y, w: band.w, h: band.h }, data);
  const TX_IDS = new Set(["footer-terms-table", "footer-staff-table"]);
  const elements: SalesSheetElement[] = [];
  let inserted = false;
  for (const el of document.elements) {
    if (TX_IDS.has(el.id)) {
      if (!inserted) {
        elements.push(...regenerated);
        inserted = true;
      }
      continue;
    }
    elements.push(el);
  }
  if (!inserted) elements.push(...regenerated);
  return { ...state, dirty: true, document: { ...document, elements } };
}
```

- [ ] **Step 6: 自動整列・間取り図・自動調整を置き換える**

888〜1355行目(`TEMPLATE_ELEMENT_IDS` から `autoBalanceLayout` の終わりまで。`nearlyEqual` と `geomEquals` は残す)を次に置き換える:

```ts
/** A4横の図面か(新しい紙面の計算は A4横専用)。 */
function isA4Landscape(document: SalesSheetDocument): boolean {
  return document.page.width === A4_LANDSCAPE.width && document.page.height === A4_LANDSCAPE.height;
}

/**
 * 写真と間取り図(type=image すべて)を写真枠(CONSUMER_PHOTO_ZONE)へモザイク配置で並べ直す。
 * - 旧ひな型・A4横以外は同一参照。
 * - 並び順=配列順(代表写真が先頭)。opts.appendedId は末尾。
 * - 枠は実寸比(opts.aspects[id]・無ければ現枠の w/h)を保つ。fit:"contain"。
 * - 純・決定的。変更ゼロなら同一参照。
 */
export function autoArrangePhotos(
  state: EditorState,
  opts?: { appendedId?: string; aspects?: Record<string, number> },
): EditorState {
  const { document } = state;
  if (!isConsumerTemplate(document) || !isA4Landscape(document)) return state;
  const targets: number[] = [];
  document.elements.forEach((e, i) => {
    if (e.type === "image") targets.push(i);
  });
  if (targets.length === 0) return state;

  const ordered = targets.slice();
  if (opts?.appendedId) {
    const k = ordered.findIndex((idx) => document.elements[idx].id === opts.appendedId);
    if (k >= 0) ordered.push(...ordered.splice(k, 1));
  }
  const aspects = ordered.map((idx) => {
    const el = document.elements[idx];
    return opts?.aspects?.[el.id] ?? (el.h > 0 ? el.w / el.h : 0);
  });
  const zone = CONSUMER_PHOTO_ZONE;
  const rects = packMosaic(aspects, zone.w, zone.h, PHOTO_GAP_MM);

  let changed = false;
  const elements = document.elements.slice() as SalesSheetElement[];
  ordered.forEach((idx, k) => {
    const el = elements[idx] as ImageElement;
    const r = rects[k];
    const x = zone.x + r.x;
    const y = zone.y + r.y;
    if (!nearlyEqual(el.x, x) || !nearlyEqual(el.y, y) || !nearlyEqual(el.w, r.w) || !nearlyEqual(el.h, r.h) || el.fit !== "contain") {
      changed = true;
      elements[idx] = { ...el, x, y, w: r.w, h: r.h, fit: "contain" };
    }
  });
  if (!changed) return state;
  return { ...state, dirty: true, document: { ...document, elements } };
}

/** 幾何座標の等値判定(1/1000mm 許容・整列の冪等性用)。 */
function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.001;
}

/** 実寸比の表を、id の付け替えに合わせて写し替える(元の表は変えない)。 */
function renameAspects(
  aspects: Record<string, number> | undefined,
  renames: [from: string, to: string][],
): Record<string, number> | undefined {
  if (!aspects) return undefined;
  const out = { ...aspects };
  for (const [from, to] of renames) if (aspects[from] !== undefined) out[to] = aspects[from];
  return out;
}

/**
 * 選んだ写真を間取り図(id="floor-plan")にする。既存の間取り図は demotedId の写真に戻す(常に1枚)。
 * 位置は写真枠の並べ直しに任せる(旧ひな型では並べ直さない)。selectedId は "floor-plan"。
 */
export function setAsFloorPlan(
  state: EditorState,
  id: string,
  demotedId: string,
  aspects?: Record<string, number>,
): EditorState {
  const { document } = state;
  const idx = document.elements.findIndex((e) => e.id === id);
  if (idx === -1) return state;
  const target = document.elements[idx];
  if (target.type !== "image" || target.id === "floor-plan") return state;

  const elements = document.elements.slice() as SalesSheetElement[];
  const existingIdx = elements.findIndex((e) => e.id === "floor-plan");
  if (existingIdx !== -1) elements[existingIdx] = { ...elements[existingIdx], id: demotedId } as SalesSheetElement;
  elements[idx] = { ...(target as ImageElement), id: "floor-plan", fit: "contain" };
  const next: EditorState = { ...state, dirty: true, selectedId: "floor-plan", document: { ...document, elements } };
  const renamed = renameAspects(aspects, [["floor-plan", demotedId], [id, "floor-plan"]]);
  return autoArrangePhotos(next, renamed ? { aspects: renamed } : undefined);
}

/** 間取り図(id="floor-plan")を newId の写真に戻す。無ければ同一参照。selectedId は newId。 */
export function unsetFloorPlan(
  state: EditorState,
  newId: string,
  aspects?: Record<string, number>,
): EditorState {
  const { document } = state;
  const idx = document.elements.findIndex((e) => e.id === "floor-plan" && e.type === "image");
  if (idx === -1) return state;
  const elements = document.elements.slice() as SalesSheetElement[];
  elements[idx] = { ...elements[idx], id: newId } as SalesSheetElement;
  const next: EditorState = { ...state, dirty: true, selectedId: newId, document: { ...document, elements } };
  const renamed = renameAspects(aspects, [["floor-plan", newId]]);
  return autoArrangePhotos(next, renamed ? { aspects: renamed } : undefined);
}

/** x/y/w/h がすべて等しいか（幾何の変更検知用）。 */
function geomEquals(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * 定型項目・表・写真・地図QRを、computeConsumerLayout の標準位置へ戻す(「レイアウト自動調整」)。
 * - 旧ひな型・A4横以外は同一参照。
 * - 表(overview / overview-detail-a / -b)は行数から文字サイズも計算し直す。
 * - 写真と間取り図は写真枠へ均等に置く(エディタが続けてモザイク整列で仕上げる)。
 * - 会社帯(footer-*)と利用者が足した要素は動かさない。変更ゼロなら同一参照。
 */
export function autoBalanceLayout(state: EditorState): EditorState {
  const { document } = state;
  if (!isConsumerTemplate(document) || !isA4Landscape(document)) return state;
  const rowsOf = (id: string): number => {
    const el = document.elements.find((e) => e.id === id);
    return el && el.type === "table" ? el.rows.length : 0;
  };
  const L = computeConsumerLayout({
    mainRowCount: rowsOf("overview"),
    detailRowCount: rowsOf("overview-detail-a") + rowsOf("overview-detail-b"),
  });
  const rects = new Map<string, Rect>([
    ["catch-band", L.catchBand],
    ["catch-copy", L.catchCopy],
    ["kind-tag", L.kindTag],
    ["heading", L.heading],
    ["price", L.price],
    ["sales-points-band", L.salesPointsBand],
    ["sales-points", L.salesPoints],
    [MAP_QR_ID, L.mapQrSlot],
  ]);
  const tables = new Map<string, { rect: Rect; fontSizePt: number }>([
    ["overview", { rect: L.mainTable, fontSizePt: L.mainTable.fontSizePt }],
    ["overview-detail-a", { rect: L.detailLeft, fontSizePt: L.detailFontSizePt }],
    ["overview-detail-b", { rect: L.detailRight, fontSizePt: L.detailFontSizePt }],
  ]);

  let changed = false;
  const next = document.elements.slice() as SalesSheetElement[];
  next.forEach((el, i) => {
    const table = tables.get(el.id);
    if (table && el.type === "table") {
      const r = table.rect;
      if (!geomEquals(el, r) || el.style.fontSizePt !== table.fontSizePt) {
        changed = true;
        next[i] = { ...el, x: r.x, y: r.y, w: r.w, h: r.h, style: { ...el.style, fontSizePt: table.fontSizePt } };
      }
      return;
    }
    const r = rects.get(el.id);
    if (r && !geomEquals(el, r)) {
      changed = true;
      next[i] = applyGeom(el, { x: r.x, y: r.y, w: r.w, h: r.h });
    }
  });

  const imageIdxs: number[] = [];
  next.forEach((e, i) => {
    if (e.type === "image") imageIdxs.push(i);
  });
  const zone = L.photoZone;
  const cells = packPhotoCells(imageIdxs.length, zone.w, zone.h);
  imageIdxs.forEach((idx, k) => {
    const c = cells[k];
    const r = { x: zone.x + c.x, y: zone.y + c.y, w: c.w, h: c.h };
    if (!geomEquals(next[idx], r)) {
      changed = true;
      next[idx] = applyGeom(next[idx], r);
    }
  });

  if (!changed) return state;
  return { ...state, dirty: true, document: { ...document, elements: next } };
}
```

注: 「作成直後は同一参照」を満たすため、ビルダーの写真配置(`packPhotoCells`・並び順)と完全に同じ計算であること。テストが落ちたら座標の丸めではなく並び順(`photo-1, floor-plan, photo-2`)の一致を確認する。

- [ ] **Step 7: 入りきらない表の検知を足す**

`estimatedTableHeightMm` の本体を、表の余白指定を反映するよう置き換える(未指定時の結果は従来と同一):

```ts
function estimatedTableHeightMm(el: TableElement, mono: boolean, maxHeightMm: number): number {
  const fontMm = (el.style.fontSizePt ?? 12) * PT_TO_MM;
  const lineMm = fontMm * 1.3;
  // 余白: 未指定は従来の 0.5mm 1mm。指定時は上下=値・左右=値×1.2(table-cell-style と同じ)。
  const padV = el.style.cellPaddingMm ?? 0.5;
  const padH = el.style.cellPaddingMm !== undefined ? el.style.cellPaddingMm * 1.2 : 1;
  const rowExtraMm = padV * 2 + (el.style.borderless ? 0 : 0.4);
  const labelW = Math.max(el.w * 0.32 - padH * 2, fontMm);
  const valueW = Math.max(el.w * 0.68 - padH * 2, fontMm);
  const labelChars = Math.max(0.1, labelW / fontMm);
  const valueChars = Math.max(0.1, valueW / fontMm);
  const lineCap = Math.max(1, Math.ceil(maxHeightMm / lineMm));
  const cellLines = (s: string, chars: number): number =>
    measureParagraph(s, chars, mono, lineCap + 1, true).length;
  let total = 0;
  for (const r of el.rows) {
    const rowLines = Math.max(cellLines(r.label, labelChars), cellLines(r.value, valueChars));
    total += rowLines * lineMm + rowExtraMm;
    if (total >= maxHeightMm) return total;
  }
  return total;
}
```

(既存のコメントのうち @codex 由来の注記は残してよい。挙動は上のとおり)

`estimatedTableHeightMm` の直後に追加:

```ts
/** 入りきらないか調べる表(消費者向けひな型の主要表・詳細表)。 */
const OVERFLOW_CHECK_TABLE_IDS = ["overview", "overview-detail-a", "overview-detail-b"] as const;

/**
 * 描画上の高さが枠を超える表の id を返す(読み取り専用・編集画面の警告用)。
 * 旧ひな型は対象外(空配列)。
 */
export function findTableOverflows(doc: SalesSheetDocument): string[] {
  if (!isConsumerTemplate(doc)) return [];
  const mono = isMonospaceFamily(doc.theme.fontFamily);
  const out: string[] = [];
  for (const id of OVERFLOW_CHECK_TABLE_IDS) {
    const el = doc.elements.find((e): e is TableElement => e.id === id && e.type === "table");
    if (!el) continue;
    if (estimatedTableHeightMm(el, mono, el.h + 10) > el.h + OVERLAP_TOLERANCE_MM) out.push(id);
  }
  return out;
}
```

- [ ] **Step 8: 合格を確認**

Run: `npx vitest run src/lib/sales-sheet && npx tsc --noEmit`
Expected: `src/lib/sales-sheet` は **layout-engine.test.ts の旧計算テストを除き** PASS。tsc は `SalesSheetEditor.tsx` の import エラー(`deleteMapQr` / `positionMapQrInState` / `commitFloorPlanGeometry`)だけが残る(Task 7 で直す)。`editor-document.ts` 内に未使用になった `clamp` / `DEFAULT_QR_SIZE_MM` 等があれば eslint の指摘に従い削除。既存の重なり検知テスト(`findTextTableOverlaps` 系)が PASS していることを必ず確認する(未指定時の見積もりが変わっていない証拠)。

- [ ] **Step 9: Commit**

```bash
git add src/lib/sales-sheet/editor-document.ts src/lib/sales-sheet/__tests__/editor-document-consumer-template.test.ts src/lib/sales-sheet/__tests__/editor-document-floor-plan.test.ts src/lib/sales-sheet/__tests__/map-qr.test.ts src/lib/sales-sheet/__tests__/editor-document-footer-data.test.ts src/lib/sales-sheet/__tests__/editor-document-autobalance.test.ts src/lib/sales-sheet/__tests__/editor-document-autolayout.test.ts
git commit -m "feat(sales-sheet): 3列を廃止し間取り図を写真の仲間に・旧ひな型では自動機能を止める"
```

---

### Task 7: 画面の配線(ツールバー・右パネル・編集画面)

**Files:**
- Modify: `src/components/sales-sheet/editor/EditorToolbar.tsx`
- Modify: `src/components/sales-sheet/editor/ElementPanel.tsx:466-486`
- Modify: `src/components/sales-sheet/editor/SalesSheetEditor.tsx`
- Test: `src/components/sales-sheet/editor/__tests__/editor-toolbar.test.tsx`、`element-panel.test.tsx`

**Interfaces:**
- Consumes: Task 6 の関数(`addMapQrElement(state, { address })` など)、`isConsumerTemplate`、`findTableOverflows`
- Produces: `EditorToolbarProps.canAutoLayout?: boolean`(既定 true)、`EditorToolbarProps.mapQrDisabledReason?: string`、`EditorToolbarProps.transactionInfoDisabledReason?: string`、`LEGACY_TEMPLATE_NOTE`(EditorToolbar から export)、`TABLE_OVERFLOW_WARNING`(SalesSheetEditor 内の定数)

- [ ] **Step 1: 失敗するテストを書く**

`editor-toolbar.test.tsx` の import を `import { EditorToolbar, LEGACY_TEMPLATE_NOTE } from "../EditorToolbar";` にして、末尾に追記(同ファイルの既存の描画ヘルパーと props の作り方に合わせる。ここでは `renderToStaticMarkup(<EditorToolbar {...baseProps} … />)` を想定し、`baseProps` が無ければ既存テストが渡している props をまとめて作る):

```tsx
describe("旧ひな型では自動機能のボタンを止める", () => {
  it("canAutoLayout=false で自動整列・自動調整が無効になり、理由が出る", () => {
    const html = renderToStaticMarkup(<EditorToolbar {...baseProps} canAutoLayout={false} />);
    for (const attr of ["data-toolbar-auto-arrange", "data-toolbar-auto-balance"]) {
      const s = html.slice(html.indexOf(attr));
      expect(s.slice(0, s.indexOf(">"))).toContain("disabled");
    }
    expect(html).toContain(LEGACY_TEMPLATE_NOTE);
  });
  it("地図QR・取引情報は渡された理由を title に出す", () => {
    const html = renderToStaticMarkup(
      <EditorToolbar {...baseProps} canAddMapQr={false} mapQrDisabledReason={LEGACY_TEMPLATE_NOTE} canEditTransactionInfo={false} transactionInfoDisabledReason={LEGACY_TEMPLATE_NOTE} />,
    );
    expect(html.split(LEGACY_TEMPLATE_NOTE).length - 1).toBeGreaterThanOrEqual(2);
  });
  it("地図QRの説明は「会社帯の右端」", () => {
    const html = renderToStaticMarkup(<EditorToolbar {...baseProps} canAddMapQr />);
    expect(html).toContain("会社帯の右端");
    expect(html).not.toContain("間取図の下");
  });
});
```

既存テスト「地図QR追加ボタン: 住所ありで活性・住所無しで無効」は、住所無しの title 期待を `"物件の住所が未登録です"`(既定値)のまま残す。既存テスト「自動整列・自動調整ボタンに効果範囲の title 注記がある」は、自動整列側の期待文言を新しい title(下の Step 3)に合わせる。

`element-panel.test.tsx` に追記(既存の画像要素を渡すテストの作り方に合わせる):

```tsx
it("間取り図ボタンの文言に「中央列」を含めない", () => {
  const photo = renderToStaticMarkup(<ElementPanel {...basePanelProps} element={imageElement("img-1")} />);
  expect(photo).toContain("間取り図にする");
  expect(photo).not.toContain("中央列");
  const plan = renderToStaticMarkup(<ElementPanel {...basePanelProps} element={imageElement("floor-plan")} />);
  expect(plan).toContain("写真に戻す");
  expect(plan).not.toContain("中央");
});
```

(`basePanelProps` / `imageElement` が既存に無ければ、ファイル内の既存テストの props をそのまま流用して作る)

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/components/sales-sheet/editor/__tests__/editor-toolbar.test.tsx src/components/sales-sheet/editor/__tests__/element-panel.test.tsx`
Expected: FAIL(`LEGACY_TEMPLATE_NOTE` が無い・文言が旧のまま)

- [ ] **Step 3: `EditorToolbar.tsx`**

props の定義に追加:

```ts
  /** 新しい紙面の自動機能(写真を自動整列・レイアウト自動調整)が使えるか。旧ひな型は false。未指定 true。 */
  canAutoLayout?: boolean;
  /** 地図QRボタンが無効なときの理由(未指定は「物件の住所が未登録です」)。 */
  mapQrDisabledReason?: string;
  /** 取引情報ボタンが無効なときの理由(未指定は従来の文言)。 */
  transactionInfoDisabledReason?: string;
```

ファイル上部(`export interface` の前)に:

```ts
/** 旧ひな型の図面で自動機能を止めたときの説明。 */
export const LEGACY_TEMPLATE_NOTE = "古いひな型の図面では使えません（新しいひな型で作り直すと使えます）";
```

関数の引数に `canAutoLayout = true, mapQrDisabledReason, transactionInfoDisabledReason` を足し、4つのボタンを次のように変える:

```tsx
      <button
        type="button"
        data-toolbar-auto-arrange
        onClick={onAutoArrange}
        disabled={busy || !canAutoLayout}
        title={!canAutoLayout ? LEGACY_TEMPLATE_NOTE : "写真と間取り図を左の写真枠に並べ直します。文字・表・バッジ・QRは動きません"}
        className="rounded px-3 py-1.5 text-sm border border-neutral-300 dark:border-zinc-600 hover:bg-neutral-100 dark:hover:bg-zinc-700 disabled:opacity-50 dark:text-neutral-200"
      >
        写真を自動整列
      </button>
      <button
        type="button"
        data-toolbar-auto-balance
        onClick={onAutoBalance}
        disabled={busy || !canAutoLayout}
        title={!canAutoLayout ? LEGACY_TEMPLATE_NOTE : "見出し・価格・キャッチコピー・表・写真・間取り図・地図QRなどの定型項目を標準の配置に戻します(手で動かしていても戻ります)。自分で追加した文字・バッジ・QR(地図QRを除く)は動きません"}
        className="rounded px-3 py-1.5 text-sm border border-neutral-300 dark:border-zinc-600 hover:bg-neutral-100 dark:hover:bg-zinc-700 disabled:opacity-50 dark:text-neutral-200"
      >
        レイアウト自動調整
      </button>
```

```tsx
        disabled={busy || !canAddMapQr}
        title={!canAddMapQr ? (mapQrDisabledReason ?? "物件の住所が未登録です") : "物件の場所（Googleマップ）のQRを会社帯の右端に追加"}
```

```tsx
        disabled={busy || !canEditTransactionInfo}
        title={!canEditTransactionInfo ? (transactionInfoDisabledReason ?? "この図面には会社帯がありません（古い様式で作成された図面）") : undefined}
```

props コメントの「間取図の下(無ければ右下)」は「会社帯の右端」に直す。

- [ ] **Step 4: `ElementPanel.tsx`**

466〜486行目のコメントとボタン文言:

```tsx
            {/* 間取り図/敷地図の指定・解除。間取り図も写真の仲間として写真枠に並ぶ。 */}
            {imageEl.id === "floor-plan" ? (
              <button … data-action="unset-floor-plan" …>
                写真に戻す（間取り図を解除）
              </button>
            ) : (
              <button … data-action="set-floor-plan" …>
                間取り図にする
              </button>
            )}
```

(`…` 部分の属性・className は現状のまま)

- [ ] **Step 5: `SalesSheetEditor.tsx`**

(a) import: `deleteMapQr` / `positionMapQrInState` / `commitFloorPlanGeometry` を削除し、`findTableOverflows` を editor-document から、`isConsumerTemplate` を `@/lib/sales-sheet/document-schema` から、`LEGACY_TEMPLATE_NOTE` を `./EditorToolbar` から import する。

(b) `measureGalleryAspects` と `cachedGalleryAspects` の対象を「すべての image」にする(間取り図も写真の仲間):

```ts
    const targets = doc.elements.filter((e): e is ImageElement => e.type === "image");
```

```ts
    for (const el of doc.elements) {
      if (el.type !== "image") continue;
```

両関数のコメントから「floor-plan 除く」「中央列」の記述を消す。

(c) `handleMove` / `handleResize` の `if (id === "floor-plan") { … }` 分岐と `commitFloorPlan` 関数を削除する(間取り図も普通の要素として動かす)。

(d) `handleElementPanelChange` の `if (editorState.selectedId === "floor-plan") { … }` ブロックを削除し、switch の delete を単純化:

```ts
        case "delete":
          return deleteElement(prev, id);
```

(e) `handleSetFloorPlan` / `handleUnsetFloorPlan` を次に置き換え、`handleDeleteFloorPlan` を削除する(実寸比の付け替えは reducer が行う):

```ts
  /** 選択中の写真を間取り図にする(**同期**・キャッシュ済みの実寸比で並べ直す)。 */
  function handleSetFloorPlan(): void {
    const id = editorState.selectedId;
    if (!id) return;
    const demotedId = safeRandomId();
    setEditorState((prev) =>
      prev.selectedId !== id ? prev : setAsFloorPlan(prev, id, demotedId, cachedGalleryAspects(prev.document)),
    );
  }

  /** 間取り図を通常の写真へ戻す(**同期**)。 */
  function handleUnsetFloorPlan(): void {
    const newId = safeRandomId();
    setEditorState((prev) =>
      prev.selectedId !== "floor-plan" ? prev : unsetFloorPlan(prev, newId, cachedGalleryAspects(prev.document)),
    );
  }
```

(f) `handleAutoBalance` のコメントの「中央列(間取り図)」を「写真と間取り図」に直す(処理は `autoArrangePhotos(autoBalanceLayout(prev), { aspects })` のまま)。

(g) 地図QR:

```ts
  /** 物件の場所を Google マップ検索する QR を、会社帯の右端に差し込む。 */
  const canAddMapQr = !!initial.propertyAddress && initial.propertyAddress.trim() !== "";
  function handleAddMapQr(): void {
    if (!canAddMapQr) return;
    setEditorState((prev) => addMapQrElement(prev, { address: initial.propertyAddress ?? "" }));
  }
```

(h) 警告: `layoutWarning` の計算を置き換える:

```ts
  const tableOverflowCount = useMemo(
    () => findTableOverflows(editorState.document).length,
    [editorState.document],
  );
  const layoutWarning =
    [
      textTableOverlapCount > 0
        ? `文字・表が重なっています(${textTableOverlapCount}箇所)。出力にもそのまま写るため、ドラッグで位置を調整してください`
        : null,
      tableOverflowCount > 0 ? TABLE_OVERFLOW_WARNING : null,
    ]
      .filter(Boolean)
      .join("／") || null;
```

コンポーネントの外(ファイル上部)に:

```ts
/** 表の文字が枠に入りきらないときの注意(仕様書 §4.8)。PDFには出さない。 */
const TABLE_OVERFLOW_WARNING = "表の文字が入りきっていません(項目を減らすか、枠を広げてください)";
```

(i) ツールバーへの props(「重なりを自動で直す」ボタンは重なりがあるときだけ出す=あふれ警告だけのときに誤って出さない):

```tsx
        onAddMapQr={handleAddMapQr}
        canAddMapQr={canAddMapQr && isConsumer}
        mapQrDisabledReason={!isConsumer ? LEGACY_TEMPLATE_NOTE : undefined}
        canAutoLayout={isConsumer}
        onOpenTransactionInfo={() => setTxInfoOpen(true)}
        canEditTransactionInfo={isConsumer && editorState.document.elements.some((e) => e.id === "footer-band")}
        transactionInfoDisabledReason={!isConsumer ? LEGACY_TEMPLATE_NOTE : undefined}
        layoutWarning={layoutWarning}
        onAutoFixOverlaps={textTableOverlapCount > 0 ? handleAutoFixOverlaps : undefined}
        autoFixNotice={autoFixNotice}
```

`isConsumer` は `layoutWarning` の近くで `const isConsumer = isConsumerTemplate(editorState.document);` と定義する。

- [ ] **Step 6: 合格を確認**

Run: `npx vitest run src/components/sales-sheet src/lib/sales-sheet && npx tsc --noEmit && npx eslint src/components/sales-sheet src/lib/sales-sheet`
Expected: 残る失敗は layout-engine.test.ts の旧計算テストのみ(Task 8)。tsc 0・eslint 0。

- [ ] **Step 7: Commit**

```bash
git add src/components/sales-sheet/editor/EditorToolbar.tsx src/components/sales-sheet/editor/ElementPanel.tsx src/components/sales-sheet/editor/SalesSheetEditor.tsx src/components/sales-sheet/editor/__tests__/editor-toolbar.test.tsx src/components/sales-sheet/editor/__tests__/element-panel.test.tsx
git commit -m "feat(sales-sheet): 編集画面の配線(旧ひな型のボタン停止・あふれ警告・3列の操作を削除)"
```

---

### Task 8: 旧い計算と会社帯を削除する

**Files:**
- Modify: `src/lib/sales-sheet/layout-engine.ts`(旧計算の削除)
- Modify: `src/lib/sales-sheet/footer-band.ts`(旧会社帯の削除)
- Test: `layout-engine.test.ts` / `footer-band.test.ts` / `footer-transaction.test.ts`(書き換え)

**Interfaces:**
- Produces(残す公開名): layout-engine=`Rect` / `PhotoCell` / `PHOTO_GAP_MM` / `packPhotoCells` / Task 3 の消費者向け一式。footer-band=`FooterBandData` / `readFooterData` / `footerDataEqual` / `CONSUMER_TEL_CTA` / `buildConsumerFooterBand` / `buildConsumerFooterTransactionElements`。

- [ ] **Step 1: テストを先に書き換える**

`layout-engine.test.ts`: `computeSpecSheetLayout` を使う describe(「3列構成」「computeSpecSheetLayout」)を削除し、`packPhotoCells` のテストだけ残す。残るテストが無ければファイルごと削除する。

`footer-band.test.ts`: import を `buildConsumerFooterBand` と `CONSUMER_FOOTER`(`../layout-engine`)に変え、`buildFooterBand(FOOTER, …)` をすべて `buildConsumerFooterBand(CONSUMER_FOOTER, …)` に置き換える。「会社ブロックの各文言を出す」「company を渡すとその会社名/連絡先が入る」「英字社名・保証協会・所属協会の要素は出力されない」は残す。旧い配分・区切り線・帯の枠線(`stroke`)・`BAND_FILL` を期待するテストは削除する(新しい帯の形は footer-band-consumer.test.ts が担う)。

`footer-transaction.test.ts`: `describe("footerColumnGeometry", …)` を削除。`buildFooterTransactionElements` / `buildFooterBand` / `FOOTER` を `buildConsumerFooterTransactionElements` / `buildConsumerFooterBand` / `CONSUMER_FOOTER` に置き換える。`footer-divider-*` を期待する行は削除。`readFooterData` / `footerDataEqual` のテストは残す。

- [ ] **Step 2: 旧コードを削除する**

`layout-engine.ts`: 次を削除する — `SpecSheetLayoutInput` / `SpecSheetLayout` / `DEFAULT_FOOTER_H` / `PAGE_H_MM` / `CATCH_BAND` / `CATCH_COPY` / `MAIN_TOP_MM` / `MAIN_BOTTOM_MARGIN_MM` / `SPLIT_X_MIN_MM` / `SPLIT_X_MAX_MM` / `SPLIT_X_PHOTO_COUNT_DIVISOR` / `COLUMN_GAP_MM` / `OVERVIEW_RIGHT_MM` / `PAGE_W_MM` / `OVERVIEW_MAX_WIDTH_MM` / `OVERVIEW_MIN_X_MM` / `OVERVIEW_X_OFFSET_MM` / `PHOTO_AREA_TO_OVERVIEW_GAP_MM` / `OVERVIEW_FONT_*` / `PHOTO_AREA_X_MM` / `PHOTO_AREA_Y_MM` / `HEADING_*` / `PRICE_*` / `LEFT_COLUMN_WIDTH_MARGIN_MM` / `SALES_POINTS_X_MM` / `SALES_POINTS_H_MM` / `SALES_POINTS_BOTTOM_OFFSET_MM` / `COMPANY_*` / `FLOOR_PLAN_MIDDLE_X_MM` / `lerp` / `clamp` / `computeSpecSheetLayout`。ファイル冒頭のコメントを「消費者向けひな型の座標計算と写真の敷き詰め」に直す。

`footer-band.ts`: 次を削除する — `NAVY` / `BAND_FILL` / `TABLE_BORDER_COLOR` / `COMPANY_W_RATIO` / `TERMS_W_RATIO` / `PAD_MM` / `GAP_MM` / `DIVIDER_W_MM` / `FRAME_STROKE_W_MM` / `GRID_LEFT_COL_W_MM` / `GRID_COL_GAP_MM` / `FONT_PT` / `mkText` / `mkDivider` / `footerColumnGeometry` / `buildFooterTransactionElements` / `buildFooterBand`。冒頭コメントを新しい帯(§4.6)の説明に直す。

- [ ] **Step 3: 残りが無いことを確かめる**

Run:
```bash
grep -rnE "computeSpecSheetLayout|buildFooterBand\b|buildFooterTransactionElements|footerColumnGeometry|OVERVIEW_MIN_X_MM|OVERVIEW_RIGHT_MM|FLOOR_PLAN_MIDDLE_X_MM|DEFAULT_FOOTER_H|positionMapQr|deleteMapQr|commitFloorPlanGeometry|defaultFloorPlanRect|snapOverviewInPlace|中央列" src
```
Expected: 出力なし(`buildConsumerFooterBand` は語の途中が違うので一致しない)

- [ ] **Step 4: フルテストと型**

Run: `npx vitest run && npx tsc --noEmit && npx eslint src/lib/sales-sheet src/components/sales-sheet`
Expected: すべて PASS・tsc 0・eslint 0

- [ ] **Step 5: Commit**

```bash
git add -A src/lib/sales-sheet src/components/sales-sheet
git diff --cached --stat
git commit -m "refactor(sales-sheet): 3列の計算と旧会社帯を削除"
```
(`--stat` に `Bin` が出たら中止して制御文字を調べる)

---

### Task 9: 実寸の見た目確認と最終ゲート

**Files:**
- Create: `scripts/sales-sheet-consumer-preview.ts`

- [ ] **Step 1: 見本を描くスクリプトを書く**

```ts
/**
 * 消費者向けひな型の実寸PNGを4種別ぶん描く(目視確認用・本番では使わない)。
 * 使い方: npx tsx scripts/sales-sheet-consumer-preview.ts <出力フォルダ>
 * 写真は色付きの仮画像を chromium で作って data: で埋め込む。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  buildSaleHouseDocument,
  buildSaleMansionDocument,
  buildSaleBuildingDocument,
  buildSaleLandDocument,
} from "../src/lib/sales-sheet/build-document";
import { renderDocumentToImage } from "../src/lib/sales-sheet/render-to-output";
import { findTableOverflows } from "../src/lib/sales-sheet/editor-document";
import type { SalesSheetDocument } from "../src/lib/sales-sheet/document-schema";

async function placeholders(specs: [label: string, w: number, h: number, color: string][]): Promise<{ fileUrl: string }[]> {
  const browser = await chromium.launch();
  try {
    const out: { fileUrl: string }[] = [];
    for (const [label, w, h, color] of specs) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      await page.setContent(
        `<body style="margin:0;width:${w}px;height:${h}px;background:${color};display:flex;align-items:center;justify-content:center;font:bold 32px sans-serif;color:#fff">${label}</body>`,
      );
      out.push({ fileUrl: `data:image/png;base64,${(await page.screenshot({ type: "png" })).toString("base64")}` });
      await page.close();
    }
    return out;
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const outDir = process.argv[2];
  if (!outDir) throw new Error("出力フォルダを指定してください");
  mkdirSync(outDir, { recursive: true });
  const photos = await placeholders([
    ["外観", 900, 600, "#5f7fa0"], ["リビング", 800, 600, "#a98865"], ["キッチン", 600, 800, "#6f9474"],
  ]);
  const [plan] = await placeholders([["間取り図", 700, 700, "#8f877b"]]);
  const footer = { transactionType: "専任媒介", compensation: "分かれ", adType: "広告可", staff: "山田" };
  const common = { photos, floorPlanImage: plan };

  const docs: [string, SalesSheetDocument][] = [
    ["house", buildSaleHouseDocument({
      ...common,
      property: { address: "東京都練馬区富士見台二丁目1-1", layoutType: "4LDK", zoningDistrict: "第一種中高層住居専用地域", buildingCoverageRatio: "60", floorAreaRatio: "200", roadType: "公道", roadWidth: "5.0", occupancyStatus: "occupied" },
      overrides: {
        propertyType: "中古戸建", price: "6980", tax: "課税", taxAmount: "180", access: "西武池袋線「富士見台」駅 徒歩6分(約450m)",
        landArea: "100.12", areaMethod: "公簿", landRight: "所有権", privateRoad: "なし", landCategory: ["宅地"],
        buildingArea: "98.54", floor1Area: "50.20", floor2Area: "48.34", structure: "木造", aboveFloors: "2", parking: "有",
        builtYearMonth: "2008年3月", roadDirections: ["東"], cityPlanning: ["市街化区域"], areaZone: ["準防火地域"],
        buildingConfirm: "確認済", rebuild: "再建築可", equipment: "都市ガス・本下水・追焚", delivery: "相談", remarks: "2019年 外壁塗装",
        catchCopy: "駅徒歩6分・南向き4LDK・駐車場付", salesPoints: ["東側公道で陽当たり良好", "2019年に外壁塗装済み", "小学校まで徒歩5分"], ...footer,
      },
    })],
    ["mansion", buildSaleMansionDocument({
      ...common,
      property: { address: "東京都練馬区平和台一丁目2-3", roomNo: "503", exclusiveArea: "67.21", balconyArea: "9.80", layoutType: "3LDK", floorNo: 5, orientation: "南", managementFee: 12800, repairReserveFee: 15600, zoningDistrict: "近隣商業地域", occupancyStatus: "vacant" },
      building: { name: "平和台パークハウス", totalFloors: 11, builtYear: 2003, structureType: "RC", managementCompany: "〇〇管理", totalUnits: 48 },
      overrides: { propertyType: "中古マンション", price: "3980", access: "東京メトロ有楽町線「平和台」駅 徒歩5分", builtYearMonth: "2003年4月", parking: "空無", delivery: "即時", catchCopy: "駅徒歩5分・南向き3LDK", salesPoints: ["南向きバルコニー", "2022年に水回りリフォーム", "ペット飼育可"], ...footer },
    })],
    ["building", buildSaleBuildingDocument({
      ...common,
      property: { address: "東京都板橋区成増四丁目5-6", zoningDistrict: "第一種住居地域", buildingCoverageRatio: "60", floorAreaRatio: "200", roadType: "公道", roadWidth: "6.0", occupancyStatus: "occupied" },
      overrides: { propertyType: "一棟マンション", price: "18800", access: "東武東上線「成増」駅 徒歩9分", landArea: "165.28", areaMethod: "実測", totalFloorArea: "312.40", structure: "軽量鉄骨造", aboveFloors: "3", builtYearMonth: "1998年11月", totalUnits: "12", grossYield: "7.85", expectedIncome: "1476", catchCopy: "満室稼働中・想定利回り7.85%", salesPoints: ["全12戸 満室", "駅徒歩9分", "2021年 屋上防水"], ...footer },
    })],
    ["land", buildSaleLandDocument({
      ...common,
      property: { address: "東京都世田谷区上馬四丁目7-8", zoningDistrict: "第一種低層住居専用地域", buildingCoverageRatio: "50", floorAreaRatio: "100", roadType: "公道", roadWidth: "4.0", occupancyStatus: "vacant" },
      overrides: { propertyType: "売地", price: "8200", unitPrice: "210", access: "東急田園都市線「駒沢大学」駅 徒歩8分", landArea: "130.50", areaMethod: "実測", landCategory: ["宅地"], roadDirections: ["南"], buildCondition: "なし", delivery: "相談", catchCopy: "南道路・整形地", salesPoints: ["南道路で陽当たり良好", "建築条件なし", "整形地"], ...footer },
    })],
  ];

  for (const [name, doc] of docs) {
    writeFileSync(join(outDir, `${name}.png`), await renderDocumentToImage(doc, "png"));
    console.log(`${name}: overflow=${JSON.stringify(findTableOverflows(doc))}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

注: 各 `Sale*Input` の型に無いキーで tsc が落ちたら、そのキーを消す(見本の中身は目視用なので減ってよい)。

- [ ] **Step 2: 描いて目で確かめる**

Run: `npx tsx scripts/sales-sheet-consumer-preview.ts "<scratchpad>/sales-sheet-preview"`
Expected: 4行の `overflow=[]`(house が詳細の多さで `["overview-detail-a"]` 等を返した場合は、PNG で実際に切れているかを見て判断し、発注者への提示時に明記する)

4枚の PNG を Read で開き、見本(案3・https://claude.ai/code/artifact/732e18ab-be03-4dd5-9ecf-554d9848ffb5 )と比べて次を確認する:
- 紺の帯・白いキャッチ・右上の物件種目
- 左に写真3枚+間取り図が重ならず並ぶ
- 右に物件名・赤い価格・主要表(1行おきに淡い紺・線なし)・詳細表2列(線なし)
- ポイント帯・会社帯(取引表に線なし・電話番号が大きい)
- 文字の切れ・はみ出しがない

崩れがあれば該当タスクの定数を直し、テストを通してからコミットする。

- [ ] **Step 3: 発注者に見せる**

4枚を data: 埋め込みの HTML 1ページにまとめ、artifact-design スキルを読んでから Artifact で公開し、URL を発注者に伝える(PC で見る前提・画像は横並びでなく縦に大きく)。

- [ ] **Step 4: 最終ゲート**

Run:
```bash
npx vitest run
npx tsc --noEmit
npx eslint
npm run build
git diff --stat origin/main...HEAD | grep -c " Bin " || true
```
Expected: vitest 全 PASS(件数を控える)・tsc 0・eslint 0・build 成功・`Bin` 0件

- [ ] **Step 5: 提出前の点検と Commit**

`feature-dev:code-reviewer` に「旧ひな型の停止漏れ(自動整列/自動調整/写真追加/取引情報/地図QR)」「作成直後に自動調整が同一参照になるか」「表の見積もりの未指定時が不変か」「両レンダラの表の出力一致」を重点に点検を依頼し、実在する指摘だけ直す。

```bash
git add scripts/sales-sheet-consumer-preview.ts
git commit -m "chore(sales-sheet): 消費者向けひな型の実寸PNG見本スクリプト"
```

---

## 反映(このPRのマージ後・別承認)

1. PR 作成と @codex レビューは ship / codex-triage スキルに従う(PR番号ではなく機能名で説明)。
2. 本番反映は vps-deploy スキルに従う。**書体の導入はサーバー変更なので、反映の承認とは別に発注者の承認を取ってから**行う:
   ```bash
   apt-get install -y fonts-morisawa-bizud-gothic
   fc-cache -f
   fc-match "BIZ UDPGothic"
   ```
   Expected: `fc-match` の出力に `BIZ UDPGothic` を含む。PDF は出力のたびに chromium を起動するため、導入後の再起動は不要(反映手順の restart はそのまま行う)。
3. 実機確認(発注者): 新しい図面を1枚作る → 紺・線なし・文字サイズ → PDF の字が BIZ UDPゴシック → 写真と間取り図を足して「写真を自動整列」 → 「地図QRを追加」で会社帯の右端 → 旧図面(2件)を開くと自動機能のボタンが無効で説明が出る。
4. 反映後、実機確認項目を [[field-check-pending]] と Artifact 2本に追記する。
