# 販売図面エディタ — Plan 1: Render core 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ドキュメントモデル（構造化JSON）→ 共通Reactレンダラ → HTML → ヘッドレスブラウザで PDF/画像、という「見たまま出力（WYSIWYG）」の核を最初に成立させる。

**Architecture:** 1つの `SalesSheetDocument`（page+theme+elements）を中心に据え、ブラウザ・サーバー共通の `SalesSheetRenderer`（HTML/CSS・絶対配置）で描画する。サーバー出力は `renderToStaticMarkup` で同じコンポーネントツリーをHTML化し、既存 playwright(chromium) で `page.pdf()` / `page.screenshot()` する。後続PlanのエディタUIは同じRendererの上にオーバーレイを載せるため、画面と出力が構造的に一致する。

**Tech Stack:** TypeScript / React 19 / `react-dom/server` / zod（いずれも既存）/ playwright（既存・registryで使用中）/ Vitest（co-located `__tests__/`）。

## Global Constraints
- A4横(landscape 297mm×210mm) を既定とする。
- レンダラは HTML/CSS で、ブラウザ・プレビューとサーバー出力で共通（`renderToStaticMarkup`）＝WYSIWYG を保証する。
- 幾何はすべて **mm**（x/y/w/h/page.width/page.height）。フォントサイズのみ **pt**。z は重ね順の整数。
- Plan 1 で **新規 npm 依存を追加しない**（zod/react/react-dom/playwright は既存）。
- Plan 1 で **Prisma migration を行わない**（DB 不使用）。
- chromium 実体の導入（`npx playwright install chromium`）は ops/deploy 工程（ユーザー承認）。テストは未導入環境では skip してCIを緑に保つ。
- ログに PII や blob key を出さない。

## Plan roadmap
- **Plan 1 — Render core**（本書）: document model + zod / 共通Reactレンダラ / render-html / 出力エンジン(PDF・画像) / fixture + e2e。
- Plan 2 — データ自動取り込み + 売土地テンプレ + generate route（物件→初期document、`POST /api/properties/[id]/sales-sheets/preview`）。
- Plan 3 — 保存(SalesSheetDesign・migration) + エディタ外枠（自由配置：選択/移動/拡縮/重ね順）。
- Plan 4 — 写真管理（枚数自由・アップロード/既存選択/トリミング/パノラマ判定）。
- Plan 5 — テンプレ・ギャラリー（売マンション/売戸建/一棟、SalesSheetTemplate）。
- Plan 6 — スマート自動レイアウト（プロトタイプ先行→本実装、ゾーン+制約）。
- Plan 7 — バッジ・デザイナー（BadgePreset・アイコンセット）。
- Plan 8 — QR + テーマ色 + 表示項目切替 + 仕上げ（権限/導線/出力ダウンロード）。

---

### Task 1: ドキュメントモデル & zod スキーマ

**Files:**
- Create: `src/lib/sales-sheet/document-schema.ts`
- Test: `src/lib/sales-sheet/__tests__/document-schema.test.ts`

**Interfaces:**
- Produces:
  - `salesSheetDocumentSchema: z.ZodType<SalesSheetDocument>`（実体は z.object）
  - `parseSalesSheetDocument(input: unknown): SalesSheetDocument`
  - 型: `SalesSheetDocument`, `SalesSheetElement`, `SalesSheetPage`, `SalesSheetTheme`, `TextElement`, `ImageElement`, `TableElement`, `BadgeElement`, `ShapeElement`, `QrElement`
  - 定数: `A4_LANDSCAPE: SalesSheetPage`, `A4_PORTRAIT: SalesSheetPage`
- Consumes: なし（純データ・zod のみ）

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/sales-sheet/__tests__/document-schema.test.ts
import { describe, it, expect } from "vitest";
import {
  parseSalesSheetDocument,
  salesSheetDocumentSchema,
  A4_LANDSCAPE,
} from "../document-schema";

describe("salesSheetDocumentSchema", () => {
  it("最小の有効documentを受理し、styleの既定({})を補完する", () => {
    const doc = parseSalesSheetDocument({
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#1f4e79" },
      elements: [
        { id: "t1", type: "text", x: 10, y: 10, w: 50, h: 8, z: 1, content: "価格" },
      ],
    });
    expect(doc.page.width).toBe(297);
    expect(doc.elements).toHaveLength(1);
    const el = doc.elements[0];
    expect(el.type).toBe("text");
    if (el.type === "text") expect(el.style).toEqual({});
  });

  it("未知の type を拒否する", () => {
    const r = salesSheetDocumentSchema.safeParse({
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [{ id: "x", type: "bogus", x: 0, y: 0, w: 1, h: 1, z: 0 }],
    });
    expect(r.success).toBe(false);
  });

  it("w/h が 0 以下なら拒否する", () => {
    const r = salesSheetDocumentSchema.safeParse({
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [{ id: "t", type: "text", x: 0, y: 0, w: 0, h: 5, z: 0, content: "x" }],
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/document-schema.test.ts`
Expected: FAIL（`Cannot find module '../document-schema'`）

- [ ] **Step 3: 最小実装**

```ts
// src/lib/sales-sheet/document-schema.ts
import { z } from "zod";

/** 幾何は mm。フォントサイズのみ pt。z は重ね順(整数)。 */
const baseElement = {
  id: z.string().min(1),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  z: z.number().int(),
};

export const textElementSchema = z.object({
  ...baseElement,
  type: z.literal("text"),
  content: z.string(),
  style: z
    .object({
      fontSizePt: z.number().positive().optional(),
      fontFamily: z.string().optional(),
      color: z.string().optional(),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      underline: z.boolean().optional(),
      align: z.enum(["left", "center", "right"]).optional(),
      lineHeight: z.number().positive().optional(),
    })
    .default({}),
});

export const imageElementSchema = z.object({
  ...baseElement,
  type: z.literal("image"),
  src: z.string().min(1),
  fit: z.enum(["cover", "contain"]).default("cover"),
  radiusMm: z.number().nonnegative().optional(),
  alt: z.string().optional(),
});

export const tableElementSchema = z.object({
  ...baseElement,
  type: z.literal("table"),
  rows: z.array(z.object({ label: z.string(), value: z.string() })),
  style: z
    .object({
      fontSizePt: z.number().positive().optional(),
      labelColor: z.string().optional(),
      valueColor: z.string().optional(),
      borderColor: z.string().optional(),
    })
    .default({}),
});

export const badgeElementSchema = z.object({
  ...baseElement,
  type: z.literal("badge"),
  label: z.string(),
  shape: z.enum(["rounded", "pill", "ribbon"]).default("rounded"),
  bg: z.string(),
  fg: z.string(),
  fontSizePt: z.number().positive().optional(),
});

export const shapeElementSchema = z.object({
  ...baseElement,
  type: z.literal("shape"),
  shape: z.enum(["rect", "line"]).default("rect"),
  fill: z.string().optional(),
  stroke: z.string().optional(),
  strokeWidthMm: z.number().nonnegative().optional(),
  radiusMm: z.number().nonnegative().optional(),
});

export const qrElementSchema = z.object({
  ...baseElement,
  type: z.literal("qr"),
  /** 生成済みQR画像の data URL（生成は後続Plan）。 */
  dataUrl: z.string().min(1),
});

export const elementSchema = z.discriminatedUnion("type", [
  textElementSchema,
  imageElementSchema,
  tableElementSchema,
  badgeElementSchema,
  shapeElementSchema,
  qrElementSchema,
]);

export const pageSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  orientation: z.enum(["landscape", "portrait"]),
});

export const themeSchema = z.object({
  fontFamily: z.string(),
  accentColor: z.string(),
});

export const salesSheetDocumentSchema = z.object({
  page: pageSchema,
  theme: themeSchema,
  elements: z.array(elementSchema),
});

export type TextElement = z.infer<typeof textElementSchema>;
export type ImageElement = z.infer<typeof imageElementSchema>;
export type TableElement = z.infer<typeof tableElementSchema>;
export type BadgeElement = z.infer<typeof badgeElementSchema>;
export type ShapeElement = z.infer<typeof shapeElementSchema>;
export type QrElement = z.infer<typeof qrElementSchema>;
export type SalesSheetElement = z.infer<typeof elementSchema>;
export type SalesSheetPage = z.infer<typeof pageSchema>;
export type SalesSheetTheme = z.infer<typeof themeSchema>;
export type SalesSheetDocument = z.infer<typeof salesSheetDocumentSchema>;

/** A4 横（既定）/ A4 縦。 */
export const A4_LANDSCAPE: SalesSheetPage = { width: 297, height: 210, orientation: "landscape" };
export const A4_PORTRAIT: SalesSheetPage = { width: 210, height: 297, orientation: "portrait" };

export function parseSalesSheetDocument(input: unknown): SalesSheetDocument {
  return salesSheetDocumentSchema.parse(input);
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/document-schema.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: コミット**

```bash
git add src/lib/sales-sheet/document-schema.ts src/lib/sales-sheet/__tests__/document-schema.test.ts
git commit -m "feat(sales-sheet): ドキュメントモデル + zodスキーマ (Plan1 Task1)"
```

---

### Task 2: サンプル fixture

**Files:**
- Create: `src/lib/sales-sheet/__fixtures__/sample-document.ts`
- Test: `src/lib/sales-sheet/__tests__/sample-document.test.ts`

**Interfaces:**
- Consumes: `SalesSheetDocument`, `A4_LANDSCAPE`（Task 1）
- Produces: `sampleDocument: SalesSheetDocument`（後続テストの共通fixture。画像は data URL でオフライン）

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/sales-sheet/__tests__/sample-document.test.ts
import { describe, it, expect } from "vitest";
import { salesSheetDocumentSchema } from "../document-schema";
import { sampleDocument } from "../__fixtures__/sample-document";

describe("sampleDocument fixture", () => {
  it("スキーマに適合する", () => {
    expect(salesSheetDocumentSchema.safeParse(sampleDocument).success).toBe(true);
  });
  it("text/image/table/badge を含む", () => {
    const types = sampleDocument.elements.map((e) => e.type);
    expect(types).toContain("text");
    expect(types).toContain("image");
    expect(types).toContain("table");
    expect(types).toContain("badge");
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/sample-document.test.ts`
Expected: FAIL（`Cannot find module '../__fixtures__/sample-document'`）

- [ ] **Step 3: 最小実装**

```ts
// src/lib/sales-sheet/__fixtures__/sample-document.ts
import { A4_LANDSCAPE, type SalesSheetDocument } from "../document-schema";

/** 1x1 透明 PNG（オフライン描画用。外部ネットワーク不要）。 */
const TRANSPARENT_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Plan 1 検証用のサンプル図面（ダミー・実データではない）。 */
export const sampleDocument: SalesSheetDocument = {
  page: A4_LANDSCAPE,
  theme: { fontFamily: '"Yu Gothic UI","Meiryo",sans-serif', accentColor: "#1f4e79" },
  elements: [
    {
      id: "title", type: "text", x: 10, y: 8, w: 180, h: 12, z: 2,
      content: "グランドメゾン上馬 101号室",
      style: { fontSizePt: 18, bold: true, color: "#15324f" },
    },
    {
      id: "price", type: "text", x: 10, y: 24, w: 120, h: 14, z: 2,
      content: "3,480万円",
      style: { fontSizePt: 28, bold: true, color: "#d0331a" },
    },
    {
      id: "badge1", type: "badge", x: 10, y: 40, w: 28, h: 7, z: 3,
      label: "リノベ済", shape: "pill", bg: "#0e9f6e", fg: "#ffffff", fontSizePt: 8,
    },
    {
      id: "photo1", type: "image", x: 10, y: 50, w: 120, h: 80, z: 1,
      src: TRANSPARENT_PNG, fit: "cover", radiusMm: 2, alt: "リビング",
    },
    {
      id: "overview", type: "table", x: 200, y: 50, w: 90, h: 120, z: 1,
      rows: [
        { label: "所在地", value: "東京都世田谷区上馬４丁目" },
        { label: "専有面積", value: "62.45㎡（壁芯）" },
        { label: "間取り", value: "2LDK" },
        { label: "築年月", value: "2008年3月" },
      ],
      style: { fontSizePt: 8, borderColor: "#cccccc" },
    },
  ],
};
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/sample-document.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: コミット**

```bash
git add src/lib/sales-sheet/__fixtures__/sample-document.ts src/lib/sales-sheet/__tests__/sample-document.test.ts
git commit -m "feat(sales-sheet): 検証用サンプルfixture (Plan1 Task2)"
```

---

### Task 3: 共通 React レンダラ `SalesSheetRenderer`

**Files:**
- Create: `src/components/sales-sheet/SalesSheetRenderer.tsx`
- Test: `src/components/sales-sheet/__tests__/SalesSheetRenderer.test.tsx`

**Interfaces:**
- Consumes: `SalesSheetDocument` 系型（Task 1）、`sampleDocument`（Task 2）
- Produces: `SalesSheetRenderer(props: { document: SalesSheetDocument }): JSX.Element`（default export も同じ）。"use client" を付けない（サーバー描画に使うため純コンポーネント）。

- [ ] **Step 1: 失敗するテストを書く**

```tsx
// src/components/sales-sheet/__tests__/SalesSheetRenderer.test.tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SalesSheetRenderer } from "../SalesSheetRenderer";
import { sampleDocument } from "@/lib/sales-sheet/__fixtures__/sample-document";

describe("SalesSheetRenderer", () => {
  it("ページを relative・mm 寸法で描画する", () => {
    const html = renderToStaticMarkup(<SalesSheetRenderer document={sampleDocument} />);
    expect(html).toContain("position:relative");
    expect(html).toContain("width:297mm");
    expect(html).toContain("height:210mm");
  });

  it("各要素を絶対配置(mm)し、内容を含む", () => {
    const html = renderToStaticMarkup(<SalesSheetRenderer document={sampleDocument} />);
    expect(html).toContain("position:absolute");
    expect(html).toContain("left:10mm");
    expect(html).toContain("3,480万円");
    expect(html).toContain("リノベ済");
    expect(html).toContain("所在地");
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run src/components/sales-sheet/__tests__/SalesSheetRenderer.test.tsx`
Expected: FAIL（`Cannot find module '../SalesSheetRenderer'`）

- [ ] **Step 3: 最小実装**

```tsx
// src/components/sales-sheet/SalesSheetRenderer.tsx
import type { CSSProperties } from "react";
import type {
  SalesSheetDocument,
  SalesSheetElement,
  TextElement,
  ImageElement,
  TableElement,
  BadgeElement,
  ShapeElement,
  QrElement,
} from "@/lib/sales-sheet/document-schema";

const mm = (v: number) => `${v}mm`;

function boxStyle(el: SalesSheetElement): CSSProperties {
  return {
    position: "absolute",
    left: mm(el.x),
    top: mm(el.y),
    width: mm(el.w),
    height: mm(el.h),
    zIndex: el.z,
    overflow: "hidden",
    boxSizing: "border-box",
  };
}

function TextEl({ el }: { el: TextElement }) {
  const s = el.style;
  const style: CSSProperties = {
    ...boxStyle(el),
    fontSize: s.fontSizePt ? `${s.fontSizePt}pt` : undefined,
    fontFamily: s.fontFamily,
    color: s.color,
    fontWeight: s.bold ? 700 : undefined,
    fontStyle: s.italic ? "italic" : undefined,
    textDecoration: s.underline ? "underline" : undefined,
    textAlign: s.align,
    lineHeight: s.lineHeight,
    whiteSpace: "pre-wrap",
  };
  return <div style={style}>{el.content}</div>;
}

function ImageEl({ el }: { el: ImageElement }) {
  return (
    <div style={{ ...boxStyle(el), borderRadius: el.radiusMm ? mm(el.radiusMm) : undefined }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={el.src}
        alt={el.alt ?? ""}
        style={{ width: "100%", height: "100%", objectFit: el.fit, display: "block" }}
      />
    </div>
  );
}

function TableEl({ el }: { el: TableElement }) {
  const s = el.style;
  const border = `0.2mm solid ${s.borderColor ?? "#cccccc"}`;
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
        {el.rows.map((r, i) => (
          <tr key={i}>
            <td style={{ border, color: s.labelColor, padding: "0.5mm 1mm", width: "32%", fontWeight: 600, verticalAlign: "top" }}>
              {r.label}
            </td>
            <td style={{ border, color: s.valueColor, padding: "0.5mm 1mm", verticalAlign: "top" }}>
              {r.value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BadgeEl({ el }: { el: BadgeElement }) {
  const radius = el.shape === "pill" ? "999px" : el.shape === "rounded" ? "2mm" : "0";
  const style: CSSProperties = {
    ...boxStyle(el),
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: el.bg,
    color: el.fg,
    borderRadius: radius,
    fontWeight: 700,
    fontSize: el.fontSizePt ? `${el.fontSizePt}pt` : undefined,
    clipPath: el.shape === "ribbon" ? "polygon(0 0,100% 0,92% 50%,100% 100%,0 100%)" : undefined,
  };
  return <div style={style}>{el.label}</div>;
}

function ShapeEl({ el }: { el: ShapeElement }) {
  if (el.shape === "line") {
    return (
      <div
        style={{ ...boxStyle(el), background: el.stroke ?? "#000000", height: el.strokeWidthMm ? mm(el.strokeWidthMm) : "0.3mm" }}
      />
    );
  }
  return (
    <div
      style={{
        ...boxStyle(el),
        background: el.fill,
        border: el.stroke ? `${el.strokeWidthMm ?? 0.3}mm solid ${el.stroke}` : undefined,
        borderRadius: el.radiusMm ? mm(el.radiusMm) : undefined,
      }}
    />
  );
}

function QrEl({ el }: { el: QrElement }) {
  return (
    <div style={boxStyle(el)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={el.dataUrl} alt="QR" style={{ width: "100%", height: "100%", display: "block" }} />
    </div>
  );
}

function ElementView({ el }: { el: SalesSheetElement }) {
  switch (el.type) {
    case "text":
      return <TextEl el={el} />;
    case "image":
      return <ImageEl el={el} />;
    case "table":
      return <TableEl el={el} />;
    case "badge":
      return <BadgeEl el={el} />;
    case "shape":
      return <ShapeEl el={el} />;
    case "qr":
      return <QrEl el={el} />;
  }
}

export function SalesSheetRenderer({ document: doc }: { document: SalesSheetDocument }) {
  const pageStyle: CSSProperties = {
    position: "relative",
    width: mm(doc.page.width),
    height: mm(doc.page.height),
    background: "#ffffff",
    fontFamily: doc.theme.fontFamily,
    overflow: "hidden",
  };
  return (
    <div data-sales-sheet-page style={pageStyle}>
      {doc.elements.map((el) => (
        <ElementView key={el.id} el={el} />
      ))}
    </div>
  );
}

export default SalesSheetRenderer;
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx vitest run src/components/sales-sheet/__tests__/SalesSheetRenderer.test.tsx`
Expected: PASS（2 tests）

- [ ] **Step 5: コミット**

```bash
git add src/components/sales-sheet/SalesSheetRenderer.tsx src/components/sales-sheet/__tests__/SalesSheetRenderer.test.tsx
git commit -m "feat(sales-sheet): 共通Reactレンダラ SalesSheetRenderer (Plan1 Task3)"
```

---

### Task 4: `renderDocumentToHtml`（完全HTML文書化）

**Files:**
- Create: `src/lib/sales-sheet/render-html.ts`
- Test: `src/lib/sales-sheet/__tests__/render-html.test.ts`

**Interfaces:**
- Consumes: `SalesSheetRenderer`（Task 3）、`SalesSheetDocument`（Task 1）、`sampleDocument`（Task 2）
- Produces: `renderDocumentToHtml(doc: SalesSheetDocument): string`（`<!doctype html>` から始まる完全文書。`@page` 寸法 = page と一致）

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/sales-sheet/__tests__/render-html.test.ts
import { describe, it, expect } from "vitest";
import { renderDocumentToHtml } from "../render-html";
import { sampleDocument } from "../__fixtures__/sample-document";

describe("renderDocumentToHtml", () => {
  it("完全なHTML文書を返す", () => {
    const html = renderDocumentToHtml(sampleDocument);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("</html>");
    expect(html).toContain('charset="utf-8"');
  });

  it("ページ寸法(@page)と要素内容を含む", () => {
    const html = renderDocumentToHtml(sampleDocument);
    expect(html).toContain("@page");
    expect(html).toContain("size:297mm 210mm");
    expect(html).toContain("3,480万円");
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/render-html.test.ts`
Expected: FAIL（`Cannot find module '../render-html'`）

- [ ] **Step 3: 最小実装**

```ts
// src/lib/sales-sheet/render-html.ts
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SalesSheetRenderer } from "@/components/sales-sheet/SalesSheetRenderer";
import type { SalesSheetDocument } from "./document-schema";

/**
 * document を、ブラウザ・サーバー共通の Renderer で完全なHTML文書に描画する。
 * 画面プレビューと出力を同一描画にして WYSIWYG を保証する。
 */
export function renderDocumentToHtml(doc: SalesSheetDocument): string {
  const body = renderToStaticMarkup(createElement(SalesSheetRenderer, { document: doc }));
  const css = [
    "*{margin:0;padding:0;box-sizing:border-box}",
    `html,body{width:${doc.page.width}mm;height:${doc.page.height}mm}`,
    `body{font-family:${doc.theme.fontFamily}}`,
    `@page{size:${doc.page.width}mm ${doc.page.height}mm;margin:0}`,
  ].join("");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/render-html.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: コミット**

```bash
git add src/lib/sales-sheet/render-html.ts src/lib/sales-sheet/__tests__/render-html.test.ts
git commit -m "feat(sales-sheet): renderDocumentToHtml (Plan1 Task4)"
```

---

### Task 5: 出力エンジン（playwright で PDF/画像）

**Files:**
- Create: `src/lib/sales-sheet/output.ts`
- Test: `src/lib/sales-sheet/__tests__/output.test.ts`

**Interfaces:**
- Consumes: `playwright` の `chromium`（既存依存）
- Produces:
  - `isChromiumAvailable(): boolean`
  - `renderHtmlToPdf(html: string, opts?: { widthMm?: number; heightMm?: number }): Promise<Buffer>`（既定 297×210mm）
  - `renderHtmlToImage(html: string, opts?: { format?: "png" | "jpeg" }): Promise<Buffer>`（既定 png）

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/sales-sheet/__tests__/output.test.ts
import { describe, it, expect } from "vitest";
import { isChromiumAvailable, renderHtmlToPdf, renderHtmlToImage } from "../output";

describe("output engine", () => {
  it("isChromiumAvailable は boolean を返す", () => {
    expect(typeof isChromiumAvailable()).toBe("boolean");
  });

  it.skipIf(!isChromiumAvailable())(
    "HTML→PDF / PNG のバッファを生成する",
    async () => {
      const html =
        '<!doctype html><html><body><div style="width:100mm;height:50mm;background:#eef">hello 図面</div></body></html>';
      const pdf = await renderHtmlToPdf(html, { widthMm: 100, heightMm: 50 });
      expect(pdf.length).toBeGreaterThan(0);
      expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      const png = await renderHtmlToImage(html, { format: "png" });
      expect(png.length).toBeGreaterThan(0);
    },
    60_000,
  );
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/output.test.ts`
Expected: FAIL（`Cannot find module '../output'`）。chromium 未導入環境では2件目は skip され、1件目で失敗する。

- [ ] **Step 3: 最小実装**

```ts
// src/lib/sales-sheet/output.ts
import { existsSync } from "node:fs";
import { chromium, type Page } from "playwright";

/** chromium 実体が導入済みか（未導入環境では出力テストを skip するために使う）。 */
export function isChromiumAvailable(): boolean {
  try {
    const p = chromium.executablePath();
    return !!p && existsSync(p);
  } catch {
    return false;
  }
}

async function withPage<T>(html: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    return await fn(page);
  } finally {
    await browser.close();
  }
}

export async function renderHtmlToPdf(
  html: string,
  opts: { widthMm?: number; heightMm?: number } = {},
): Promise<Buffer> {
  const width = `${opts.widthMm ?? 297}mm`;
  const height = `${opts.heightMm ?? 210}mm`;
  return withPage(html, (page) =>
    page.pdf({ width, height, printBackground: true, pageRanges: "1" }),
  );
}

export async function renderHtmlToImage(
  html: string,
  opts: { format?: "png" | "jpeg" } = {},
): Promise<Buffer> {
  const type = opts.format ?? "png";
  return withPage(html, (page) => page.screenshot({ type, fullPage: true }));
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/output.test.ts`
Expected: PASS（chromium 導入済みなら 2 件 PASS。未導入なら 1 件 PASS + 1 件 skipped）

- [ ] **Step 5: コミット**

```bash
git add src/lib/sales-sheet/output.ts src/lib/sales-sheet/__tests__/output.test.ts
git commit -m "feat(sales-sheet): 出力エンジン(playwright PDF/画像) (Plan1 Task5)"
```

---

### Task 6: document 直結の便利関数 + e2e（fixture→PDF/PNG）

**Files:**
- Create: `src/lib/sales-sheet/render-to-output.ts`
- Test: `src/lib/sales-sheet/__tests__/render-core.e2e.test.ts`

**Interfaces:**
- Consumes: `renderDocumentToHtml`（Task 4）、`renderHtmlToPdf`/`renderHtmlToImage`/`isChromiumAvailable`（Task 5）、`sampleDocument`（Task 2）
- Produces:
  - `renderDocumentToPdf(doc: SalesSheetDocument): Promise<Buffer>`（page 寸法を自動適用）
  - `renderDocumentToImage(doc: SalesSheetDocument, format?: "png" | "jpeg"): Promise<Buffer>`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/sales-sheet/__tests__/render-core.e2e.test.ts
import { describe, it, expect } from "vitest";
import { isChromiumAvailable } from "../output";
import { renderDocumentToPdf, renderDocumentToImage } from "../render-to-output";
import { sampleDocument } from "../__fixtures__/sample-document";

describe("sales-sheet render core (e2e)", () => {
  it.skipIf(!isChromiumAvailable())(
    "fixture → PDF と PNG を生成する",
    async () => {
      const pdf = await renderDocumentToPdf(sampleDocument);
      expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(pdf.length).toBeGreaterThan(1000);

      const png = await renderDocumentToImage(sampleDocument, "png");
      expect(png.length).toBeGreaterThan(1000);
    },
    60_000,
  );
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/render-core.e2e.test.ts`
Expected: FAIL（`Cannot find module '../render-to-output'`）。chromium 未導入なら本体は skip だが import 解決で失敗する。

- [ ] **Step 3: 最小実装**

```ts
// src/lib/sales-sheet/render-to-output.ts
import { renderDocumentToHtml } from "./render-html";
import { renderHtmlToPdf, renderHtmlToImage } from "./output";
import type { SalesSheetDocument } from "./document-schema";

/** document → HTML → PDF（page 寸法を自動適用）。 */
export async function renderDocumentToPdf(doc: SalesSheetDocument): Promise<Buffer> {
  return renderHtmlToPdf(renderDocumentToHtml(doc), {
    widthMm: doc.page.width,
    heightMm: doc.page.height,
  });
}

/** document → HTML → 画像。 */
export async function renderDocumentToImage(
  doc: SalesSheetDocument,
  format: "png" | "jpeg" = "png",
): Promise<Buffer> {
  return renderHtmlToImage(renderDocumentToHtml(doc), { format });
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/render-core.e2e.test.ts`
Expected: PASS（chromium 導入済みなら 1 件 PASS。未導入なら skipped）

- [ ] **Step 5: 全ゲートを通す**

Run（順に）:
- `npx vitest run src/lib/sales-sheet src/components/sales-sheet`
- `npx tsc --noEmit`
- `npx eslint src/lib/sales-sheet src/components/sales-sheet`
- `npm run build`

Expected: いずれも成功（tsc 0 / eslint 0 / build OK / vitest green）。

- [ ] **Step 6: コミット**

```bash
git add src/lib/sales-sheet/render-to-output.ts src/lib/sales-sheet/__tests__/render-core.e2e.test.ts
git commit -m "feat(sales-sheet): document直結の出力 + e2e (Plan1 Task6)"
```

---

## Self-Review（記入済み）
- **Spec coverage（Plan 1 範囲）**: §4 共通レンダラ→Task3 / §12 出力(PDF・画像)→Task5,6 / §16 HTML/CSS方針→Task3,4 / WYSIWYG（同一レンダラ）→Task4で renderToStaticMarkup 共有 / §17-3 chromium 未導入対応→Task5 skipIf。データ自動取込・エディタ・API・永続化は Plan 2+（範囲外）。
- **Placeholder scan**: TODO/「適切に」等なし。各 step に完全コードと実コマンドを記載。
- **Type consistency**: `SalesSheetDocument` / `*Element` / `A4_LANDSCAPE` / `renderDocumentToHtml` / `renderHtmlToPdf` / `renderHtmlToImage` / `isChromiumAvailable` / `renderDocumentToPdf` / `renderDocumentToImage` を全タスクで一貫使用。レンダラの prop は `document`。
- **既定/単位**: 幾何 mm・フォント pt・A4横既定で全タスク統一。

## 前提・リスク（実装時の注意）
- 単位は mm（幾何）/ pt（フォント）。CSS は mm/pt をそのまま使用、playwright `page.pdf` も mm 指定。
- fixture の画像は data URL（オフライン）。`setContent` の `networkidle` がネット待ちで止まらない。
- chromium 未導入環境では出力系テストを `it.skipIf` で skip（CI 緑維持）。本番出力には `npx playwright install chromium`（ops・ユーザー承認・反映時）。
- レンダラは "use client" を付けない（サーバー描画に使うため）。エディタ化（クライアント操作）は Plan 3 でラッパー側に持たせる。
- 日本語フォント忠実性：プレビューと出力で同一フォント。サーバーに日本語フォント未導入だと出力で字形差が出るため、反映時にフォント導入（Plan 8/ops）。
