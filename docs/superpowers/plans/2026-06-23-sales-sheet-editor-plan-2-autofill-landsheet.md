# 販売図面エディタ — Plan 2: 自動取込 + 売土地テンプレ + 生成導線 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 実在物件のDBデータ＋写真から「売土地」販売図面を自動生成し、**PDFでダウンロード**できる最初の“使える”機能を提供する。あわせて Plan 1 で繰り越した「生HTML SSRF」をブラウザ側のネットワーク遮断で根治する。

**Architecture:** Plan 1 の描画核（`SalesSheetDocument` → `renderDocumentToPdf`）の上に、(1) 出力時にChromiumの全リモート要求を遮断するガード、(2) `/uploads/` 写真を `data:` URL に展開する `inlineDocumentImages`、(3) 物件→売土地documentを組む `buildInitialSalesSheetDocument`（売土地ビルトインテンプレ・コード）、(4) `POST /api/properties/[id]/sales-sheet/preview` 生成route、(5) 物件詳細の生成ボタン＋不足項目フォーム、を積む。DB保存・エディタUIは後続Plan。

**Tech Stack:** Next.js App Router / TypeScript / React 19 / Prisma / Vitest / playwright(既存) / zod(既存)。新規依存なし。

## Global Constraints
- A4横(landscape 297mm×210mm) を既定とする。
- 画像srcは **`data:` のみ**（Plan 1 schema: `isSafeImageSrc`）、色/フォントは許可リスト（`isCssColor`/`isSafeFontFamily`）。よって **build-initial-document は写真を `data:` に展開してから返す**（renderは描画入口で `parseSalesSheetDocument` 検証）。
- **新規 npm 依存を追加しない**。**Prisma migration を行わない**（売土地テンプレはコード、Plan 2 は永続化しない）。
- ログ・レスポンスに **PII / blob key / 画像バイト** を出さない。
- 生成routeは **認証必須**（`proxy.ts` の公開パスに載せない）。権限は既存 `property:read` ＋ `canAccessPropertyRecord`（field_staff は自分の物件のみ）。新規perm/seedは作らない。
- chromium 未導入環境では実描画(PDF)テストは `it.skipIf(!isChromiumAvailable())` で skip し CI を緑に保つ。

## Plan roadmap
- Plan 1 — Render core（✅MERGED `e3f78b9`）。
- **Plan 2 — 自動取込 + 売土地テンプレ + 生成導線（本書）**。
- Plan 3 — 保存(SalesSheetDesign・migration) + エディタ外枠（自由配置）。
- Plan 4 — 写真管理（枚数自由・トリミング・パノラマ）。
- Plan 5 — テンプレ・ギャラリー（売マンション/売戸建/一棟）。
- Plan 6 — スマート自動レイアウト（試作先行）。
- Plan 7 — バッジ・デザイナー。
- Plan 8 — QR + テーマ色 + 表示項目 + 仕上げ。

## 既存フィールド対応（schema実フィールド名・売土地）
- 直接マップ可能: 所在地=`Property.address` / 物件種目=`Property.propertyType` / 用途地域=`Property.zoningDistrict` / 建蔽率=`Property.buildingCoverageRatio` / 容積率=`Property.floorAreaRatio` / 高さ制限=`Property.heightDistrict` / 防火=`Property.firePreventionZone` / 接道(種別/幅/接道幅/方向)=`roadType`/`roadWidth`/`frontageWidth`/`frontageDirection` / セットバック=`setbackRequired` / 路線価=`rosenkaValue`,`rosenkaYear` / 現況=`occupancyStatus` / 備考=`note` / 会社情報=テンプレ静的。
- **DB に無い→作成時フォーム override（確認済）**: 価格(price) / 交通(access) / 土地面積(landArea) / 地目(landCategory) / 取引態様(transactionType) / 引渡(deliveryTiming)。

---

### Task 1: 出力時ネットワーク遮断（生HTML SSRF 根治）

**Files:**
- Modify: `src/lib/sales-sheet/output.ts`
- Test: `src/lib/sales-sheet/__tests__/output-network-guard.test.ts`

**Interfaces:**
- Produces: `isAllowedRequestUrl(url: string): boolean`（`data:` / `about:` / `blob:` のみ true）。`withPage` と画像出力 context の page に `page.route("**/*", …)` を適用して非許可スキームを abort する。
- Consumes: 既存 `chromium`（playwright）。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/sales-sheet/__tests__/output-network-guard.test.ts
import { describe, it, expect } from "vitest";
import { isAllowedRequestUrl } from "../output";

describe("isAllowedRequestUrl (export network guard)", () => {
  it("data:/about:/blob: のみ許可する", () => {
    expect(isAllowedRequestUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(isAllowedRequestUrl("about:blank")).toBe(true);
    expect(isAllowedRequestUrl("blob:http://localhost/x")).toBe(true);
  });
  it("http/https/file 等の外部取得を拒否する（SSRF防止）", () => {
    expect(isAllowedRequestUrl("http://169.254.169.254/latest")).toBe(false);
    expect(isAllowedRequestUrl("https://example.com/x.png")).toBe(false);
    expect(isAllowedRequestUrl("file:///etc/passwd")).toBe(false);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/output-network-guard.test.ts`
Expected: FAIL（`isAllowedRequestUrl` が未export）

- [ ] **Step 3: 実装（output.ts を修正）**

`output.ts` の先頭付近（`mmToPx` の近く）に追加し、`withPage` と 画像出力 context の `newPage()` 直後に route を適用する。

```ts
/** export 時にChromiumが取得してよいURLか。data:/about:/blob: のみ許可し、
 *  http(s)/file 等の外部取得を遮断する（生HTML SSRF/ローカル資源露出の根治）。 */
const ALLOWED_REQUEST_SCHEMES = ["data:", "about:", "blob:"];
export function isAllowedRequestUrl(url: string): boolean {
  return ALLOWED_REQUEST_SCHEMES.some((s) => url.startsWith(s));
}

/** page の全リクエストに遮断ルールを適用する。 */
async function applyNetworkGuard(page: Page): Promise<void> {
  await page.route("**/*", (route) => {
    if (isAllowedRequestUrl(route.request().url())) route.continue();
    else route.abort();
  });
}
```

`withPage` を次のように変更（route 適用を setContent の前に入れる）:

```ts
async function withPage<T>(html: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await applyNetworkGuard(page);
    await page.setContent(html, { waitUntil: "networkidle" });
    return await fn(page);
  } finally {
    await browser.close();
  }
}
```

`renderHtmlToImage` の context.newPage 直後にも適用:

```ts
    const page = await context.newPage();
    await applyNetworkGuard(page);
    try {
      await page.setContent(html, { waitUntil: "networkidle" });
      // ...既存のスクリーンショット処理...
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/output-network-guard.test.ts`
Expected: PASS（2 tests）。既存の `output.test.ts`（chromium 依存）は引き続き skip。

- [ ] **Step 5: コミット**

```bash
git add src/lib/sales-sheet/output.ts src/lib/sales-sheet/__tests__/output-network-guard.test.ts
git commit -m "fix(sales-sheet): 出力時にchromiumの外部取得を遮断 (SSRF根治・Plan2 Task1)"
```

---

### Task 2: 写真の data: 展開（inlineDocumentImages）

**Files:**
- Create: `src/lib/sales-sheet/inline-images.ts`
- Test: `src/lib/sales-sheet/__tests__/inline-images.test.ts`

**Interfaces:**
- Consumes: `getStorage` from `@/lib/storage`（`getStorage().keyFromUrl(url)`, `getStorage().read(key) → Promise<{body:Buffer; contentType:string; size:number}|null>`）、`SalesSheetDocument`/`ImageElement`（document-schema）。
- Produces: `inlineDocumentImages(doc: SalesSheetDocument): Promise<SalesSheetDocument>`。各 image 要素について、src が `data:` 以外なら storage から bytes を読み `data:<contentType>;base64,<...>` に置換。key 解決不可 / read が null / 例外 の場合はその image 要素を**取り除く**（壊れ src を残さない）。PII/バイトはログに出さない。他要素は不変。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/sales-sheet/__tests__/inline-images.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SalesSheetDocument } from "../document-schema";
import { A4_LANDSCAPE } from "../document-schema";

const read = vi.fn();
const keyFromUrl = vi.fn();
vi.mock("@/lib/storage", () => ({
  getStorage: () => ({ read, keyFromUrl }),
}));

import { inlineDocumentImages } from "../inline-images";

const baseDoc = (src: string): SalesSheetDocument => ({
  page: A4_LANDSCAPE,
  theme: { fontFamily: "sans-serif", accentColor: "#000" },
  elements: [
    { id: "p", type: "image", x: 0, y: 0, w: 10, h: 10, z: 1, src, fit: "cover" },
    { id: "t", type: "text", x: 0, y: 0, w: 10, h: 5, z: 2, content: "x", style: {} },
  ],
});

beforeEach(() => { read.mockReset(); keyFromUrl.mockReset(); });

describe("inlineDocumentImages", () => {
  it("/uploads/ 画像を data: に展開する", async () => {
    keyFromUrl.mockReturnValue("properties/a/1.jpg");
    read.mockResolvedValue({ body: Buffer.from([1, 2, 3]), contentType: "image/jpeg", size: 3 });
    const out = await inlineDocumentImages(baseDoc("/uploads/properties/a/1.jpg"));
    const img = out.elements.find((e) => e.type === "image");
    expect(img && img.type === "image" && img.src.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(out.elements).toHaveLength(2);
  });
  it("既に data: の画像は変更しない & storage を読まない", async () => {
    const out = await inlineDocumentImages(baseDoc("data:image/png;base64,AAAA"));
    const img = out.elements.find((e) => e.type === "image");
    expect(img && img.type === "image" && img.src).toBe("data:image/png;base64,AAAA");
    expect(read).not.toHaveBeenCalled();
  });
  it("読めない画像は要素を取り除く（壊れsrcを残さない）", async () => {
    keyFromUrl.mockReturnValue("k");
    read.mockResolvedValue(null);
    const out = await inlineDocumentImages(baseDoc("/uploads/x.jpg"));
    expect(out.elements.some((e) => e.type === "image")).toBe(false);
    expect(out.elements).toHaveLength(1);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/inline-images.test.ts`
Expected: FAIL（`Cannot find module '../inline-images'`）

- [ ] **Step 3: 最小実装**

```ts
// src/lib/sales-sheet/inline-images.ts
import { getStorage } from "@/lib/storage";
import type { SalesSheetDocument, SalesSheetElement } from "./document-schema";

/**
 * document 内の画像 src を出力可能な形に整える。
 *  - 既に data: の src はそのまま。
 *  - それ以外（/uploads/ 等）は storage から bytes を読み data: URL に展開。
 *  - key 解決不可 / read null / 例外 の画像要素は取り除く（壊れた src を残さない）。
 * バイト列・key・URL はログに出さない。
 */
export async function inlineDocumentImages(
  doc: SalesSheetDocument,
): Promise<SalesSheetDocument> {
  const storage = getStorage();
  const out: SalesSheetElement[] = [];
  for (const el of doc.elements) {
    if (el.type !== "image") {
      out.push(el);
      continue;
    }
    if (el.src.startsWith("data:")) {
      out.push(el);
      continue;
    }
    const key = storage.keyFromUrl(el.src);
    if (!key) continue; // 解決不可 → 取り除く
    try {
      const result = await storage.read(key);
      if (!result) continue; // 存在しない → 取り除く
      const b64 = result.body.toString("base64");
      out.push({ ...el, src: `data:${result.contentType};base64,${b64}` });
    } catch {
      continue; // I/O エラー → 取り除く（詳細はログに出さない）
    }
  }
  return { ...doc, elements: out };
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/inline-images.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: コミット**

```bash
git add src/lib/sales-sheet/inline-images.ts src/lib/sales-sheet/__tests__/inline-images.test.ts
git commit -m "feat(sales-sheet): 写真src を data: に展開する inlineDocumentImages (Plan2 Task2)"
```

---

### Task 3: 売土地テンプレ + 初期document生成（build-initial-document）

**Files:**
- Create: `src/lib/sales-sheet/build-document.ts`
- Test: `src/lib/sales-sheet/__tests__/build-document.test.ts`

**Interfaces:**
- Consumes: `SalesSheetDocument`/`A4_LANDSCAPE`/element types（document-schema）、`inlineDocumentImages`（Task 2）。
- Produces:
  - 型 `SaleLandInput`（下記）と `SaleLandOverrides`（price/access/landArea/landCategory/transactionType/deliveryTiming：全て optional string）。
  - `buildSaleLandDocument(input: SaleLandInput): SalesSheetDocument`（純関数・写真src は `input.photo?.fileUrl`（/uploads/）のまま=未展開。schema検証はしない）。
  - `buildInitialSalesSheetDocument(input: SaleLandInput): Promise<SalesSheetDocument>`（= `inlineDocumentImages(buildSaleLandDocument(input))`。写真が data: 化され schema 検証を通る doc を返す）。
- 数値/Decimal は呼び出し側で string 化して渡す（このモジュールは表示文字列のみ扱う）。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/sales-sheet/__tests__/build-document.test.ts
import { describe, it, expect, vi } from "vitest";
import { salesSheetDocumentSchema } from "../document-schema";

vi.mock("@/lib/storage", () => ({
  getStorage: () => ({
    keyFromUrl: () => "k",
    read: async () => ({ body: Buffer.from([1]), contentType: "image/jpeg", size: 1 }),
  }),
}));

import { buildSaleLandDocument, buildInitialSalesSheetDocument } from "../build-document";

const input = {
  property: {
    address: "東京都世田谷区上馬４丁目",
    zoningDistrict: "第一種低層住居専用地域",
    buildingCoverageRatio: "50",
    floorAreaRatio: "100",
    roadType: "公道",
    roadWidth: "4.0",
    occupancyStatus: "更地",
    note: "南西角地",
  },
  owner: null,
  photo: { fileUrl: "/uploads/properties/a/1.jpg" },
  overrides: {
    price: "3,480万円",
    access: "東急田園都市線「駒沢大学」駅 徒歩8分",
    landArea: "120.50㎡",
    landCategory: "宅地",
    transactionType: "仲介",
    deliveryTiming: "相談",
  },
};

describe("buildSaleLandDocument", () => {
  it("価格(override)と所在地(DB)を含む要素を生成する", () => {
    const doc = buildSaleLandDocument(input);
    const texts = doc.elements.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.content : ""));
    expect(texts.join("\n")).toContain("3,480万円");
    expect(JSON.stringify(doc.elements)).toContain("東京都世田谷区上馬４丁目");
    expect(JSON.stringify(doc.elements)).toContain("仲介");
    expect(doc.page.orientation).toBe("landscape");
  });
});

describe("buildInitialSalesSheetDocument", () => {
  it("写真を data: 化し、schema 検証を通る doc を返す", async () => {
    const doc = await buildInitialSalesSheetDocument(input);
    expect(salesSheetDocumentSchema.safeParse(doc).success).toBe(true);
    const img = doc.elements.find((e) => e.type === "image");
    expect(img && img.type === "image" && img.src.startsWith("data:image/")).toBe(true);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/build-document.test.ts`
Expected: FAIL（`Cannot find module '../build-document'`）

- [ ] **Step 3: 最小実装**

```ts
// src/lib/sales-sheet/build-document.ts
import {
  A4_LANDSCAPE,
  type SalesSheetDocument,
  type SalesSheetElement,
} from "./document-schema";
import { inlineDocumentImages } from "./inline-images";

export interface SaleLandOverrides {
  price?: string;
  access?: string;
  landArea?: string;
  landCategory?: string;
  transactionType?: string;
  deliveryTiming?: string;
}

export interface SaleLandInput {
  property: {
    address: string;
    zoningDistrict?: string | null;
    buildingCoverageRatio?: string | null;
    floorAreaRatio?: string | null;
    roadType?: string | null;
    roadWidth?: string | null;
    occupancyStatus?: string | null;
    note?: string | null;
  };
  owner?: { name?: string | null } | null;
  photo?: { fileUrl: string } | null;
  overrides?: SaleLandOverrides;
}

const NAVY = "#15324f";
const RED = "#d0331a";
const FONT = '"Yu Gothic UI","Meiryo",sans-serif';

function row(label: string, value: string | null | undefined): { label: string; value: string } {
  return { label, value: value ?? "" };
}

/** 売土地 図面の document を組む（純関数・写真は未展開の /uploads/ src のまま）。 */
export function buildSaleLandDocument(input: SaleLandInput): SalesSheetDocument {
  const o = input.overrides ?? {};
  const p = input.property;
  const ratio =
    p.buildingCoverageRatio || p.floorAreaRatio
      ? `${p.buildingCoverageRatio ?? "-"}％ ／ ${p.floorAreaRatio ?? "-"}％`
      : "";
  const road =
    [p.roadType, p.roadWidth ? `幅員${p.roadWidth}m` : null].filter(Boolean).join(" ") || "";

  const elements: SalesSheetElement[] = [
    { id: "title", type: "text", x: 10, y: 8, w: 180, h: 10, z: 2,
      content: "売土地", style: { fontSizePt: 16, bold: true, color: NAVY } },
    { id: "price-label", type: "text", x: 10, y: 22, w: 30, h: 8, z: 2,
      content: "価格", style: { fontSizePt: 10, color: "#888888" } },
    { id: "price", type: "text", x: 10, y: 28, w: 130, h: 14, z: 2,
      content: o.price ?? "", style: { fontSizePt: 26, bold: true, color: RED } },
    { id: "overview", type: "table", x: 150, y: 22, w: 137, h: 160, z: 1,
      rows: [
        row("所在地", p.address),
        row("交通", o.access),
        row("土地面積", o.landArea),
        row("地目", o.landCategory),
        row("用途地域", p.zoningDistrict),
        row("建蔽率/容積率", ratio),
        row("接道", road),
        row("現況", p.occupancyStatus),
        row("引渡", o.deliveryTiming),
        row("取引態様", o.transactionType),
        row("備考", p.note),
      ],
      style: { fontSizePt: 9, borderColor: "#cccccc", labelColor: NAVY } },
    { id: "company", type: "text", x: 10, y: 192, w: 277, h: 10, z: 2,
      content: "株式会社リガーレジャパン Ligare Japan　TEL 03-6823-2760",
      style: { fontSizePt: 9, color: NAVY } },
  ];

  if (input.photo?.fileUrl) {
    elements.push({
      id: "photo", type: "image", x: 10, y: 46, w: 130, h: 95, z: 1,
      src: input.photo.fileUrl, fit: "cover", radiusMm: 2, alt: "物件写真",
    });
  }

  return {
    page: A4_LANDSCAPE,
    theme: { fontFamily: FONT, accentColor: NAVY },
    elements,
  };
}

/** DB データ → 写真を data: 展開済みの検証可能な document。 */
export async function buildInitialSalesSheetDocument(
  input: SaleLandInput,
): Promise<SalesSheetDocument> {
  return inlineDocumentImages(buildSaleLandDocument(input));
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/build-document.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: コミット**

```bash
git add src/lib/sales-sheet/build-document.ts src/lib/sales-sheet/__tests__/build-document.test.ts
git commit -m "feat(sales-sheet): 売土地テンプレ + 初期document生成 (Plan2 Task3)"
```

---

### Task 4: 生成route（POST /api/properties/[id]/sales-sheet/preview）

**Files:**
- Create: `src/app/api/properties/[id]/sales-sheet/preview/route.ts`
- Test: `src/app/api/properties/[id]/sales-sheet/preview/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `getApiSession`/`getUserPermissions`/`parseJsonBody`/`ApiError`/`handleApiError`（api-helpers）、`hasPermission`（permissions）、`canAccessPropertyRecord`（property-access）、`prisma`、`buildInitialSalesSheetDocument`（Task 3）、`renderDocumentToPdf`（render-to-output）、`isChromiumAvailable`（output）。
- 振る舞い: POST。401(no session)/403(no property:read)/404(not found)/403(access)/400(bad body)/503(chromium未導入)/200(application/pdf bytes)。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/app/api/properties/[id]/sales-sheet/preview/__tests__/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const getApiSession = vi.fn();
const getUserPermissions = vi.fn();
vi.mock("@/lib/api-helpers", async (orig) => {
  const actual = await orig<typeof import("@/lib/api-helpers")>();
  return { ...actual, getApiSession: () => getApiSession(), getUserPermissions: () => getUserPermissions() };
});
const findUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({ default: { property: { findUnique: () => findUnique() } } }));
const renderDocumentToPdf = vi.fn();
vi.mock("@/lib/sales-sheet/render-to-output", () => ({ renderDocumentToPdf: () => renderDocumentToPdf() }));
vi.mock("@/lib/sales-sheet/output", () => ({ isChromiumAvailable: () => true }));
vi.mock("@/lib/sales-sheet/build-document", () => ({ buildInitialSalesSheetDocument: async () => ({ ok: true }) }));

import { POST } from "../route";

function req(body: unknown = {}) {
  return new Request("http://localhost/api/properties/p1/sales-sheet/preview", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
const ctx = { params: Promise.resolve({ id: "p1" }) };

beforeEach(() => {
  getApiSession.mockReset(); getUserPermissions.mockReset();
  findUnique.mockReset(); renderDocumentToPdf.mockReset();
  getApiSession.mockResolvedValue({ id: "u1", role: "admin" });
  getUserPermissions.mockResolvedValue([{ resource: "property", action: "read", granted: true }]);
  findUnique.mockResolvedValue({ id: "p1", address: "addr", createdBy: "u1", assignedTo: null, building: null, photos: [] });
  renderDocumentToPdf.mockResolvedValue(Buffer.from("%PDF-1.4 test"));
});

describe("POST sales-sheet/preview", () => {
  it("権限なしは403", async () => {
    getUserPermissions.mockResolvedValue([]);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
  });
  it("物件が無ければ404", async () => {
    findUnique.mockResolvedValue(null);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(404);
  });
  it("field_staff が他人の物件なら403", async () => {
    getApiSession.mockResolvedValue({ id: "other", role: "field_staff" });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
  });
  it("成功時は application/pdf を返す", async () => {
    const res = await POST(req({ price: "3,480万円" }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run src/app/api/properties/[id]/sales-sheet/preview/__tests__/route.test.ts`
Expected: FAIL（`Cannot find module '../route'`）

- [ ] **Step 3: 最小実装**

```ts
// src/app/api/properties/[id]/sales-sheet/preview/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  parseJsonBody,
  ApiError,
  handleApiError,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { buildInitialSalesSheetDocument } from "@/lib/sales-sheet/build-document";
import { renderDocumentToPdf } from "@/lib/sales-sheet/render-to-output";
import { isChromiumAvailable } from "@/lib/sales-sheet/output";

const overridesSchema = z.object({
  price: z.string().max(200).optional(),
  access: z.string().max(500).optional(),
  landArea: z.string().max(200).optional(),
  landCategory: z.string().max(200).optional(),
  transactionType: z.string().max(200).optional(),
  deliveryTiming: z.string().max(200).optional(),
});

function s(v: unknown): string | null {
  return v == null ? null : String(v);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件閲覧の権限がありません", "FORBIDDEN");
    }

    const property = await prisma.property.findUnique({
      where: { id },
      include: { building: true, photos: { where: { isPrimary: true }, take: 1 } },
    });
    if (!property) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    if (!canAccessPropertyRecord(session, property)) {
      throw new ApiError(403, "この物件にアクセスできません", "FORBIDDEN");
    }

    const overrides = overridesSchema.parse(await parseJsonBody(request));

    if (!isChromiumAvailable()) {
      throw new ApiError(503, "PDF生成が利用できません（サーバー未設定）", "PDF_UNAVAILABLE");
    }

    const photo = property.photos[0] ? { fileUrl: property.photos[0].fileUrl } : null;
    const doc = await buildInitialSalesSheetDocument({
      property: {
        address: property.address,
        zoningDistrict: s(property.zoningDistrict),
        buildingCoverageRatio: s(property.buildingCoverageRatio),
        floorAreaRatio: s(property.floorAreaRatio),
        roadType: s(property.roadType),
        roadWidth: s(property.roadWidth),
        occupancyStatus: s(property.occupancyStatus),
        note: s(property.note),
      },
      photo,
      overrides,
    });

    const pdf = await renderDocumentToPdf(doc);
    return new NextResponse(pdf, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'inline; filename="sales-sheet.pdf"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx vitest run src/app/api/properties/[id]/sales-sheet/preview/__tests__/route.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: コミット**

```bash
git add "src/app/api/properties/[id]/sales-sheet/preview/route.ts" "src/app/api/properties/[id]/sales-sheet/preview/__tests__/route.test.ts"
git commit -m "feat(sales-sheet): 売土地PDF生成route (Plan2 Task4)"
```

---

### Task 5: 物件詳細の「販売図面を作成（売土地）」ボタン＋不足項目フォーム

**Files:**
- Create: `src/components/sales-sheet/SaleLandSheetButton.tsx`
- Test: `src/components/sales-sheet/__tests__/SaleLandSheetButton.test.tsx`
- Modify: 物件詳細ページ（実装者が特定。`src/app/(dashboard)/properties/[id]/page.tsx` 系の「アクション」群に `<SaleLandSheetButton propertyId={property.id} />` を追加。既存のアクションボタン配置に倣う。物件種別が土地のときに表示する条件は任意・最小実装では常時表示でよい）

**Interfaces:**
- Produces: `SaleLandSheetButton({ propertyId }: { propertyId: string })` — クリックで不足項目（価格/交通/土地面積/地目/取引態様/引渡）入力フォームを開き、`POST /api/properties/${propertyId}/sales-sheet/preview` を呼び、返却 PDF(blob) をダウンロードする client component。

- [ ] **Step 1: 失敗するテストを書く**

```tsx
// src/components/sales-sheet/__tests__/SaleLandSheetButton.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SaleLandSheetButton } from "../SaleLandSheetButton";

describe("SaleLandSheetButton", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("ボタン押下でフォーム（価格入力）が開く", () => {
    render(<SaleLandSheetButton propertyId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: /販売図面を作成/ }));
    expect(screen.getByLabelText("価格")).toBeInTheDocument();
  });

  it("生成押下で preview API を正しいURL・POSTで呼ぶ", async () => {
    const blob = new Blob(["%PDF-"], { type: "application/pdf" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(blob, { status: 200, headers: { "Content-Type": "application/pdf" } }),
    );
    // jsdom: URL.createObjectURL 未実装のため stub
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() });

    render(<SaleLandSheetButton propertyId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: /販売図面を作成/ }));
    fireEvent.change(screen.getByLabelText("価格"), { target: { value: "3,480万円" } });
    fireEvent.click(screen.getByRole("button", { name: /PDFを作成/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/properties/p1/sales-sheet/preview");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string).price).toBe("3,480万円");
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run src/components/sales-sheet/__tests__/SaleLandSheetButton.test.tsx`
Expected: FAIL（`Cannot find module '../SaleLandSheetButton'`）

- [ ] **Step 3: 最小実装**

```tsx
// src/components/sales-sheet/SaleLandSheetButton.tsx
"use client";

import { useState } from "react";

const FIELDS: { key: string; label: string }[] = [
  { key: "price", label: "価格" },
  { key: "access", label: "交通" },
  { key: "landArea", label: "土地面積" },
  { key: "landCategory", label: "地目" },
  { key: "transactionType", label: "取引態様" },
  { key: "deliveryTiming", label: "引渡" },
];

export function SaleLandSheetButton({ propertyId }: { propertyId: string }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/properties/${propertyId}/sales-sheet/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!res.ok) {
        setError("PDFの作成に失敗しました");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "販売図面.pdf";
      a.click();
      URL.revokeObjectURL(url);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white"
      >
        販売図面を作成（売土地）
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-[420px] rounded-lg bg-white p-5 shadow-xl dark:bg-neutral-800">
            <h2 className="mb-3 text-base font-bold">販売図面（売土地）の作成</h2>
            <p className="mb-3 text-xs text-neutral-500">
              システムに無い項目を入力してください（空欄可）。
            </p>
            <div className="space-y-2">
              {FIELDS.map((f) => (
                <div key={f.key} className="flex items-center gap-2">
                  <label htmlFor={`ss-${f.key}`} className="w-20 text-sm">{f.label}</label>
                  <input
                    id={`ss-${f.key}`}
                    aria-label={f.label}
                    className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm dark:bg-neutral-700"
                    value={values[f.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
            {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className="rounded px-3 py-2 text-sm">
                キャンセル
              </button>
              <button
                type="button"
                onClick={generate}
                disabled={busy}
                className="rounded bg-indigo-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {busy ? "作成中…" : "PDFを作成"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx vitest run src/components/sales-sheet/__tests__/SaleLandSheetButton.test.tsx`
Expected: PASS（2 tests）

- [ ] **Step 5: 物件詳細ページに組込**

物件詳細ページ（`src/app/(dashboard)/properties/[id]/page.tsx` 等・実装者が特定）の既存アクションボタン群に次を追加（import 済み前提）:

```tsx
<SaleLandSheetButton propertyId={property.id} />
```

`import { SaleLandSheetButton } from "@/components/sales-sheet/SaleLandSheetButton";` を追加。配置・スタイルは周囲のアクションに合わせる。

- [ ] **Step 6: 全ゲートを通す**

Run（順に）:
- `npx vitest run src/lib/sales-sheet src/components/sales-sheet "src/app/api/properties/[id]/sales-sheet"`
- `npx tsc --noEmit`
- `npx eslint src/lib/sales-sheet src/components/sales-sheet "src/app/api/properties/[id]/sales-sheet"`
- `npm run build`

Expected: tsc 0 / eslint 0 / build OK / vitest green（chromium依存の実描画は skip）。

- [ ] **Step 7: コミット**

```bash
git add src/components/sales-sheet/SaleLandSheetButton.tsx src/components/sales-sheet/__tests__/SaleLandSheetButton.test.tsx
git add "src/app/(dashboard)/properties/[id]/page.tsx"
git commit -m "feat(sales-sheet): 物件詳細に売土地図面作成ボタン+フォーム (Plan2 Task5)"
```

---

## Self-Review（記入済み）
- **Spec coverage（Plan 2 範囲）**: §3 データ自動取込→Task3 / §5 出力エンジン(PDF)→既存+Task1 ガード / §6 写真→Task2 inline / §11 generate→Task4 route / §作成フォーム(不足項目)→Task5 / §13 権限(property:read+access)→Task4 / §17-3 chromium skip→Task4 503 + テスト。テンプレ・ギャラリー/自動レイアウト/バッジ/QR/保存/エディタは範囲外（Plan3+）。
- **Placeholder scan**: TODO/「適切に」等なし。各 step に完全コードと実コマンド。UI 組込先のみ実装者が特定（理由明記）。
- **Type consistency vs Plan 1**: `SalesSheetDocument`/`SalesSheetElement`/`A4_LANDSCAPE`/`isSafeImageSrc`(data:のみ)/`renderDocumentToPdf`/`isChromiumAvailable`/`getStorage().read/keyFromUrl`/`StorageReadResult{body,contentType}`/`getApiSession`/`getUserPermissions`/`hasPermission`/`canAccessPropertyRecord`/`parseJsonBody`/`ApiError`/`handleApiError` を実シグネチャで使用。build→inline→render→parse の順で data:制約を満たす。
- **No migration / no new deps**: 売土地テンプレはコード。保存は Plan 3。zod/react/playwright/prisma は既存。

## 前提・リスク
- 権限は `property:read`＋`canAccessPropertyRecord` を採用（専用 `sales_sheet` 権限は seed/migration が必要なため Plan 2 では作らない。図面生成=物件閲覧の範囲という整理）。
- `renderDocumentToPdf` の実描画は chromium 必須。未導入時は route が 503 を返す（テストは isChromiumAvailable をmockし200経路を確認、実描画はchromium環境のみ）。本番反映時に `npx playwright install chromium`（ops・承認）。
- 写真は最初の `isPrimary` 1枚のみ（複数写真/トリミングは Plan 4）。
- 数値/Decimal は route で string 化して渡す（build-document は表示文字列のみ扱う）。
- UI は最小（モーダル＋6入力＋ダウンロード）。本格エディタは Plan 3。
