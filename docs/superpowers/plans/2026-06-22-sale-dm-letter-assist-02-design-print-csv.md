# 売却促進DM 作成 — Plan 2: デザインテンプレート + ブラウザ印刷 + CSV補助 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plan 1 で生成・保存・確認・確定できるようになった売却DM下書きに、(a) 3種のデザインテンプレート(formal/soft/impact)で体裁化した HTML を作る純関数レンダラ、(b) 確定分(status=confirmed)をページ区切りで1ドキュメントに連結する**まとめ印刷** route、(c) 設定一式の列+本文+宛名を含む**CSV補助** route を足す。これにより「画面プレビュー → ブラウザ印刷で PDF/印刷」「外部分析・差し込み用 CSV」が揃う。追跡リンク/QR の**実体は Plan 5**で、本プランでは HTML 内に差し込み枠(プレースホルダ slot)とコメントだけ用意する。

**Architecture:** デザインは `src/lib/sale-dm-letter/templates/` に純関数レンダラとして分離(I/O なし・サーバー重依存なし)。`renderLetterHtml(input)` が AI 本文 + 宛名 + 差出人 + 追跡リンク枠を流し込み、テンプレ別の CSS と印刷用 CSS(`@page` / `page-break-after`)を含む完結した HTML 断片を返す。`renderLetterSheetHtml(letters[])` が複数通を `<div class="letter-page">…</div>` で連結し1つの完全 HTML ドキュメントにする。route は Plan 1 の `requireSaleDmAccess()` ゲートと prisma を再利用し、print は `text/html`・export は `text/csv`、いずれも `no-store`。CSV は既存 `encodeCsv`/`sanitizeCsvCellForExcel`(BOM+CRLF+formula injection 対策)を流用する。すべて HTML エスケープ必須(本文・宛名・住所は PII かつ未エスケープだと XSS/レイアウト破壊)。

**Tech Stack:** Next.js 16 (App Router) / Prisma 7 / PostgreSQL / next-auth v5 / zod 4 / vitest 4。新規依存なし。

## Global Constraints

- 設計書: `docs/superpowers/specs/2026-06-22-sale-dm-letter-assist-design.md`(本プランの上位)。
- 上流プラン: `docs/superpowers/plans/2026-06-22-sale-dm-letter-assist-01-foundation.md`(Plan 1)。**Plan 1 が先に実装・マージされている前提**で本プランは Plan 1 が produces した interface に乗る(再定義しない)。
- 実装は**専用 git worktree** で行う(`superpowers:using-git-worktrees` を実行時に使用)。base = `main`・branch = `feat/sale-dm-letter-assist`(Plan 1 と同一ブランチに積む)。
- **Plan 1 が提供済みで本プランが consume する interface(再実装禁止・正確な形は各ファイルを Read):**
  - Prisma: `DmCampaign` / `DmVariant` / `DmRecipientDraft`、enum `DmDraftStatus`(`draft`/`confirmed`/`sent`)。`DmRecipientDraft` の主なフィールド: `id` / `campaignId` / `variantId` / `propertyId` / `recipientName` / `recipientZip`(`String?`) / `recipientAddress`(`String?`) / `honorific` / `body` / `status`(`DmDraftStatus`) / `trackingToken`(unique) / `createdAt`。`DmVariant`: `id` / `campaignId` / `label` / `designTemplate` / `tone` / `length` / `appeal` / `strength` / `extraInstruction`(`String?`)。`DmCampaign`: `id` / `name` / `createdBy` / `createdAt`。
  - `src/lib/sale-dm-letter/route-guard.ts`: `requireSaleDmAccess(): Promise<{ session, permissions, ownerDisplayConfig }>`。4権限(`property`/`csv_export`/`csv_export_personal`/`owner` の read)+ owner 氏名/郵便番号/住所が生値レベルを確認し、不足は `ApiError(403)` を throw(副作用なし)。
  - `src/lib/sale-dm-letter/types.ts`: `LetterOptions`(`designTemplate`/`tone`/`length`/`appeal`/`strength`/`senderName`/`senderContact`/`extraInstruction?`)。
  - route ベースパス: `src/app/api/properties/sale-dm/`(Plan 1 で `campaigns/route.ts`・`campaigns/[id]/route.ts`・`drafts/...` が存在)。
- 既存ヘルパ再利用(再実装しない):
  - `@/lib/api-helpers`: `handleApiError`, `ApiError`(`status`/`code`)。
  - `@/lib/csv-encode`: `encodeCsv(headers, rows, { bom })`, `sanitizeCsvCellForExcel(value)`。
  - `@/lib/prisma`: default `prisma`。
- 秘密はサーバー側のみ・`NEXT_PUBLIC_*` 露出禁止・client 直叩き禁止。本プランは外部 API を呼ばない(生成は Plan 1 済み・本プランは保存済み本文を読むだけ)。
- 本文・宛名・住所は **PII**。print/export route のレスポンスは `Cache-Control: no-store`。AuditLog には本文/PII を残さない(非PIIメタのみ)。
- 権限ゲートは `requireSaleDmAccess()` を使う(独自に権限判定コードを書かない)。
- HTML は**必ずエスケープ**してから埋め込む(`&`/`<`/`>`/`"`/`'` を実体参照化)。本プランで小さな純関数 `escapeHtml` を `templates/` 内に置く(既存に汎用 HTML エスケープが無いため)。
- CSV は BOM + CRLF(encodeCsv 既定)+ formula injection 対策(全セル `sanitizeCsvCellForExcel`)。
- **追跡リンク/QR の実体は Plan 5。本プランでは差し込み枠(`<!-- TRACKING_SLOT -->` 相当の DOM ノード)とコメントだけ用意し、URL/QR は描かない。**
- DRY / YAGNI / TDD / こまめにコミット。raw SQL を入れない。
- テストは `src/lib/__tests__/*.test.ts`。実行: `npm test`(= `vitest run`)。単体は `npx vitest run <file>`。route テストは Plan 1 / dm-export route test と同じ流儀(`vi.mock("next/server" | "@/lib/api-helpers" | "@/lib/audit" | "@/lib/prisma")`)。
- 本プランのスコープ外(後続プラン): 複数型と割当・割当 route(P3)・配達/反響/宛先不明連動/集計(P4)・LP 追跡 `/t/[token]`・QR/短縮URL 実体・`proxy.ts` 公開パス(P5)・物件一覧 UI/作業画面 3分割(P6)。本プランは「印刷 HTML と CSV を返す API + 純関数レンダラ」までで、UI 画面は作らない。

---

### Task 1: デザインテンプレート純関数レンダラ(formal/soft/impact)

**Files:**
- Create: `src/lib/sale-dm-letter/templates/types.ts`
- Create: `src/lib/sale-dm-letter/templates/index.ts`
- Test: `src/lib/__tests__/sale-dm-templates.test.ts`

**Interfaces:**
- Produces(後続が依存):
  - `interface LetterRenderInput { designTemplate: string; body: string; addresseeName: string; honorific: string; recipientZip: string | null; recipientAddress: string | null; senderName: string; senderContact: string; trackingToken: string }`
  - `escapeHtml(value: string | null | undefined): string`
  - `renderLetterHtml(input: LetterRenderInput): string`(単一通の `<div class="letter-page">…</div>` 断片。テンプレ別スコープ CSS を `<style>` で内包)
  - `DESIGN_TEMPLATES: readonly ["formal", "soft", "impact"]`
  - `resolveDesignTemplate(value: string): "formal" | "soft" | "impact"`(未知値は `formal` にフォールバック)

- [ ] **Step 1: 型を定義**

`src/lib/sale-dm-letter/templates/types.ts`:

```ts
// 1通の手紙を HTML 断片へ流し込むための入力。すべて呼び出し側(route)が
// DmRecipientDraft + DmVariant + 差出人設定から組み立てる。PII(body/宛名/住所)を含むため
// レンダラ側で必ず escapeHtml を通してから埋め込む。
export interface LetterRenderInput {
  designTemplate: string; // "formal" | "soft" | "impact"(未知値は formal にフォールバック)
  body: string; // AI 生成 or 手直し済みの本文(改行を含む)
  addresseeName: string; // 代表者名(生値)
  honorific: string; // "様" / "御中" / "様 他共有者様" 等
  recipientZip: string | null;
  recipientAddress: string | null;
  senderName: string;
  senderContact: string;
  trackingToken: string; // Plan 5 で QR/短縮URL に使う。本プランでは枠のみ。
}
```

- [ ] **Step 2: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-templates.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  renderLetterHtml,
  escapeHtml,
  DESIGN_TEMPLATES,
  resolveDesignTemplate,
} from "../sale-dm-letter/templates";
import type { LetterRenderInput } from "../sale-dm-letter/templates/types";

const base: LetterRenderInput = {
  designTemplate: "formal",
  body: "拝啓 時下ますますご清栄のこととお慶び申し上げます。\n2行目の本文です。",
  addresseeName: "田中 一郎",
  honorific: "様",
  recipientZip: "100-0001",
  recipientAddress: "東京都〇〇区△△1-2-3",
  senderName: "△△不動産",
  senderContact: "000-000-0000",
  trackingToken: "tok_abc",
};

describe("escapeHtml", () => {
  it("HTML 特殊文字を実体参照へ変換する", () => {
    expect(escapeHtml(`<script>"a&b"'c'`)).toBe(
      "&lt;script&gt;&quot;a&amp;b&quot;&#39;c&#39;",
    );
  });
  it("null / undefined は空文字", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("resolveDesignTemplate", () => {
  it("既知の3種はそのまま", () => {
    expect(resolveDesignTemplate("soft")).toBe("soft");
    expect(resolveDesignTemplate("impact")).toBe("impact");
    expect(resolveDesignTemplate("formal")).toBe("formal");
  });
  it("未知値は formal にフォールバック", () => {
    expect(resolveDesignTemplate("unknown")).toBe("formal");
  });
});

describe("renderLetterHtml", () => {
  it("3デザインとも宛名・本文・差出人を含む完結した断片を返す", () => {
    for (const design of DESIGN_TEMPLATES) {
      const html = renderLetterHtml({ ...base, designTemplate: design });
      expect(html).toContain("letter-page");
      expect(html).toContain(`letter-page--${design}`);
      expect(html).toContain("田中 一郎");
      expect(html).toContain("様");
      expect(html).toContain("△△不動産");
      // 本文の改行が <br> へ展開される
      expect(html).toContain("2行目の本文です。");
      expect(html).toContain("<br");
    }
  });

  it("HTML エスケープ: 本文の <script> はそのまま出力されない", () => {
    const html = renderLetterHtml({
      ...base,
      body: '<script>alert("x")</script>悪意ある本文',
      addresseeName: 'タグ<b>"&名',
    });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("悪意ある本文");
    expect(html).toContain("タグ&lt;b&gt;&quot;&amp;名");
  });

  it("追跡リンクの差し込み枠(プレースホルダ)を持つが URL/QR は描かない", () => {
    const html = renderLetterHtml(base);
    expect(html).toContain("tracking-slot");
    // Plan 5 まで実 URL は載せない(トークンを生の URL として出さない)
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
  });

  it("未知の designTemplate でも落ちず formal にフォールバックして描画する", () => {
    const html = renderLetterHtml({ ...base, designTemplate: "nope" });
    expect(html).toContain("letter-page--formal");
  });
});
```

- [ ] **Step 3: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-templates.test.ts`
Expected: FAIL(モジュール `../sale-dm-letter/templates` 未解決)。

- [ ] **Step 4: 実装**

`src/lib/sale-dm-letter/templates/index.ts`:

```ts
import type { LetterRenderInput } from "./types";

export const DESIGN_TEMPLATES = ["formal", "soft", "impact"] as const;
export type DesignTemplate = (typeof DESIGN_TEMPLATES)[number];

export function resolveDesignTemplate(value: string): DesignTemplate {
  return (DESIGN_TEMPLATES as readonly string[]).includes(value)
    ? (value as DesignTemplate)
    : "formal";
}

// HTML 特殊文字を実体参照へ。順序重要(& を最初に)。null/undefined は空文字。
export function escapeHtml(value: string | null | undefined): string {
  if (value == null) return "";
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 改行を <br /> へ。先に escapeHtml 済みの文字列に対して適用する。
function escapedBodyToHtml(body: string): string {
  return escapeHtml(body).replace(/\r\n|\r|\n/g, "<br />\n");
}

// テンプレ別の見た目(色/フォント/装飾)。可変要素は CSS 変数で持ち、将来 調整パネルから
// 上書きできるよう設計(本プランでは固定値)。
const TEMPLATE_VARS: Record<DesignTemplate, string> = {
  // 信頼: 明朝・落ち着いた紺・罫線控えめ。
  formal:
    "--accent:#1f3a5f; --font:'Yu Mincho','Hiragino Mincho ProN',serif; --body-size:11pt; --line:1.9;",
  // やわらか: ゴシック・温かみのある色・余白広め・角丸。
  soft: "--accent:#9a6a3a; --font:'Yu Gothic','Hiragino Sans',sans-serif; --body-size:11.5pt; --line:2.0;",
  // インパクト: 太字見出し・コントラスト強め。
  impact:
    "--accent:#b3261e; --font:'Yu Gothic','Hiragino Sans',sans-serif; --body-size:11.5pt; --line:1.8;",
}; 

// 1通分の HTML 断片。<style> はテンプレ別クラス(.letter-page--<design>)にスコープし、
// まとめ印刷で複数 <style> が並んでも相互干渉しないようにする。
export function renderLetterHtml(input: LetterRenderInput): string {
  const design = resolveDesignTemplate(input.designTemplate);
  const cls = `letter-page letter-page--${design}`;
  const vars = TEMPLATE_VARS[design];

  const addressee = `${escapeHtml(input.addresseeName)} ${escapeHtml(input.honorific)}`;
  const zip = input.recipientZip ? `〒${escapeHtml(input.recipientZip)}` : "";
  const address = escapeHtml(input.recipientAddress);
  const sender = escapeHtml(input.senderName);
  const contact = escapeHtml(input.senderContact);
  const bodyHtml = escapedBodyToHtml(input.body);

  return `<div class="${cls}">
  <style>
    .letter-page--${design} { ${vars} }
    .letter-page--${design} {
      box-sizing: border-box; width: 100%; min-height: 257mm; padding: 22mm 20mm;
      font-family: var(--font); color: #222; line-height: var(--line); font-size: var(--body-size);
    }
    .letter-page--${design} .letter-addr-block { margin-bottom: 14mm; }
    .letter-page--${design} .letter-zip { font-size: 10pt; color: #555; }
    .letter-page--${design} .letter-addr { font-size: 10pt; color: #555; }
    .letter-page--${design} .letter-addressee { margin-top: 4mm; font-size: 13pt; font-weight: 700; color: var(--accent); }
    .letter-page--${design} .letter-body { white-space: normal; }
    .letter-page--${design} .letter-sender { margin-top: 16mm; text-align: right; }
    .letter-page--${design} .letter-sender-name { font-weight: 700; color: var(--accent); }
    .letter-page--${design} .letter-sender-contact { font-size: 10pt; color: #555; }
    .letter-page--${design} .tracking-slot {
      margin-top: 12mm; padding: 6mm; border: 1px dashed #bbb; text-align: center;
      font-size: 9pt; color: #999;
    }
  </style>
  <div class="letter-addr-block">
    <div class="letter-zip">${zip}</div>
    <div class="letter-addr">${address}</div>
    <div class="letter-addressee">${addressee}</div>
  </div>
  <div class="letter-body">${bodyHtml}</div>
  <div class="letter-sender">
    <div class="letter-sender-name">${sender}</div>
    <div class="letter-sender-contact">${contact}</div>
  </div>
  <!--
    TRACKING SLOT (Plan 5): 宛先固有の追跡QR/短縮URL をここに差し込む。
    data-tracking-token は Plan 5 のレンダラ拡張が参照する識別子。
    本プランでは枠のみで、URL/QR は描画しない(opaque トークンを生URLとして載せない)。
  -->
  <div class="tracking-slot" data-tracking-token="${escapeHtml(input.trackingToken)}">
    [ 追跡QR / 短縮URL は後日掲載 ]
  </div>
</div>`;
}
```

> 実装メモ: `data-tracking-token` には escape 済みトークンを入れるが、これは識別子であって URL ではない。Plan 5 で `tracking-slot` を QR + `SALE_DM_LP_URL/t/<token>` 風の短縮URLに差し替える。テストの `not.toContain("http")` を壊さないため、本プランでは URL スキームを一切出力しない。

`src/lib/sale-dm-letter/templates/index.ts` から `LetterRenderInput` 型も re-export して import 経路を一本化:

```ts
// ファイル末尾に追記
export type { LetterRenderInput } from "./types";
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-templates.test.ts`
Expected: PASS(escapeHtml 2 + resolveDesignTemplate 2 + renderLetterHtml 4)。

- [ ] **Step 6: コミット**

```bash
git add src/lib/sale-dm-letter/templates/types.ts src/lib/sale-dm-letter/templates/index.ts src/lib/__tests__/sale-dm-templates.test.ts
git commit -m "feat(sale-dm): add letter HTML template renderer (formal/soft/impact) with escaping + tracking slot"
```

---

### Task 2: まとめ印刷ドキュメント連結(純関数)

**Files:**
- Modify: `src/lib/sale-dm-letter/templates/index.ts`(`renderLetterSheetHtml` を追加)
- Test: `src/lib/__tests__/sale-dm-templates.test.ts`(追記)

**Interfaces:**
- Consumes: `renderLetterHtml` / `LetterRenderInput`(Task 1)。
- Produces: `renderLetterSheetHtml(title: string, letters: LetterRenderInput[]): string`(完全な `<!doctype html>` ドキュメント。各通を `page-break-after: always` で区切り、最後の通は余白の空ページを出さない)。

- [ ] **Step 1: 失敗するテストを追記**

`src/lib/__tests__/sale-dm-templates.test.ts` 末尾に追記:

```ts
import { renderLetterSheetHtml } from "../sale-dm-letter/templates";

describe("renderLetterSheetHtml", () => {
  const make = (name: string): LetterRenderInput => ({ ...base, addresseeName: name });

  it("完全な HTML ドキュメント(doctype + @page)を返す", () => {
    const html = renderLetterSheetHtml("テストキャンペーン", [make("田中"), make("佐藤")]);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>テストキャンペーン</title>");
    expect(html).toContain("@page");
    expect(html).toContain("page-break-after");
  });

  it("通数ぶんの letter-page を連結する", () => {
    const html = renderLetterSheetHtml("c", [make("A"), make("B"), make("C")]);
    const count = (html.match(/class="letter-page /g) ?? []).length;
    expect(count).toBe(3);
  });

  it("最後の通は page-break を付けない(末尾空白ページ回避)", () => {
    const html = renderLetterSheetHtml("c", [make("A"), make("B")]);
    const breaks = (html.match(/letter-sheet-item--break/g) ?? []).length;
    expect(breaks).toBe(1); // 2通中、区切りは1つ
  });

  it("0通でも落ちず空ドキュメントを返す", () => {
    const html = renderLetterSheetHtml("空", []);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain("class=\"letter-page ");
  });

  it("タイトルも HTML エスケープされる", () => {
    const html = renderLetterSheetHtml("<b>x</b>", []);
    expect(html).toContain("<title>&lt;b&gt;x&lt;/b&gt;</title>");
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-templates.test.ts`
Expected: FAIL(`renderLetterSheetHtml` 未定義)。

- [ ] **Step 3: 実装**

`src/lib/sale-dm-letter/templates/index.ts` に追記:

```ts
// 確定済みの全通を1ドキュメントへ連結する(ブラウザ印刷 = PDF 化の入力)。
// 各通は A4 1枚。通と通の間だけ page-break-after:always を入れ、最後の通には付けない
// (末尾に空白ページが1枚増えるのを防ぐ)。<style> の @page で余白とサイズを固定。
export function renderLetterSheetHtml(
  title: string,
  letters: LetterRenderInput[],
): string {
  const items = letters
    .map((letter, i) => {
      const isLast = i === letters.length - 1;
      const wrapCls = isLast
        ? "letter-sheet-item"
        : "letter-sheet-item letter-sheet-item--break";
      return `<div class="${wrapCls}">${renderLetterHtml(letter)}</div>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="robots" content="noindex,nofollow" />
<title>${escapeHtml(title)}</title>
<style>
  @page { size: A4; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .letter-sheet-item { break-inside: avoid; }
  .letter-sheet-item--break { page-break-after: always; break-after: page; }
  @media screen {
    body { background: #eee; }
    .letter-sheet-item { width: 210mm; margin: 8mm auto; background: #fff; box-shadow: 0 0 4px rgba(0,0,0,.2); }
  }
</style>
</head>
<body>
${items}
</body>
</html>`;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-templates.test.ts`
Expected: PASS(Task 1 の 8 + 本 Task の 5 = 13)。

- [ ] **Step 5: コミット**

```bash
git add src/lib/sale-dm-letter/templates/index.ts src/lib/__tests__/sale-dm-templates.test.ts
git commit -m "feat(sale-dm): add multi-letter print sheet renderer (page-break, no trailing blank page)"
```

---

### Task 3: まとめ印刷 route(GET .../campaigns/[id]/print)

**Files:**
- Create: `src/app/api/properties/sale-dm/campaigns/[id]/print/route.ts`(GET)
- Test: `src/lib/__tests__/sale-dm-print-route.test.ts`

**Interfaces:**
- Consumes: `requireSaleDmAccess`(Plan 1)、`renderLetterSheetHtml`/`LetterRenderInput`(Task 1,2)、`prisma`(Plan 1 モデル)、`resolveSender`(Plan 1 Task 7 メモで導入された env 既定 sender ヘルパ。存在しない場合は本プランで `src/lib/sale-dm-letter/sender.ts` を作る — Step 3 参照)。
- Produces: route `GET /api/properties/sale-dm/campaigns/[id]/print`。**確定分(status=confirmed)のみ**を `renderLetterSheetHtml` で連結し `Content-Type: text/html; charset=utf-8`・`no-store` で返す。確定 0 件でも 200(空ドキュメント)。campaign 不在は 404。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-print-route.test.ts`(Plan 1 / dm-export route test と同じ `vi.mock` 流儀):

```ts
import { vi } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response {
    static json = (b: unknown, init?: ResponseInit) => Response.json(b, init);
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(s: number, m: string, c = "ERROR") {
      super(m);
      this.status = s;
      this.code = c;
    }
  }
  return {
    ApiError: MockApiError,
    handleApiError: vi.fn((e: unknown) =>
      e instanceof MockApiError
        ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status })
        : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 }),
    ),
  };
});

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

// requireSaleDmAccess は Plan 1 の route-guard。ここではゲートを mock し、許可/403 を切り替える。
const requireSaleDmAccess = vi.fn();
vi.mock("@/lib/sale-dm-letter/route-guard", () => ({ requireSaleDmAccess }));

vi.mock("@/lib/prisma", () => ({
  default: {
    dmCampaign: { findUnique: vi.fn() },
    dmRecipientDraft: { findMany: vi.fn() },
  },
}));

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { ApiError } from "@/lib/api-helpers";
import { GET } from "../../app/api/properties/sale-dm/campaigns/[id]/print/route";

const pm = prismaMock as never as {
  dmCampaign: { findUnique: ReturnType<typeof vi.fn> };
  dmRecipientDraft: { findMany: ReturnType<typeof vi.fn> };
};

const variant = {
  designTemplate: "formal",
  tone: "formal",
  length: "medium",
  appeal: "price",
  strength: "low",
  extraInstruction: null,
};
const draft = {
  id: "r1",
  recipientName: "田中 一郎",
  honorific: "様",
  recipientZip: "100-0001",
  recipientAddress: "東京都〇〇区",
  body: "本文です",
  status: "confirmed",
  trackingToken: "tok1",
  variant,
};

const ctx = { params: Promise.resolve({ id: "c1" }) };
const req = () => new Request("http://x/api/properties/sale-dm/campaigns/c1/print");

beforeEach(() => {
  vi.clearAllMocks();
  requireSaleDmAccess.mockResolvedValue({ session: { id: "u1" } });
  pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", name: "テスト" });
  pm.dmRecipientDraft.findMany.mockResolvedValue([draft]);
});

describe("GET .../campaigns/[id]/print", () => {
  it("確定分を text/html + no-store で返す", async () => {
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("田中 一郎");
    expect(html).toContain("本文です");
    // confirmed のみを問い合わせていること(status フィルタ)
    const arg = pm.dmRecipientDraft.findMany.mock.calls[0][0];
    expect(arg.where.campaignId).toBe("c1");
    expect(arg.where.status).toBe("confirmed");
  });

  it("確定 0 件でも 200(空ドキュメント)", async () => {
    pm.dmRecipientDraft.findMany.mockResolvedValue([]);
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain("letter-page ");
  });

  it("campaign 不在は 404", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue(null);
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(404);
  });

  it("権限不足(ゲートが 403 throw)で 403・DB を読まない", async () => {
    requireSaleDmAccess.mockRejectedValue(new ApiError(403, "x", "FORBIDDEN"));
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(403);
    expect(pm.dmCampaign.findUnique).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-print-route.test.ts`
Expected: FAIL(route 未実装)。

- [ ] **Step 3: 差出人解決ヘルパを確認/用意**

Plan 1 Task 7 のメモで `SALE_DM_SENDER_NAME` / `SALE_DM_SENDER_CONTACT` を読む `resolveSender()` を導入する方針になっている。実装済みなら再利用する。**未実装の場合は本プランで作る**:

`src/lib/sale-dm-letter/sender.ts`:

```ts
// 差出人(会社名・連絡先)の既定を env から解決する。生成・再生成・印刷・CSV で共通利用する。
// 設計書「差出人情報(任意)」: 自社名・連絡先のプレースホルダ既定。未設定でも安全に空でなく
// プレースホルダ文言にして、本文/印刷に「差出人欄が空」のまま出ないようにする。
export interface ResolvedSender {
  senderName: string;
  senderContact: string;
}

export function resolveSender(): ResolvedSender {
  return {
    senderName: process.env.SALE_DM_SENDER_NAME ?? "(差出人未設定)",
    senderContact: process.env.SALE_DM_SENDER_CONTACT ?? "",
  };
}
```

> DRY 注: Plan 1 で `resolveSender()` が `recipients.ts` 隣などに既にある場合は、本プランで重複作成せずそれを import する。`sender.ts` を新規作成したら、Plan 1 由来の生成/再生成 route もこの単一実装を使うよう揃えてよい(任意・テスト緑を確認)。

- [ ] **Step 4: route を実装**

`src/app/api/properties/sale-dm/campaigns/[id]/print/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import {
  renderLetterSheetHtml,
  type LetterRenderInput,
} from "@/lib/sale-dm-letter/templates";
import { resolveSender } from "@/lib/sale-dm-letter/sender";

// 確定済み(status=confirmed)の全通をページ区切りで連結した印刷用 HTML を返す。
// PII(本文・宛名・住所)を含むため no-store。本文は AuditLog に残さない。
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireSaleDmAccess();
    const { id } = await params;

    const campaign = await prisma.dmCampaign.findUnique({ where: { id } });
    if (!campaign) {
      throw new ApiError(404, "キャンペーンが見つかりません", "NOT_FOUND");
    }

    // 確定分のみ・作成順。variant は設定一式(designTemplate 等)を引くために include。
    const drafts = await prisma.dmRecipientDraft.findMany({
      where: { campaignId: id, status: "confirmed" },
      orderBy: { createdAt: "asc" },
      include: { variant: true },
    });

    const { senderName, senderContact } = resolveSender();

    const letters: LetterRenderInput[] = drafts.map((d) => ({
      designTemplate: d.variant.designTemplate,
      body: d.body,
      addresseeName: d.recipientName,
      honorific: d.honorific,
      recipientZip: d.recipientZip,
      recipientAddress: d.recipientAddress,
      senderName,
      senderContact,
      trackingToken: d.trackingToken,
    }));

    const html = renderLetterSheetHtml(campaign.name, letters);

    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-print-route.test.ts`
Expected: PASS(4 件)。

- [ ] **Step 6: コミット**

```bash
git add src/lib/sale-dm-letter/sender.ts src/app/api/properties/sale-dm/campaigns/[id]/print/route.ts src/lib/__tests__/sale-dm-print-route.test.ts
git commit -m "feat(sale-dm): add print route (confirmed drafts -> page-broken HTML, no-store)"
```

> 注: `sender.ts` を Plan 1 が既に作っていた場合は `git add` から外す。

---

### Task 4: CSV補助 列定義 + 行ビルダ(純関数)

**Files:**
- Create: `src/lib/sale-dm-letter/csv.ts`
- Test: `src/lib/__tests__/sale-dm-csv.test.ts`

**Interfaces:**
- Consumes: なし(純関数。`encodeCsv`/`sanitizeCsvCellForExcel` は route 側で使う)。
- Produces:
  - `SALE_DM_CSV_HEADERS: readonly string[]`(設定一式の列 + 宛名 + 本文 + 状態)
  - `interface SaleDmCsvRecord`(1通分の入力 = draft + variant の必要フィールド)
  - `buildSaleDmCsvRow(record: SaleDmCsvRecord): Record<string, string>`(ヘッダをキーにした1行。`null` は空文字・本文はそのまま1セル)

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-csv.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  SALE_DM_CSV_HEADERS,
  buildSaleDmCsvRow,
  type SaleDmCsvRecord,
} from "../sale-dm-letter/csv";

const record: SaleDmCsvRecord = {
  variantLabel: "A",
  designTemplate: "formal",
  tone: "formal",
  length: "medium",
  appeal: "price",
  strength: "low",
  recipientName: "田中 一郎",
  honorific: "様",
  recipientZip: "100-0001",
  recipientAddress: "東京都〇〇区△△1-2-3",
  status: "confirmed",
  body: "拝啓\n本文2行目",
};

describe("SALE_DM_CSV_HEADERS", () => {
  it("設定一式・宛名・本文の列を含む", () => {
    for (const h of ["型", "デザイン", "トーン", "長さ", "訴求軸", "強さ", "宛名", "敬称", "郵便番号", "送付先住所", "状態", "本文"]) {
      expect(SALE_DM_CSV_HEADERS).toContain(h);
    }
  });
});

describe("buildSaleDmCsvRow", () => {
  it("各列に対応する値を入れる(本文は1セル)", () => {
    const row = buildSaleDmCsvRow(record);
    expect(row["型"]).toBe("A");
    expect(row["デザイン"]).toBe("formal");
    expect(row["宛名"]).toBe("田中 一郎");
    expect(row["敬称"]).toBe("様");
    expect(row["郵便番号"]).toBe("100-0001");
    expect(row["送付先住所"]).toBe("東京都〇〇区△△1-2-3");
    expect(row["状態"]).toBe("confirmed");
    expect(row["本文"]).toBe("拝啓\n本文2行目");
  });

  it("null フィールドは空文字", () => {
    const row = buildSaleDmCsvRow({ ...record, recipientZip: null, recipientAddress: null });
    expect(row["郵便番号"]).toBe("");
    expect(row["送付先住所"]).toBe("");
  });

  it("全ヘッダのキーが存在する(欠けセルなし)", () => {
    const row = buildSaleDmCsvRow(record);
    for (const h of SALE_DM_CSV_HEADERS) {
      expect(Object.prototype.hasOwnProperty.call(row, h)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-csv.test.ts`
Expected: FAIL(モジュール未解決)。

- [ ] **Step 3: 実装**

`src/lib/sale-dm-letter/csv.ts`:

```ts
// 売却DM 補助 CSV(外部分析・差し込み用)の列定義と行ビルダ(純関数)。
// route 側で sanitizeCsvCellForExcel + encodeCsv(BOM+CRLF) に通す前提のため、
// ここでは formula injection 対策・quoting は行わない(セル値を素直に組むだけ)。
export const SALE_DM_CSV_HEADERS = [
  "型",
  "デザイン",
  "トーン",
  "長さ",
  "訴求軸",
  "強さ",
  "宛名",
  "敬称",
  "郵便番号",
  "送付先住所",
  "状態",
  "本文",
] as const;

export type SaleDmCsvHeader = (typeof SALE_DM_CSV_HEADERS)[number];

export interface SaleDmCsvRecord {
  variantLabel: string;
  designTemplate: string;
  tone: string;
  length: string;
  appeal: string;
  strength: string;
  recipientName: string;
  honorific: string;
  recipientZip: string | null;
  recipientAddress: string | null;
  status: string;
  body: string;
}

// null/undefined は空文字に倒す("null" という文字列は決して出さない)。
function s(value: string | null | undefined): string {
  return value ?? "";
}

export function buildSaleDmCsvRow(
  record: SaleDmCsvRecord,
): Record<SaleDmCsvHeader, string> {
  return {
    型: s(record.variantLabel),
    デザイン: s(record.designTemplate),
    トーン: s(record.tone),
    長さ: s(record.length),
    訴求軸: s(record.appeal),
    強さ: s(record.strength),
    宛名: s(record.recipientName),
    敬称: s(record.honorific),
    郵便番号: s(record.recipientZip),
    送付先住所: s(record.recipientAddress),
    状態: s(record.status),
    本文: s(record.body),
  };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-csv.test.ts`
Expected: PASS(列 1 + 行 3 = 4)。

- [ ] **Step 5: コミット**

```bash
git add src/lib/sale-dm-letter/csv.ts src/lib/__tests__/sale-dm-csv.test.ts
git commit -m "feat(sale-dm): add auto CSV headers + row builder (settings + addressee + body)"
```

---

### Task 5: CSV補助 route(GET .../campaigns/[id]/export)

**Files:**
- Create: `src/app/api/properties/sale-dm/campaigns/[id]/export/route.ts`(GET)
- Test: `src/lib/__tests__/sale-dm-export-route.test.ts`

**Interfaces:**
- Consumes: `requireSaleDmAccess`(Plan 1)、`SALE_DM_CSV_HEADERS`/`buildSaleDmCsvRow`/`SaleDmCsvRecord`(Task 4)、`encodeCsv`/`sanitizeCsvCellForExcel`(`@/lib/csv-encode`)、`writeAuditLog`(`@/lib/audit`)、`prisma`。
- Produces: route `GET /api/properties/sale-dm/campaigns/[id]/export`。**全下書き**(状態列で区別)を CSV 化し、BOM+CRLF・formula injection 対策・`text/csv`・`no-store`・`attachment` で返す。AuditLog は非PIIメタ(campaignId/件数のみ)。campaign 不在は 404。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-export-route.test.ts`(Task 3 と同じ `vi.mock` ブロックを流用し、`@/lib/csv-encode` は実モジュールを使う=mock しない):

```ts
import { vi } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response {
    static json = (b: unknown, init?: ResponseInit) => Response.json(b, init);
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(s: number, m: string, c = "ERROR") {
      super(m);
      this.status = s;
      this.code = c;
    }
  }
  return {
    ApiError: MockApiError,
    handleApiError: vi.fn((e: unknown) =>
      e instanceof MockApiError
        ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status })
        : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 }),
    ),
  };
});

const writeAuditLog = vi.fn();
vi.mock("@/lib/audit", () => ({ writeAuditLog }));

const requireSaleDmAccess = vi.fn();
vi.mock("@/lib/sale-dm-letter/route-guard", () => ({ requireSaleDmAccess }));

vi.mock("@/lib/prisma", () => ({
  default: {
    dmCampaign: { findUnique: vi.fn() },
    dmRecipientDraft: { findMany: vi.fn() },
  },
}));

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { ApiError } from "@/lib/api-helpers";
import { GET } from "../../app/api/properties/sale-dm/campaigns/[id]/export/route";

const pm = prismaMock as never as {
  dmCampaign: { findUnique: ReturnType<typeof vi.fn> };
  dmRecipientDraft: { findMany: ReturnType<typeof vi.fn> };
};

const variant = {
  label: "A",
  designTemplate: "formal",
  tone: "formal",
  length: "medium",
  appeal: "price",
  strength: "low",
};
const draft = {
  recipientName: "田中 一郎",
  honorific: "様",
  recipientZip: "100-0001",
  recipientAddress: "東京都〇〇区",
  status: "confirmed",
  body: "本文",
  variant,
};

const ctx = { params: Promise.resolve({ id: "c1" }) };
const req = () => new Request("http://x/api/properties/sale-dm/campaigns/c1/export");

beforeEach(() => {
  vi.clearAllMocks();
  requireSaleDmAccess.mockResolvedValue({ session: { id: "u1" } });
  pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", name: "テスト" });
  pm.dmRecipientDraft.findMany.mockResolvedValue([draft]);
});

describe("GET .../campaigns/[id]/export", () => {
  it("text/csv + BOM + no-store + attachment で返す", async () => {
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    const csv = await res.text();
    expect(csv.charCodeAt(0)).toBe(0xfeff); // BOM
    expect(csv).toContain("型,デザイン"); // ヘッダ
    expect(csv).toContain("田中 一郎");
    expect(csv).toContain("\r\n"); // CRLF
  });

  it("formula injection: 先頭 = で始まる値は ' でエスケープされる", async () => {
    pm.dmRecipientDraft.findMany.mockResolvedValue([
      { ...draft, recipientName: "=HYPERLINK(1)" },
    ]);
    const res = await GET(req() as never, ctx);
    const csv = await res.text();
    expect(csv).toContain("'=HYPERLINK(1)");
  });

  it("カンマ/改行/クオートを含む本文は RFC quoting される", async () => {
    pm.dmRecipientDraft.findMany.mockResolvedValue([
      { ...draft, body: 'a,b\n"c"' },
    ]);
    const res = await GET(req() as never, ctx);
    const csv = await res.text();
    expect(csv).toContain('"a,b\n""c"""');
  });

  it("AuditLog は非PIIメタのみ(本文を含まない)", async () => {
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(200);
    expect(writeAuditLog).toHaveBeenCalledOnce();
    const detail = writeAuditLog.mock.calls[0][0].detail;
    expect(detail.campaignId).toBe("c1");
    expect(JSON.stringify(detail)).not.toContain("本文");
    expect(JSON.stringify(detail)).not.toContain("田中");
  });

  it("campaign 不在は 404", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue(null);
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(404);
  });

  it("権限不足で 403・DB を読まない", async () => {
    requireSaleDmAccess.mockRejectedValue(new ApiError(403, "x", "FORBIDDEN"));
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(403);
    expect(pm.dmCampaign.findUnique).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-export-route.test.ts`
Expected: FAIL(route 未実装)。

- [ ] **Step 3: route を実装**

`src/app/api/properties/sale-dm/campaigns/[id]/export/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { encodeCsv, sanitizeCsvCellForExcel } from "@/lib/csv-encode";
import {
  SALE_DM_CSV_HEADERS,
  buildSaleDmCsvRow,
  type SaleDmCsvRecord,
} from "@/lib/sale-dm-letter/csv";

// キャンペーンの全下書きを「設定一式 + 宛名 + 本文 + 状態」の CSV にして返す。
// PII(本文・宛名・住所)を含むため no-store。AuditLog には件数等の非PIIメタのみ残す。
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id } = await params;

    const campaign = await prisma.dmCampaign.findUnique({ where: { id } });
    if (!campaign) {
      throw new ApiError(404, "キャンペーンが見つかりません", "NOT_FOUND");
    }

    const drafts = await prisma.dmRecipientDraft.findMany({
      where: { campaignId: id },
      orderBy: { createdAt: "asc" },
      include: { variant: true },
    });

    const records: SaleDmCsvRecord[] = drafts.map((d) => ({
      variantLabel: d.variant.label,
      designTemplate: d.variant.designTemplate,
      tone: d.variant.tone,
      length: d.variant.length,
      appeal: d.variant.appeal,
      strength: d.variant.strength,
      recipientName: d.recipientName,
      honorific: d.honorific,
      recipientZip: d.recipientZip,
      recipientAddress: d.recipientAddress,
      status: d.status,
      body: d.body,
    }));

    // 各セルを formula injection 対策で無害化してから encodeCsv(BOM+CRLF)へ。
    const sanitizedRows = records.map((record) => {
      const row = buildSaleDmCsvRow(record);
      return Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          sanitizeCsvCellForExcel(value),
        ]),
      );
    });

    const csv = encodeCsv([...SALE_DM_CSV_HEADERS], sanitizedRows, { bom: true });

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_campaign_csv_export",
      targetTable: "dm_campaigns",
      detail: {
        campaignId: id,
        count: records.length,
        exportedAt: new Date().toISOString(),
      },
    });

    const fileDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="sale_dm_${fileDate}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-export-route.test.ts`
Expected: PASS(6 件)。

- [ ] **Step 5: 全テスト + lint + build を確認**

Run: `npm test` → 既存 + 新規すべて green。
Run: `npm run lint` → エラーなし。
Run: `npm run build` → 成功(`.../print` と `.../export` route が manifest に出る)。

- [ ] **Step 6: コミット**

```bash
git add src/app/api/properties/sale-dm/campaigns/[id]/export/route.ts src/lib/__tests__/sale-dm-export-route.test.ts
git commit -m "feat(sale-dm): add CSV export route (settings+body, BOM+CRLF, formula-injection safe, no-store)"
```

---

## Self-Review(本プラン → 設計書の突合)

- デザインテンプレート3種(formal/soft/impact)HTML/CSS レンダラ・純関数・HTMLエスケープ: Task 1 ✅(`renderLetterHtml` + `escapeHtml` + テンプレ別スコープ CSS + CSS 変数で可変要素)。
- 流し込み(AI本文 + 宛名 + 差出人 + 追跡リンク差し込み枠): Task 1 ✅(`tracking-slot` は枠のみ・URL/QR は描かない=Plan 5)。
- 印刷用 CSS(`@page` / `page-break-after`)・まとめ印刷=全確定通を1ドキュメントに連結: Task 2 ✅(`renderLetterSheetHtml`・最後の通は page-break 無しで末尾空白ページ回避)。
- まとめ印刷 route(GET .../print・確定分のみ・text/html・no-store・権限ゲート): Task 3 ✅(`status=confirmed` で findMany・`requireSaleDmAccess`・campaign 不在 404・確定0件でも200)。
- CSV補助 route(GET .../export・設定一式列+本文+宛名・encodeCsv/sanitize・BOM+CRLF・formula injection): Task 4(列/行純関数)+ Task 5(route)✅。
- テスト網羅: 3テンプレ描画(流し込み・ページ区切り・HTMLエスケープ)=Task 1,2 / CSV列・エスケープ・BOM=Task 4,5 / print・export の権限ゲート・no-store=Task 3,5 ✅。
- **未カバー(意図的に後続プラン)**: QR/短縮URL 実体・`/t/[token]`・`proxy.ts` 公開パス=Plan 5(本プランは差し込み枠+コメントのみ)。複数型と割当=Plan 3(本プランは draft が持つ `variantId`→`variant` を読むだけ)。配達/反響/集計=Plan 4。物件一覧/作業画面 UI=Plan 6。
- Placeholder スキャン: なし(各 step に実コード/実コマンド。`tracking-slot` は「実体のあるプレースホルダ DOM ノード+コメント」で TODO 文字列ではない)。
- PII/秘密: 外部 API 非呼び出し・`NEXT_PUBLIC_*` 不使用・print/export とも `no-store`・AuditLog は非PIIメタのみ(本プランで実テスト検証=Task 5)✅。raw SQL なし ✅。
- 型整合: `LetterRenderInput`/`SaleDmCsvRecord` を本プランで定義し全 Task で同名使用。`requireSaleDmAccess`/`LetterOptions`/Prisma モデルは Plan 1 produces を consume(再定義せず)✅。

> 既知の実装時確認点(レビュアー向け): (1) `DmRecipientDraft.recipientZip`/`recipientAddress` の null 許容・`variant` relation 名(`variant`)・`DmVariant.label`/`designTemplate` 等のフィールド名は Plan 1 の `prisma/schema.prisma` を Read して厳密一致させる。(2) `resolveSender()` が Plan 1 で既に存在するか確認し、あれば本プランの `sender.ts` は作らずそれを import(DRY)。存在しなければ Task 3 Step 3 の `sender.ts` を新規作成し、env 表に `SALE_DM_SENDER_NAME`/`SALE_DM_SENDER_CONTACT` の2件が追記済みか確認。(3) dynamic route の第2引数は `{ params: Promise<{ id: string }> }`(Next.js 16・本リポジトリ既存 route と同形)。(4) route テストの `vi.mock` fixture は本リポジトリの dm-export route test に厳密一致させる(`getUserPermissions`/`hasPermission` の形に依存する箇所は本プランには無いが、`requireSaleDmAccess` を直接 mock しているため影響を受けない)。
