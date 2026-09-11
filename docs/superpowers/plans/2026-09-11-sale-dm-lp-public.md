# 売却DM LP型「公開LP」(第1段 PR3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** お手紙のQR(`/t/<token>`)を読んだ所有者に、宛先に付いたLP型(文章+写真と図)を組み立てた**アプリ内のご案内ページ**を返す。PC/スマホ両方に最適化。送付前は「プレビュー」帯。社内プレビュー(PC/スマホ切替)。電話ボタンのタップ計測。LP型ごと/組合せの集計表を解禁。申込フォームの中身(PR4)とメール(PR5)は作らない。

**Architecture:** `/t/[token]` は既存の計数(`recordTrackingHit`)をそのまま先に行い、その後に**新しい読み出し `loadLpPageData`**(宛先→LP型の文章/枠/写真の publicId・物件の所在(町名まで)と種別・会社案内・配信停止URL)が「LP型に文章あり」を返したときだけ **HTML(200)** を返す。それ以外は従来どおり 302。ページは**純関数 `renderLpPage(input)`**(React なし・全値 escape・CSS inline・外部読み込みなし・`unsubscribe-page.ts` と同じ作り)。`LpRenderInput` には**氏名・番地・所有者住所の列が存在しない**(構造的に混入不能)。差し込みは `expandLetterTags` を共用し、未解決なら一般語に置換。電話タップは `POST /t/[token]/phone-tap`(sendBeacon・best-effort・sent のみ計数・新列 `phoneTapCount/phoneTapFirstAt`)。社内プレビューは認証必須の `GET .../lp-variants/[lpId]/preview?device=sp|pc`(見本の差し込み・プレビュー帯)を画面の iframe で PC/スマホ切替表示。

**Tech Stack:** Next.js App Router route handlers, Prisma 7(`@/generated/prisma`), zod v4, vitest(`src/lib/__tests__/`), React client components(Tailwind・lucide-react)。**新規 npm 依存なし。**

**Spec:** `docs/superpowers/specs/2026-09-08-sale-dm-lp-autobuild-design.md` §2.4(公開LPの表示・**PC/スマホ最適化の追記 2026-09-11**)・§2.1(集計)・§2.7・§2.8・§3-3。

## Global Constraints

- **新規 npm 依存を足さない。** 公開ページは React を使わず文字列で組み立てる(`src/lib/sale-dm-letter/unsubscribe-page.ts` と同じ)。外部読み込み(font/CSS/JS/CDN)なし。画像は `/lp-assets/<publicId>` だけ。図は `renderFigureSvg` の SVG を**インライン**で埋める。
- **PII 不在は構造で保証**: `LpRenderInput` に氏名・番地・所有者住所・trackingToken 以外の識別子を持たせない(テストで型のキー集合を固定)。差し込みは `coarsePropertyLocation`(町名まで)と `propertyTypeLabel` のみ。未解決なら `{{物件所在}}`→「ご所有の物件の周辺」、`{{物件種別}}`→「不動産」に置換(**波括弧を画面に出さない**=テストで固定)。
- **escape**: 全ての動的文字列は `escapeHtml`(`src/lib/sale-dm-letter/templates/index.ts`)を通す。`renderFigureSvg` の出力だけは信頼済み(自前生成)としてそのまま埋める。`<script>` は**電話タップ用の固定文字列1本のみ**(動的値は token を `JSON.stringify` で埋める)。
- **入口4通りの挙動(既存維持)**: 未知token→既定LPへ302(列挙耐性)/既定LP未設定→404/送付前→**LP型に文章があれば「プレビュー」帯付きHTML(計数なし)**・無ければ従来どおり302/送付済み→HTML(初回のみ計数・監査)。LP型なし・文章未保存は全て従来どおり302。
- **ヘッダ**: HTML は `PUBLIC_PAGE_HEADERS`(`text/html; charset=utf-8`・`no-store`・`noindex`・`no-referrer`・`nosniff`)。
- **レスポンシブ**: 同一HTML。スマホ(〜767px)=1列・画像幅いっぱい・**画面下固定バー**(「無料査定を申し込む」「電話」・44px以上・本文末尾に余白)。PC(768px〜)=中央1列 `max-width:760px`・ヒーロー16:9・固定バーなし。文字16px以上。`prefers-reduced-motion` 尊重。
- **申込フォームは本PRでは出さない**(PR4)。申込ボタンは会社案内+電話の枠へのページ内リンク。`renderLpPage` は `form: null` を受ける口だけ持つ。
- **電話タップ**: `POST /t/[token]/phone-tap` は常に 204(未知token でも=オラクル封じ)。sent のみ計数。`lockPropertyRow → tx.dmRecipientDraft.update`(`recordTrackingHit` と同じ順・`lockOwnersForUpdate` は取らない)。初回のみ監査 `sale_dm_lp_phone_tap`(detail `{ at }`)。反響(outcome)は**立てない**。レート制限 60/分。
- **プレビュー**: `requireSaleDmAccess`+`assertSaleDmCampaignOwned`。文章未保存は 409 `TEMPLATE_MISSING`。監査 `sale_dm_lp_preview_view`(`campaignId`,`device`,`viewedAt`)。iframe は同一オリジン。
- **監査 allowlist**(`src/lib/audit-log-detail-safety.ts`)に `sale_dm_tracking_hit`(既存の抜け=`firstHit`,`at`)・`sale_dm_lp_phone_tap`(`at`)・`sale_dm_lp_preview_view`(`device`,`viewedAt`)を足し、`sale-dm-external-audit-visible.test.ts` の CASES と `admin/audit-logs/page.tsx` の日本語ラベルも足す。
- **集計**: `LP_METRICS_ENABLED = true` に切替(API と画面の両方が同じ定数を見る)。LP型表に「電話タップ」件数と率を追加(分母=閲覧あり)。
- **走査テストの縛り**: 書き込み route は `requireSaleDmWriteAccess`(公開の `/t/` 配下は `src/app/api/properties/sale-dm` の外=対象外); `src/` に `saleDmLetter` を書かない; Tailwind `bg-blue-600` 禁止・`fixed inset-0` モーダル/`border-b-2` タブ手書き禁止(`ModalShell`/`ConfirmDialog`); dashboard page に生 `<h1` 禁止; `dm-writer-lock-order.test.ts` の型で phone-tap の順序を固定。
- 各ファイルの改行は既存に合わせる(CRLF 混在禁止)・NUL 等の制御文字禁止・`git add` は列挙・commit 末尾に `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。「緑」の前に `npx vitest run`(フル)+`npx tsc --noEmit`+`npx eslint <変更ファイル>`+`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build`。
- 専用 worktree `property-management-worktrees/sale-dm-lp-public`(branch `feat/sale-dm-lp-public`・base `origin/main` 5c22a606)。

### 設計書からの読み替え(controller ruling・計画で確定)
1. **申込フォームは枠も出さない**(§2.4 の「申込フォーム」段は PR4 で追加)。空のフォームや disabled のフォームを所有者に見せるより、電話案内へ誘導する方が誠実。
2. **会社案内は `senderName`/`senderContact`(売却DM設定)を流用**。専用の会社案内欄は作らない。`senderContact` から電話番号らしい文字列(`0\d{1,4}-?\d{1,4}-?\d{3,4}`)を取り出せたときだけ `tel:` ボタンを出し、取れなければ連絡先を文字で出す。
3. **既定LP未設定→404 は維持**(在庫の入口の fail-closed を壊さない)。アプリ内LPも既定LPの設定が前提。
4. **電話タップの列は新設**(`phoneTapCount`・`phoneTapFirstAt`)。既存 `phoneInquiryAt`(担当者が手で立てる電話反響)とは別物。

---

## File Structure

| 種別 | パス | 責務 |
|---|---|---|
| Modify | `prisma/schema.prisma` / `prisma/migrations/20260911100000_add_dm_phone_tap/migration.sql` | `DmRecipientDraft.phoneTapCount Int @default(0)`・`phoneTapFirstAt DateTime?`(additive) |
| Create | `src/lib/sale-dm-letter/lp-render-input.ts` | `LpRenderInput` 型・`expandLpText`(未解決の一般語置換)・`extractPhone`・`buildLpRenderInput`(DB行→入力の純関数) |
| Create | `src/lib/sale-dm-letter/lp-page.ts` | `renderLpPage(input)`(HTML 純関数・CSS inline・レスポンシブ・固定バー・電話タップ script) |
| Create | `src/lib/sale-dm-letter/lp-page-loader.ts` | `loadLpPageData(client, token)`(宛先→LP型/枠/写真/物件/設定を読む・PII を渡さない) |
| Modify | `src/app/t/[token]/route.ts` | 計数後に `loadLpPageData` → HTML or 従来 302 |
| Create | `src/app/t/[token]/phone-tap/route.ts` | 電話タップ計数(常に 204) |
| Create | `src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/preview/route.ts` | 社内プレビュー HTML |
| Create | `src/components/sale-dm/lp-preview-panel.tsx` | iframe + PC/スマホ切替 |
| Modify | `src/components/sale-dm/lp-variant-manager.tsx` | 「プレビュー」ボタン(Eye)+パネル |
| Modify | `src/lib/sale-dm-letter/lp-metrics-flag.ts` | `true` |
| Modify | `src/lib/sale-dm-letter/aggregate.ts` / `aggregate-view-model.ts` / `src/components/sale-dm/aggregate-view.tsx` / aggregate route | LP型表に電話タップ |
| Modify | `src/lib/audit-log-detail-safety.ts` / `src/app/(dashboard)/admin/audit-logs/page.tsx` | allowlist 3件・ラベル |
| Modify | `src/lib/api-client.ts` | `LP_PREVIEW_URL`・`SaleDmLpVariant` に `hasTemplate` は不要(`headline` で判定) |
| Modify | `public/docs/guide.html` / `manual.html` / `docs/deploy.md` | 文書 |
| Test | `src/lib/__tests__/sale-dm-lp-render-input.test.ts`, `sale-dm-lp-page.test.ts`, `sale-dm-lp-page-loader.test.ts`, `sale-dm-tracking-route.test.ts`(追記), `sale-dm-lp-phone-tap-route.test.ts`, `sale-dm-lp-preview-route.test.ts`, `sale-dm-lp-preview-ui-scan.test.ts`, `dm-writer-lock-order.test.ts`(追記), `sale-dm-aggregate-two-axis.test.ts`(追記), `sale-dm-aggregate-route-lp-metrics.test.ts`(更新), `sale-dm-external-audit-visible.test.ts`(追記) | |

---

### Task 1: スキーマ(電話タップ列)と migration

**Files:**
- Modify: `prisma/schema.prisma`(`model DmRecipientDraft` の `phoneInquiryAt` の直後)
- Create: `prisma/migrations/20260911100000_add_dm_phone_tap/migration.sql`
- Test: `src/lib/__tests__/sale-dm-phone-tap-columns.test.ts`

**Interfaces:**
- Produces: `DmRecipientDraft.phoneTapCount: number`(既定0)、`phoneTapFirstAt: Date | null`。列名は後続 Task が verbatim で使う。

- [ ] **Step 1: テスト**

```ts
// src/lib/__tests__/sale-dm-phone-tap-columns.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const schema = readFileSync(path.resolve(process.cwd(), "prisma/schema.prisma"), "utf8").replace(/\r\n/g, "\n");
const sql = readFileSync(path.resolve(process.cwd(), "prisma/migrations/20260911100000_add_dm_phone_tap/migration.sql"), "utf8").replace(/\r\n/g, "\n");

describe("電話タップの列(公開LPの電話ボタン)", () => {
  const model = schema.slice(schema.indexOf("model DmRecipientDraft {"), schema.indexOf("model DmRecipientDraftOwner {"));
  it("DmRecipientDraft に phoneTapCount / phoneTapFirstAt がある", () => {
    expect(model).toMatch(/phoneTapCount\s+Int\s+@default\(0\)\s+@map\("phone_tap_count"\)/);
    expect(model).toMatch(/phoneTapFirstAt\s+DateTime\?\s+@map\("phone_tap_first_at"\)/);
  });
  it("migration は additive のみ(ALTER TABLE ADD COLUMN 2本・DROP/UPDATE なし)", () => {
    expect(sql).toMatch(/ALTER TABLE "dm_recipient_drafts" ADD COLUMN\s+"phone_tap_count" INTEGER NOT NULL DEFAULT 0/);
    expect(sql).toMatch(/ADD COLUMN\s+"phone_tap_first_at" TIMESTAMP\(3\)/);
    expect(sql).not.toMatch(/DROP|UPDATE|DELETE/i);
  });
  it("既存の手動の電話反響(phoneInquiryAt)は残っている", () => {
    expect(model).toMatch(/phoneInquiryAt\s+DateTime\?/);
  });
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-phone-tap-columns.test.ts` → FAIL

- [ ] **Step 3: schema**(`phoneInquiryAt` 行の直後に追加)

```prisma
  // 公開LPの電話ボタンのタップ(設計 2026-09-08 §2.4)。タップ≠通話なので反響(outcome)は立てない。
  // phoneInquiryAt(担当者が手で立てる電話反響)とは別物。
  phoneTapCount   Int       @default(0) @map("phone_tap_count")
  phoneTapFirstAt DateTime? @map("phone_tap_first_at")
```

migration.sql(既存 `20260909000000_add_dm_lp_variants` の書式に合わせる):

```sql
-- 公開LPの電話ボタンのタップ計測(additive)
ALTER TABLE "dm_recipient_drafts" ADD COLUMN     "phone_tap_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "dm_recipient_drafts" ADD COLUMN     "phone_tap_first_at" TIMESTAMP(3);
```

- [ ] **Step 4: 確認** — Run: `npx prisma validate && npx prisma generate && npx vitest run src/lib/__tests__/sale-dm-phone-tap-columns.test.ts && npx tsc --noEmit` → PASS

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260911100000_add_dm_phone_tap/migration.sql src/lib/__tests__/sale-dm-phone-tap-columns.test.ts
git commit -m "feat(sale-dm): 公開LPの電話タップ計測の列を追加(additive)"
```

---

### Task 2: 描画入力の純関数 `lp-render-input.ts`

**Files:**
- Create: `src/lib/sale-dm-letter/lp-render-input.ts`
- Test: `src/lib/__tests__/sale-dm-lp-render-input.test.ts`

**Interfaces:**
- Consumes: `expandLetterTags`, `hasUnresolvedTag`, `coarsePropertyLocation`, `propertyTypeLabel`(`./tags`)、`lpBodyHeadings`, `LpFaqItem`(`./lp-template`)、`isFigureKind`, `FigureKind`(`./lp-figures`)。
- Produces:
  ```ts
  export type LpMode = "live" | "preview";
  export interface LpImage { publicId: string; width: number; height: number }
  export type LpSectionMedia = { kind: "asset"; image: LpImage } | { kind: "figure"; figureKind: FigureKind } | null;
  export interface LpRenderInput {
    mode: LpMode;
    headline: string;            // 差し込み済み
    lead: string | null;         // 差し込み済み
    sections: Array<{ heading: string; paragraphs: string[]; media: LpSectionMedia }>;
    intro: string[];             // 最初の■より前の段落(あれば)
    faq: LpFaqItem[];
    hero: LpImage | null;
    company: { name: string | null; contact: string | null; phone: string | null };
    unsubscribeUrl: string | null;
    phoneTapToken: string | null; // live のときだけ trackingToken(電話タップ送信先に使う)。preview は null
    form: null;                  // PR4 で埋める口
  }
  export const LP_RENDER_INPUT_KEYS = [...] as const;   // 上のキー集合(PII 列が増えていないことをテストで固定)
  export function expandLpText(text: string, values: { location: string | null; propertyType: string | null }): string;
  export function extractPhone(contact: string | null): string | null;   // "03-1234-5678" 等 → "0312345678"(tel: 用)。無ければ null
  export function splitBodyIntoSections(body: string): { intro: string[]; sections: Array<{ heading: string; paragraphs: string[] }> };
  export interface LpSourceRows {
    variant: { headline: string; lead: string | null; bodyText: string; faqJson: unknown };
    media: Array<{ slot: string; heading: string | null; figureKind: string | null; asset: { publicId: string; width: number; height: number; deletedAt: Date | null } | null }>;
    property: { address: string | null; propertyType: string | null };
    company: { senderName: string | null; senderContact: string | null };
  }
  export function buildLpRenderInput(rows: LpSourceRows, opts: { mode: LpMode; unsubscribeUrl: string | null; phoneTapToken: string | null }): LpRenderInput;
  ```

- [ ] **Step 1: テスト**

```ts
// src/lib/__tests__/sale-dm-lp-render-input.test.ts
import { describe, it, expect } from "vitest";
import { expandLpText, extractPhone, splitBodyIntoSections, buildLpRenderInput, LP_RENDER_INPUT_KEYS, type LpSourceRows } from "../sale-dm-letter/lp-render-input";

const rows = (over: Partial<LpSourceRows> = {}): LpSourceRows => ({
  variant: { headline: "ご所有の{{物件種別}}のご売却について", lead: "{{物件所在}}周辺で売却をご検討の方へ", bodyText: "はじめに一言。\n\n■売却の進め方\n流れの説明。\n\n二段落目。\n■費用について\n費用の説明。", faqJson: [{ q: "費用は？", a: "無料です。" }] },
  media: [
    { slot: "hero", heading: null, figureKind: null, asset: { publicId: "a".repeat(32), width: 1600, height: 900, deletedAt: null } },
    { slot: "section", heading: "売却の進め方", figureKind: "sale_flow", asset: null },
    { slot: "section", heading: "費用について", figureKind: null, asset: { publicId: "b".repeat(32), width: 1200, height: 900, deletedAt: null } },
  ],
  property: { address: "東京都世田谷区経堂1-2-3 ○○ハイツ101", propertyType: "house" },
  company: { senderName: "株式会社リガーレ", senderContact: "TEL 03-1234-5678 / info@example.com" },
  ...over,
});

describe("expandLpText", () => {
  it("町名までの所在と種別を差し込む", () => {
    expect(expandLpText("{{物件所在}}の{{物件種別}}", { location: "世田谷区経堂", propertyType: "戸建" })).toBe("世田谷区経堂の戸建");
  });
  it("解決できない記号は一般語に置換し、波括弧を残さない", () => {
    const out = expandLpText("{{物件所在}}の{{物件種別}}", { location: null, propertyType: null });
    expect(out).toBe("ご所有の物件の周辺の不動産");
    expect(out).not.toMatch(/[{}]/);
  });
});

describe("extractPhone", () => {
  it("連絡先の文字列から電話番号だけを取り出す(tel: 用にハイフン除去)", () => {
    expect(extractPhone("TEL 03-1234-5678 / info@example.com")).toBe("0312345678");
    expect(extractPhone("090 1234 5678")).toBe("09012345678");
    expect(extractPhone("info@example.com")).toBeNull();
    expect(extractPhone(null)).toBeNull();
  });
});

describe("splitBodyIntoSections", () => {
  it("最初の■より前を intro に、■ごとに段落を分ける(空行区切り・LF正規化)", () => {
    const r = splitBodyIntoSections("はじめに。\r\n\r\n■A\r\n一\r\n\r\n二\r\n■B\r\n三");
    expect(r.intro).toEqual(["はじめに。"]);
    expect(r.sections).toEqual([{ heading: "A", paragraphs: ["一", "二"] }, { heading: "B", paragraphs: ["三"] }]);
  });
  it("同じ■見出しが2回あっても2つの節として並ぶ(表示は本文どおり)", () => {
    expect(splitBodyIntoSections("■A\nx\n■A\ny").sections.length).toBe(2);
  });
});

describe("buildLpRenderInput", () => {
  it("差し込み済みの見出し/リード・節ごとの枠・ヒーロー・会社案内・電話を組み立てる", () => {
    const out = buildLpRenderInput(rows(), { mode: "live", unsubscribeUrl: "https://lp.example.com/u/x", phoneTapToken: "tok" });
    expect(out.headline).toBe("ご所有の戸建のご売却について");
    expect(out.lead).toBe("世田谷区経堂周辺で売却をご検討の方へ");
    expect(out.intro).toEqual(["はじめに一言。"]);
    expect(out.sections[0]).toEqual({ heading: "売却の進め方", paragraphs: ["流れの説明。", "二段落目。"], media: { kind: "figure", figureKind: "sale_flow" } });
    expect(out.sections[1].media).toEqual({ kind: "asset", image: { publicId: "b".repeat(32), width: 1200, height: 900 } });
    expect(out.hero).toEqual({ publicId: "a".repeat(32), width: 1600, height: 900 });
    expect(out.company).toEqual({ name: "株式会社リガーレ", contact: "TEL 03-1234-5678 / info@example.com", phone: "0312345678" });
    expect(out.faq).toEqual([{ q: "費用は？", a: "無料です。" }]);
    expect(out.phoneTapToken).toBe("tok");
    expect(out.form).toBeNull();
  });
  it("削除済みの写真・知らない図・本文に無い見出しの行は枠なし(null)になる", () => {
    const out = buildLpRenderInput(rows({ media: [
      { slot: "hero", heading: null, figureKind: null, asset: { publicId: "z".repeat(32), width: 1, height: 1, deletedAt: new Date() } },
      { slot: "section", heading: "売却の進め方", figureKind: "nope", asset: null },
      { slot: "section", heading: "無い見出し", figureKind: "sale_flow", asset: null },
    ] }), { mode: "preview", unsubscribeUrl: null, phoneTapToken: null });
    expect(out.hero).toBeNull();
    expect(out.sections.map((s) => s.media)).toEqual([null, null]);
  });
  it("所在が読めない物件でも波括弧は出ない・faqJson が壊れていれば空配列", () => {
    const out = buildLpRenderInput(rows({ property: { address: null, propertyType: null }, variant: { ...rows().variant, faqJson: "broken" } }), { mode: "live", unsubscribeUrl: null, phoneTapToken: "t" });
    expect(out.headline).toBe("ご所有の不動産のご売却について");
    expect(out.lead).not.toMatch(/[{}]/);
    expect(out.faq).toEqual([]);
  });
  it("入力型のキー集合は固定(氏名・番地・所有者住所・token 以外の識別子が増えたら落ちる)", () => {
    const out = buildLpRenderInput(rows(), { mode: "live", unsubscribeUrl: null, phoneTapToken: "t" });
    expect(Object.keys(out).sort()).toEqual([...LP_RENDER_INPUT_KEYS].sort());
    expect(LP_RENDER_INPUT_KEYS).toEqual(["mode", "headline", "lead", "intro", "sections", "faq", "hero", "company", "unsubscribeUrl", "phoneTapToken", "form"]);
    for (const k of LP_RENDER_INPUT_KEYS) expect(/name|zip|address|owner|recipient/i.test(k) && k !== "company").toBe(false);
  });
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-render-input.test.ts` → FAIL

- [ ] **Step 3: 実装**

```ts
// src/lib/sale-dm-letter/lp-render-input.ts
/**
 * 公開LP(設計 2026-09-08 §2.4)の描画入力。DB 行 → 純粋な描画入力への変換だけを担う。
 *  - 差し込みは町名までの所在と物件種別の2つだけ(expandLetterTags を共用)。解決できなければ一般語に置換し、
 *    波括弧を所有者の画面に出さない。
 *  - LpRenderInput には氏名・番地・所有者住所を**持たせない**(キー集合をテストで固定)。
 */
import { expandLetterTags, hasUnresolvedTag, coarsePropertyLocation, propertyTypeLabel } from "./tags";
import type { LpFaqItem } from "./lp-template";
import { isFigureKind, type FigureKind } from "./lp-figures";

export type LpMode = "live" | "preview";
export interface LpImage { publicId: string; width: number; height: number }
export type LpSectionMedia = { kind: "asset"; image: LpImage } | { kind: "figure"; figureKind: FigureKind } | null;
export interface LpRenderInput {
  mode: LpMode;
  headline: string;
  lead: string | null;
  intro: string[];
  sections: Array<{ heading: string; paragraphs: string[]; media: LpSectionMedia }>;
  faq: LpFaqItem[];
  hero: LpImage | null;
  company: { name: string | null; contact: string | null; phone: string | null };
  unsubscribeUrl: string | null;
  phoneTapToken: string | null;
  form: null;
}
export const LP_RENDER_INPUT_KEYS = ["mode", "headline", "lead", "intro", "sections", "faq", "hero", "company", "unsubscribeUrl", "phoneTapToken", "form"] as const;

const FALLBACK_LOCATION = "ご所有の物件の周辺";
const FALLBACK_TYPE = "不動産";

export function expandLpText(text: string, values: { location: string | null; propertyType: string | null }): string {
  const expanded = expandLetterTags(text, values);
  if (!hasUnresolvedTag(expanded)) return expanded;
  return expanded.split("{{物件所在}}").join(FALLBACK_LOCATION).split("{{物件種別}}").join(FALLBACK_TYPE);
}

export function extractPhone(contact: string | null): string | null {
  if (!contact) return null;
  const m = contact.match(/0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}/);
  if (!m) return null;
  const digits = m[0].replace(/[-\s]/g, "");
  return digits.length >= 10 && digits.length <= 11 ? digits : null;
}

export function splitBodyIntoSections(body: string): { intro: string[]; sections: Array<{ heading: string; paragraphs: string[] }> } {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const intro: string[] = [];
  const sections: Array<{ heading: string; paragraphs: string[] }> = [];
  let cur: string[] = [];
  let target: string[] = intro;
  const flush = () => { const t = cur.join("\n").trim(); if (t) target.push(t); cur = []; };
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("■")) {
      flush();
      sections.push({ heading: line.slice(1).trim(), paragraphs: [] });
      target = sections[sections.length - 1].paragraphs;
      continue;
    }
    if (line === "") { flush(); continue; }
    cur.push(line);
  }
  flush();
  return { intro, sections: sections.filter((s) => s.heading.length > 0) };
}

export interface LpSourceRows {
  variant: { headline: string; lead: string | null; bodyText: string; faqJson: unknown };
  media: Array<{ slot: string; heading: string | null; figureKind: string | null; asset: { publicId: string; width: number; height: number; deletedAt: Date | null } | null }>;
  property: { address: string | null; propertyType: string | null };
  company: { senderName: string | null; senderContact: string | null };
}

function parseFaq(v: unknown): LpFaqItem[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => (x && typeof x === "object" && typeof (x as LpFaqItem).q === "string" && typeof (x as LpFaqItem).a === "string" ? [{ q: (x as LpFaqItem).q, a: (x as LpFaqItem).a }] : []));
}

function toImage(asset: LpSourceRows["media"][number]["asset"]): LpImage | null {
  if (!asset || asset.deletedAt) return null;
  return { publicId: asset.publicId, width: asset.width, height: asset.height };
}

export function buildLpRenderInput(rows: LpSourceRows, opts: { mode: LpMode; unsubscribeUrl: string | null; phoneTapToken: string | null }): LpRenderInput {
  const values = { location: coarsePropertyLocation(rows.property.address), propertyType: propertyTypeLabel(rows.property.propertyType) };
  const { intro, sections } = splitBodyIntoSections(rows.variant.bodyText);
  const heroRow = rows.media.find((m) => m.slot === "hero");
  const byHeading = new Map<string, LpSourceRows["media"][number]>();
  for (const m of rows.media) if (m.slot === "section" && m.heading) byHeading.set(m.heading, m);
  const mediaFor = (heading: string): LpSectionMedia => {
    const m = byHeading.get(heading);
    if (!m) return null;
    const image = toImage(m.asset);
    if (image) return { kind: "asset", image };
    if (m.figureKind && isFigureKind(m.figureKind)) return { kind: "figure", figureKind: m.figureKind };
    return null;
  };
  return {
    mode: opts.mode,
    headline: expandLpText(rows.variant.headline, values),
    lead: rows.variant.lead ? expandLpText(rows.variant.lead, values) : null,
    intro: intro.map((p) => expandLpText(p, values)),
    sections: sections.map((s) => ({ heading: expandLpText(s.heading, values), paragraphs: s.paragraphs.map((p) => expandLpText(p, values)), media: mediaFor(s.heading) })),
    faq: parseFaq(rows.variant.faqJson).map((f) => ({ q: expandLpText(f.q, values), a: expandLpText(f.a, values) })),
    hero: heroRow ? toImage(heroRow.asset) : null,
    company: { name: rows.company.senderName, contact: rows.company.senderContact, phone: extractPhone(rows.company.senderContact) },
    unsubscribeUrl: opts.unsubscribeUrl,
    phoneTapToken: opts.phoneTapToken,
    form: null,
  };
}
```

- [ ] **Step 4: 確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-render-input.test.ts && npx tsc --noEmit && npx eslint src/lib/sale-dm-letter/lp-render-input.ts` → PASS(`propertyTypeLabel("house")` が「戸建」であることは PR2 で確認済み)

- [ ] **Step 5: Commit**

```bash
git add src/lib/sale-dm-letter/lp-render-input.ts src/lib/__tests__/sale-dm-lp-render-input.test.ts
git commit -m "feat(sale-dm): 公開LPの描画入力(差し込み・節分割・枠の解決)の純関数"
```

---

### Task 3: ページ描画の純関数 `lp-page.ts`(PC/スマホ最適化)

**Files:**
- Create: `src/lib/sale-dm-letter/lp-page.ts`
- Test: `src/lib/__tests__/sale-dm-lp-page.test.ts`

**Interfaces:**
- Consumes: `LpRenderInput`(Task 2)、`escapeHtml`(`./templates/index`)、`renderFigureSvg`(`./lp-figures`)、`PUBLIC_PAGE_HEADERS`(`./unsubscribe-page`・再エクスポートして route から使う)。
- Produces: `export function renderLpPage(input: LpRenderInput): string`(完結した HTML 文書)、`export const LP_CTA_LABEL = "無料査定を申し込む"`、`export { PUBLIC_PAGE_HEADERS }`。

- [ ] **Step 1: テスト**

```ts
// src/lib/__tests__/sale-dm-lp-page.test.ts
import { describe, it, expect } from "vitest";
import { renderLpPage, LP_CTA_LABEL } from "../sale-dm-letter/lp-page";
import type { LpRenderInput } from "../sale-dm-letter/lp-render-input";

const input = (over: Partial<LpRenderInput> = {}): LpRenderInput => ({
  mode: "live",
  headline: "ご所有の戸建のご売却について <b>",
  lead: "世田谷区経堂周辺で & 売却をご検討の方へ",
  intro: ["はじめに。"],
  sections: [
    { heading: "売却の進め方", paragraphs: ["流れの説明。", "二段落目。"], media: { kind: "figure", figureKind: "sale_flow" } },
    { heading: "費用について", paragraphs: ["費用の説明。"], media: { kind: "asset", image: { publicId: "b".repeat(32), width: 1200, height: 900 } } },
    { heading: "枠なし", paragraphs: ["x"], media: null },
  ],
  faq: [{ q: "費用は？", a: "無料です。" }],
  hero: { publicId: "a".repeat(32), width: 1600, height: 900 },
  company: { name: "株式会社リガーレ", contact: "TEL 03-1234-5678", phone: "0312345678" },
  unsubscribeUrl: "https://lp.example.com/u/tok.sig",
  phoneTapToken: "tok",
  form: null,
  ...over,
});

describe("renderLpPage", () => {
  const html = renderLpPage(input());
  it("完結した HTML・viewport・noindex・外部読み込みなし", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('name="viewport" content="width=device-width,initial-scale=1"');
    expect(html).toContain('name="robots" content="noindex,nofollow"');
    expect(html).not.toMatch(/<link\s|src="http|url\(http|@import/);
  });
  it("段の順番: ヒーロー→見出し→リード→申込ボタン→本文→よくある質問→会社案内+電話→配信停止", () => {
    const idx = (s: string) => { const i = html.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
    const order = [idx(`/lp-assets/${"a".repeat(32)}`), idx("<h1"), idx("売却をご検討の方へ"), idx(LP_CTA_LABEL), idx("売却の進め方"), idx("<details"), idx("株式会社リガーレ"), idx("tel:0312345678"), idx("/u/tok.sig")];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("動的文字列は escape される", () => {
    expect(html).toContain("ご所有の戸建のご売却について &lt;b&gt;");
    expect(html).toContain("&amp; 売却");
    expect(html).not.toContain("<b>");
  });
  it("写真は公開口の URL・寸法付き、図は inline SVG、枠なしの節には画像が無い", () => {
    expect(html).toMatch(new RegExp(`<img[^>]*src="/lp-assets/${"b".repeat(32)}"[^>]*width="1200"[^>]*height="900"`));
    expect(html).toContain('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"');
    expect(html).not.toContain("/uploads/");
  });
  it("live ではプレビュー帯が無く、電話タップの script が token 付きで1本だけ", () => {
    expect(html).not.toContain("プレビュー");
    expect((html.match(/<script/g) ?? []).length).toBe(1);
    expect(html).toContain('sendBeacon("/t/tok/phone-tap")');
  });
  it("preview ではプレビュー帯が出て、script が無く、tel は押せるが計測されない", () => {
    const p = renderLpPage(input({ mode: "preview", phoneTapToken: null }));
    expect(p).toContain("プレビュー");
    expect(p).not.toContain("<script");
    expect(p).toContain("tel:0312345678");
  });
  it("PC/スマホの両方の CSS がある(固定バーはスマホだけ・PC は中央 760px)", () => {
    expect(html).toContain("@media (max-width: 767px)");
    expect(html).toContain("@media (min-width: 768px)");
    expect(html).toContain("max-width:760px");
    expect(html).toContain("position:fixed;bottom:0");
    expect(html).toContain("prefers-reduced-motion");
  });
  it("電話番号が無い会社案内では tel ボタンを出さず連絡先を文字で出す", () => {
    const h = renderLpPage(input({ company: { name: "会社", contact: "info@example.com", phone: null } }));
    expect(h).not.toContain("tel:");
    expect(h).toContain("info@example.com");
  });
  it("ヒーロー無し・FAQ無し・配信停止無しでも壊れない", () => {
    const h = renderLpPage(input({ hero: null, faq: [], unsubscribeUrl: null }));
    expect(h).not.toContain("<details");
    expect(h).not.toContain("/u/");
    expect(h).toContain("<h1");
  });
  it("入力に無い文字列(氏名など)が出ない=入力の全値以外の文字を持ち込まない", () => {
    expect(html).not.toMatch(/山田|様/);
  });
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-page.test.ts` → FAIL

- [ ] **Step 3: 実装**

```ts
// src/lib/sale-dm-letter/lp-page.ts
/**
 * 公開LP(設計 2026-09-08 §2.4)。React を使わない純関数。unsubscribe-page.ts と同じ作り。
 *  - 全ての動的値は escapeHtml。図(renderFigureSvg)だけは自前生成の SVG としてそのまま埋める。
 *  - CSS は inline・外部読み込みなし。スマホ(〜767px)=1列+画面下の固定バー、PC(768px〜)=中央1列 760px。
 *  - <script> は電話タップ送信の固定文字列1本(live のみ)。token は JSON.stringify で埋める。
 */
import { escapeHtml } from "./templates/index";
import { renderFigureSvg } from "./lp-figures";
import type { LpRenderInput, LpImage } from "./lp-render-input";
export { PUBLIC_PAGE_HEADERS } from "./unsubscribe-page";

export const LP_CTA_LABEL = "無料査定を申し込む";
const CONTACT_ID = "contact";

const CSS = [
  ":root{color-scheme:light}",
  "*{box-sizing:border-box}",
  "body{margin:0;background:#f6f7f6;color:#1f2a2d;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Hiragino Kaku Gothic ProN','Yu Gothic UI','Noto Sans JP',sans-serif;font-size:16px;line-height:1.9;-webkit-text-size-adjust:100%}",
  "main{margin:0 auto;padding:0 0 96px}",
  "h1{font-size:24px;line-height:1.4;margin:0}",
  "h2{font-size:19px;line-height:1.45;margin:0 0 8px;padding-left:10px;border-left:4px solid #0e6b5c}",
  "p{margin:0 0 12px}",
  ".band{background:#f7ebdd;color:#a85f1b;font-weight:700;text-align:center;padding:8px 12px;font-size:14px}",
  ".hero{display:block;width:100%;height:auto;aspect-ratio:16/9;object-fit:cover;background:#e6ebe9}",
  ".wrap{padding:20px}",
  ".lead{color:#4a5b5e;font-size:16px}",
  ".cta{display:block;background:#0e6b5c;color:#fff;text-align:center;text-decoration:none;border-radius:10px;padding:14px;font-size:17px;font-weight:700;min-height:44px}",
  ".cta.secondary{background:#fff;color:#0a5246;border:2px solid #0e6b5c}",
  "section{margin:26px 0}",
  ".media{margin:10px 0 14px}",
  ".media img{display:block;width:100%;height:auto;border-radius:10px;background:#e6ebe9}",
  ".media svg{display:block;width:100%;height:auto;border-radius:10px;border:1px solid #d6dedb;background:#fff}",
  "details{border:1px solid #d6dedb;border-radius:10px;padding:10px 14px;margin:8px 0;background:#fff}",
  "summary{cursor:pointer;font-weight:700;min-height:44px;display:flex;align-items:center}",
  ".company{background:#fff;border:1px solid #d6dedb;border-radius:12px;padding:16px}",
  ".company .name{font-weight:700;font-size:17px}",
  ".company .contact{color:#4a5b5e;white-space:pre-wrap;word-break:break-all}",
  ".tel{display:block;margin-top:12px}",
  ".unsub{margin-top:28px;font-size:13px;color:#6b7a7d;text-align:center}",
  ".unsub a{color:#6b7a7d}",
  ".bar{display:none}",
  "@media (max-width: 767px){",
  "  .bar{display:grid;grid-template-columns:1fr 1fr;gap:8px;position:fixed;bottom:0;left:0;right:0;padding:10px 12px calc(10px + env(safe-area-inset-bottom));background:rgba(255,255,255,.96);border-top:1px solid #d6dedb;backdrop-filter:saturate(1.2) blur(6px)}",
  "  .bar.single{grid-template-columns:1fr}",
  "  .bar .cta{padding:12px;font-size:16px}",
  "}",
  "@media (min-width: 768px){",
  "  main{max-width:760px;padding:24px 0 64px}",
  "  .hero{border-radius:14px}",
  "  .wrap{padding:24px 8px}",
  "  h1{font-size:30px}",
  "  .cta{max-width:420px;margin:0 auto}",
  "}",
  "@media (prefers-reduced-motion: reduce){*{scroll-behavior:auto!important;transition:none!important}}",
  "html{scroll-behavior:smooth}",
].join("\n");

function img(image: LpImage, cls: string, alt: string): string {
  return `<img class="${cls}" src="/lp-assets/${escapeHtml(image.publicId)}" width="${image.width}" height="${image.height}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async" />`;
}

function paragraphs(ps: string[]): string {
  return ps.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br />")}</p>`).join("");
}

export function renderLpPage(input: LpRenderInput): string {
  const cta = `<a class="cta" href="#${CONTACT_ID}">${escapeHtml(LP_CTA_LABEL)}</a>`;
  const telHref = input.company.phone ? `tel:${escapeHtml(input.company.phone)}` : null;
  const telBtn = telHref ? `<a class="cta secondary tel" href="${telHref}" data-phone-tap="1">電話で相談する</a>` : "";
  const sections = input.sections.map((s) => {
    let media = "";
    if (s.media?.kind === "asset") media = `<div class="media">${img(s.media.image, "", s.heading)}</div>`;
    else if (s.media?.kind === "figure") media = `<div class="media">${renderFigureSvg(s.media.figureKind)}</div>`;
    return `<section><h2>${escapeHtml(s.heading)}</h2>${media}${paragraphs(s.paragraphs)}</section>`;
  }).join("");
  const faq = input.faq.length === 0 ? "" : `<section><h2>よくある質問</h2>${input.faq.map((f) => `<details><summary>${escapeHtml(f.q)}</summary><p>${escapeHtml(f.a).replace(/\n/g, "<br />")}</p></details>`).join("")}</section>`;
  const company = `<section class="company" id="${CONTACT_ID}">` +
    (input.company.name ? `<div class="name">${escapeHtml(input.company.name)}</div>` : "") +
    (input.company.contact ? `<div class="contact">${escapeHtml(input.company.contact)}</div>` : "") +
    `<p style="margin-top:10px">無料査定のお申し込み・ご相談は、お電話で承ります。</p>${telBtn}</section>`;
  const unsub = input.unsubscribeUrl ? `<p class="unsub">今後このようなお手紙が不要な方は <a href="${escapeHtml(input.unsubscribeUrl)}">こちら(配信停止)</a></p>` : "";
  const band = input.mode === "preview" ? `<div class="band">プレビュー ── この宛先はまだ送付前です。お申し込みは受け付けません</div>` : "";
  const bar = telHref
    ? `<div class="bar">${cta}<a class="cta secondary" href="${telHref}" data-phone-tap="1">電話</a></div>`
    : `<div class="bar single">${cta}</div>`;
  const script = input.mode === "live" && input.phoneTapToken && telHref
    ? `<script>(function(){var u=${JSON.stringify(`/t/${input.phoneTapToken}/phone-tap`)};document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("[data-phone-tap]"):null;if(!a)return;try{if(navigator.sendBeacon){navigator.sendBeacon(u)}else{fetch(u,{method:"POST",keepalive:true}).catch(function(){})}}catch(_){}});})();</script>`
    : "";
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="robots" content="noindex,nofollow" /><meta name="referrer" content="no-referrer" /><title>${escapeHtml(input.headline)}</title><style>${CSS}</style></head><body>${band}<main>` +
    (input.hero ? img(input.hero, "hero", "") : "") +
    `<div class="wrap"><h1>${escapeHtml(input.headline)}</h1>` +
    (input.lead ? `<p class="lead">${escapeHtml(input.lead)}</p>` : "") +
    `<div style="margin:16px 0 8px">${cta}</div>` +
    paragraphs(input.intro) + sections + faq + company + unsub +
    `</div></main>${bar}${script}</body></html>`;
}
```

⚠ 上の `sendBeacon("/t/tok/phone-tap")` のテスト期待は `JSON.stringify` の出力(`"/t/tok/phone-tap"`)と一致する。`renderFigureSvg` の先頭が `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"` であることは `lp-figures.ts` を読んで確認し、違えばテストの期待をその実値に合わせる(`http` の外部読み込み検査は `<link`/`src="http`/`url(http`/`@import` だけを見るので xmlns は当たらない)。

- [ ] **Step 4: 確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-page.test.ts && npx tsc --noEmit && npx eslint src/lib/sale-dm-letter/lp-page.ts` → PASS

- [ ] **Step 5: 目視(1回)** — `npx tsx -e` で `renderLpPage` に上のテスト入力を渡した HTML を `.superpowers/sdd/<plan>/dev/lp-sample.html` に書き、Playwright(`chromium.launch({channel:"chrome"})`)で幅 390 と 1000 のスクリーンショットを撮って崩れが無いことを見る(固定バーがスマホだけに出ること・PC で中央 760px)。崩れがあれば CSS を直してから commit。

- [ ] **Step 6: Commit**

```bash
git add src/lib/sale-dm-letter/lp-page.ts src/lib/__tests__/sale-dm-lp-page.test.ts
git commit -m "feat(sale-dm): 公開LPの描画(純関数・PC/スマホ最適化・固定バー・電話タップ)"
```

---

### Task 4: 読み出し `lp-page-loader.ts` と `/t/[token]` の拡張

**Files:**
- Create: `src/lib/sale-dm-letter/lp-page-loader.ts`
- Modify: `src/app/t/[token]/route.ts`
- Test: `src/lib/__tests__/sale-dm-lp-page-loader.test.ts`
- Test: `src/lib/__tests__/sale-dm-tracking-route.test.ts`(`GET /t/[token]` の describe に追記)

**Interfaces:**
- Consumes: `buildLpRenderInput`(Task 2)、`renderLpPage`/`PUBLIC_PAGE_HEADERS`(Task 3)、`loadSaleDmConfig`(`./config-store`・senderName/senderContact/trackingBaseUrl)、`buildUnsubscribeToken`/`buildUnsubscribeUrl`/`deriveUnsubscribeKey`(`./unsubscribe-token`・**印刷 route が停止URLを作っている呼び方をそのまま写す**。鍵の導出に env が要るなら同じ関数を使い、鍵が無い環境では `unsubscribeUrl: null`)。
- Produces:
  ```ts
  export interface LpPageClientLike { dmRecipientDraft: { findUnique: (...) => Promise<...> } }
  export type LpPageData = { kind: "none" } | { kind: "page"; html: string; status: "draft" | "confirmed" | "sent" };
  export async function loadLpPageData(client: LpPageClientLike, token: string): Promise<LpPageData>;
  ```
  `findUnique({ where: { trackingToken }, select: { status, trackingToken, lpVariant: { select: { headline, lead, bodyText, faqJson, media: { select: { slot, heading, figureKind, asset: { select: { publicId, width, height, deletedAt } } }, orderBy: { sortOrder: "asc" } } } }, property: { select: { address, propertyType } } } })`。`lpVariant` が無い・`bodyText`/`headline` が空 → `{kind:"none"}`。**select に氏名・番地(recipientName/recipientAddress/owner)を含めない**(テストで select の形を固定)。
- route: 既存の順序を保つ — rate limit → `loadSaleDmLpUrl`(無ければ 404) → `recordTrackingHit`(計数・監査) → `loadLpPageData` → `page` なら `new NextResponse(html, { status: 200, headers: PUBLIC_PAGE_HEADERS })`、`none` なら従来の 302。`loadLpPageData` の例外は握って従来の 302(best-effort・ページを出せなくても入口は壊さない)。

- [ ] **Step 1: テスト(loader)**

```ts
// src/lib/__tests__/sale-dm-lp-page-loader.test.ts
import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/sale-dm-letter/config-store", () => ({ loadSaleDmConfig: vi.fn(async () => ({ senderName: "株式会社リガーレ", senderContact: "TEL 03-1234-5678", trackingBaseUrl: "https://lp.example.com", lpUrl: "https://x.example/lp", provider: "none", model: "", anthropicApiKey: undefined, openaiApiKey: undefined, useMock: false })) }));
import { loadLpPageData } from "../sale-dm-letter/lp-page-loader";

const draft = (over: Record<string, unknown> = {}) => ({
  status: "sent", trackingToken: "tok",
  lpVariant: { headline: "ご所有の{{物件種別}}", lead: null, bodyText: "■A\nx", faqJson: null, media: [] },
  property: { address: "東京都世田谷区経堂1-2-3", propertyType: "house" },
  ...over,
});
const client = (row: unknown) => ({ dmRecipientDraft: { findUnique: vi.fn(async () => row) } });

describe("loadLpPageData", () => {
  it("LP型に文章があればページ HTML を返す(差し込み済み・status 付き)", async () => {
    const c = client(draft());
    const r = await loadLpPageData(c as never, "tok");
    expect(r.kind).toBe("page");
    if (r.kind !== "page") return;
    expect(r.status).toBe("sent");
    expect(r.html).toContain("ご所有の戸建");
    expect(r.html).not.toContain("プレビュー");
  });
  it("送付前なら preview モード(帯あり・script なし)", async () => {
    const r = await loadLpPageData(client(draft({ status: "confirmed" })) as never, "tok");
    expect(r.kind === "page" && r.html.includes("プレビュー") && !r.html.includes("<script")).toBe(true);
  });
  it("未知 token・LP型なし・文章未保存は none", async () => {
    expect((await loadLpPageData(client(null) as never, "tok")).kind).toBe("none");
    expect((await loadLpPageData(client(draft({ lpVariant: null })) as never, "tok")).kind).toBe("none");
    expect((await loadLpPageData(client(draft({ lpVariant: { headline: null, lead: null, bodyText: null, faqJson: null, media: [] } })) as never, "tok")).kind).toBe("none");
  });
  it("select に氏名・宛先住所・所有者を含めない(構造で PII を渡さない)", async () => {
    const c = client(draft());
    await loadLpPageData(c as never, "tok");
    const select = JSON.stringify(c.dmRecipientDraft.findUnique.mock.calls[0][0].select);
    expect(select).not.toMatch(/recipientName|recipientAddress|recipientZip|owner|draftOwners/);
    expect(select).toMatch(/"address":true/);
  });
});
```

- [ ] **Step 2: テスト(route 追記)** — `sale-dm-tracking-route.test.ts` の `GET /t/[token]` ブロックに追加(既存 mock の流儀に合わせる。`@/lib/sale-dm-letter/lp-page-loader` を `vi.mock` して `loadLpPageData` を差し替える):

```ts
  it("LP型に文章がある送付済み宛先は 302 ではなく HTML(200・no-store・noindex)を返し、計数と監査は従来どおり", async () => {
    loadLpPageData.mockResolvedValueOnce({ kind: "page", html: "<!doctype html><html><body>LP</body></html>", status: "sent" });
    // 既存の「known token + LP set」ケースと同じ mock 準備
    const res = await GET(req("tok"), ctx("tok"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(await res.text()).toContain("LP");
    expect(writeAuditLog).toHaveBeenCalledTimes(1);   // 初回計数の監査は変わらない
  });
  it("送付前でも LP型に文章があればプレビュー帯付き HTML(計数なし)", async () => {
    loadLpPageData.mockResolvedValueOnce({ kind: "page", html: "<html>プレビュー</html>", status: "confirmed" });
    const res = await GET(req("tok-presend"), ctx("tok-presend"));
    expect(res.status).toBe(200);
    expect(prismaMock.dmRecipientDraft.update).not.toHaveBeenCalled();
  });
  it("LP型なしは従来どおり 302、loader が例外でも 302(入口を壊さない)", async () => {
    loadLpPageData.mockResolvedValueOnce({ kind: "none" });
    expect((await GET(req("tok"), ctx("tok"))).status).toBe(302);
    loadLpPageData.mockRejectedValueOnce(new Error("db"));
    expect((await GET(req("tok"), ctx("tok"))).status).toBe(302);
  });
  it("既定LP未設定は LP型があっても 404(fail-closed 維持)・未知 token は 302", async () => { /* 既存ケースの流儀で */ });
```

- [ ] **Step 3: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-page-loader.test.ts src/lib/__tests__/sale-dm-tracking-route.test.ts` → FAIL

- [ ] **Step 4: loader**

```ts
// src/lib/sale-dm-letter/lp-page-loader.ts
/**
 * /t/[token] のページ描画用の読み出し(設計 §2.4)。計数(recordTrackingHit)とは分け、読むだけ。
 * select に氏名・宛先住所・所有者を**含めない**(テストで固定)。ページの材料は LP型の文章/枠/写真の publicId と
 * 物件の所在(町名まで)・種別・会社案内・配信停止URL だけ。
 */
import { buildLpRenderInput } from "./lp-render-input";
import { renderLpPage } from "./lp-page";
import { loadSaleDmConfig } from "./config-store";
import { buildUnsubscribeToken, buildUnsubscribeUrl, deriveUnsubscribeKey } from "./unsubscribe-token";

const SELECT = {
  status: true,
  trackingToken: true,
  lpVariant: {
    select: {
      headline: true, lead: true, bodyText: true, faqJson: true,
      media: { select: { slot: true, heading: true, figureKind: true, asset: { select: { publicId: true, width: true, height: true, deletedAt: true } } }, orderBy: { sortOrder: "asc" as const } },
    },
  },
  property: { select: { address: true, propertyType: true } },
} as const;

type Row = {
  status: "draft" | "confirmed" | "sent";
  trackingToken: string;
  lpVariant: { headline: string | null; lead: string | null; bodyText: string | null; faqJson: unknown; media: Array<{ slot: string; heading: string | null; figureKind: string | null; asset: { publicId: string; width: number; height: number; deletedAt: Date | null } | null }> } | null;
  property: { address: string | null; propertyType: string | null };
};
export interface LpPageClientLike { dmRecipientDraft: { findUnique: (args: { where: { trackingToken: string }; select: typeof SELECT }) => Promise<Row | null> } }
export type LpPageData = { kind: "none" } | { kind: "page"; html: string; status: Row["status"] };

function unsubscribeUrlFor(trackingToken: string, baseUrl: string | undefined): string | null {
  try {
    // ⚠印刷 route(お手紙の停止QR)と同じ導出を使う。鍵が無い環境では null(案内を出さない)。
    const key = deriveUnsubscribeKey();
    if (!key) return null;
    return buildUnsubscribeUrl(buildUnsubscribeToken(trackingToken, key), baseUrl);
  } catch { return null; }
}

export async function loadLpPageData(client: LpPageClientLike, token: string): Promise<LpPageData> {
  const row = await client.dmRecipientDraft.findUnique({ where: { trackingToken: token }, select: SELECT });
  const v = row?.lpVariant;
  if (!row || !v || !v.headline || !v.bodyText || v.bodyText.trim().length === 0) return { kind: "none" };
  const cfg = await loadSaleDmConfig();
  const mode = row.status === "sent" ? "live" : "preview";
  const input = buildLpRenderInput(
    { variant: { headline: v.headline, lead: v.lead, bodyText: v.bodyText, faqJson: v.faqJson }, media: v.media, property: row.property, company: { senderName: cfg.senderName ?? null, senderContact: cfg.senderContact ?? null } },
    { mode, unsubscribeUrl: mode === "live" ? unsubscribeUrlFor(row.trackingToken, cfg.trackingBaseUrl) : null, phoneTapToken: mode === "live" ? row.trackingToken : null },
  );
  return { kind: "page", html: renderLpPage(input), status: row.status };
}
```

`deriveUnsubscribeKey` の実引数は `src/lib/sale-dm-letter/unsubscribe-token.ts:27` と、印刷 route(`grep -rn "buildUnsubscribeToken(" src/app`)の呼び方を読んで合わせる(secret の出所を変えない)。

- [ ] **Step 5: route** — `src/app/t/[token]/route.ts` の redirect 直前に:

```ts
    // LP型に文章がある宛先はアプリ内のご案内ページを返す(設計 §2.4)。読めなければ従来の転送(入口を壊さない)。
    let page: LpPageData = { kind: "none" };
    try { page = await loadLpPageData(prisma, token); } catch { page = { kind: "none" }; }
    if (page.kind === "page") {
      return new NextResponse(page.html, { status: 200, headers: { ...PUBLIC_PAGE_HEADERS } });
    }
```

import: `loadLpPageData, type LpPageData` from `@/lib/sale-dm-letter/lp-page-loader`、`PUBLIC_PAGE_HEADERS` from `@/lib/sale-dm-letter/lp-page`。既存の 404(既定LP未設定)と計数の順序は変えない。

- [ ] **Step 6: 確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-page-loader.test.ts src/lib/__tests__/sale-dm-tracking-route.test.ts src/lib/__tests__/dm-writer-lock-order.test.ts && npx tsc --noEmit && npx eslint src/lib/sale-dm-letter/lp-page-loader.ts "src/app/t/[token]/route.ts"` → PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/sale-dm-letter/lp-page-loader.ts "src/app/t/[token]/route.ts" src/lib/__tests__/sale-dm-lp-page-loader.test.ts src/lib/__tests__/sale-dm-tracking-route.test.ts
git commit -m "feat(sale-dm): QR入口(/t/)でLP型のご案内ページを返す(従来の転送・計数・404は維持)"
```

---

### Task 5: 電話タップ `POST /t/[token]/phone-tap` と監査

**Files:**
- Create: `src/app/t/[token]/phone-tap/route.ts`
- Create: `src/lib/sale-dm-letter/phone-tap-record.ts`(`recordPhoneTap(client, token)`)
- Modify: `src/lib/audit-log-detail-safety.ts`(`sale_dm_qr_unsubscribe` の近く)
- Modify: `src/app/(dashboard)/admin/audit-logs/page.tsx`(ラベル辞書)
- Modify: `src/lib/__tests__/sale-dm-external-audit-visible.test.ts`(CASES)
- Modify: `src/lib/__tests__/dm-writer-lock-order.test.ts`(recordPhoneTap の順序)
- Test: `src/lib/__tests__/sale-dm-lp-phone-tap-route.test.ts`

**Interfaces:**
- Produces: `recordPhoneTap(client, token): Promise<{ matched: boolean; first: boolean }>` — `findUnique({ where: { trackingToken }, select: { id, propertyId, status, phoneTapFirstAt } })` → `status !== "sent"` → `{matched:false, first:false}` → `$transaction(lockPropertyRow(tx, propertyId) → tx.dmRecipientDraft.update({ phoneTapCount: { increment: 1 }, ...(first ? { phoneTapFirstAt: new Date() } : {}) }))`。`syncSaleDmReaction` は**呼ばない**(反響ではない)。例外は握って `{matched:false, first:false}`。
- route: `createRateLimiter({ limit: 60, windowMs: 60_000 }, { onOverflow: "allow" })`、キー `t-tap:<ip>`; 超過は 204(オラクル封じ・沈黙)。`recordPhoneTap` → `first` なら `writeAuditLog({ action: "sale_dm_lp_phone_tap", targetTable: "dm_recipient_drafts", targetId, detail: { at } })`。**常に** `new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } })`。
- allowlist: `sale_dm_tracking_hit: new Set(["firstHit", "at"])`(既存の抜け)、`sale_dm_lp_phone_tap: new Set(["at"])`、`sale_dm_lp_preview_view: new Set(["device", "viewedAt"])`(Task 6 で使う)。ラベル: 「売却DM LP 電話タップ」「売却DM LP プレビュー表示」(`sale_dm_tracking_hit` のラベルは既存)。

- [ ] **Step 1: テスト**

```ts
// src/lib/__tests__/sale-dm-lp-phone-tap-route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", () => { class R extends Request {} class S extends Response { static json = (b: unknown, i?: ResponseInit) => Response.json(b, i); } return { NextRequest: R, NextResponse: S }; });
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
const { lockPropertyRow } = vi.hoisted(() => ({ lockPropertyRow: vi.fn(async () => undefined) }));
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = { dmRecipientDraft: { findUnique: vi.fn(), update: vi.fn(async () => ({})) } };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});
import prismaMock from "@/lib/prisma";
import { POST } from "../../app/t/[token]/phone-tap/route";
import { recordPhoneTap } from "../sale-dm-letter/phone-tap-record";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as { dmRecipientDraft: { findUnique: Fn; update: Fn } };
const req = (ip = "10.0.0.1") => new Request("http://x/t/tok/phone-tap", { method: "POST", headers: { "x-real-ip": ip } }) as never;
const ctx = { params: Promise.resolve({ token: "tok" }) };

beforeEach(() => { vi.clearAllMocks(); pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "d1", propertyId: "p1", status: "sent", phoneTapFirstAt: null }); });

describe("recordPhoneTap", () => {
  it("送付済みなら物件行をロックして回数+1・初回だけ phoneTapFirstAt", async () => {
    const r = await recordPhoneTap(prismaMock as never, "tok");
    expect(r).toEqual({ matched: true, first: true });
    expect(lockPropertyRow.mock.invocationCallOrder[0]).toBeLessThan(pm.dmRecipientDraft.update.mock.invocationCallOrder[0]);
    expect(pm.dmRecipientDraft.update.mock.calls[0][0].data).toEqual({ phoneTapCount: { increment: 1 }, phoneTapFirstAt: expect.any(Date) });
    pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "d1", propertyId: "p1", status: "sent", phoneTapFirstAt: new Date() });
    expect(await recordPhoneTap(prismaMock as never, "tok")).toEqual({ matched: true, first: false });
    expect(pm.dmRecipientDraft.update.mock.calls[1][0].data).toEqual({ phoneTapCount: { increment: 1 } });
  });
  it("送付前・未知 token は数えない・反響は立てない", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "d1", propertyId: "p1", status: "confirmed", phoneTapFirstAt: null });
    expect(await recordPhoneTap(prismaMock as never, "tok")).toEqual({ matched: false, first: false });
    pm.dmRecipientDraft.findUnique.mockResolvedValue(null);
    expect(await recordPhoneTap(prismaMock as never, "tok")).toEqual({ matched: false, first: false });
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
    expect(JSON.stringify(pm.dmRecipientDraft.update.mock.calls)).not.toContain("outcome");
  });
  it("更新に失敗しても例外を投げない", async () => {
    pm.dmRecipientDraft.update.mockRejectedValue(new Error("db"));
    expect(await recordPhoneTap(prismaMock as never, "tok")).toEqual({ matched: false, first: false });
  });
});

describe("POST /t/[token]/phone-tap", () => {
  it("常に 204(初回は監査 sale_dm_lp_phone_tap に at だけ)", async () => {
    const res = await POST(req(), ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(writeAuditLog.mock.calls[0][0]).toMatchObject({ action: "sale_dm_lp_phone_tap", targetTable: "dm_recipient_drafts", targetId: "d1" });
    expect(Object.keys(writeAuditLog.mock.calls[0][0].detail)).toEqual(["at"]);
  });
  it("未知 token も 204(存在を漏らさない)・2回目は監査なし", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue(null);
    expect((await POST(req("10.0.0.2"), ctx)).status).toBe(204);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
  it("同じ端末から1分に60回を超えると黙って 204(計数しない)", async () => {
    for (let i = 0; i < 61; i++) await POST(req("10.9.9.9"), ctx);
    expect(pm.dmRecipientDraft.update.mock.calls.length).toBeLessThanOrEqual(60);
  });
});
```

`dm-writer-lock-order.test.ts` に追記(既存 `recordTrackingHit` の describe の型で):

```ts
  it("recordPhoneTap: lockPropertyRow → update の順・syncSaleDmReaction と lockOwnersForUpdate を呼ばない", () => {
    const src = read("src/lib/sale-dm-letter/phone-tap-record.ts");
    const body = src.slice(src.indexOf("export async function recordPhoneTap"));
    assertOrder(body, ["lockPropertyRow", "tx.dmRecipientDraft.update"]);
    expect(body).not.toMatch(/syncSaleDmReaction|lockOwnersForUpdate|outcome/);
  });
```

CASES 追記: `{ action: "sale_dm_tracking_hit", detail: { firstHit: true, at: "2026-09-11T00:00:00.000Z" } }`、`{ action: "sale_dm_lp_phone_tap", detail: { at: "2026-09-11T00:00:00.000Z" } }`、`{ action: "sale_dm_lp_preview_view", detail: { campaignId: "c1", device: "sp", viewedAt: "2026-09-11T00:00:00.000Z" } }`。

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-phone-tap-route.test.ts src/lib/__tests__/dm-writer-lock-order.test.ts src/lib/__tests__/sale-dm-external-audit-visible.test.ts` → FAIL

- [ ] **Step 3: 実装**

```ts
// src/lib/sale-dm-letter/phone-tap-record.ts
/** 公開LPの電話ボタンのタップ計測(設計 §2.4)。recordTrackingHit と同じ順序(lockPropertyRow → update)。反響は立てない。 */
import { lockPropertyRow } from "@/lib/property-record-guard";

export interface PhoneTapClientLike {
  dmRecipientDraft: {
    findUnique: (args: { where: { trackingToken: string }; select: { id: true; propertyId: true; status: true; phoneTapFirstAt: true } }) => Promise<{ id: string; propertyId: string; status: string; phoneTapFirstAt: Date | null } | null>;
  };
  $transaction: <T>(fn: (tx: PhoneTapTx) => Promise<T>) => Promise<T>;
}
export interface PhoneTapTx { dmRecipientDraft: { update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown> } }

export async function recordPhoneTap(client: PhoneTapClientLike, token: string): Promise<{ matched: boolean; first: boolean; draftId?: string }> {
  const draft = await client.dmRecipientDraft.findUnique({ where: { trackingToken: token }, select: { id: true, propertyId: true, status: true, phoneTapFirstAt: true } });
  if (!draft || draft.status !== "sent") return { matched: false, first: false };
  const first = draft.phoneTapFirstAt == null;
  try {
    await client.$transaction(async (tx) => {
      await lockPropertyRow(tx as never, draft.propertyId);
      await tx.dmRecipientDraft.update({ where: { id: draft.id }, data: { phoneTapCount: { increment: 1 }, ...(first ? { phoneTapFirstAt: new Date() } : {}) } });
    });
  } catch {
    return { matched: false, first: false };
  }
  return { matched: true, first, draftId: draft.id };
}
```

```ts
// src/app/t/[token]/phone-tap/route.ts
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { clientRateKey, createRateLimiter } from "@/lib/public-rate-limit";
import { recordPhoneTap } from "@/lib/sale-dm-letter/phone-tap-record";

/** 電話ボタンのタップ(sendBeacon)。常に 204(未知 token でも=存在を漏らさない)。sent のみ計数・初回だけ監査。 */
const limiter = createRateLimiter({ limit: 60, windowMs: 60_000 }, { onOverflow: "allow" });
const NO_CONTENT = () => new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  if (!limiter.hit(`t-tap:${clientRateKey(req.headers)}`)) return NO_CONTENT();
  const { token } = await params;
  const r = await recordPhoneTap(prisma, token);
  if (r.first && r.draftId) {
    try {
      await writeAuditLog({ userId: null, action: "sale_dm_lp_phone_tap", targetTable: "dm_recipient_drafts", targetId: r.draftId, detail: { at: new Date().toISOString() } });
    } catch { /* best-effort */ }
  }
  return NO_CONTENT();
}
```

`writeAuditLog` の `userId` は既存 `/t/[token]/route.ts` の呼び方(公開経路の userId の扱い)に合わせる。`lockPropertyRow` の第1引数の型は `src/lib/property-record-guard.ts` を読んで `as never` を外せるなら外す。

- [ ] **Step 4: 確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-phone-tap-route.test.ts src/lib/__tests__/dm-writer-lock-order.test.ts src/lib/__tests__/sale-dm-external-audit-visible.test.ts "src/app/(dashboard)/__tests__" && npx tsc --noEmit && npx eslint "src/app/t/[token]/phone-tap/route.ts" src/lib/sale-dm-letter/phone-tap-record.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add "src/app/t/[token]/phone-tap/route.ts" src/lib/sale-dm-letter/phone-tap-record.ts src/lib/audit-log-detail-safety.ts "src/app/(dashboard)/admin/audit-logs/page.tsx" src/lib/__tests__/sale-dm-lp-phone-tap-route.test.ts src/lib/__tests__/dm-writer-lock-order.test.ts src/lib/__tests__/sale-dm-external-audit-visible.test.ts
git commit -m "feat(sale-dm): 公開LPの電話タップ計測(常に204・sentのみ・初回監査)と監査allowlistの補完"
```

---

### Task 6: 社内プレビュー(route・api-client・画面の PC/スマホ切替)

**Files:**
- Create: `src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/preview/route.ts`
- Modify: `src/lib/api-client.ts`(`LP_ASSET_URL` の直後に `LP_PREVIEW_URL`)
- Create: `src/components/sale-dm/lp-preview-panel.tsx`
- Modify: `src/components/sale-dm/lp-variant-manager.tsx`
- Test: `src/lib/__tests__/sale-dm-lp-preview-route.test.ts`, `src/lib/__tests__/sale-dm-lp-preview-ui-scan.test.ts`

**Interfaces:**
- Produces: `GET .../preview?device=sp|pc` → HTML(200・`PUBLIC_PAGE_HEADERS` に加えて `X-Frame-Options: SAMEORIGIN`)。見本: `location: "○○区○○町"`, `propertyType`: キャンペーンの宛先で最も多い種別(image-prompt route と同じ集計・無ければ "house")、`mode: "preview"`、`unsubscribeUrl: null`、`phoneTapToken: null`、会社案内は設定から。文章未保存 → 409 `TEMPLATE_MISSING`。監査 `sale_dm_lp_preview_view` `{ campaignId, device, viewedAt }`。`device` は表示に影響しない(監査用の区別のみ。CSS は同じ HTML の中で幅に応じて切り替わる)。
- `export const LP_PREVIEW_URL = (campaignId: string, lpId: string, device: "sp" | "pc") => \`/api/properties/sale-dm/campaigns/${campaignId}/lp-variants/${lpId}/preview?device=${device}\`;`
- `LpPreviewPanel({ campaignId, lpId, label, onClose })`: 上に「スマホ / PC」の切替(2 ボタン・`aria-pressed`)、下に `<iframe src={LP_PREVIEW_URL(...)} title="…">` を幅 390px(sp)/1000px(pc)・高さ 720px の枠で表示(`max-width:100%`・横スクロール可)。`key={device}` で切替時に再読み込み。「別タブで開く」リンク。
- manager: 行のボタン群に `Eye` アイコンの「プレビュー」(`disabled={busy || !v.headline}`・title「プレビュー」/「先に文章を保存してください」)。`previewFor` state。文章/写真と図/プレビューの3パネルは同時に1つだけ(他を開くとき閉じる)。

- [ ] **Step 1: テスト(route)**

```ts
// src/lib/__tests__/sale-dm-lp-preview-route.test.ts
// mock は sale-dm-lp-media-route.test.ts と同じ形(api-helpers/audit/prisma)。加えて config-store を mock。
// ケース: (1) 文章ありで 200・text/html・no-store・X-Frame-Options SAMEORIGIN・プレビュー帯・「○○区○○町」が本文に入る・script なし・監査 device=sp
//         (2) 文章未保存は 409 TEMPLATE_MISSING  (3) 他人のキャンペーンは 404  (4) device が不正なら 400  (5) 読み取り権限のみでも 200(閲覧は書き込み門でない)
```

(テスト本文は media-route テストの mock を写し、上の 5 ケースを `it` にする。期待するヘッダ・コードは上記のとおり。)

UI 走査テスト `sale-dm-lp-preview-ui-scan.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const read = (f: string) => readFileSync(path.resolve(process.cwd(), f), "utf8").replace(/\r\n/g, "\n");
describe("LPプレビュー画面", () => {
  const panel = read("src/components/sale-dm/lp-preview-panel.tsx");
  const manager = read("src/components/sale-dm/lp-variant-manager.tsx");
  it("iframe は LP_PREVIEW_URL 経由・PC/スマホの切替が aria-pressed 付きである", () => {
    expect(panel).toMatch(/<iframe[^>]*src=\{LP_PREVIEW_URL\(/);
    expect((panel.match(/aria-pressed/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(panel).toContain("390");
    expect(panel).toContain("1000");
    expect(panel).not.toContain("dangerouslySetInnerHTML");
  });
  it("LP型の行にプレビューのボタンがあり、文章未保存では押せない", () => {
    expect(manager).toMatch(/aria-label=\{`LP型「\$\{v\.label\}」のプレビュー`\}/);
    expect(manager).toMatch(/previewFor/);
    expect(manager).toContain('key={previewFor.id}');
  });
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-preview-route.test.ts src/lib/__tests__/sale-dm-lp-preview-ui-scan.test.ts` → FAIL

- [ ] **Step 3: route**

```ts
// .../lp-variants/[lpId]/preview/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess, assertSaleDmCampaignOwned } from "@/lib/sale-dm-letter/route-guard";
import { loadSaleDmConfig } from "@/lib/sale-dm-letter/config-store";
import { buildLpRenderInput } from "@/lib/sale-dm-letter/lp-render-input";
import { renderLpPage, PUBLIC_PAGE_HEADERS } from "@/lib/sale-dm-letter/lp-page";

const querySchema = z.object({ device: z.enum(["sp", "pc"]).default("sp") });
const SAMPLE_ADDRESS = "○○区○○町1-2-3";   // coarsePropertyLocation が「○○区○○町」に落とす見本(氏名・実在住所は使わない)

/** 社内プレビュー(設計 §2.4)。認証必須・見本の差し込み・プレビュー帯。device は監査用の区別のみ(HTML は同じ)。 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; lpId: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id, lpId } = await params;
    await assertSaleDmCampaignOwned(id, session.id);
    const q = querySchema.parse({ device: new URL(request.url).searchParams.get("device") ?? undefined });
    const v = await prisma.dmLpVariant.findFirst({
      where: { id: lpId, campaignId: id },
      select: { headline: true, lead: true, bodyText: true, faqJson: true, media: { select: { slot: true, heading: true, figureKind: true, asset: { select: { publicId: true, width: true, height: true, deletedAt: true } } }, orderBy: { sortOrder: "asc" } } },
    });
    if (!v) throw new ApiError(404, "指定されたLP型が見つかりません", "LP_VARIANT_NOT_FOUND");
    if (!v.headline || !v.bodyText || v.bodyText.trim().length === 0) throw new ApiError(409, "先に文章を保存してください", "TEMPLATE_MISSING");
    const kinds = await prisma.dmRecipientDraft.findMany({ where: { campaignId: id }, select: { property: { select: { propertyType: true } } }, take: 500, orderBy: { id: "asc" } });
    const tally = new Map<string, number>();
    for (const k of kinds) { const t = k.property?.propertyType; if (t) tally.set(t, (tally.get(t) ?? 0) + 1); }
    const propertyType = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "house";
    const cfg = await loadSaleDmConfig();
    const html = renderLpPage(buildLpRenderInput(
      { variant: { headline: v.headline, lead: v.lead, bodyText: v.bodyText, faqJson: v.faqJson }, media: v.media, property: { address: SAMPLE_ADDRESS, propertyType }, company: { senderName: cfg.senderName ?? null, senderContact: cfg.senderContact ?? null } },
      { mode: "preview", unsubscribeUrl: null, phoneTapToken: null },
    ));
    await writeAuditLog({ userId: session.id, action: "sale_dm_lp_preview_view", targetTable: "dm_lp_variants", targetId: lpId, detail: { campaignId: id, device: q.device, viewedAt: new Date().toISOString() } });
    return new NextResponse(html, { status: 200, headers: { ...PUBLIC_PAGE_HEADERS, "X-Frame-Options": "SAMEORIGIN" } });
  } catch (error) {
    return handleApiError(error);
  }
}
```

⚠ `coarsePropertyLocation("○○区○○町1-2-3")` が `"○○区○○町"` を返すかは `tags.ts` の実装(丁目・番地の切り落とし規則)を読んで確かめる。返さない場合は、見本として `expandLpText` の一般語(「ご所有の物件の周辺」)で構わないので、テストの期待は**実際の出力**に合わせ、氏名・実在住所が入らないことだけを固定する。

- [ ] **Step 4: パネルと組み込み**

```tsx
// src/components/sale-dm/lp-preview-panel.tsx
"use client";
import { useState } from "react";
import { Eye, ExternalLink, X } from "lucide-react";
import { LP_PREVIEW_URL } from "@/lib/api-client";

type Device = "sp" | "pc";
const WIDTH: Record<Device, number> = { sp: 390, pc: 1000 };

/** LP型のプレビュー(設計 §2.4)。同じページを幅 390px(スマホ)と 1000px(PC)の枠で見る。 */
export default function LpPreviewPanel({ campaignId, lpId, label, onClose }: { campaignId: string; lpId: string; label: string; onClose: () => void }) {
  const [device, setDevice] = useState<Device>("sp");
  const src = LP_PREVIEW_URL(campaignId, lpId, device);
  return (
    <div className="mt-3 rounded-md border border-sky-200 bg-sky-50/40 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-gray-700"><Eye className="mr-1 inline h-3.5 w-3.5" />「{label}」のプレビュー(見本の差し込み・送付前の帯付き)</span>
        <div className="flex items-center gap-2">
          {(["sp", "pc"] as const).map((d) => (
            <button key={d} type="button" aria-pressed={device === d} onClick={() => setDevice(d)} className={`rounded border px-2 py-1 ${device === d ? "border-sky-500 bg-white text-sky-700" : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50"}`}>{d === "sp" ? "スマホ" : "PC"}</button>
          ))}
          <a href={src} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sky-700 hover:underline"><ExternalLink className="h-3 w-3" />別タブで開く</a>
          <button type="button" onClick={onClose} className="text-gray-500 hover:underline"><X className="inline h-3 w-3" /> 閉じる</button>
        </div>
      </div>
      <div className="mt-2 overflow-x-auto">
        <iframe key={device} src={src} title={`LP型「${label}」のプレビュー(${device === "sp" ? "スマホ" : "PC"})`} style={{ width: WIDTH[device], maxWidth: "100%", height: 720 }} className="rounded border border-gray-300 bg-white" />
      </div>
    </div>
  );
}
```

`lp-variant-manager.tsx`: `previewFor` state・`Eye` import・行ボタン(写真と図の隣・`aria-label={\`LP型「${v.label}」のプレビュー\`}`・`disabled={busy || !v.headline}`)・`{previewFor && <LpPreviewPanel key={previewFor.id} campaignId={campaign.id} lpId={previewFor.id} label={previewFor.label} onClose={() => setPreviewFor(null)} />}`・他パネルを開くとき `setPreviewFor(null)`、プレビューを開くとき `setLetterFor(null); setLetter(null); setMediaFor(null)`。`sale-dm-lp-media-ui-scan.test.ts` の `key={mediaFor.id}` 等の既存 assertion を壊さない。

- [ ] **Step 5: 確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-preview-route.test.ts src/lib/__tests__/sale-dm-lp-preview-ui-scan.test.ts src/lib/__tests__/sale-dm-lp-media-ui-scan.test.ts src/lib/__tests__/sale-dm-write-permission-guard.test.ts src/components && npx tsc --noEmit && npx eslint src/components/sale-dm "src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/preview/route.ts" src/lib/api-client.ts` → PASS

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/preview/route.ts" src/lib/api-client.ts src/components/sale-dm/lp-preview-panel.tsx src/components/sale-dm/lp-variant-manager.tsx src/lib/__tests__/sale-dm-lp-preview-route.test.ts src/lib/__tests__/sale-dm-lp-preview-ui-scan.test.ts
git commit -m "feat(sale-dm): LP型の社内プレビュー(PC/スマホ切替・見本の差し込み・プレビュー帯)"
```

---

### Task 7: 集計の解禁(LP型ごと/組合せ表)と電話タップ列

**Files:**
- Modify: `src/lib/sale-dm-letter/lp-metrics-flag.ts`(`true`・コメント更新)
- Modify: `src/lib/sale-dm-letter/aggregate.ts`(`TwoAxisDraftInput.phoneTapFirstAt`, `LpVariantAggregate.phoneTapped`, `phoneTapRate`)
- Modify: `src/lib/sale-dm-letter/aggregate-view-model.ts` / `src/components/sale-dm/aggregate-view.tsx`(列「電話タップ」件数と率・分母は閲覧あり)
- Modify: aggregate route(`select` に `phoneTapFirstAt`)
- Modify: tests `sale-dm-aggregate-two-axis.test.ts`, `sale-dm-aggregate-route-lp-metrics.test.ts`(フラグ true 前提に更新), `sale-dm-aggregate-view-model.test.ts`, `sale-dm-management-ui-wiring.test.ts`(該当 assertion)

- [ ] **Step 1: テスト** — `aggregateTwoAxis` に `phoneTapFirstAt` 付き drafts を渡し、`byLpVariant[i].phoneTapped` と `phoneTapRate = phoneTapped / viewed`(viewed 0 は null)を assert。route テストは `byLpVariant`/`byPair` が返ることに反転。view-model テストに「電話タップ 1 / 閲覧 4(25%)」の文字列。
- [ ] **Step 2: 落ちることを確認**
- [ ] **Step 3: 実装** — `phoneTapFirstAt: Date | null` を `TwoAxisDraftInput` に追加(既存呼び出しは `null` を渡すよう route を更新)。`LpVariantAggregate` に `phoneTapped: number; phoneTapRate: number | null`。view は「閲覧率」列の右に「電話タップ」(件数・率・分母=閲覧)。`LP_METRICS_ENABLED = true` とコメント「2026-09-11 公開LP(PR3)で /t/ が LP型ごとにページを出すようになったため解禁」。
- [ ] **Step 4: 確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-aggregate*.test.ts src/lib/__tests__/sale-dm-management-ui-wiring.test.ts && npx tsc --noEmit && npx eslint <変更ファイル>` → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(sale-dm): LP型ごと/組合せの集計表を解禁し電話タップの列を追加"`

---

### Task 8: 文書・全ゲート・実機確認・PR

**Files:**
- Modify: `public/docs/guide.html` / `public/docs/manual.html`(「ご案内ページ(LP)の公開」節: QRの動き・プレビュー(PC/スマホ)・電話ボタン・集計表・**所有者に見せるには公開LP用HTTPSと売却DM設定の追跡URLの切替が要る**)
- Modify: `docs/deploy.md`(migration `20260911100000_add_dm_phone_tap`・`/t/` が HTML を返すようになったこと・`trackingBaseUrl` を https の公開ドメインへ切り替える手順(Xserver DNS A レコード→certbot→nginx server block→設定画面)・`/t/<token>/phone-tap` は POST・nginx のログ除外は `/u/` のみのまま)

- [ ] **Step 1: 文書 commit**
- [ ] **Step 2: 全ゲート** — `npx prisma generate && npx tsc --noEmit && npx eslint <変更ファイル群> && npx vitest run && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build`、制御文字/CRLF/`Bin` スキャン、`saleDmLetter` grep。
- [ ] **Step 3: ローカル実機(controller)** — `npx next dev -p 3013`(turbopack)で: LP型(PR2 の見本データ)→「プレビュー」→スマホ/PC 切替でページが出る(固定バーはスマホだけ)・別タブで開く→ `/t/<token>`(seed の draft を `sent` にして)で HTML(200)・未知 token は 302・電話ボタンの `sendBeacon` が `phone-tap` に届き `phoneTapCount` が増える・集計表に LP型ごと/組合せが出る。Playwright で 390/1000 のスクリーンショット。
- [ ] **Step 4: PR**(`ship` スキル)— 本文: Summary/実装/テスト/セキュリティ(入口4通りの現状維持・PII 不在の構造保証・escape・script 1本・204 オラクル封じ・lock order・`X-Frame-Options`・HTTPS の前提)。Monitor(`-R ligarejapan-hue/property-management`)。マージは発注者。

---

## Self-Review

**1. 設計書との対応(§2.4 + 2026-09-11 追記)**
- `/t/` 拡張・302 と 404 の現状維持・列挙耐性 → Task 4 ✅
- `renderLpPage` 純関数・React なし・全値 escape・CSS inline・外部読み込みなし → Task 3 ✅
- 構成(ヒーロー→見出し→リード→申込ボタン→本文(■+写真/図)→FAQ→(フォーム=PR4)→会社案内+電話→配信停止) → Task 3 ✅(フォームは口だけ=読み替え1)
- 差し込みは町名までと種別のみ・PII 列を持たせない → Task 2(キー集合テスト)・Task 4(select 固定) ✅
- `no-store` → Task 3/4 ✅・送付前のプレビュー帯とフォーム送信不可(フォーム自体なし) → Task 2/3/4 ✅
- 社内プレビュー(認証・見本・帯)+**PC/スマホ切替** → Task 6 ✅
- 電話タップ(sendBeacon・best-effort・sent のみ・初回監査・反響なし・レート制限) → Task 3/5 ✅
- PC/スマホ最適化(固定バー・中央1列・16px・44px・reduced-motion) → Task 3 ✅
- §2.1 集計(LP型ごと・組合せ・電話タップ率) → Task 7 ✅
- §4 HTTPS の前提 → Task 8 文書 ✅(コードは `trackingBaseUrl` を既存設定で切替)

**2. プレースホルダー走査**: Task 6 の route テストと Task 7 は「既存テストの流儀で」の指示付きだが、期待するコード/ヘッダ/列名は明記。Task 8 Step 3 は controller 実施。

**3. 型の一貫性**: `LpRenderInput`/`LpImage`/`LpSectionMedia`(Task 2)=Task 3 の `img()`/描画・Task 4/6 の `buildLpRenderInput` 呼び出しと一致。`PUBLIC_PAGE_HEADERS` は Task 3 が再エクスポートし Task 4/6 が使う。`recordPhoneTap` の戻り `{matched, first, draftId?}`=Task 5 route の使用と一致。列名 `phoneTapCount`/`phoneTapFirstAt`(Task 1)=Task 5/7 と一致。監査 action 3 種(Task 5 allowlist)=Task 4(既存 `sale_dm_tracking_hit`)/5/6 の呼び出しと一致。
