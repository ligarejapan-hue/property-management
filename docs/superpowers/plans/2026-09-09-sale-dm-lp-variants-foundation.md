# 売却DM LP型の土台(第1段 PR1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** キャンペーンに「LP型」(DmLpVariant)を新設し、DM型と独立に作成・プロンプト表示・貼り戻し(切り分け)・凍結・宛先への両軸割当(総当たり均等)・二軸集計ができる状態にする。所有者側(公開 `/t/`)の挙動は**一切変えない**。

**Architecture:** 既存の DM型(DmVariant)の3手順(prompt→template→freeze)を LP型にも複製する。判定はすべて `src/lib/sale-dm-letter/` の純関数(`splitLpTemplate` / `assignCrossEvenly` / `aggregateTwoAxis` / `markLpVariantsFrozen`)に隔離し、route は既存の variants route と同じ骨組み(`requireSaleDmWriteAccess` → `assertSaleDmCampaignOwned` → tx でロック → 二重凍結判定 → 監査)で書く。ロック順序は **Owner → dm_variants → dm_lp_variants → properties → dm_recipient_drafts**(既存順序に dm_lp_variants を dm_variants の直後に挿入)。

**Tech Stack:** Next.js App Router route handlers, Prisma(PostgreSQL・`@/generated/prisma`), zod, vitest(`src/lib/__tests__/`・prisma は `vi.mock("@/lib/prisma")`)、React client components(Tailwind)。

**Spec:** `docs/superpowers/specs/2026-09-08-sale-dm-lp-autobuild-design.md` §2.1 §2.2 §2.8 §2.9 §3-1(本PRは §3 の 1 のみ。写真/公開LP/申込/メールは範囲外)。

## Global Constraints

- 新規 route(書き込み)は必ず `requireSaleDmWriteAccess` を呼ぶ(走査テスト `sale-dm-write-gate*.test.ts` が落ちる)。読み取りは `requireSaleDmAccess` + `assertSaleDmCampaignOwned`。
- 全応答に `{ headers: { "Cache-Control": "no-store" } }`。not-found と not-owned は同じ 404。
- `src/` 配下のどのファイルにも文字列 `saleDmLetter` を書かない(走査テスト)。ディレクトリ名 `sale-dm-letter` は可。
- `model DmLpVariant` は schema.prisma で **`model DmRecipientDraft {` … の後・`model SaleDmConfig {` の前**に置く(既存走査テストが `DmVariant`〜`DmRecipientDraft` 間を切り出すため、その間に入れない)。
- 監査ログ detail に外部由来の文字(本文・見出し・ラベル)を入れない。件数/ID/ISO日時のみ。新 action は `src/lib/audit-log-detail-safety.ts` の allowlist に追加し、`sale-dm-external-audit-visible.test.ts` に CASES を足す。
- 文字数距離を使う判定は改行を LF に正規化してから行う(CRLF/LF で判定が変わらないことをテストで固定)。
- Tailwind: `bg-blue-600` を使わない(ラチェット)。`fixed inset-0` のモーダル・`border-b-2` のタブ行を手書きしない(既存 variant-manager と同じくインラインフォームで作る)。
- `src/components/sale-dm/variant-manager.tsx` の既存文字列(`optionChanged` `lpUrlChanged` `r.status === "confirmed"` `確定が解除` `window.confirm` `const openLetter` 直後の構造)は変えない(走査テストが文字列で見る)。本PRではこのファイルを**触らない**。
- コミットは task ごと。`git add` は変更したファイルを列挙(`.claude/settings.local.json` を混ぜない)。
- 作業は専用 worktree(memory ルール)。base は `origin/main`。設計書ブランチ `design/sale-dm-lp-autobuild` の spec を `git checkout design/sale-dm-lp-autobuild -- docs/superpowers/specs/2026-09-08-sale-dm-lp-autobuild-design.md` で取り込んでから始める。
- 「緑」と言う前に `npx vitest run`(フル)と `npx tsc --noEmit` を通す。

---

## File Structure

| 種別 | パス | 責務 |
|---|---|---|
| 変更 | `prisma/schema.prisma` | `DmLpVariant` 新設、`DmRecipientDraft.lpVariantId`、`DmCampaign.lpVariants` |
| 作成 | `prisma/migrations/20260909000000_add_dm_lp_variants/migration.sql` | 表・列・索引・FK(additive のみ) |
| 作成 | `src/lib/sale-dm-letter/lp-template.ts` | 貼り戻しの切り分け `splitLpTemplate` と上限・文言(純関数) |
| 変更 | `src/lib/sale-dm-letter/external-prompt.ts` | `buildLpExternalPrompt`(文体4項目のみ) |
| 変更 | `src/lib/sale-dm-letter/assign.ts` | `assignCrossEvenly`(両軸の総当たり均等) |
| 変更 | `src/lib/sale-dm-letter/freeze.ts` | `markLpVariantsFrozen` |
| 変更 | `src/lib/sale-dm-letter/aggregate.ts` | `aggregateTwoAxis`(DM型の閲覧率・LP型・組み合わせ) |
| 変更 | `src/lib/validators-sale-dm.ts` | LP型の zod、assign に `lpAssignments` |
| 作成 | `src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/route.ts` | GET/POST |
| 作成 | `.../lp-variants/[lpId]/route.ts` | PATCH/DELETE |
| 作成 | `.../lp-variants/[lpId]/prompt/route.ts` | GET(プロンプト+指紋+凍結) |
| 作成 | `.../lp-variants/[lpId]/template/route.ts` | PUT(貼り戻し保存) |
| 変更 | `.../campaigns/[id]/assign/route.ts` | 両軸割当・dm_lp_variants ロック・LP凍結印 |
| 変更 | `.../campaigns/[id]/route.ts` | 応答に `lpVariants` と `lpVariantId` |
| 変更 | `.../campaigns/[id]/aggregate/route.ts` | 応答に二軸集計 |
| 変更 | `.../drafts/confirm/route.ts`, `.../drafts/[id]/route.ts`, `.../variants/[variantId]/route.ts` | 確定の証拠が消える前に LP型へも凍結印 |
| 変更 | `src/lib/audit-log-detail-safety.ts` | 新 action の allowlist |
| 変更 | `src/lib/api-client.ts` | 型と client 関数 |
| 変更 | `src/lib/sale-dm-letter/aggregate-view-model.ts` | 画面用の3表の行 |
| 変更 | `src/components/sale-dm/aggregate-view.tsx` | 3表の描画 |
| 作成 | `src/components/sale-dm/lp-variant-manager.tsx` | LP型の管理パネル(作成/編集/削除/文面) |
| 変更 | `src/app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx` | パネルの組み込み |
| 変更 | `public/docs/guide.html` | 使い方の追記 |
| テスト | `src/lib/__tests__/sale-dm-lp-*.test.ts` ほか | 各 task に記載 |

---

### Task 1: スキーマと migration(LP型の表・宛先の列)

**Files:**
- Modify: `prisma/schema.prisma`(`model DmCampaign` L1129-1146 / `model DmRecipientDraft` L1175-1220 / `model SaleDmConfig` L1243 の直前)
- Create: `prisma/migrations/20260909000000_add_dm_lp_variants/migration.sql`
- Test: `src/lib/__tests__/sale-dm-lp-variant-columns.test.ts`

**Interfaces:**
- Produces: Prisma model `DmLpVariant`(client では `prisma.dmLpVariant`)、`DmRecipientDraft.lpVariantId: string | null`、relation `DmLpVariant.recipients`、`DmCampaign.lpVariants`。

- [ ] **Step 1: 走査テストを書く(schema と migration の形を固定)**

```ts
// src/lib/__tests__/sale-dm-lp-variant-columns.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const schema = readFileSync(path.resolve(process.cwd(), "prisma/schema.prisma"), "utf-8").replace(/\r\n/g, "\n");
const lp = schema.slice(schema.indexOf("model DmLpVariant {"), schema.indexOf("model SaleDmConfig {"));
const draft = schema.slice(schema.indexOf("model DmRecipientDraft {"), schema.indexOf("model DmLpVariant {"));
const sql = readFileSync(
  path.resolve(process.cwd(), "prisma/migrations/20260909000000_add_dm_lp_variants/migration.sql"),
  "utf-8",
).replace(/\r\n/g, "\n");

describe("DmLpVariant(LP型)の表", () => {
  it("DmRecipientDraft の後・SaleDmConfig の前に置く(既存走査の切り出しを壊さない)", () => {
    const a = schema.indexOf("model DmRecipientDraft {");
    const b = schema.indexOf("model DmLpVariant {");
    const c = schema.indexOf("model SaleDmConfig {");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
  it("文体4項目・プロンプト控え・原文・切り分け結果・凍結印を持つ", () => {
    for (const col of ["tone", "length", "appeal", "strength", "promptText", "rawTemplate", "headline", "lead", "bodyText", "faqJson", "templateFrozenAt"]) {
      expect(lp, `${col} が無い`).toMatch(new RegExp(`\\n\\s+${col}\\s`));
    }
    expect(lp).toMatch(/@@map\("dm_lp_variants"\)/);
    expect(lp).toMatch(/@@index\(\[campaignId\]\)/);
  });
  it("宛先の lpVariantId は nullable(既存行を壊さない)", () => {
    expect(draft).toMatch(/lpVariantId\s+String\?\s+@map\("lp_variant_id"\)/);
    expect(draft).toMatch(/@@index\(\[lpVariantId\]\)/);
  });
  it("migration は additive のみ(UPDATE/DELETE/DROP/NOT NULL 追加を含まない)", () => {
    expect(sql).toMatch(/CREATE TABLE "dm_lp_variants"/);
    expect(sql).toMatch(/ADD COLUMN "lp_variant_id" UUID;/);
    expect(sql).toMatch(/ON DELETE CASCADE/); // campaign 削除で LP型も消える
    // 文頭の UPDATE/DELETE/DROP だけを禁止(FK の "ON UPDATE CASCADE" / "ON DELETE SET NULL" は許可)。
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|DROP)\b/m);
    expect(sql).not.toMatch(/ALTER TABLE "dm_recipient_drafts"[^;]*NOT NULL/);
  });
});
```

- [ ] **Step 2: 落ちることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-lp-variant-columns.test.ts`
Expected: FAIL(`model DmLpVariant {` が無い / migration ファイルが無い)

- [ ] **Step 3: schema.prisma を編集**

`model DmCampaign` の relations に1行足す:

```prisma
  variants   DmVariant[]
  lpVariants DmLpVariant[]
  recipients DmRecipientDraft[]
```

`model DmRecipientDraft` に列・relation・index を足す(`variantId` の直後、`variant` relation の直後、`@@index([propertyId])` の直後):

```prisma
  variantId             String           @map("variant_id") @db.Uuid
  /// LP型(DmLpVariant)。null = LP型なし(QR は従来どおり外部LPへ転送)。
  lpVariantId           String?          @map("lp_variant_id") @db.Uuid
```
```prisma
  variant   DmVariant  @relation(fields: [variantId], references: [id])
  lpVariant DmLpVariant? @relation(fields: [lpVariantId], references: [id])
```
```prisma
  @@index([propertyId])
  @@index([lpVariantId])
```

`model DmRecipientDraft { … }` の閉じ `}` の後(`model SaleDmConfig {` の前)に追加:

```prisma
/// 売却DMの「LP型」(設計 2026-09-08 §2.1)。DM型(DmVariant)と独立の A/B 軸。
/// 貼り戻した原文(rawTemplate)と切り分け結果(headline/lead/bodyText/faqJson)を同時に持つ。
/// 凍結は DmVariant と同じ二重判定(templateFrozenAt OR 配下に confirmed/sent)。
model DmLpVariant {
  id               String    @id @default(uuid()) @db.Uuid
  campaignId       String    @map("campaign_id") @db.Uuid
  label            String
  tone             String
  length           String
  appeal           String
  strength         String
  promptText       String?   @map("prompt_text")
  rawTemplate      String?   @map("raw_template")
  headline         String?
  lead             String?
  bodyText         String?   @map("body_text")
  faqJson          Json?     @map("faq_json")
  templateFrozenAt DateTime? @map("template_frozen_at")
  createdAt        DateTime  @default(now()) @map("created_at")
  updatedAt        DateTime  @updatedAt @map("updated_at")

  campaign   DmCampaign         @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  recipients DmRecipientDraft[]

  @@index([campaignId])
  @@map("dm_lp_variants")
}
```

- [ ] **Step 4: migration.sql を書く**

```sql
-- 売却DM LP型(設計 2026-09-08 §2.1/§2.9)。additive のみ。既存行の lp_variant_id は NULL=従来どおり。
-- CreateTable
CREATE TABLE "dm_lp_variants" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "tone" TEXT NOT NULL,
    "length" TEXT NOT NULL,
    "appeal" TEXT NOT NULL,
    "strength" TEXT NOT NULL,
    "prompt_text" TEXT,
    "raw_template" TEXT,
    "headline" TEXT,
    "lead" TEXT,
    "body_text" TEXT,
    "faq_json" JSONB,
    "template_frozen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dm_lp_variants_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "dm_recipient_drafts" ADD COLUMN "lp_variant_id" UUID;

-- CreateIndex
CREATE INDEX "dm_lp_variants_campaign_id_idx" ON "dm_lp_variants"("campaign_id");
CREATE INDEX "dm_recipient_drafts_lp_variant_id_idx" ON "dm_recipient_drafts"("lp_variant_id");

-- AddForeignKey
ALTER TABLE "dm_lp_variants" ADD CONSTRAINT "dm_lp_variants_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "dm_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dm_recipient_drafts" ADD CONSTRAINT "dm_recipient_drafts_lp_variant_id_fkey" FOREIGN KEY ("lp_variant_id") REFERENCES "dm_lp_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 5: Prisma client を再生成し、テストと型検査**

Run: `npx prisma generate && npx vitest run src/lib/__tests__/sale-dm-lp-variant-columns.test.ts src/lib/__tests__/sale-dm-variant-template-columns.test.ts && npx tsc --noEmit`
Expected: PASS(既存の DmVariant 列走査も緑のまま)

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260909000000_add_dm_lp_variants/migration.sql src/lib/__tests__/sale-dm-lp-variant-columns.test.ts
git commit -m "feat(sale-dm): LP型(dm_lp_variants)の表と宛先の lp_variant_id を追加(additive)"
```

---

### Task 2: 貼り戻しの切り分け `splitLpTemplate`(純関数)

**Files:**
- Create: `src/lib/sale-dm-letter/lp-template.ts`
- Test: `src/lib/__tests__/sale-dm-lp-template-split.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const LP_LIMITS = { headline: 60, lead: 300, body: 4000, faqItem: 300, faqCount: 6 } as const;
  export interface LpFaqItem { q: string; a: string }
  export interface LpTemplateParts { headline: string; lead: string | null; body: string; faq: LpFaqItem[] | null }
  export type LpSplitIssue =
    | { code: "MISSING_SECTION" | "DUPLICATE_SECTION" | "ORDER_MISMATCH" | "UNKNOWN_SECTION" | "EMPTY_SECTION" | "HEADLINE_MULTILINE" | "UNKNOWN_TAG"; section: string }
    | { code: "TOO_LONG"; section: string; limit: number }
    | { code: "FAQ_PAIR_MISMATCH" }
    | { code: "FAQ_TOO_MANY"; limit: number };
  export type LpSplitResult = { ok: true; parts: LpTemplateParts } | { ok: false; issue: LpSplitIssue };
  export function splitLpTemplate(raw: string): LpSplitResult;
  export function lpSplitIssueMessage(issue: LpSplitIssue): string;
  export function lpBodyHeadings(body: string): string[]; // 行頭 ■ の小見出し(PR2 の写真枠で使う)
  ```

- [ ] **Step 1: テストを書く(見出しの欠け/重複/順番/未知・上限・FAQ・タグ・CRLF)**

```ts
// src/lib/__tests__/sale-dm-lp-template-split.test.ts
import { describe, it, expect } from "vitest";
import { splitLpTemplate, lpSplitIssueMessage, lpBodyHeadings, LP_LIMITS } from "../sale-dm-letter/lp-template";

const OK = [
  "【見出し】売却をご検討の方へ",
  "【リード文】",
  "ご所有の{{物件種別}}について、いまの相場と進め方をご案内します。",
  "【本文】",
  "■ 売却の進め方",
  "査定から引渡しまでの流れをご説明します。",
  "",
  "■ 費用について",
  "仲介手数料などの費用の目安です。",
  "【よくある質問】",
  "Q. 査定は無料ですか",
  "A. はい、無料です。",
  "Q. 住みながら売れますか",
  "A. 可能です。",
].join("\n");

describe("splitLpTemplate: 正常系", () => {
  it("4部位に切り分ける", () => {
    const r = splitLpTemplate(OK);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parts.headline).toBe("売却をご検討の方へ");
    expect(r.parts.lead).toContain("{{物件種別}}");
    expect(r.parts.body.startsWith("■ 売却の進め方")).toBe(true);
    expect(r.parts.faq).toEqual([
      { q: "査定は無料ですか", a: "はい、無料です。" },
      { q: "住みながら売れますか", a: "可能です。" },
    ]);
  });
  it("見出しと本文だけでも通る(リード・FAQ は任意 → null)", () => {
    const r = splitLpTemplate("【見出し】\nタイトル\n【本文】\n本文です");
    expect(r).toEqual({ ok: true, parts: { headline: "タイトル", lead: null, body: "本文です", faq: null } });
  });
  it("CRLF でも LF と同じ結果", () => {
    expect(splitLpTemplate(OK.replace(/\n/g, "\r\n"))).toEqual(splitLpTemplate(OK));
  });
  it("Q./A. の全角ピリオド・コロンも受け付け、複数行の回答は結合する", () => {
    const r = splitLpTemplate("【見出し】t\n【本文】b\n【よくある質問】\nQ．質問\nA：回答1行目\n回答2行目");
    expect(r.ok && r.parts.faq).toEqual([{ q: "質問", a: "回答1行目\n回答2行目" }]);
  });
  it("lpBodyHeadings は行頭 ■ の小見出しを順に返す", () => {
    expect(lpBodyHeadings("■ A\nx\n■B\ny")).toEqual(["A", "B"]);
  });
});

describe("splitLpTemplate: 異常系(どこが問題かを返す)", () => {
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ["見出しが無い", "【本文】b", { code: "MISSING_SECTION", section: "見出し" }],
    ["本文が無い", "【見出し】t", { code: "MISSING_SECTION", section: "本文" }],
    ["同じ見出しが2回", "【見出し】t\n【本文】b\n【本文】c", { code: "DUPLICATE_SECTION", section: "本文" }],
    ["順番違い", "【本文】b\n【見出し】t", { code: "ORDER_MISMATCH", section: "見出し" }],
    ["知らない見出し", "【見出し】t\n【おまけ】x\n【本文】b", { code: "UNKNOWN_SECTION", section: "おまけ" }],
    ["見出しが空", "【見出し】\n【本文】b", { code: "EMPTY_SECTION", section: "見出し" }],
    ["見出しが複数行", "【見出し】\n1行目\n2行目\n【本文】b", { code: "HEADLINE_MULTILINE", section: "見出し" }],
    ["FAQ の対が崩れている", "【見出し】t\n【本文】b\n【よくある質問】\nQ. a\nQ. b", { code: "FAQ_PAIR_MISMATCH" }],
    ["FAQ が A から始まる", "【見出し】t\n【本文】b\n【よくある質問】\nA. x", { code: "FAQ_PAIR_MISMATCH" }],
    ["FAQ 見出しだけで中身が無い", "【見出し】t\n【本文】b\n【よくある質問】\n", { code: "EMPTY_SECTION", section: "よくある質問" }],
    ["未知の差し込み記号", "【見出し】t\n【本文】{{氏名}}様", { code: "UNKNOWN_TAG", section: "本文" }],
    ["波かっこの書き損じ", "【見出し】t\n【本文】{{物件所在}}}", { code: "UNKNOWN_TAG", section: "本文" }],
    ["見出し以外の行が最初にある", "前置き\n【見出し】t\n【本文】b", { code: "UNKNOWN_SECTION", section: "(見出しの前)" }],
  ];
  for (const [name, raw, issue] of cases) {
    it(name, () => {
      const r = splitLpTemplate(raw);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.issue).toMatchObject(issue);
      expect(lpSplitIssueMessage(r.issue).length).toBeGreaterThan(0);
    });
  }
  it("上限超え: 見出し60/リード300/本文4000/Q&A各300/FAQ 6組", () => {
    const long = (n: number) => "あ".repeat(n);
    expect(splitLpTemplate(`【見出し】${long(61)}\n【本文】b`)).toMatchObject({ ok: false, issue: { code: "TOO_LONG", section: "見出し", limit: 60 } });
    expect(splitLpTemplate(`【見出し】t\n【リード文】${long(301)}\n【本文】b`)).toMatchObject({ ok: false, issue: { code: "TOO_LONG", section: "リード文", limit: 300 } });
    expect(splitLpTemplate(`【見出し】t\n【本文】${long(4001)}`)).toMatchObject({ ok: false, issue: { code: "TOO_LONG", section: "本文", limit: 4000 } });
    expect(splitLpTemplate(`【見出し】t\n【本文】b\n【よくある質問】\nQ. ${long(301)}\nA. x`)).toMatchObject({ ok: false, issue: { code: "TOO_LONG", section: "よくある質問", limit: 300 } });
    const seven = Array.from({ length: 7 }, (_, i) => `Q. q${i}\nA. a${i}`).join("\n");
    expect(splitLpTemplate(`【見出し】t\n【本文】b\n【よくある質問】\n${seven}`)).toMatchObject({ ok: false, issue: { code: "FAQ_TOO_MANY", limit: LP_LIMITS.faqCount } });
    expect(splitLpTemplate(`【見出し】${long(60)}\n【本文】${long(4000)}`).ok).toBe(true);
  });
});
```

- [ ] **Step 2: 落ちることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-lp-template-split.test.ts`
Expected: FAIL(module not found)

- [ ] **Step 3: 実装**

```ts
// src/lib/sale-dm-letter/lp-template.ts
/**
 * LP型の貼り戻し文章を、固定見出しで4部位に切り分ける(設計 2026-09-08 §2.2)。
 * DB を触らない純関数のみ。改行は LF に正規化してから判定する。
 * 文字だけを受け付ける(HTML/URL はそのまま文字として扱い、表示側で escape する)。
 */
import { LETTER_TAGS } from "./tags";

export const LP_SECTIONS = ["見出し", "リード文", "本文", "よくある質問"] as const;
export type LpSection = (typeof LP_SECTIONS)[number];
export const LP_LIMITS = { headline: 60, lead: 300, body: 4000, faqItem: 300, faqCount: 6 } as const;

export interface LpFaqItem { q: string; a: string }
export interface LpTemplateParts { headline: string; lead: string | null; body: string; faq: LpFaqItem[] | null }

export type LpSplitIssue =
  | { code: "MISSING_SECTION" | "DUPLICATE_SECTION" | "ORDER_MISMATCH" | "UNKNOWN_SECTION" | "EMPTY_SECTION" | "HEADLINE_MULTILINE" | "UNKNOWN_TAG"; section: string }
  | { code: "TOO_LONG"; section: string; limit: number }
  | { code: "FAQ_PAIR_MISMATCH" }
  | { code: "FAQ_TOO_MANY"; limit: number };

export type LpSplitResult = { ok: true; parts: LpTemplateParts } | { ok: false; issue: LpSplitIssue };

const HEADING_LINE = /^【([^】]*)】\s*(.*)$/;
const FAQ_Q = /^[QqＱ][.．:：]\s*(.*)$/;
const FAQ_A = /^[AaＡ][.．:：]\s*(.*)$/;

function fail(issue: LpSplitIssue): LpSplitResult {
  return { ok: false, issue };
}

/** 許可タグを取り除いた後に波かっこが残れば未知タグ(body-validation と同じ考え方)。 */
function hasBadTag(text: string): boolean {
  const rest = LETTER_TAGS.reduce((acc, tag) => acc.split(`{{${tag}}}`).join(""), text);
  return rest.includes("{") || rest.includes("}");
}

function parseFaq(lines: string[]): { faq: LpFaqItem[] } | { issue: LpSplitIssue } {
  const items: LpFaqItem[] = [];
  let cur: { q: string; a: string | null } | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const q = FAQ_Q.exec(line);
    const a = FAQ_A.exec(line);
    if (q) {
      if (cur && cur.a === null) return { issue: { code: "FAQ_PAIR_MISMATCH" } };
      if (cur) items.push({ q: cur.q, a: cur.a as string });
      cur = { q: q[1].trim(), a: null };
    } else if (a) {
      if (!cur || cur.a !== null) return { issue: { code: "FAQ_PAIR_MISMATCH" } };
      cur.a = a[1].trim();
    } else {
      // 続きの行: 直前の Q か A に結合する。
      if (!cur) return { issue: { code: "FAQ_PAIR_MISMATCH" } };
      if (cur.a === null) cur.q = `${cur.q}\n${line}`;
      else cur.a = `${cur.a}\n${line}`;
    }
  }
  if (cur) {
    if (cur.a === null) return { issue: { code: "FAQ_PAIR_MISMATCH" } };
    items.push({ q: cur.q, a: cur.a });
  }
  return { faq: items };
}

export function splitLpTemplate(raw: string): LpSplitResult {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const found = new Map<LpSection, string[]>();
  let current: LpSection | null = null;
  let lastIndex = -1;

  for (const line of lines) {
    const m = HEADING_LINE.exec(line.trim());
    if (m) {
      const name = m[1].trim();
      const idx = (LP_SECTIONS as readonly string[]).indexOf(name);
      if (idx < 0) return fail({ code: "UNKNOWN_SECTION", section: name });
      const section = LP_SECTIONS[idx];
      if (found.has(section)) return fail({ code: "DUPLICATE_SECTION", section });
      if (idx < lastIndex) return fail({ code: "ORDER_MISMATCH", section });
      lastIndex = idx;
      current = section;
      found.set(section, m[2] ? [m[2]] : []);
      continue;
    }
    if (current === null) {
      if (line.trim().length === 0) continue;
      return fail({ code: "UNKNOWN_SECTION", section: "(見出しの前)" });
    }
    found.get(current)!.push(line);
  }

  for (const required of ["見出し", "本文"] as const) {
    if (!found.has(required)) return fail({ code: "MISSING_SECTION", section: required });
  }

  const text = (s: LpSection) => (found.get(s) ?? []).join("\n").trim();

  const headline = text("見出し");
  if (headline.length === 0) return fail({ code: "EMPTY_SECTION", section: "見出し" });
  if (headline.includes("\n")) return fail({ code: "HEADLINE_MULTILINE", section: "見出し" });
  if (headline.length > LP_LIMITS.headline) return fail({ code: "TOO_LONG", section: "見出し", limit: LP_LIMITS.headline });
  if (hasBadTag(headline)) return fail({ code: "UNKNOWN_TAG", section: "見出し" });

  let lead: string | null = null;
  if (found.has("リード文")) {
    lead = text("リード文");
    if (lead.length === 0) return fail({ code: "EMPTY_SECTION", section: "リード文" });
    if (lead.length > LP_LIMITS.lead) return fail({ code: "TOO_LONG", section: "リード文", limit: LP_LIMITS.lead });
    if (hasBadTag(lead)) return fail({ code: "UNKNOWN_TAG", section: "リード文" });
  }

  const body = text("本文");
  if (body.length === 0) return fail({ code: "EMPTY_SECTION", section: "本文" });
  if (body.length > LP_LIMITS.body) return fail({ code: "TOO_LONG", section: "本文", limit: LP_LIMITS.body });
  if (hasBadTag(body)) return fail({ code: "UNKNOWN_TAG", section: "本文" });

  let faq: LpFaqItem[] | null = null;
  if (found.has("よくある質問")) {
    const parsed = parseFaq(found.get("よくある質問") ?? []);
    if ("issue" in parsed) return fail(parsed.issue);
    if (parsed.faq.length === 0) return fail({ code: "EMPTY_SECTION", section: "よくある質問" });
    if (parsed.faq.length > LP_LIMITS.faqCount) return fail({ code: "FAQ_TOO_MANY", limit: LP_LIMITS.faqCount });
    for (const item of parsed.faq) {
      if (item.q.length > LP_LIMITS.faqItem || item.a.length > LP_LIMITS.faqItem) {
        return fail({ code: "TOO_LONG", section: "よくある質問", limit: LP_LIMITS.faqItem });
      }
      if (hasBadTag(item.q) || hasBadTag(item.a)) return fail({ code: "UNKNOWN_TAG", section: "よくある質問" });
    }
    faq = parsed.faq;
  }

  return { ok: true, parts: { headline, lead, body, faq } };
}

export function lpSplitIssueMessage(issue: LpSplitIssue): string {
  switch (issue.code) {
    case "MISSING_SECTION": return `【${issue.section}】の見出しがありません。指示文どおりの見出しで区切ってください`;
    case "DUPLICATE_SECTION": return `【${issue.section}】の見出しが2回あります`;
    case "ORDER_MISMATCH": return `【${issue.section}】の順番が違います(見出し→リード文→本文→よくある質問)`;
    case "UNKNOWN_SECTION": return `知らない見出し「${issue.section}」があります。使えるのは 見出し・リード文・本文・よくある質問 の4つです`;
    case "EMPTY_SECTION": return `【${issue.section}】の中身が空です`;
    case "HEADLINE_MULTILINE": return "【見出し】は1行にしてください";
    case "UNKNOWN_TAG": return `【${issue.section}】に使えない差し込み記号があります。使えるのは {{物件所在}} と {{物件種別}} だけです`;
    case "TOO_LONG": return `【${issue.section}】が長すぎます(上限 ${issue.limit} 字)`;
    case "FAQ_PAIR_MISMATCH": return "【よくある質問】は Q. と A. を対にして書いてください";
    case "FAQ_TOO_MANY": return `【よくある質問】は ${issue.limit} 組までです`;
  }
}

/** 本文の行頭 ■ の小見出しを順に返す(PR2 の「節ごとの写真/図」で使う)。 */
export function lpBodyHeadings(body: string): string[] {
  return body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("■"))
    .map((l) => l.slice(1).trim())
    .filter((l) => l.length > 0);
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-lp-template-split.test.ts`
Expected: PASS(全件)

- [ ] **Step 5: Commit**

```bash
git add src/lib/sale-dm-letter/lp-template.ts src/lib/__tests__/sale-dm-lp-template-split.test.ts
git commit -m "feat(sale-dm): LP型の貼り戻し文章を固定見出しで切り分ける純関数 splitLpTemplate"
```

---

### Task 3: LP用プロンプト `buildLpExternalPrompt`

**Files:**
- Modify: `src/lib/sale-dm-letter/external-prompt.ts`(`buildExternalPrompt` の直後に追加)
- Test: `src/lib/__tests__/sale-dm-lp-external-prompt.test.ts`

**Interfaces:**
- Produces: `export function buildLpExternalPrompt(options: ExternalPromptOptions): string`(引数は既存 `ExternalPromptOptions` = tone/length/appeal/strength のみ)。指紋は既存 `promptDigest` / `bodyTemplateDigest` を共用。

- [ ] **Step 1: テスト**

```ts
// src/lib/__tests__/sale-dm-lp-external-prompt.test.ts
import { describe, it, expect } from "vitest";
import { buildLpExternalPrompt, buildExternalPrompt, promptDigest } from "../sale-dm-letter/external-prompt";

const OPT = { tone: "formal", length: "medium", appeal: "inheritance", strength: "low" };

describe("buildLpExternalPrompt", () => {
  it("4つの固定見出しと Q./A. の指示を含む", () => {
    const p = buildLpExternalPrompt(OPT);
    for (const h of ["【見出し】", "【リード文】", "【本文】", "【よくある質問】"]) expect(p).toContain(h);
    expect(p).toContain("Q.");
    expect(p).toContain("A.");
    expect(p).toContain("■");
  });
  it("文体4項目を日本語で反映する", () => {
    const p = buildLpExternalPrompt(OPT);
    expect(p).toContain("相続");
    expect(p).not.toContain("inheritance");
  });
  it("社名・連絡先・ボタン文言・宛名・特定情報を書かせない指示がある", () => {
    const p = buildLpExternalPrompt(OPT);
    expect(p).toContain("社名");
    expect(p).toContain("連絡先");
    expect(p).toContain("ボタン");
    expect(p).toContain("宛名");
    expect(p).toContain("{{物件所在}}");
    expect(p).toContain("{{物件種別}}");
    expect(p).toContain("入力しないでください");
  });
  it("DM用プロンプトと指紋が別(貼り違いを検出できる)", () => {
    expect(promptDigest(buildLpExternalPrompt(OPT))).not.toBe(promptDigest(buildExternalPrompt(OPT)));
  });
  it("引数は文体4項目だけ(宛先・物件・差出人を渡す口が無い)", () => {
    expect(buildLpExternalPrompt.length).toBe(1);
    const p = buildLpExternalPrompt({ ...OPT, senderName: "山田" } as never);
    expect(p).not.toContain("山田");
  });
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-external-prompt.test.ts` → FAIL(export が無い)

- [ ] **Step 3: 実装(`buildExternalPrompt` の直後に追加)**

```ts
/**
 * LP型用。DM用と同じく**文体4項目だけ**から組み立てる(宛先・物件・差出人・追加指示は引数に無い)。
 * 出力は固定見出しで区切らせ、貼り戻し時に splitLpTemplate が切り分ける(設計 2026-09-08 §2.2)。
 */
export function buildLpExternalPrompt(options: ExternalPromptOptions): string {
  const tagLines = LETTER_TAGS.map((tag) => `  - {{${tag}}}（システムが読んだ人の物件に合わせて差し込みます）`);
  return [
    "あなたは日本の不動産会社の営業担当者です。ダイレクトメールを受け取った所有者が、QRコードを読んで開く「ご案内ページ（LP）」の文章を作成してください。",
    "手紙より詳しく、所有者が「まず相談してみよう」と思える情報（売却の進め方、費用のかかり方、査定で分かること、よくある不安への答え）を書いてください。",
    "",
    "【文体の方針】",
    `- トーン: ${TONE_JA[options.tone] ?? options.tone}`,
    `- 長さ: ${LENGTH_JA[options.length] ?? options.length}`,
    `- 訴求の軸: ${APPEAL_JA[options.appeal] ?? options.appeal}`,
    `- 押しの強さ: ${STRENGTH_JA[options.strength] ?? options.strength}`,
    "",
    "【出力の形式（必ずこの見出しで区切る）】",
    "【見出し】",
    "（ページの一番上に大きく出る文。1行）",
    "【リード文】",
    "（2〜3文）",
    "【本文】",
    "（段落は空行で区切る。小見出しを付けるときは行頭に ■ を付ける）",
    "【よくある質問】",
    "Q. （質問）",
    "A. （答え）",
    "（Q. と A. を対にして3〜6組）",
    "",
    "【必ず守ること】",
    "- 誇大な表現や誇張を避ける。価格や売却の確実性を断定しない（「必ず高く売れます」等は書かない）。",
    "- 宅地建物取引業法に照らして問題となる断定・誇張をしない。",
    "- **社名・連絡先・住所は書かない**（会社案内の枠はシステムが付けます）。自社に触れる場合も「弊社」等にとどめる。",
    "- **宛名は書かない**。",
    "- 無料査定の申し込みを促す一文は入れてよいが、**ボタンの文言は書かない**（システムが付けます）。",
    "- 出力は上の4つの見出しと中身だけ。前置きや説明、マークダウン記法（# や ** など）は付けない。",
    "",
    "【場所や種別に触れたいとき】",
    "この文章は複数の宛先で共通して使います。特定の物件の情報は書かず、次の記号をそのまま書いてください。",
    ...tagLines,
    "使わなくても構いません。",
    "",
    "【お願い】",
    "所有者の氏名・住所・電話番号や、物件を特定できる情報は、この画面や外部のAIに入力しないでください。場所と種別は上記の記号で自動的に差し込まれます。",
  ].join("\n");
}
```

- [ ] **Step 4: 確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-external-prompt.test.ts src/lib/__tests__/sale-dm-external-prompt*.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/sale-dm-letter/external-prompt.ts src/lib/__tests__/sale-dm-lp-external-prompt.test.ts
git commit -m "feat(sale-dm): LP型用の外部AIプロンプト buildLpExternalPrompt(文体4項目のみ)"
```

---

### Task 4: 両軸の総当たり割当 `assignCrossEvenly` と LP凍結印 `markLpVariantsFrozen`

**Files:**
- Modify: `src/lib/sale-dm-letter/assign.ts`(末尾に追加)
- Modify: `src/lib/sale-dm-letter/freeze.ts`(末尾に追加)
- Test: `src/lib/__tests__/sale-dm-assign-cross.test.ts`, `src/lib/__tests__/sale-dm-lp-freeze.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CrossAssignment { variantId: string; lpVariantId: string | null }
  export function assignCrossEvenly(recipientIds: string[], dmVariantIds: string[], lpVariantIds: string[], opts?: AssignOptions): Map<string, CrossAssignment>;
  export async function markLpVariantsFrozen(tx: { dmLpVariant: { updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }> } }, lpVariantIds: string[], at?: Date): Promise<number>;
  ```

- [ ] **Step 1: テスト(総当たり: 型数×宛先数を全部回す・LP型0件は既存と完全一致)**

```ts
// src/lib/__tests__/sale-dm-assign-cross.test.ts
import { describe, it, expect } from "vitest";
import { assignCrossEvenly, assignVariantsEvenly } from "../sale-dm-letter/assign";

const ids = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`);

function counts(map: Map<string, { variantId: string; lpVariantId: string | null }>) {
  const pair = new Map<string, number>(); const dm = new Map<string, number>(); const lp = new Map<string, number>();
  for (const v of map.values()) {
    const k = `${v.variantId}|${v.lpVariantId}`;
    pair.set(k, (pair.get(k) ?? 0) + 1);
    dm.set(v.variantId, (dm.get(v.variantId) ?? 0) + 1);
    lp.set(String(v.lpVariantId), (lp.get(String(v.lpVariantId)) ?? 0) + 1);
  }
  return { pair, dm, lp };
}
const spread = (m: Map<string, number>, expectedKeys: number) => {
  const vals = [...m.values()];
  while (vals.length < expectedKeys) vals.push(0);
  return Math.max(...vals) - Math.min(...vals);
};

describe("assignCrossEvenly(総当たり)", () => {
  it("LP型が0件なら既存の assignVariantsEvenly と完全一致(後方互換)・lpVariantId は null", () => {
    for (let n = 1; n <= 4; n++) for (let r = 0; r <= 12; r++) {
      const dm = ids("d", n); const rec = ids("r", r);
      const cross = assignCrossEvenly(rec, dm, []);
      const legacy = assignVariantsEvenly(rec, dm);
      expect(cross.size).toBe(legacy.size);
      for (const [rid, vid] of legacy) expect(cross.get(rid)).toEqual({ variantId: vid, lpVariantId: null });
    }
  });
  it("DM型×LP型の全組が最大1差で均等、DM型の周辺も既存と同じ順、LP型の周辺は最大2差", () => {
    for (let n = 1; n <= 4; n++) for (let m = 1; m <= 4; m++) for (let r = 0; r <= 40; r++) {
      const dm = ids("d", n); const lp = ids("l", m); const rec = ids("r", r);
      const map = assignCrossEvenly(rec, dm, lp);
      expect(map.size).toBe(r);
      const c = counts(map);
      expect(spread(c.pair, n * m), `n=${n} m=${m} r=${r}`).toBeLessThanOrEqual(1);
      expect(spread(c.dm, n)).toBeLessThanOrEqual(1);
      expect(spread(c.lp, m)).toBeLessThanOrEqual(2);
      const legacy = assignVariantsEvenly(rec, dm);
      for (const [rid, vid] of legacy) expect(map.get(rid)?.variantId).toBe(vid);
      for (const v of map.values()) expect(lp).toContain(v.lpVariantId);
    }
  });
  it("端数は先頭の組から1つずつ多い(sequential・n=2 m=2 r=5)", () => {
    const map = assignCrossEvenly(ids("r", 5), ids("d", 2), ids("l", 2));
    expect([...map.values()]).toEqual([
      { variantId: "d0", lpVariantId: "l0" }, { variantId: "d1", lpVariantId: "l1" },
      { variantId: "d0", lpVariantId: "l1" }, { variantId: "d1", lpVariantId: "l0" },
      { variantId: "d0", lpVariantId: "l0" },
    ]);
  });
  it("random は本数分布を変えず並びだけ変える(rng 注入)", () => {
    const rec = ids("r", 9);
    const a = assignCrossEvenly(rec, ids("d", 2), ids("l", 2));
    const b = assignCrossEvenly(rec, ids("d", 2), ids("l", 2), { order: "random", rng: () => 0.99 });
    expect(counts(a).pair).toEqual(counts(b).pair);
    expect([...a.values()]).not.toEqual([...b.values()]);
  });
  it("DM型か宛先が空なら空 Map", () => {
    expect(assignCrossEvenly([], ids("d", 2), ids("l", 2)).size).toBe(0);
    expect(assignCrossEvenly(ids("r", 3), [], ids("l", 2)).size).toBe(0);
  });
});
```

```ts
// src/lib/__tests__/sale-dm-lp-freeze.test.ts
import { describe, it, expect, vi } from "vitest";
import { markLpVariantsFrozen } from "../sale-dm-letter/freeze";

describe("markLpVariantsFrozen", () => {
  it("未設定の LP型だけに印を立て、重複と null を除いて id 順に渡す", async () => {
    const updateMany = vi.fn(async () => ({ count: 2 }));
    const at = new Date("2026-09-09T00:00:00Z");
    const n = await markLpVariantsFrozen({ dmLpVariant: { updateMany } }, ["b", "a", "b"], at);
    expect(n).toBe(2);
    expect(updateMany).toHaveBeenCalledWith({ where: { id: { in: ["a", "b"] }, templateFrozenAt: null }, data: { templateFrozenAt: at } });
  });
  it("空なら DB を触らない", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    expect(await markLpVariantsFrozen({ dmLpVariant: { updateMany } }, [])).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-assign-cross.test.ts src/lib/__tests__/sale-dm-lp-freeze.test.ts` → FAIL

- [ ] **Step 3: 実装(assign.ts 末尾)**

```ts
export interface CrossAssignment {
  variantId: string;
  lpVariantId: string | null;
}

/**
 * DM型×LP型の両軸へ総当たりで均等割り(設計 2026-09-08 §2.1)。
 *  - 宛先 k 番目: DM型 = dm[k % n](既存 assignVariantsEvenly と同じ順)、
 *    LP型 = lp[(k % n + floor(k / n)) % m](行ごとにずらすラテン方陣。n×m の1周で全組を1回ずつ)。
 *  - 端数は先頭の組から1つずつ多い。random は本数分布を保ったまま並びだけシャッフル。
 *  - LP型が0件なら lpVariantId=null で、DM軸は既存関数と完全一致(後方互換)。
 */
export function assignCrossEvenly(
  recipientIds: string[],
  dmVariantIds: string[],
  lpVariantIds: string[],
  opts?: AssignOptions,
): Map<string, CrossAssignment> {
  const map = new Map<string, CrossAssignment>();
  if (dmVariantIds.length === 0 || recipientIds.length === 0) return map;
  const n = dmVariantIds.length;
  const m = lpVariantIds.length;
  let seq: CrossAssignment[] = [];
  for (let k = 0; k < recipientIds.length; k++) {
    const dmIdx = k % n;
    const lp = m === 0 ? null : lpVariantIds[(dmIdx + Math.floor(k / n)) % m];
    seq.push({ variantId: dmVariantIds[dmIdx], lpVariantId: lp });
  }
  if (opts?.order === "random") {
    seq = shuffle(seq, opts.rng ?? Math.random);
  }
  recipientIds.forEach((rid, i) => map.set(rid, seq[i]));
  return map;
}
```

freeze.ts 末尾:

```ts
/** LP型の凍結印(DM型の markVariantsFrozen と同じ規則)。呼び出し側は dm_lp_variants 行をロック済みであること。 */
export async function markLpVariantsFrozen(
  tx: {
    dmLpVariant: {
      updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }>;
    };
  },
  lpVariantIds: Array<string | null | undefined>,
  at: Date = new Date(),
): Promise<number> {
  const ids = [...new Set(lpVariantIds.filter((x): x is string => typeof x === "string" && x.length > 0))].sort();
  if (ids.length === 0) return 0;
  const r = await tx.dmLpVariant.updateMany({
    where: { id: { in: ids }, templateFrozenAt: null },
    data: { templateFrozenAt: at },
  });
  return r.count;
}
```

- [ ] **Step 4: 確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-assign-cross.test.ts src/lib/__tests__/sale-dm-lp-freeze.test.ts src/lib/__tests__/sale-dm-assign.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/sale-dm-letter/assign.ts src/lib/sale-dm-letter/freeze.ts src/lib/__tests__/sale-dm-assign-cross.test.ts src/lib/__tests__/sale-dm-lp-freeze.test.ts
git commit -m "feat(sale-dm): 両軸の総当たり割当 assignCrossEvenly と LP型の凍結印 markLpVariantsFrozen"
```

---

### Task 5: 二軸集計 `aggregateTwoAxis`

**Files:**
- Modify: `src/lib/sale-dm-letter/aggregate.ts`(末尾に追加。既存 `aggregateByVariant` は変更しない)
- Test: `src/lib/__tests__/sale-dm-aggregate-two-axis.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TwoAxisDraftInput extends AggregateDraftInput { lpVariantId: string | null }
  export interface DmViewAggregate { variantId: string; sent: number; delivered: number; viewed: number; deliveredViewed: number; viewRate: number | null }
  export interface LpVariantAggregate { lpVariantId: string; sent: number; delivered: number; viewed: number; deliveredViewed: number; viewRate: number | null }
  export interface PairAggregate { variantId: string; lpVariantId: string; sent: number; delivered: number; viewed: number }
  export const LP_NONE = "__none__";  // LP型なし(外部LP)の宛先のまとめ先
  export interface TwoAxisAggregate { byDmVariant: DmViewAggregate[]; byLpVariant: LpVariantAggregate[]; byPair: PairAggregate[] }
  export function aggregateTwoAxis(drafts: TwoAxisDraftInput[]): TwoAxisAggregate
  ```
  閲覧 = `lpFirstAccessAt != null`。閲覧率 = (到達かつ閲覧) ÷ 到達。到達0は null。並びは id の localeCompare。

- [ ] **Step 1: テスト**

```ts
// src/lib/__tests__/sale-dm-aggregate-two-axis.test.ts
import { describe, it, expect } from "vitest";
import { aggregateTwoAxis, LP_NONE } from "../sale-dm-letter/aggregate";

const d = (variantId: string, lpVariantId: string | null, deliveryStatus: string, viewed: boolean) => ({
  variantId, lpVariantId, deliveryStatus, lpFirstAccessAt: viewed ? new Date() : null, phoneInquiryAt: null,
});

describe("aggregateTwoAxis", () => {
  it("DM型ごとの閲覧率(到達かつ閲覧 ÷ 到達)を出す", () => {
    const r = aggregateTwoAxis([
      d("A", "X", "delivered", true), d("A", "X", "delivered", false), d("A", "Y", "returned_undeliverable", true),
      d("B", "Y", "delivered", false),
    ]);
    expect(r.byDmVariant).toEqual([
      { variantId: "A", sent: 3, delivered: 2, viewed: 2, deliveredViewed: 1, viewRate: 0.5 },
      { variantId: "B", sent: 1, delivered: 1, viewed: 0, deliveredViewed: 0, viewRate: 0 },
    ]);
  });
  it("LP型ごとと組み合わせごとを出し、到達0は率 null", () => {
    const r = aggregateTwoAxis([d("A", "X", "unknown", true), d("B", "X", "delivered", true), d("A", "Y", "delivered", false)]);
    expect(r.byLpVariant).toEqual([
      { lpVariantId: "X", sent: 2, delivered: 1, viewed: 2, deliveredViewed: 1, viewRate: 1 },
      { lpVariantId: "Y", sent: 1, delivered: 1, viewed: 0, deliveredViewed: 0, viewRate: 0 },
    ]);
    expect(r.byPair).toEqual([
      { variantId: "A", lpVariantId: "X", sent: 1, delivered: 0, viewed: 1 },
      { variantId: "A", lpVariantId: "Y", sent: 1, delivered: 1, viewed: 0 },
      { variantId: "B", lpVariantId: "X", sent: 1, delivered: 1, viewed: 1 },
    ]);
    expect(aggregateTwoAxis([d("A", "X", "unknown", true)]).byLpVariant[0].viewRate).toBeNull();
  });
  it("LP型なし(null)の宛先は LP_NONE にまとめ、総数は宛先数と一致する", () => {
    const r = aggregateTwoAxis([d("A", null, "delivered", false), d("A", "X", "delivered", true)]);
    expect(r.byLpVariant.map((x) => x.lpVariantId)).toEqual([LP_NONE, "X"]);
    expect(r.byLpVariant.reduce((s, x) => s + x.sent, 0)).toBe(2);
    expect(r.byPair.reduce((s, x) => s + x.sent, 0)).toBe(2);
  });
  it("空なら空", () => {
    expect(aggregateTwoAxis([])).toEqual({ byDmVariant: [], byLpVariant: [], byPair: [] });
  });
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-aggregate-two-axis.test.ts` → FAIL

- [ ] **Step 3: 実装(aggregate.ts 末尾)**

```ts
// ---- 二軸集計(設計 2026-09-08 §2.1)。DM型=閲覧率、LP型=閲覧(申込率は PR4 で追加)、組み合わせ表。
export const LP_NONE = "__none__";

export interface TwoAxisDraftInput extends AggregateDraftInput {
  lpVariantId: string | null;
}
interface ViewBucket { sent: number; delivered: number; viewed: number; deliveredViewed: number }
export interface DmViewAggregate { variantId: string; sent: number; delivered: number; viewed: number; deliveredViewed: number; viewRate: number | null }
export interface LpVariantAggregate { lpVariantId: string; sent: number; delivered: number; viewed: number; deliveredViewed: number; viewRate: number | null }
export interface PairAggregate { variantId: string; lpVariantId: string; sent: number; delivered: number; viewed: number }
export interface TwoAxisAggregate { byDmVariant: DmViewAggregate[]; byLpVariant: LpVariantAggregate[]; byPair: PairAggregate[] }

function bump(map: Map<string, ViewBucket>, key: string, draft: TwoAxisDraftInput): void {
  const b = map.get(key) ?? { sent: 0, delivered: 0, viewed: 0, deliveredViewed: 0 };
  const isDelivered = draft.deliveryStatus === "delivered";
  const isViewed = draft.lpFirstAccessAt != null;
  b.sent += 1;
  if (isDelivered) b.delivered += 1;
  if (isViewed) b.viewed += 1;
  if (isDelivered && isViewed) b.deliveredViewed += 1;
  map.set(key, b);
}

export function aggregateTwoAxis(drafts: TwoAxisDraftInput[]): TwoAxisAggregate {
  const dm = new Map<string, ViewBucket>();
  const lp = new Map<string, ViewBucket>();
  const pair = new Map<string, ViewBucket>();
  for (const draft of drafts) {
    const lpKey = draft.lpVariantId ?? LP_NONE;
    bump(dm, draft.variantId, draft);
    bump(lp, lpKey, draft);
    bump(pair, `${draft.variantId}|${lpKey}`, draft);
  }
  const sortKeys = (m: Map<string, ViewBucket>) => [...m.keys()].sort((a, b) => a.localeCompare(b));
  return {
    byDmVariant: sortKeys(dm).map((k) => { const b = dm.get(k)!; return { variantId: k, sent: b.sent, delivered: b.delivered, viewed: b.viewed, deliveredViewed: b.deliveredViewed, viewRate: rate(b.deliveredViewed, b.delivered) }; }),
    byLpVariant: sortKeys(lp).map((k) => { const b = lp.get(k)!; return { lpVariantId: k, sent: b.sent, delivered: b.delivered, viewed: b.viewed, deliveredViewed: b.deliveredViewed, viewRate: rate(b.deliveredViewed, b.delivered) }; }),
    byPair: sortKeys(pair).map((k) => { const b = pair.get(k)!; const [variantId, lpVariantId] = k.split("|"); return { variantId, lpVariantId, sent: b.sent, delivered: b.delivered, viewed: b.viewed }; }),
  };
}
```

- [ ] **Step 4: 確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-aggregate-two-axis.test.ts src/lib/__tests__/sale-dm-aggregate.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/sale-dm-letter/aggregate.ts src/lib/__tests__/sale-dm-aggregate-two-axis.test.ts
git commit -m "feat(sale-dm): 二軸集計 aggregateTwoAxis(DM型の閲覧率・LP型・組み合わせ表)"
```

---

### Task 6: zod(LP型の作成/更新/貼り戻し・割当の lpAssignments)

**Files:**
- Modify: `src/lib/validators-sale-dm.ts`(末尾に追加・`saleDmAssignSchema` を差し替え)
- Test: `src/lib/__tests__/sale-dm-lp-validators.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const saleDmLpVariantOptionsSchema  // tone/length/appeal/strength(DM型と同じ列挙。designTemplate と extraInstruction は無い)
  export type SaleDmLpVariantOptions
  export const saleDmLpVariantCreateSchema   // { label: 1..40, options }
  export const saleDmLpVariantUpdateSchema   // { label?, options?: partial }
  export const saleDmLpTemplatePutSchema     // { body: string, promptDigest: 64, baseBodyDigest: 64 }
  export const saleDmAssignSchema            // 既存 + lpAssignments?: { recipientId, lpVariantId }[]
  ```

- [ ] **Step 1: テスト**

```ts
// src/lib/__tests__/sale-dm-lp-validators.test.ts
import { describe, it, expect } from "vitest";
import { saleDmLpVariantCreateSchema, saleDmLpVariantUpdateSchema, saleDmLpTemplatePutSchema, saleDmAssignSchema } from "../validators-sale-dm";

const OPT = { tone: "formal", length: "medium", appeal: "price", strength: "low" };

describe("LP型の zod", () => {
  it("作成は label と文体4項目のみ(designTemplate/extraInstruction は落とす)", () => {
    const r = saleDmLpVariantCreateSchema.parse({ label: "A", options: { ...OPT, designTemplate: "formal", extraInstruction: "x" } });
    expect(r).toEqual({ label: "A", options: OPT });
  });
  it("label は 1〜40 字", () => {
    expect(() => saleDmLpVariantCreateSchema.parse({ label: "", options: OPT })).toThrow();
    expect(() => saleDmLpVariantCreateSchema.parse({ label: "あ".repeat(41), options: OPT })).toThrow();
  });
  it("更新は部分指定", () => {
    expect(saleDmLpVariantUpdateSchema.parse({ options: { tone: "soft" } })).toEqual({ options: { tone: "soft" } });
    expect(() => saleDmLpVariantUpdateSchema.parse({ options: { tone: "loud" } })).toThrow();
  });
  it("貼り戻しは本文と2つの指紋(64桁)", () => {
    expect(() => saleDmLpTemplatePutSchema.parse({ body: "x", promptDigest: "a".repeat(64) })).toThrow();
    expect(saleDmLpTemplatePutSchema.parse({ body: "x", promptDigest: "a".repeat(64), baseBodyDigest: "b".repeat(64) }).body).toBe("x");
  });
  it("割当は lpAssignments を任意で受け付ける(既存の形はそのまま通る)", () => {
    expect(saleDmAssignSchema.parse({ mode: "auto", order: "random" })).toEqual({ mode: "auto", order: "random" });
    const r = saleDmAssignSchema.parse({ mode: "manual", lpAssignments: [{ recipientId: "r1", lpVariantId: "l1" }] });
    expect(r.lpAssignments).toEqual([{ recipientId: "r1", lpVariantId: "l1" }]);
  });
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-validators.test.ts` → FAIL

- [ ] **Step 3: 実装**

`saleDmAssignSchema` を次に差し替え:

```ts
export const saleDmAssignSchema = z.object({
  mode: z.enum(["auto", "manual"]),
  order: z.enum(["sequential", "random"]).optional(),
  assignments: z
    .array(z.object({ recipientId: z.string(), variantId: z.string() }))
    .optional(),
  // LP型の手動割当(設計 2026-09-08 §2.1)。DM型の assignments と独立に指定する。
  lpAssignments: z
    .array(z.object({ recipientId: z.string(), lpVariantId: z.string() }))
    .optional(),
});
```

末尾に追加:

```ts
// ---- LP型(設計 2026-09-08 §2.1/§2.2)。文体4項目は DM型と同じ列挙。印刷デザイン・追加の指示は持たない。
export const saleDmLpVariantOptionsSchema = z.object({
  tone: z.enum(["formal", "standard", "soft"]),
  length: z.enum(["short", "medium", "long"]),
  appeal: z.enum(["price", "inheritance", "vacant", "buyer"]),
  strength: z.enum(["low", "medium", "high"]),
});
export type SaleDmLpVariantOptions = z.infer<typeof saleDmLpVariantOptionsSchema>;

export const saleDmLpVariantCreateSchema = z.object({
  label: z.string().min(1).max(40),
  options: saleDmLpVariantOptionsSchema,
});
export const saleDmLpVariantUpdateSchema = z.object({
  label: z.string().min(1).max(40).optional(),
  options: saleDmLpVariantOptionsSchema.partial().optional(),
});
export const saleDmLpTemplatePutSchema = z.object({
  body: z.string(),
  promptDigest: z.string().length(64),
  baseBodyDigest: z.string().length(64),
});
```

- [ ] **Step 4: 確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-validators.test.ts src/lib/__tests__/sale-dm-assign-route.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/validators-sale-dm.ts src/lib/__tests__/sale-dm-lp-validators.test.ts
git commit -m "feat(sale-dm): LP型の zod と割当の lpAssignments"
```

---

### Task 7: LP型の一覧/作成/更新/削除 route

**Files:**
- Create: `src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/route.ts`
- Create: `src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/route.ts`
- Modify: `src/lib/audit-log-detail-safety.ts`(`sale_dm_variant_delete` の行の直後に追加)
- Test: `src/lib/__tests__/sale-dm-lp-variants-route.test.ts`

**Interfaces:**
- Consumes: Task 6 の zod、`isVariantFrozen`/`SETTLED_DRAFT_STATUSES`(既存)、`requireSaleDmAccess`/`requireSaleDmWriteAccess`/`assertSaleDmCampaignOwned`。
- Produces: `GET → { lpVariants }`、`POST → { lpVariant }`、`PATCH → { lpVariant }`、`DELETE → { deleted }`。エラーコード `LP_VARIANT_NOT_FOUND`(404) / `VARIANT_LOCKED`(409・凍結中の文体変更) / `VARIANT_FROZEN`(409・凍結中の削除) / `VARIANT_IN_USE`(409)。監査 `sale_dm_lp_variant_create` / `_update` / `_delete`。

- [ ] **Step 1: テスト**

```ts
// src/lib/__tests__/sale-dm-lp-variants-route.test.ts
import { vi } from "vitest";
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response { static json = (b: unknown, init?: ResponseInit) => Response.json(b, init); }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/generated/prisma", () => ({ Prisma: { DbNull: Symbol("DbNull") } }));
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error { status: number; code: string; constructor(s: number, m: string, c = "ERROR") { super(m); this.status = s; this.code = c; } }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(), getUserPermissions: vi.fn(), getOwnerDisplayConfig: vi.fn(),
    parseJsonBody: vi.fn(async (r: Request) => { const t = await r.text(); return t ? JSON.parse(t) : {}; }),
    handleApiError: vi.fn((e: unknown) => e instanceof MockApiError ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status }) : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 })),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    dmCampaign: { findFirst: vi.fn(), findUnique: vi.fn() },
    dmLpVariant: { findMany: vi.fn(async () => []), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
    dmRecipientDraft: { count: vi.fn(async () => 0) },
    $queryRaw: vi.fn(async () => []),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { GET, POST } from "../../app/api/properties/sale-dm/campaigns/[id]/lp-variants/route";
import { PATCH, DELETE } from "../../app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  dmCampaign: { findFirst: Fn; findUnique: Fn };
  dmLpVariant: { findMany: Fn; findFirst: Fn; create: Fn; update: Fn; deleteMany: Fn };
  dmRecipientDraft: { count: Fn };
  $queryRaw: Fn;
};
const READS = ["property", "csv_export", "csv_export_personal", "owner"];
const OPT = { tone: "formal", length: "medium", appeal: "price", strength: "low" };
const ctx = { params: Promise.resolve({ id: "c1" }) };
const ctxLp = { params: Promise.resolve({ id: "c1", lpId: "l1" }) };
const req = (method: string, body?: unknown) =>
  new Request("http://x", { method, body: body === undefined ? undefined : JSON.stringify(body) }) as never;
// $queryRaw はタグ付きテンプレートで呼ばれる。第1引数(文字列配列)を結合して SQL を見る。
const sqlCalls = () => pm.$queryRaw.mock.calls.map((c) => (Array.isArray(c[0]) ? c[0].join("?") : String(c[0])));

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Fn).mockResolvedValue([
    ...READS.map((r) => ({ resource: r, action: "read", granted: true })),
    { resource: "property", action: "write", granted: true },
  ]);
  (getOwnerDisplayConfig as Fn).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
  pm.dmCampaign.findFirst.mockResolvedValue({ id: "c1" });
  pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", createdBy: "u1" });
  pm.dmLpVariant.findFirst.mockResolvedValue({ id: "l1", campaignId: "c1", ...OPT, templateFrozenAt: null });
  pm.dmLpVariant.create.mockResolvedValue({ id: "l1", label: "A" });
  pm.dmLpVariant.update.mockResolvedValue({ id: "l1", label: "A" });
  pm.dmLpVariant.deleteMany.mockResolvedValue({ count: 1 });
  pm.dmRecipientDraft.count.mockResolvedValue(0);
});

describe("GET/POST lp-variants", () => {
  it("一覧は本人のキャンペーンだけ(他人=404)", async () => {
    pm.dmCampaign.findFirst.mockResolvedValue(null);
    expect((await GET(req("GET"), ctx)).status).toBe(404);
  });
  it("作成は文体4項目とラベルを保存し、監査 sale_dm_lp_variant_create を残す", async () => {
    const res = await POST(req("POST", { label: "A", options: OPT }), ctx);
    expect(res.status).toBe(200);
    expect(pm.dmLpVariant.create.mock.calls[0][0].data).toEqual({ campaignId: "c1", label: "A", ...OPT });
    expect((writeAuditLog as Fn).mock.calls[0][0].action).toBe("sale_dm_lp_variant_create");
  });
  it("作成は他人のキャンペーンだと 404", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", createdBy: "someone" });
    expect((await POST(req("POST", { label: "A", options: OPT }), ctx)).status).toBe(404);
  });
});

describe("PATCH lp-variants/[lpId]", () => {
  it("文体を実際に変えたら原文・切り分け結果・プロンプト控えを消す", async () => {
    const res = await PATCH(req("PATCH", { options: { tone: "soft" } }), ctxLp);
    expect(res.status).toBe(200);
    const data = pm.dmLpVariant.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ tone: "soft", promptText: null, rawTemplate: null, headline: null, lead: null, bodyText: null });
    expect("faqJson" in data).toBe(true);
  });
  it("同じ値の再送(no-op)や label だけなら原文を消さない", async () => {
    await PATCH(req("PATCH", { label: "B", options: { tone: "formal" } }), ctxLp);
    expect(pm.dmLpVariant.update.mock.calls[0][0].data).toEqual({ label: "B", tone: "formal" });
  });
  it("凍結中(配下に確定/送付済み)の文体変更は 409 VARIANT_LOCKED、label だけなら通る", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(1);
    const r1 = await PATCH(req("PATCH", { options: { tone: "soft" } }), ctxLp);
    expect(r1.status).toBe(409);
    expect((await r1.json()).error.code).toBe("VARIANT_LOCKED");
    expect((await PATCH(req("PATCH", { label: "B" }), ctxLp)).status).toBe(200);
  });
  it("凍結印の列だけでも止まる(二重判定)", async () => {
    pm.dmLpVariant.findFirst.mockResolvedValue({ id: "l1", campaignId: "c1", ...OPT, templateFrozenAt: new Date() });
    expect((await PATCH(req("PATCH", { options: { appeal: "vacant" } }), ctxLp)).status).toBe(409);
  });
  it("dm_lp_variants 行を FOR UPDATE でロックしてから判定する", async () => {
    await PATCH(req("PATCH", { options: { tone: "soft" } }), ctxLp);
    expect(sqlCalls().join("\n")).toMatch(/FROM dm_lp_variants[\s\S]*FOR UPDATE/);
  });
  it("存在しない LP型は 404", async () => {
    pm.dmLpVariant.findFirst.mockResolvedValue(null);
    expect((await PATCH(req("PATCH", { label: "B" }), ctxLp)).status).toBe(404);
  });
});

describe("DELETE lp-variants/[lpId]", () => {
  it("宛先が居なければ削除(recipients none をアトミックに条件へ)", async () => {
    const res = await DELETE(req("DELETE"), ctxLp);
    expect(res.status).toBe(200);
    expect(pm.dmLpVariant.deleteMany.mock.calls[0][0].where).toEqual({ id: "l1", campaignId: "c1", recipients: { none: {} } });
  });
  it("凍結中は 409 VARIANT_FROZEN", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(2);
    const res = await DELETE(req("DELETE"), ctxLp);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("VARIANT_FROZEN");
  });
  it("割当済みなら 409 VARIANT_IN_USE", async () => {
    pm.dmLpVariant.deleteMany.mockResolvedValue({ count: 0 });
    expect((await (await DELETE(req("DELETE"), ctxLp)).json()).error.code).toBe("VARIANT_IN_USE");
  });
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-variants-route.test.ts` → FAIL(module not found)

- [ ] **Step 3: `lp-variants/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess, requireSaleDmWriteAccess, assertSaleDmCampaignOwned } from "@/lib/sale-dm-letter/route-guard";
import { saleDmLpVariantCreateSchema } from "@/lib/validators-sale-dm";

// LP型(設計 2026-09-08 §2.1)。DM型(variants route)と同じ骨組み。
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id } = await params;
    await assertSaleDmCampaignOwned(id, session.id);
    const lpVariants = await prisma.dmLpVariant.findMany({ where: { campaignId: id }, orderBy: { label: "asc" } });
    return NextResponse.json({ lpVariants }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session } = await requireSaleDmWriteAccess();
    const { id } = await params;
    const { label, options } = saleDmLpVariantCreateSchema.parse(await parseJsonBody(request));
    const campaign = await prisma.dmCampaign.findUnique({ where: { id }, select: { id: true, createdBy: true } });
    if (!campaign || campaign.createdBy !== session.id) throw new ApiError(404, "キャンペーンが見つかりません", "NOT_FOUND");

    const lpVariant = await prisma.dmLpVariant.create({
      data: { campaignId: id, label, tone: options.tone, length: options.length, appeal: options.appeal, strength: options.strength },
    });
    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_lp_variant_create",
      targetTable: "dm_lp_variants",
      targetId: lpVariant.id,
      // label は自由記述(PII混入し得る)。detail には保存しない。
      detail: { campaignId: id, createdAt: new Date().toISOString() },
    });
    return NextResponse.json({ lpVariant }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: `lp-variants/[lpId]/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmWriteAccess, assertSaleDmCampaignOwned } from "@/lib/sale-dm-letter/route-guard";
import { saleDmLpVariantUpdateSchema } from "@/lib/validators-sale-dm";
import { SETTLED_DRAFT_STATUSES, isVariantFrozen } from "@/lib/sale-dm-letter/freeze";

const OPTION_KEYS = ["tone", "length", "appeal", "strength"] as const;

/**
 * LP型の設定変更(設計 2026-09-08 §2.1/§2.8)。
 * 文体4項目はプロンプトに載るので、実際に変わったら原文・切り分け結果・控えを消す(DM型と同じ)。
 * 凍結(列 OR 配下に確定/送付済み)中は文体を変えられない。label だけは変えられる。
 * LP は印刷物ではないので、DM型の PATCH と違い確定の解除はしない(刷り上がりが変わらない)。
 * ロック順序: dm_lp_variants のみ(dm_variants は触らない)。
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; lpId: string }> }) {
  try {
    const { session } = await requireSaleDmWriteAccess();
    const { id, lpId } = await params;
    await assertSaleDmCampaignOwned(id, session.id);
    const parsed = saleDmLpVariantUpdateSchema.parse(await parseJsonBody(request));

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM dm_lp_variants WHERE id = ${lpId}::uuid AND campaign_id = ${id}::uuid FOR UPDATE`;
      const existing = await tx.dmLpVariant.findFirst({
        where: { id: lpId, campaignId: id },
        select: { id: true, tone: true, length: true, appeal: true, strength: true, templateFrozenAt: true },
      });
      if (!existing) throw new ApiError(404, "指定されたLP型が見つかりません", "LP_VARIANT_NOT_FOUND");

      const data: Prisma.DmLpVariantUpdateInput = {};
      if (parsed.label !== undefined) data.label = parsed.label;
      let optionFieldChanged = false;
      if (parsed.options) {
        for (const k of OPTION_KEYS) {
          const v = parsed.options[k];
          if (v === undefined) continue;
          data[k] = v;
          if (v !== existing[k]) optionFieldChanged = true;
        }
      }
      if (optionFieldChanged) {
        const settledCount = await tx.dmRecipientDraft.count({
          where: { campaignId: id, lpVariantId: lpId, status: { in: [...SETTLED_DRAFT_STATUSES] } },
        });
        if (isVariantFrozen({ templateFrozenAt: existing.templateFrozenAt, settledCount })) {
          throw new ApiError(
            409,
            "送付実績のあるLP型の文面の設定(トーン・長さ・訴求・押しの強さ)は変更できません。文面を変えるときは新しいLP型を追加してください",
            "VARIANT_LOCKED",
          );
        }
        // 古いプロンプトで作った文章を新しい設定の型として使えないよう、原文・切り分け結果・控えを消す。
        data.promptText = null;
        data.rawTemplate = null;
        data.headline = null;
        data.lead = null;
        data.bodyText = null;
        data.faqJson = Prisma.DbNull;
      }
      return tx.dmLpVariant.update({ where: { id: lpId }, data });
    });

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_lp_variant_update",
      targetTable: "dm_lp_variants",
      targetId: lpId,
      detail: { campaignId: id, fields: Object.keys(parsed), updatedAt: new Date().toISOString() },
    });
    return NextResponse.json({ lpVariant: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; lpId: string }> }) {
  try {
    const { session } = await requireSaleDmWriteAccess();
    const { id, lpId } = await params;
    await assertSaleDmCampaignOwned(id, session.id);

    const deleted = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM dm_lp_variants WHERE id = ${lpId}::uuid AND campaign_id = ${id}::uuid FOR UPDATE`;
      const row = await tx.dmLpVariant.findFirst({ where: { id: lpId, campaignId: id }, select: { templateFrozenAt: true } });
      if (!row) throw new ApiError(404, "指定されたLP型が見つかりません", "LP_VARIANT_NOT_FOUND");
      const settledCount = await tx.dmRecipientDraft.count({
        where: { campaignId: id, lpVariantId: lpId, status: { in: [...SETTLED_DRAFT_STATUSES] } },
      });
      if (isVariantFrozen({ templateFrozenAt: row.templateFrozenAt, settledCount })) {
        throw new ApiError(409, "送付実績のあるLP型は削除できません", "VARIANT_FROZEN");
      }
      // 宛先を1件も持たない場合のみ削除(count→delete の隙間を作らない)。
      return tx.dmLpVariant.deleteMany({ where: { id: lpId, campaignId: id, recipients: { none: {} } } });
    });
    if (deleted.count === 0) throw new ApiError(409, "このLP型は宛先に割り当てられているため削除できません", "VARIANT_IN_USE");

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_lp_variant_delete",
      targetTable: "dm_lp_variants",
      targetId: lpId,
      detail: { campaignId: id, deletedAt: new Date().toISOString() },
    });
    return NextResponse.json({ deleted: lpId }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 5: 監査 allowlist(`audit-log-detail-safety.ts` の `sale_dm_variant_delete` 行の直後)**

```ts
  // LP型(設計 2026-09-08)。DM型と同じく件数/ID/日時のみ。見出し・本文・ラベルは載せない。
  sale_dm_lp_variant_create: new Set(["createdAt"]),
  sale_dm_lp_variant_update: new Set(["updatedAt"]),
  sale_dm_lp_variant_delete: new Set(["deletedAt"]),
  sale_dm_lp_prompt_view: new Set(["viewedAt"]),
  sale_dm_lp_body_paste: new Set(["pastedAt", "faqCount", "bodyLength"]),
```

- [ ] **Step 6: 確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-variants-route.test.ts src/lib/__tests__/sale-dm-write-gate*.test.ts src/lib/__tests__/sale-dm-freeze-guard.test.ts && npx tsc --noEmit` → PASS

- [ ] **Step 7: Commit**

```bash
git add "src/app/api/properties/sale-dm/campaigns/[id]/lp-variants" src/lib/audit-log-detail-safety.ts src/lib/__tests__/sale-dm-lp-variants-route.test.ts
git commit -m "feat(sale-dm): LP型の一覧/作成/更新/削除 route(凍結の二重判定・監査)"
```

---

### Task 8: LP型のプロンプト表示と貼り戻し保存 route

**Files:**
- Create: `.../lp-variants/[lpId]/prompt/route.ts`
- Create: `.../lp-variants/[lpId]/template/route.ts`
- Modify: `src/lib/__tests__/sale-dm-external-audit-visible.test.ts`(CASES に2件追加)
- Test: `src/lib/__tests__/sale-dm-lp-template-route.test.ts`

**Interfaces:**
- Consumes: `buildLpExternalPrompt`/`promptDigest`/`bodyTemplateDigest`(Task 3)、`splitLpTemplate`/`lpSplitIssueMessage`(Task 2)、`saleDmLpTemplatePutSchema`(Task 6)。
- Produces: `GET prompt → { prompt, digest, frozen, rawTemplate: string|null, bodyDigest }`(bodyDigest = `bodyTemplateDigest(rawTemplate)`)。`PUT template → { changed: false, bodyDigest } | { changed: true, bodyDigest, parts: { headline, lead, faqCount, bodyLength } }`。エラー `PROMPT_STALE`/`TEMPLATE_STALE`(409)、`VARIANT_FROZEN`(409・初期化は許可)、`INVALID_LP_TEMPLATE`(400・message は `lpSplitIssueMessage`)、`LP_VARIANT_NOT_FOUND`(404)。

- [ ] **Step 1: テスト**

```ts
// src/lib/__tests__/sale-dm-lp-template-route.test.ts
import { vi } from "vitest";
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response { static json = (b: unknown, init?: ResponseInit) => Response.json(b, init); }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/generated/prisma", () => ({ Prisma: { DbNull: Symbol("DbNull") } }));
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error { status: number; code: string; constructor(s: number, m: string, c = "ERROR") { super(m); this.status = s; this.code = c; } }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(), getUserPermissions: vi.fn(), getOwnerDisplayConfig: vi.fn(),
    parseJsonBody: vi.fn(async (r: Request) => { const t = await r.text(); return t ? JSON.parse(t) : {}; }),
    handleApiError: vi.fn((e: unknown) => e instanceof MockApiError ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status }) : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 })),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    dmCampaign: { findFirst: vi.fn() },
    dmLpVariant: { findFirst: vi.fn(), update: vi.fn() },
    dmRecipientDraft: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
    property: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { GET } from "../../app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/prompt/route";
import { PUT } from "../../app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/template/route";
import { buildLpExternalPrompt, promptDigest, bodyTemplateDigest } from "../sale-dm-letter/external-prompt";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  dmCampaign: { findFirst: Fn };
  dmLpVariant: { findFirst: Fn; update: Fn };
  dmRecipientDraft: { count: Fn; findMany: Fn };
  property: { findMany: Fn };
  $queryRaw: Fn;
};
const OPT = { tone: "formal", length: "medium", appeal: "price", strength: "low" };
const DIGEST = promptDigest(buildLpExternalPrompt(OPT));
const READS = ["property", "csv_export", "csv_export_personal", "owner"];
const ctx = { params: Promise.resolve({ id: "c1", lpId: "l1" }) };
const GOOD = "【見出し】タイトル\n【本文】本文です\n【よくある質問】\nQ. a\nA. b";
let armedRaw: string | null = null;
const put = (b: Record<string, unknown>) =>
  new Request("http://x", { method: "PUT", body: JSON.stringify({ promptDigest: DIGEST, baseBodyDigest: bodyTemplateDigest(armedRaw), ...b }) }) as never;
function arm(over: Record<string, unknown> = {}) {
  armedRaw = ("rawTemplate" in over ? over.rawTemplate : null) as string | null;
  pm.dmLpVariant.findFirst.mockResolvedValue({ id: "l1", ...OPT, templateFrozenAt: null, rawTemplate: null, ...over });
}
const sqlCalls = () => pm.$queryRaw.mock.calls.map((c) => (Array.isArray(c[0]) ? c[0].join("?") : String(c[0])));

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Fn).mockResolvedValue([
    ...READS.map((r) => ({ resource: r, action: "read", granted: true })),
    { resource: "property", action: "write", granted: true },
  ]);
  (getOwnerDisplayConfig as Fn).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
  pm.dmCampaign.findFirst.mockResolvedValue({ id: "c1" });
  arm();
  pm.dmRecipientDraft.count.mockResolvedValue(0);
  pm.dmRecipientDraft.findMany.mockResolvedValue([]);
  pm.property.findMany.mockResolvedValue([]);
  pm.dmLpVariant.update.mockResolvedValue({ id: "l1" });
});

describe("GET lp prompt", () => {
  it("LP用プロンプト・指紋・凍結・原文の指紋を返し、監査を残す", async () => {
    const res = await GET(new Request("http://x") as never, ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.prompt).toContain("【よくある質問】");
    expect(j.digest).toBe(DIGEST);
    expect(j.frozen).toBe(false);
    expect(j.rawTemplate).toBeNull();
    expect(j.bodyDigest).toBe(bodyTemplateDigest(null));
    expect((writeAuditLog as Fn).mock.calls[0][0].action).toBe("sale_dm_lp_prompt_view");
  });
  it("存在しない LP型は 404", async () => {
    pm.dmLpVariant.findFirst.mockResolvedValue(null);
    expect((await GET(new Request("http://x") as never, ctx)).status).toBe(404);
  });
});

describe("PUT lp template(貼り戻し保存)", () => {
  it("切り分けて原文と4部位を同じ処理で保存し、要約を返す", async () => {
    const res = await PUT(put({ body: GOOD }), ctx);
    expect(res.status).toBe(200);
    const data = pm.dmLpVariant.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ rawTemplate: GOOD, headline: "タイトル", lead: null, bodyText: "本文です", faqJson: [{ q: "a", a: "b" }] });
    expect(typeof data.promptText).toBe("string");
    const j = await res.json();
    expect(j).toMatchObject({ changed: true, bodyDigest: bodyTemplateDigest(GOOD), parts: { headline: "タイトル", faqCount: 1, bodyLength: 4 } });
    expect((writeAuditLog as Fn).mock.calls[0][0].action).toBe("sale_dm_lp_body_paste");
  });
  it("見出しの欠けは 400 INVALID_LP_TEMPLATE で保存しない", async () => {
    const res = await PUT(put({ body: "【本文】b" }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_LP_TEMPLATE");
    expect(pm.dmLpVariant.update).not.toHaveBeenCalled();
  });
  it("同じ原文の再保存は何も書かない", async () => {
    arm({ rawTemplate: GOOD });
    const res = await PUT(put({ body: GOOD }), ctx);
    expect((await res.json()).changed).toBe(false);
    expect(pm.dmLpVariant.update).not.toHaveBeenCalled();
  });
  it("プロンプトの指紋がずれていたら 409 PROMPT_STALE", async () => {
    const res = await PUT(put({ body: GOOD, promptDigest: "0".repeat(64) }), ctx);
    expect((await res.json()).error.code).toBe("PROMPT_STALE");
  });
  it("原文の指紋がずれていたら 409 TEMPLATE_STALE", async () => {
    arm({ rawTemplate: "【見出し】old\n【本文】old" });
    const res = await PUT(put({ body: GOOD, baseBodyDigest: bodyTemplateDigest("違う") }), ctx);
    expect((await res.json()).error.code).toBe("TEMPLATE_STALE");
  });
  it("凍結中の差し替えは 409 VARIANT_FROZEN、原文が無ければ初期化として許可", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(1);
    arm({ rawTemplate: "【見出し】old\n【本文】old" });
    expect((await (await PUT(put({ body: GOOD }), ctx)).json()).error.code).toBe("VARIANT_FROZEN");
    arm();
    expect((await PUT(put({ body: GOOD }), ctx)).status).toBe(200);
  });
  it("field_staff は担当外の未送付宛先が居ると 403", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "field_staff" });
    pm.dmRecipientDraft.findMany.mockResolvedValue([{ propertyId: "p1" }]);
    pm.property.findMany.mockResolvedValue([]);
    expect((await PUT(put({ body: GOOD }), ctx)).status).toBe(403);
  });
  it("ロックは dm_lp_variants → properties の順", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "field_staff" });
    pm.dmRecipientDraft.findMany.mockResolvedValue([{ propertyId: "p1" }]);
    pm.property.findMany.mockResolvedValue([{ id: "p1" }]);
    await PUT(put({ body: GOOD }), ctx);
    const sql = sqlCalls();
    expect(sql[0]).toMatch(/dm_lp_variants/);
    expect(sql[1]).toMatch(/properties/);
  });
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-template-route.test.ts` → FAIL

- [ ] **Step 3: `prompt/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess, assertSaleDmCampaignOwned } from "@/lib/sale-dm-letter/route-guard";
import { buildLpExternalPrompt, promptDigest, bodyTemplateDigest } from "@/lib/sale-dm-letter/external-prompt";
import { SETTLED_DRAFT_STATUSES, isVariantFrozen } from "@/lib/sale-dm-letter/freeze";

/** LP型のプロンプト表示(設計 2026-09-08 §2.2)。DM型の prompt route と同じ(読み取り・ロック無し・指紋2つを返す)。 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; lpId: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id, lpId } = await params;
    await assertSaleDmCampaignOwned(id, session.id);
    const v = await prisma.dmLpVariant.findFirst({
      where: { id: lpId, campaignId: id },
      select: { id: true, tone: true, length: true, appeal: true, strength: true, templateFrozenAt: true, rawTemplate: true },
    });
    if (!v) throw new ApiError(404, "指定されたLP型が見つかりません", "LP_VARIANT_NOT_FOUND");
    const settledCount = await prisma.dmRecipientDraft.count({
      where: { campaignId: id, lpVariantId: lpId, status: { in: [...SETTLED_DRAFT_STATUSES] } },
    });
    const prompt = buildLpExternalPrompt(v);
    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_lp_prompt_view",
      targetTable: "dm_lp_variants",
      targetId: lpId,
      detail: { campaignId: id, viewedAt: new Date().toISOString() },
    });
    return NextResponse.json(
      {
        prompt,
        digest: promptDigest(prompt),
        frozen: isVariantFrozen({ templateFrozenAt: v.templateFrozenAt, settledCount }),
        rawTemplate: v.rawTemplate,
        bodyDigest: bodyTemplateDigest(v.rawTemplate),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: `template/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmWriteAccess, assertSaleDmCampaignOwned } from "@/lib/sale-dm-letter/route-guard";
import { buildLpExternalPrompt, promptDigest, bodyTemplateDigest } from "@/lib/sale-dm-letter/external-prompt";
import { SETTLED_DRAFT_STATUSES, isVariantFrozen } from "@/lib/sale-dm-letter/freeze";
import { splitLpTemplate, lpSplitIssueMessage } from "@/lib/sale-dm-letter/lp-template";
import { saleDmLpTemplatePutSchema } from "@/lib/validators-sale-dm";

/**
 * LP型の貼り戻し保存(設計 2026-09-08 §2.2)。DM型の template route と同じ順序:
 * dm_lp_variants を FOR UPDATE → 同一原文なら何も書かない → 凍結(初期化は許可)→ 指紋2つ → 切り分け →
 * 担当範囲(field_staff は物件親行をロックして読み直す)→ 原文+4部位+プロンプト控えを同じ tx で保存。
 * LP は表示のたびに展開するので、DM型と違い下書きのクリアは無い。
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string; lpId: string }> }) {
  try {
    const { session } = await requireSaleDmWriteAccess();
    const { id, lpId } = await params;
    await assertSaleDmCampaignOwned(id, session.id);
    const parsed = saleDmLpTemplatePutSchema.parse(await parseJsonBody(request));

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM dm_lp_variants WHERE id = ${lpId}::uuid AND campaign_id = ${id}::uuid FOR UPDATE`;
      const v = await tx.dmLpVariant.findFirst({
        where: { id: lpId, campaignId: id },
        select: { id: true, tone: true, length: true, appeal: true, strength: true, templateFrozenAt: true, rawTemplate: true },
      });
      if (!v) throw new ApiError(404, "指定されたLP型が見つかりません", "LP_VARIANT_NOT_FOUND");
      if (v.rawTemplate === parsed.body) {
        return { changed: false as const, bodyDigest: bodyTemplateDigest(parsed.body) };
      }
      const settledCount = await tx.dmRecipientDraft.count({
        where: { campaignId: id, lpVariantId: lpId, status: { in: [...SETTLED_DRAFT_STATUSES] } },
      });
      const frozen = isVariantFrozen({ templateFrozenAt: v.templateFrozenAt, settledCount });
      const isInitialization = !v.rawTemplate || v.rawTemplate.trim().length === 0;
      if (frozen && !isInitialization) {
        throw new ApiError(409, "送付実績のあるLP型の文章は変更できません。文章を変えるときは新しいLP型を追加してください", "VARIANT_FROZEN");
      }
      const prompt = buildLpExternalPrompt(v);
      if (promptDigest(prompt) !== parsed.promptDigest) {
        throw new ApiError(409, "LP型の設定が変わっています。プロンプトを表示し直してから貼り付けてください", "PROMPT_STALE");
      }
      if (bodyTemplateDigest(v.rawTemplate) !== parsed.baseBodyDigest) {
        throw new ApiError(409, "このLP型の文章は、ほかの画面で先に保存されています。開き直して最新の文章を確認してから貼り付けてください", "TEMPLATE_STALE");
      }
      const split = splitLpTemplate(parsed.body);
      if (!split.ok) throw new ApiError(400, lpSplitIssueMessage(split.issue), "INVALID_LP_TEMPLATE");

      if (session.role === "field_staff") {
        const unsent = await tx.dmRecipientDraft.findMany({
          where: { campaignId: id, lpVariantId: lpId, status: { not: "sent" } },
          select: { propertyId: true },
        });
        const propertyIds = [...new Set(unsent.map((d) => d.propertyId))].sort();
        if (propertyIds.length > 0) {
          await tx.$queryRaw`SELECT id FROM properties WHERE id = ANY(${propertyIds}::uuid[]) ORDER BY id FOR UPDATE`;
          const visible = await tx.property.findMany({
            where: { id: { in: propertyIds }, OR: [{ createdBy: session.id }, { assignedTo: session.id }] },
            select: { id: true },
          });
          if (visible.length !== propertyIds.length) {
            throw new ApiError(403, "担当外の宛先を含むLP型は文章を保存できません", "FORBIDDEN");
          }
        }
      }

      const { parts } = split;
      await tx.dmLpVariant.update({
        where: { id: lpId },
        data: {
          rawTemplate: parsed.body,
          promptText: prompt,
          headline: parts.headline,
          lead: parts.lead,
          bodyText: parts.body,
          faqJson: parts.faq === null ? Prisma.DbNull : parts.faq,
        },
      });
      return {
        changed: true as const,
        bodyDigest: bodyTemplateDigest(parsed.body),
        parts: { headline: parts.headline, lead: parts.lead, faqCount: parts.faq?.length ?? 0, bodyLength: parts.body.length },
      };
    });

    if (result.changed) {
      await writeAuditLog({
        userId: session.id,
        action: "sale_dm_lp_body_paste",
        targetTable: "dm_lp_variants",
        targetId: lpId,
        // 非PII: 件数・長さ・日時のみ(見出し・本文は残さない)。
        detail: { campaignId: id, faqCount: result.parts.faqCount, bodyLength: result.parts.bodyLength, pastedAt: new Date().toISOString() },
      });
    }
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 5: 監査の可視性テストに CASES を追加(`sale-dm-external-audit-visible.test.ts` の配列末尾)**

```ts
    { action: "sale_dm_lp_prompt_view", detail: { campaignId: "c1", viewedAt: "2026-09-09T00:00:00.000Z" } },
    { action: "sale_dm_lp_body_paste", detail: { campaignId: "c1", faqCount: 3, bodyLength: 120, pastedAt: "2026-09-09T00:00:00.000Z" } },
```

- [ ] **Step 6: 確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-template-route.test.ts src/lib/__tests__/sale-dm-external-audit-visible.test.ts src/lib/__tests__/sale-dm-freeze-guard.test.ts src/lib/__tests__/sale-dm-write-gate*.test.ts && npx tsc --noEmit` → PASS

- [ ] **Step 7: Commit**

```bash
git add "src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/prompt" "src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/template" src/lib/__tests__/sale-dm-lp-template-route.test.ts src/lib/__tests__/sale-dm-external-audit-visible.test.ts
git commit -m "feat(sale-dm): LP型のプロンプト表示と貼り戻し保存(切り分け・二重指紋・凍結)"
```

---

### Task 9: 割当 route の両軸化と、確定の証拠が消える全経路への LP凍結印

**Files:**
- Modify: `src/app/api/properties/sale-dm/campaigns/[id]/assign/route.ts`
- Modify: `src/app/api/properties/sale-dm/drafts/confirm/route.ts`(L58 select・L82-85 ロック・L239 凍結印)
- Modify: `src/app/api/properties/sale-dm/drafts/[id]/route.ts`(L110-114 の tx)
- Modify: `src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/route.ts`(L82 の直後にロック・L172-174 の凍結印)
- Modify: `src/lib/__tests__/sale-dm-assign-route.test.ts`(prisma mock に `dmLpVariant` を足す)
- Test: `src/lib/__tests__/sale-dm-assign-cross-route.test.ts`, `src/lib/__tests__/sale-dm-lp-freeze-pairing.test.ts`

**Interfaces:**
- Consumes: `assignCrossEvenly`/`applyManualAssignment`/`markLpVariantsFrozen`(Task 4)、`saleDmAssignSchema.lpAssignments`(Task 6)。
- Produces: assign 応答 `{ assigned, perVariant, assignedLp, perLpVariant }`。監査 `sale_dm_assign_variants` detail に `assignedLp` を追加(allowlist にも追加)。

- [ ] **Step 1: 走査テスト(凍結印の対)を書く**

```ts
// src/lib/__tests__/sale-dm-lp-freeze-pairing.test.ts
/**
 * 「確定を作る／動かす／戻す」経路は DM型へ凍結印を立てている(markVariantsFrozen)。
 * 同じ経路は LP型の確定の証拠も消すので、**必ず対で** markLpVariantsFrozen も呼ぶ(設計 2026-09-08 §2.8)。
 * route 名を手で並べず、markVariantsFrozen を含む sale-dm の route を機械的に対象にする。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "src/app/api/properties/sale-dm");
function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return routeFiles(p);
    return name === "route.ts" ? [p] : [];
  });
}
const FILES = routeFiles(ROOT).filter((f) => readFileSync(f, "utf-8").includes("markVariantsFrozen("));

describe("DM型へ凍結印を立てる経路は LP型へも立てる", () => {
  it("対象が見つかっている(0件なら検査が空振り)", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(4);
  });
  for (const file of FILES) {
    const rel = path.relative(process.cwd(), file).replace(/\\/g, "/");
    it(rel, () => {
      const s = readFileSync(file, "utf-8");
      expect(s.includes("markLpVariantsFrozen("), `${rel} が LP型へ凍結印を立てていない`).toBe(true);
      // ロック順序: dm_variants → dm_lp_variants(両方を掴む経路では LP のロックが後)。
      const v = s.search(/FROM dm_variants[\s\S]{0,200}FOR UPDATE/);
      const l = s.search(/FROM dm_lp_variants[\s\S]{0,200}FOR UPDATE/);
      expect(l, `${rel} が dm_lp_variants をロックしていない`).toBeGreaterThan(-1);
      if (v > -1) expect(l).toBeGreaterThan(v);
    });
  }
});
```

- [ ] **Step 2: assign route のテスト**

```ts
// src/lib/__tests__/sale-dm-assign-cross-route.test.ts
import { vi } from "vitest";
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response { static json = (b: unknown, init?: ResponseInit) => Response.json(b, init); }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error { status: number; code: string; constructor(s: number, m: string, c = "ERROR") { super(m); this.status = s; this.code = c; } }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(), getUserPermissions: vi.fn(), getOwnerDisplayConfig: vi.fn(),
    parseJsonBody: vi.fn(async (r: Request) => { const t = await r.text(); return t ? JSON.parse(t) : {}; }),
    handleApiError: vi.fn((e: unknown) => e instanceof MockApiError ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status }) : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 })),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    dmCampaign: { findFirst: vi.fn() },
    dmVariant: { findMany: vi.fn(), updateMany: vi.fn(async () => ({ count: 0 })) },
    dmLpVariant: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })) },
    dmRecipientDraft: { findMany: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    $queryRaw: vi.fn(async () => []),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { POST as assign } from "../../app/api/properties/sale-dm/campaigns/[id]/assign/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  dmCampaign: { findFirst: Fn };
  dmVariant: { findMany: Fn; updateMany: Fn };
  dmLpVariant: { findMany: Fn; updateMany: Fn };
  dmRecipientDraft: { findMany: Fn; updateMany: Fn };
  $queryRaw: Fn;
};
const READS = ["property", "csv_export", "csv_export_personal", "owner"];
const ctx = { params: Promise.resolve({ id: "c1" }) };
const post = (b: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(b) }) as never;
const prop = { createdBy: "u1", assignedTo: null };
const sqlCalls = () => pm.$queryRaw.mock.calls.map((c) => (Array.isArray(c[0]) ? c[0].join("?") : String(c[0])));

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Fn).mockResolvedValue([
    ...READS.map((r) => ({ resource: r, action: "read", granted: true })),
    { resource: "property", action: "write", granted: true },
  ]);
  (getOwnerDisplayConfig as Fn).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
  pm.dmCampaign.findFirst.mockResolvedValue({ id: "c1" });
  pm.dmVariant.findMany.mockResolvedValue([{ id: "d0" }, { id: "d1" }]);
  pm.dmLpVariant.findMany.mockResolvedValue([{ id: "l0" }, { id: "l1" }]);
  // 1回目=対象宛先(先読み)、2回目=移動元の型(sourcesPre)、3回目=確定/送付済み(movingSettled)
  pm.dmRecipientDraft.findMany
    .mockResolvedValueOnce([{ id: "r0", property: prop }, { id: "r1", property: prop }, { id: "r2", property: prop }, { id: "r3", property: prop }])
    .mockResolvedValueOnce([{ variantId: "d0", lpVariantId: null }, { variantId: "d0", lpVariantId: "l0" }])
    .mockResolvedValueOnce([{ variantId: "d1", lpVariantId: "l1" }]);
});

describe("POST assign(両軸)", () => {
  it("auto は DM型と LP型の両方へ総当たりで割り当て、LP側は本文を消さない", async () => {
    const res = await assign(post({ mode: "auto" }), ctx);
    expect(res.status).toBe(200);
    const calls = pm.dmRecipientDraft.updateMany.mock.calls.map((c) => c[0]);
    const dmCalls = calls.filter((c) => "variantId" in c.data);
    const lpCalls = calls.filter((c) => "lpVariantId" in c.data);
    expect(dmCalls.length).toBe(2);
    expect(lpCalls.length).toBe(2);
    for (const c of lpCalls) {
      expect(c.data).toEqual({ lpVariantId: expect.any(String) });
      expect(c.where).toMatchObject({ campaignId: "c1", status: { not: "sent" }, NOT: { lpVariantId: c.data.lpVariantId } });
    }
    const j = await res.json();
    expect(j).toHaveProperty("perLpVariant");
    expect(j).toHaveProperty("assignedLp");
  });
  it("LP型が0件なら LP側の updateMany を呼ばない(既存キャンペーンの挙動不変)", async () => {
    pm.dmLpVariant.findMany.mockResolvedValue([]);
    await assign(post({ mode: "auto" }), ctx);
    const lpCalls = pm.dmRecipientDraft.updateMany.mock.calls.filter((c) => "lpVariantId" in c[0].data);
    expect(lpCalls.length).toBe(0);
  });
  it("移動元の LP型(確定/送付済み)へ凍結印を立て、ロックは dm_variants → dm_lp_variants の順", async () => {
    await assign(post({ mode: "auto" }), ctx);
    expect(pm.dmLpVariant.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["l1"] }, templateFrozenAt: null } }));
    const sql = sqlCalls();
    const v = sql.findIndex((s) => /dm_variants/.test(s) && !/dm_lp_variants/.test(s));
    const l = sql.findIndex((s) => /dm_lp_variants/.test(s));
    expect(v).toBeGreaterThan(-1);
    expect(l).toBeGreaterThan(v);
  });
  it("manual は assignments と lpAssignments を軸ごとに独立に反映する", async () => {
    await assign(post({ mode: "manual", lpAssignments: [{ recipientId: "r2", lpVariantId: "l1" }] }), ctx);
    const calls = pm.dmRecipientDraft.updateMany.mock.calls.map((c) => c[0]);
    expect(calls.filter((c) => "variantId" in c.data).length).toBe(0);
    const lp = calls.filter((c) => "lpVariantId" in c.data);
    expect(lp.length).toBe(1);
    expect(lp[0].where.id).toEqual({ in: ["r2"] });
    expect(lp[0].data).toEqual({ lpVariantId: "l1" });
  });
});
```

- [ ] **Step 3: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-freeze-pairing.test.ts src/lib/__tests__/sale-dm-assign-cross-route.test.ts` → FAIL

- [ ] **Step 4: assign route を書き換える**

import に追加:

```ts
import { markVariantsFrozen, markLpVariantsFrozen, SETTLED_DRAFT_STATUSES } from "@/lib/sale-dm-letter/freeze";
import { assignCrossEvenly, applyManualAssignment } from "@/lib/sale-dm-letter/assign";
```
(`assignVariantsEvenly` の import は外す)

L17-21 の読み込みを3本に:

```ts
    const [variants, lpVariants, recipients] = await Promise.all([
      prisma.dmVariant.findMany({ where: { campaignId: id }, select: { id: true }, orderBy: { label: "asc" } }),
      prisma.dmLpVariant.findMany({ where: { campaignId: id }, select: { id: true }, orderBy: { label: "asc" } }),
      prisma.dmRecipientDraft.findMany({ where: { campaignId: id, status: { not: "sent" } }, select: { id: true, property: { select: { createdBy: true, assignedTo: true } } }, orderBy: { id: "asc" } }),
    ]);
```

L27-43 を次に:

```ts
    const variantIds = variants.map((v) => v.id);
    const lpVariantIds = lpVariants.map((v) => v.id);
    const recipientIds = filterDraftsByFieldStaffScope(recipients, session).map((r) => r.id);

    // DM軸の割当(既存の形)。LP軸は別 Map に分ける(LP は本文に影響しないので本文を消さない)。
    const dmAssignment = new Map<string, string>();
    const lpAssignment = new Map<string, string>();
    if (body.mode === "manual") {
      for (const [rid, vid] of applyManualAssignment(recipientIds, variantIds, body.assignments ?? [])) dmAssignment.set(rid, vid);
      const lpManual = (body.lpAssignments ?? []).map((a) => ({ recipientId: a.recipientId, variantId: a.lpVariantId }));
      for (const [rid, lid] of applyManualAssignment(recipientIds, lpVariantIds, lpManual)) lpAssignment.set(rid, lid);
    } else {
      for (const [rid, a] of assignCrossEvenly(recipientIds, variantIds, lpVariantIds, { order: body.order ?? "sequential" })) {
        dmAssignment.set(rid, a.variantId);
        if (a.lpVariantId) lpAssignment.set(rid, a.lpVariantId);
      }
    }

    const byVariant = new Map<string, string[]>();
    for (const [recipientId, variantId] of dmAssignment) {
      const bucket = byVariant.get(variantId);
      if (bucket) bucket.push(recipientId);
      else byVariant.set(variantId, [recipientId]);
    }
    const byLpVariant = new Map<string, string[]>();
    for (const [recipientId, lpVariantId] of lpAssignment) {
      const bucket = byLpVariant.get(lpVariantId);
      if (bucket) bucket.push(recipientId);
      else byLpVariant.set(lpVariantId, [recipientId]);
    }

    let assigned = 0;
    let assignedLp = 0;
    const perVariant: Record<string, number> = {};
    const perLpVariant: Record<string, number> = {};
```

tx の中(L62-88)を次に(移動元の収集に lpVariantId も含め、dm_variants の直後に dm_lp_variants をロック、LP型へも凍結印):

```ts
      const allIds = [...new Set([...[...byVariant.values()].flat(), ...[...byLpVariant.values()].flat()])];
      const sourcesPre = await tx.dmRecipientDraft.findMany({
        where: { id: { in: allIds }, campaignId: id },
        select: { variantId: true, lpVariantId: true },
      });
      const lockVariantIds = [...new Set([...byVariant.keys(), ...sourcesPre.map((d) => d.variantId)])].sort();
      if (lockVariantIds.length > 0) {
        await tx.$queryRaw`SELECT id FROM dm_variants WHERE id = ANY(${lockVariantIds}::uuid[]) AND campaign_id = ${id}::uuid ORDER BY id FOR UPDATE`;
      }
      // ロック順序(設計 2026-09-08): dm_variants → dm_lp_variants。移動元・移動先の両方を id 順に。
      const lockLpIds = [...new Set([...byLpVariant.keys(), ...sourcesPre.map((d) => d.lpVariantId).filter((x): x is string => !!x)])].sort();
      if (lockLpIds.length > 0) {
        await tx.$queryRaw`SELECT id FROM dm_lp_variants WHERE id = ANY(${lockLpIds}::uuid[]) AND campaign_id = ${id}::uuid ORDER BY id FOR UPDATE`;
      }

      const movingSettled = await tx.dmRecipientDraft.findMany({
        where: { id: { in: allIds }, campaignId: id, status: { in: [...SETTLED_DRAFT_STATUSES] } },
        select: { variantId: true, lpVariantId: true },
      });
      await markVariantsFrozen(tx, movingSettled.map((d) => d.variantId));
      await markLpVariantsFrozen(tx, movingSettled.map((d) => d.lpVariantId));
```

既存の DM 側 for ループの直後に LP 側を追加:

```ts
      for (const [lpVariantId, ids] of byLpVariant) {
        if (ids.length === 0) continue;
        // LP型は本文に影響しない(表示のたびに展開)ので、本文・状態は触らない。
        const result = await tx.dmRecipientDraft.updateMany({
          where: { id: { in: ids }, campaignId: id, status: { not: "sent" }, NOT: { lpVariantId } },
          data: { lpVariantId },
        });
        assignedLp += result.count;
        perLpVariant[lpVariantId] = result.count;
      }
```

監査と応答:

```ts
      detail: { campaignId: id, mode: body.mode, order: body.order ?? null, assigned, assignedLp, perVariant, assignedAt: new Date().toISOString() },
```
```ts
    return NextResponse.json({ assigned, perVariant, assignedLp, perLpVariant }, { headers: { "Cache-Control": "no-store" } });
```

`audit-log-detail-safety.ts` の `sale_dm_assign_variants` を `new Set(["mode", "order", "assigned", "assignedLp", "assignedAt"])` に。

既存テスト `sale-dm-assign-route.test.ts` の prisma mock に `dmLpVariant: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })) },` を足す(LP型0件=既存挙動)。

- [ ] **Step 5: confirm route**

L53-65 の select に `lpVariantId: true,` を足す。L82-85 の直後に:

```ts
      // ロック順序(設計 2026-09-08): dm_variants → dm_lp_variants。
      const lpVariantIds = [...new Set(pre.map((d) => d.lpVariantId).filter((x): x is string => !!x))].sort();
      if (lpVariantIds.length > 0) {
        await tx.$queryRaw`SELECT id FROM dm_lp_variants WHERE id = ANY(${lpVariantIds}::uuid[]) ORDER BY id FOR UPDATE`;
      }
```

L239 の直後に:

```ts
      await markLpVariantsFrozen(tx, drafts.map((d) => d.lpVariantId));
```
(`drafts` は `pre` から派生している配列。型に `lpVariantId` が含まれることを tsc で確認。import に `markLpVariantsFrozen` を足す。)

- [ ] **Step 6: drafts/[id] route**

draft の先読み select に `lpVariantId: true` が無ければ足す(`draft.variantId` を読んでいる箇所の select を確認)。L110-114 の tx を:

```ts
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM dm_variants WHERE id = ${draft.variantId}::uuid FOR UPDATE`;
        if (draft.lpVariantId) {
          await tx.$queryRaw`SELECT id FROM dm_lp_variants WHERE id = ${draft.lpVariantId}::uuid FOR UPDATE`;
        }
        await markVariantsFrozen(tx, [draft.variantId]);
        await markLpVariantsFrozen(tx, [draft.lpVariantId]);
      });
```

- [ ] **Step 7: variants/[variantId] PATCH route**

L82 の直後に(確定を解除し得る経路なので、その宛先の LP型も掴む):

```ts
      // 確定の解除は LP型の「確定があった」証拠も消す。dm_variants の直後に dm_lp_variants を掴む(設計 2026-09-08)。
      const settledLp = await tx.dmRecipientDraft.findMany({
        where: { campaignId: id, variantId, status: { in: [...SETTLED_DRAFT_STATUSES] } },
        select: { lpVariantId: true },
      });
      const settledLpIds = [...new Set(settledLp.map((d) => d.lpVariantId).filter((x): x is string => !!x))].sort();
      if (settledLpIds.length > 0) {
        await tx.$queryRaw`SELECT id FROM dm_lp_variants WHERE id = ANY(${settledLpIds}::uuid[]) ORDER BY id FOR UPDATE`;
      }
```

L172-174 を:

```ts
        if (settledCount > 0) {
          await markVariantsFrozen(tx, [variantId]);
          await markLpVariantsFrozen(tx, settledLpIds);
        }
```
import に `markLpVariantsFrozen` を足す。既存テスト `sale-dm-variants-route.test.ts` の tx mock に `dmLpVariant: { updateMany: vi.fn(async () => ({ count: 0 })) }` と、`dmRecipientDraft.findMany` が無ければ `findMany: vi.fn(async () => [])` を足す。

- [ ] **Step 8: 確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-*.test.ts && npx tsc --noEmit` → PASS(既存の assign/confirm/draft/variants テストも緑)

- [ ] **Step 9: Commit**

```bash
git add "src/app/api/properties/sale-dm/campaigns/[id]/assign/route.ts" src/app/api/properties/sale-dm/drafts/confirm/route.ts "src/app/api/properties/sale-dm/drafts/[id]/route.ts" "src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/route.ts" src/lib/audit-log-detail-safety.ts src/lib/__tests__/sale-dm-assign-route.test.ts src/lib/__tests__/sale-dm-variants-route.test.ts src/lib/__tests__/sale-dm-assign-cross-route.test.ts src/lib/__tests__/sale-dm-lp-freeze-pairing.test.ts
git commit -m "feat(sale-dm): 割当を両軸化し、確定の証拠が消える全経路で LP型へも凍結印"
```

---

### Task 10: キャンペーン応答・集計 route・api-client の型と関数

**Files:**
- Modify: `src/app/api/properties/sale-dm/campaigns/[id]/route.ts`(L13-19 include・L32-47 whitelist)
- Modify: `src/app/api/properties/sale-dm/campaigns/[id]/aggregate/route.ts`
- Modify: `src/lib/api-client.ts`(`SaleDmDraft` L220 / `SaleDmCampaign` L250 / `assignSaleDmVariants` L403 / 末尾に LP型の関数)
- Test: `src/lib/__tests__/sale-dm-aggregate-route.test.ts`(既存に1ケース追加)、`src/lib/__tests__/sale-dm-review-routes.test.ts`(campaign GET の期待値に `lpVariantId` を足す必要があれば)

**Interfaces:**
- Produces(api-client):
  ```ts
  export interface SaleDmLpVariant { id: string; label: string; tone: string; length: string; appeal: string; strength: string; headline: string | null; templateFrozenAt: string | null }
  export interface SaleDmDraft { ...既存; lpVariantId: string | null }
  export interface SaleDmCampaign { ...既存; lpVariants: SaleDmLpVariant[] }
  export async function createSaleDmLpVariant(campaignId, body: { label; options: SaleDmLpVariantOptions })
  export async function updateSaleDmLpVariant(campaignId, lpId, body: { label?; options?: Partial<SaleDmLpVariantOptions> })
  export async function deleteSaleDmLpVariant(campaignId, lpId)
  export async function fetchSaleDmLpVariantPrompt(campaignId, lpId) → { prompt; digest; frozen; rawTemplate: string|null; bodyDigest }
  export async function saveSaleDmLpVariantTemplate(campaignId, lpId, body: { body; promptDigest; baseBodyDigest }) → { changed: boolean; bodyDigest: string; parts?: { headline: string; lead: string|null; faqCount: number; bodyLength: number } }
  // assignSaleDmVariants の body に lpAssignments?: { recipientId; lpVariantId }[] を追加、戻り値に assignedLp/perLpVariant
  ```
  `SaleDmLpVariantOptions` は `@/lib/validators-sale-dm` から re-export ではなく api-client 内に同名 interface を定義(client bundle に zod を引き込まない。既存 `SaleDmVariantOptions` と同じやり方)。

- [ ] **Step 1: campaign GET**

include に `lpVariants: { orderBy: { label: "asc" } },` を足し、recipients の whitelist に `lpVariantId: r.lpVariantId,` を足す(`variantId` の直後)。応答の campaign は `{ ...campaign, recipients }` のまま(lpVariants は include で含まれる)。

- [ ] **Step 2: aggregate route**

```ts
import { aggregateByVariant, aggregateTwoAxis, LP_NONE } from "@/lib/sale-dm-letter/aggregate";
```
読み込みを:
```ts
    const [variants, lpVariants, drafts] = await Promise.all([
      prisma.dmVariant.findMany({ where: { campaignId: id }, select: { id: true, label: true } }),
      prisma.dmLpVariant.findMany({ where: { campaignId: id }, select: { id: true, label: true } }),
      prisma.dmRecipientDraft.findMany({
        where: { campaignId: id, status: "sent" },
        select: { variantId: true, lpVariantId: true, deliveryStatus: true, lpFirstAccessAt: true, phoneInquiryAt: true, property: { select: { createdBy: true, assignedTo: true } } },
      }),
    ]);
```
応答に追加:
```ts
        const twoAxis = aggregateTwoAxis(visibleDrafts);
        const lpLabel = new Map(lpVariants.map((v) => [v.id, v.label]));
        // ...NextResponse.json の中:
        byDmVariantView: twoAxis.byDmVariant.map((v) => ({ ...v, label: labelByVariantId.get(v.variantId) ?? v.variantId })),
        byLpVariant: twoAxis.byLpVariant.map((v) => ({ ...v, label: v.lpVariantId === LP_NONE ? "LP型なし(外部LP)" : (lpLabel.get(v.lpVariantId) ?? v.lpVariantId) })),
        byPair: twoAxis.byPair.map((p) => ({ ...p, label: `${labelByVariantId.get(p.variantId) ?? p.variantId} × ${p.lpVariantId === LP_NONE ? "LP型なし" : (lpLabel.get(p.lpVariantId) ?? p.lpVariantId)}` })),
```
既存テスト `sale-dm-aggregate-route.test.ts` の prisma mock に `dmLpVariant: { findMany: vi.fn(async () => []) }` を足し、次のケースを追加:

```ts
  it("二軸集計(byLpVariant / byPair)を返し、LP型なしは「LP型なし(外部LP)」のラベル", async () => {
    pm.dmVariant.findMany.mockResolvedValue([{ id: "v1", label: "A" }]);
    pm.dmLpVariant.findMany.mockResolvedValue([{ id: "l1", label: "X" }]);
    pm.dmRecipientDraft.findMany.mockResolvedValue([
      { variantId: "v1", lpVariantId: "l1", deliveryStatus: "delivered", lpFirstAccessAt: new Date(), phoneInquiryAt: null, property: { createdBy: "u1", assignedTo: null } },
      { variantId: "v1", lpVariantId: null, deliveryStatus: "delivered", lpFirstAccessAt: null, phoneInquiryAt: null, property: { createdBy: "u1", assignedTo: null } },
    ]);
    const j = await (await GET(new Request("http://x") as never, ctx)).json();
    expect(j.byLpVariant.map((x: { label: string }) => x.label)).toEqual(["LP型なし(外部LP)", "X"]);
    expect(j.byPair.length).toBe(2);
    expect(j.byDmVariantView[0]).toMatchObject({ label: "A", viewed: 1, delivered: 2, viewRate: 0.5 });
  });
```
(`GET` と `ctx` の名前は既存テストファイルの流儀に合わせる。)

- [ ] **Step 3: api-client**

`SaleDmDraft` に `lpVariantId: string | null;`(`variantId` の直後)。`SaleDmVariant` の直後に:

```ts
export interface SaleDmLpVariantOptions {
  tone: string;
  length: string;
  appeal: string;
  strength: string;
}
// LP型(設計 2026-09-08)。文章そのもの(rawTemplate/bodyText)は一覧には載せない(プロンプト画面で取る)。
export interface SaleDmLpVariant {
  id: string;
  label: string;
  tone: string;
  length: string;
  appeal: string;
  strength: string;
  headline: string | null;
  templateFrozenAt: string | null;
}
```
`SaleDmCampaign` に `lpVariants: SaleDmLpVariant[];`。モック分岐(L261)の campaign に `lpVariants: []` を足す。

`assignSaleDmVariants` の body 型に `lpAssignments?: { recipientId: string; lpVariantId: string }[]`、戻り型に `assignedLp: number; perLpVariant: Record<string, number>`(モックは `assignedLp: 0, perLpVariant: {}`)。

`applySaleDmVariantTemplate` の直後に追加:

```ts
// ---- LP型(設計 2026-09-08 §2.1/§2.2)
export async function createSaleDmLpVariant(campaignId: string, body: { label: string; options: SaleDmLpVariantOptions }) {
  if (USE_MOCK) {
    await mockDelay();
    return { lpVariant: { id: `mock-lp-${body.label}`, label: body.label, ...body.options, headline: null, templateFrozenAt: null } as SaleDmLpVariant };
  }
  return apiFetch<{ lpVariant: SaleDmLpVariant }>(`/api/properties/sale-dm/campaigns/${campaignId}/lp-variants`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function updateSaleDmLpVariant(campaignId: string, lpId: string, body: { label?: string; options?: Partial<SaleDmLpVariantOptions> }) {
  if (USE_MOCK) {
    await mockDelay();
    return { lpVariant: { id: lpId } as SaleDmLpVariant };
  }
  return apiFetch<{ lpVariant: SaleDmLpVariant }>(`/api/properties/sale-dm/campaigns/${campaignId}/lp-variants/${lpId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function deleteSaleDmLpVariant(campaignId: string, lpId: string) {
  if (USE_MOCK) {
    await mockDelay();
    return { deleted: lpId };
  }
  return apiFetch<{ deleted: string }>(`/api/properties/sale-dm/campaigns/${campaignId}/lp-variants/${lpId}`, { method: "DELETE" });
}

export async function fetchSaleDmLpVariantPrompt(campaignId: string, lpId: string) {
  if (USE_MOCK) {
    await mockDelay();
    return { prompt: "（モック）LP用プロンプト", digest: "0".repeat(64), frozen: false, rawTemplate: null as string | null, bodyDigest: "0".repeat(64) };
  }
  return apiFetch<{ prompt: string; digest: string; frozen: boolean; rawTemplate: string | null; bodyDigest: string }>(
    `/api/properties/sale-dm/campaigns/${campaignId}/lp-variants/${lpId}/prompt`,
  );
}

export async function saveSaleDmLpVariantTemplate(
  campaignId: string,
  lpId: string,
  body: { body: string; promptDigest: string; baseBodyDigest: string },
) {
  if (USE_MOCK) {
    await mockDelay();
    return { changed: true, bodyDigest: "0".repeat(64), parts: { headline: "見出し", lead: null as string | null, faqCount: 0, bodyLength: 0 } };
  }
  return apiFetch<{ changed: boolean; bodyDigest: string; parts?: { headline: string; lead: string | null; faqCount: number; bodyLength: number } }>(
    `/api/properties/sale-dm/campaigns/${campaignId}/lp-variants/${lpId}/template`,
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}
```

- [ ] **Step 4: 確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-aggregate-route.test.ts src/lib/__tests__/sale-dm-review-routes.test.ts src/lib/__tests__/sale-dm-aggregate-view-model.test.ts && npx tsc --noEmit` → PASS。`sale-dm-review-routes.test.ts` が recipients の**キー集合を toEqual で固定**していれば `lpVariantId: null` を期待値に足す(集合の変更理由をコメントに書く)。

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/properties/sale-dm/campaigns/[id]/route.ts" "src/app/api/properties/sale-dm/campaigns/[id]/aggregate/route.ts" src/lib/api-client.ts src/lib/__tests__/sale-dm-aggregate-route.test.ts src/lib/__tests__/sale-dm-review-routes.test.ts
git commit -m "feat(sale-dm): キャンペーン応答に LP型・集計に二軸・api-client に LP型の関数"
```

---

### Task 11: 画面(LP型の管理パネル・集計3表・作業画面への組み込み)

**Files:**
- Modify: `src/lib/sale-dm-letter/aggregate-view-model.ts`(末尾に追加)
- Modify: `src/components/sale-dm/aggregate-view.tsx`(3表)
- Create: `src/components/sale-dm/lp-variant-manager.tsx`
- Modify: `src/app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx`(import と L229-231 の直後)
- Modify: `src/lib/__tests__/sale-dm-management-ui-wiring.test.ts`(2ケース追加)
- Test: `src/lib/__tests__/sale-dm-aggregate-view-model.test.ts`(既存に追加)

**Interfaces:**
- Produces(view-model):
  ```ts
  export interface DmViewRow { variantId: string; label: string; delivered: number; viewed: number; viewRate: string }
  export interface LpVariantRow { lpVariantId: string; label: string; sent: number; delivered: number; viewed: number; viewRate: string }
  export interface PairRow { key: string; label: string; sent: number; delivered: number; viewed: number }
  export function buildDmViewRows(campaign: SaleDmCampaign): DmViewRow[]
  export function buildLpVariantRows(campaign: SaleDmCampaign): LpVariantRow[]   // LP型が0件なら []
  export function buildPairRows(campaign: SaleDmCampaign): PairRow[]             // LP型が0件なら []
  ```
  率の書式は既存 `formatRate`(分母0は "—")。集計対象は `status === "sent"` のみ(既存 `buildVariantRows` と同じ)。

- [ ] **Step 1: view-model のテスト(既存ファイルに追加)**

```ts
import { buildDmViewRows, buildLpVariantRows, buildPairRows } from "../sale-dm-letter/aggregate-view-model";

describe("二軸の表(設計 2026-09-08)", () => {
  const base = { propertyId: "p", recipientName: "", recipientZip: null, recipientAddress: null, honorific: "様", coOwnerCount: 1, body: "b", outcome: "none", phoneInquiryAt: null };
  const campaign = {
    id: "c", name: "n", status: "sent",
    variants: [{ id: "v1", label: "A", designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low", extraInstruction: null, lpUrl: null }],
    lpVariants: [{ id: "l1", label: "X", tone: "formal", length: "medium", appeal: "price", strength: "low", headline: null, templateFrozenAt: null }],
    recipients: [
      { ...base, id: "r1", variantId: "v1", lpVariantId: "l1", status: "sent", deliveryStatus: "delivered", lpFirstAccessAt: "2026-09-09T00:00:00Z" },
      { ...base, id: "r2", variantId: "v1", lpVariantId: "l1", status: "sent", deliveryStatus: "delivered", lpFirstAccessAt: null },
      { ...base, id: "r3", variantId: "v1", lpVariantId: null, status: "sent", deliveryStatus: "unknown", lpFirstAccessAt: null },
      { ...base, id: "r4", variantId: "v1", lpVariantId: "l1", status: "draft", deliveryStatus: "unknown", lpFirstAccessAt: null },
    ],
  } as unknown as SaleDmCampaign;
  it("DM型の閲覧率 = 到達かつ閲覧 ÷ 到達", () => {
    expect(buildDmViewRows(campaign)).toEqual([{ variantId: "v1", label: "A", delivered: 2, viewed: 1, viewRate: "50.0%" }]);
  });
  it("LP型ごと(LP型なしの宛先は『LP型なし(外部LP)』)・送付済みのみ", () => {
    expect(buildLpVariantRows(campaign)).toEqual([
      { lpVariantId: "__none__", label: "LP型なし(外部LP)", sent: 1, delivered: 0, viewed: 0, viewRate: "—" },
      { lpVariantId: "l1", label: "X", sent: 2, delivered: 2, viewed: 1, viewRate: "50.0%" },
    ]);
  });
  it("組み合わせ表", () => {
    expect(buildPairRows(campaign).map((r) => r.label)).toEqual(["A × LP型なし", "A × X"]);
  });
  it("LP型が0件なら LP型の表と組み合わせ表は空(既存キャンペーンは今までどおり1表)", () => {
    const c = { ...campaign, lpVariants: [], recipients: campaign.recipients.map((r) => ({ ...r, lpVariantId: null })) } as SaleDmCampaign;
    expect(buildLpVariantRows(c)).toEqual([]);
    expect(buildPairRows(c)).toEqual([]);
  });
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-aggregate-view-model.test.ts` → FAIL

- [ ] **Step 3: view-model 実装(末尾に追加)**

```ts
import { aggregateTwoAxis, LP_NONE } from "./aggregate";

export const LP_NONE_LABEL = "LP型なし(外部LP)";

function sentDraftsForTwoAxis(campaign: SaleDmCampaign) {
  return campaign.recipients
    .filter((r) => r.status === "sent")
    .map((r) => ({
      variantId: r.variantId,
      lpVariantId: r.lpVariantId ?? null,
      deliveryStatus: r.deliveryStatus,
      lpFirstAccessAt: r.lpFirstAccessAt ? new Date(r.lpFirstAccessAt) : null,
      phoneInquiryAt: r.phoneInquiryAt ? new Date(r.phoneInquiryAt) : null,
    }));
}

export interface DmViewRow { variantId: string; label: string; delivered: number; viewed: number; viewRate: string }
export interface LpVariantRow { lpVariantId: string; label: string; sent: number; delivered: number; viewed: number; viewRate: string }
export interface PairRow { key: string; label: string; sent: number; delivered: number; viewed: number }

// DM型の成績 = 閲覧率(設計 2026-09-08 §2.1)。到達かつ閲覧 ÷ 到達。
export function buildDmViewRows(campaign: SaleDmCampaign): DmViewRow[] {
  const label = new Map(campaign.variants.map((v) => [v.id, v.label]));
  return aggregateTwoAxis(sentDraftsForTwoAxis(campaign)).byDmVariant.map((v) => ({
    variantId: v.variantId,
    label: label.get(v.variantId) ?? v.variantId,
    delivered: v.delivered,
    viewed: v.viewed,
    viewRate: formatRate(v.deliveredViewed, v.delivered),
  }));
}

export function buildLpVariantRows(campaign: SaleDmCampaign): LpVariantRow[] {
  if (campaign.lpVariants.length === 0) return [];
  const label = new Map(campaign.lpVariants.map((v) => [v.id, v.label]));
  return aggregateTwoAxis(sentDraftsForTwoAxis(campaign)).byLpVariant.map((v) => ({
    lpVariantId: v.lpVariantId,
    label: v.lpVariantId === LP_NONE ? LP_NONE_LABEL : (label.get(v.lpVariantId) ?? v.lpVariantId),
    sent: v.sent,
    delivered: v.delivered,
    viewed: v.viewed,
    viewRate: formatRate(v.deliveredViewed, v.delivered),
  }));
}

export function buildPairRows(campaign: SaleDmCampaign): PairRow[] {
  if (campaign.lpVariants.length === 0) return [];
  const dm = new Map(campaign.variants.map((v) => [v.id, v.label]));
  const lp = new Map(campaign.lpVariants.map((v) => [v.id, v.label]));
  return aggregateTwoAxis(sentDraftsForTwoAxis(campaign)).byPair.map((p) => ({
    key: `${p.variantId}|${p.lpVariantId}`,
    label: `${dm.get(p.variantId) ?? p.variantId} × ${p.lpVariantId === LP_NONE ? "LP型なし" : (lp.get(p.lpVariantId) ?? p.lpVariantId)}`,
    sent: p.sent,
    delivered: p.delivered,
    viewed: p.viewed,
  }));
}
```
`viewRate` の分子は Task 5 が露出する `deliveredViewed`(到達かつ閲覧)をそのまま使う(率から逆算しない)。

- [ ] **Step 4: `aggregate-view.tsx` を3表に**

```tsx
"use client";

import type { SaleDmCampaign } from "@/lib/api-client";
import { buildVariantRows, buildDmViewRows, buildLpVariantRows, buildPairRows } from "@/lib/sale-dm-letter/aggregate-view-model";

const th = "px-3 py-2 font-medium text-gray-600";
const td = "px-3 py-2";

function Table({ title, head, rows }: { title: string; head: string[]; rows: Array<{ key: string; cells: Array<string | number>; strong?: number[] }> }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <div className="border-b border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-600">{title}</div>
      <table className="w-full text-left text-sm">
        <thead className="border-b border-gray-200 bg-gray-50">
          <tr>{head.map((h) => <th key={h} className={th}>{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => (
            <tr key={r.key}>
              {r.cells.map((c, i) => (
                <td key={i} className={`${td} ${i === 0 ? "font-semibold" : ""} ${r.strong?.includes(i) ? "font-medium text-indigo-700" : ""}`}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// 3つの見方(設計 2026-09-08 §2.1)。率の隣に必ず分母と件数を置く(少数での早合点を防ぐ)。
export default function SaleDmAggregateView({ campaign }: { campaign: SaleDmCampaign }) {
  const dmRows = buildVariantRows(campaign);
  const viewRows = new Map(buildDmViewRows(campaign).map((r) => [r.variantId, r]));
  const lpRows = buildLpVariantRows(campaign);
  const pairRows = buildPairRows(campaign);
  if (dmRows.length === 0) return null;
  return (
    <div className="space-y-3">
      <Table
        title="DM型ごと(文面の成績 = 閲覧率)"
        head={["型", "送付", "到達", "宛先不明", "閲覧", "閲覧率", "反響", "反響率", "宛先不明率"]}
        rows={dmRows.map((r) => {
          const v = viewRows.get(r.variantId);
          return { key: r.variantId, cells: [`型 ${r.label}`, r.sent, r.delivered, r.undeliverable, v?.viewed ?? 0, v?.viewRate ?? "—", r.inquiries, r.inquiryRate, r.undeliverableRate], strong: [5, 7] };
        })}
      />
      <Table
        title="LP型ごと(ページの成績。申込率は申込フォーム対応後に追加)"
        head={["LP型", "送付", "到達", "閲覧", "閲覧率"]}
        rows={lpRows.map((r) => ({ key: r.lpVariantId, cells: [r.label, r.sent, r.delivered, r.viewed, r.viewRate], strong: [4] }))}
      />
      <Table
        title="組み合わせ(DM型 × LP型)"
        head={["組", "送付", "到達", "閲覧"]}
        rows={pairRows.map((r) => ({ key: r.key, cells: [r.label, r.sent, r.delivered, r.viewed] }))}
      />
    </div>
  );
}
```

- [ ] **Step 5: `lp-variant-manager.tsx`(DM型の管理パネルを手本に、LP型向けに簡略化)**

```tsx
"use client";

import { useState } from "react";
import { Loader2, Plus, Trash2, Pencil, FileText, Copy } from "lucide-react";
import type { SaleDmCampaign, SaleDmLpVariant, SaleDmLpVariantOptions } from "@/lib/api-client";
import {
  createSaleDmLpVariant,
  updateSaleDmLpVariant,
  deleteSaleDmLpVariant,
  fetchSaleDmLpVariantPrompt,
  saveSaleDmLpVariantTemplate,
} from "@/lib/api-client";
import { TONE_OPTIONS, LENGTH_OPTIONS, APPEAL_OPTIONS, STRENGTH_OPTIONS } from "@/lib/sale-dm-letter/adjust-model";

const DEFAULT_OPTIONS: SaleDmLpVariantOptions = { tone: "formal", length: "medium", appeal: "price", strength: "low" };
type FormState = { label: string; options: SaleDmLpVariantOptions };

// LP型(設計 2026-09-08 §2.1/§2.2)の管理パネル。DM型と独立の A/B 軸。
// 割当はDM型のパネルの「均等に割り当て」が両軸をまとめて行う(assign route)。
export default function SaleDmLpVariantManager({ campaign, onChanged }: { campaign: SaleDmCampaign; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<FormState>({ label: "", options: { ...DEFAULT_OPTIONS } });

  const [letterFor, setLetterFor] = useState<SaleDmLpVariant | null>(null);
  const [letter, setLetter] = useState<{ prompt: string; digest: string; frozen: boolean; rawTemplate: string | null; bodyDigest: string } | null>(null);
  const [pasteBody, setPasteBody] = useState("");
  const [letterNotice, setLetterNotice] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>, keepPanel = false) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (!keepPanel) setEditing(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const countByLp = (lid: string) => campaign.recipients.filter((r) => r.lpVariantId === lid).length;
  const sentByLp = (lid: string) => campaign.recipients.filter((r) => r.lpVariantId === lid && r.status === "sent").length;

  const startNew = () => { setForm({ label: "", options: { ...DEFAULT_OPTIONS } }); setEditing("new"); };
  const startEdit = (v: SaleDmLpVariant) => { setForm({ label: v.label, options: { tone: v.tone, length: v.length, appeal: v.appeal, strength: v.strength } }); setEditing(v.id); };
  const copyFromDm = (variantId: string) => {
    const v = campaign.variants.find((x) => x.id === variantId);
    if (!v) return;
    setForm((f) => ({ ...f, options: { tone: v.tone, length: v.length, appeal: v.appeal, strength: v.strength } }));
  };
  const setOpt = (k: keyof SaleDmLpVariantOptions, value: string) => setForm((f) => ({ ...f, options: { ...f.options, [k]: value } }));

  const submit = () => {
    if (editing === "new") return run(() => createSaleDmLpVariant(campaign.id, { label: form.label, options: form.options }));
    if (!editing) return;
    const prev = campaign.lpVariants.find((v) => v.id === editing);
    const optionChanged = !!prev && (["tone", "length", "appeal", "strength"] as const).some((k) => prev[k] !== form.options[k]);
    if (optionChanged && !window.confirm("文体の設定を変えると、このLP型に保存済みの文章は消えます(貼り直しが必要です)。続けますか？")) return;
    return run(() => updateSaleDmLpVariant(campaign.id, editing, { label: form.label, options: form.options }));
  };
  const remove = (v: SaleDmLpVariant) => {
    if (!window.confirm(`LP型「${v.label}」を削除します。よろしいですか？(宛先が割り当てられているLP型は削除できません)`)) return;
    run(() => deleteSaleDmLpVariant(campaign.id, v.id));
  };

  const openLetter = (v: SaleDmLpVariant) =>
    run(async () => {
      const res = await fetchSaleDmLpVariantPrompt(campaign.id, v.id);
      setLetterFor(v);
      setLetter(res);
      setPasteBody(res.rawTemplate ?? "");
      setLetterNotice(null);
    }, true);
  const copyPrompt = () =>
    run(async () => {
      if (!letter) return;
      await navigator.clipboard.writeText(letter.prompt);
      setLetterNotice("プロンプトをコピーしました。お手元のAIに貼り付けてください");
    }, true);
  const saveTemplate = () =>
    run(async () => {
      if (!letterFor || !letter) return;
      const r = await saveSaleDmLpVariantTemplate(campaign.id, letterFor.id, { body: pasteBody, promptDigest: letter.digest, baseBodyDigest: letter.bodyDigest });
      // 保存の応答が返した指紋へ更新する(取り直さない。DM型と同じ理由)。
      setLetter({ ...letter, rawTemplate: pasteBody, bodyDigest: r.bodyDigest });
      setLetterNotice(
        r.changed && r.parts
          ? `保存しました。見出し「${r.parts.headline}」・本文 ${r.parts.bodyLength} 字・よくある質問 ${r.parts.faqCount} 組${r.parts.lead ? "・リード文あり" : "・リード文なし"}`
          : "同じ文章が保存済みです(変更はありません)",
      );
    }, true);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-700">LP型(ご案内ページの A/B)</h3>
        <button type="button" onClick={startNew} disabled={busy} className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
          <Plus className="h-3.5 w-3.5" /> LP型を追加
        </button>
      </div>
      {campaign.lpVariants.length === 0 && (
        <p className="text-xs text-gray-500">LP型がまだありません。追加すると、QRの飛び先がアプリ内のご案内ページになります(追加しなければ今までどおり外部LPへ転送)。</p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}

      <ul className="space-y-1">
        {campaign.lpVariants.map((v) => (
          <li key={v.id} className="flex items-center justify-between rounded border border-gray-200 px-2 py-1.5 text-xs">
            <div>
              <span className="font-medium text-gray-700">{v.label}</span>
              <span className="ml-2 text-gray-400">割当 {countByLp(v.id)} 件(送付済 {sentByLp(v.id)})</span>
              {v.headline ? <span className="ml-2 text-gray-500">「{v.headline}」</span> : <span className="ml-2 text-amber-700">文章なし</span>}
            </div>
            <div className="flex gap-1">
              <button type="button" onClick={() => openLetter(v)} disabled={busy} aria-label={`LP型「${v.label}」の文章`} title="プロンプトを表示して、手元のAIで作った文章を貼り付けます" className="rounded p-1 text-indigo-600 hover:bg-indigo-50 disabled:opacity-50"><FileText className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={() => startEdit(v)} disabled={busy} aria-label={`LP型「${v.label}」を編集`} className="rounded p-1 text-gray-600 hover:bg-gray-100 disabled:opacity-50"><Pencil className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={() => remove(v)} disabled={busy} aria-label={`LP型「${v.label}」を削除`} className="rounded p-1 text-red-600 hover:bg-red-50 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          </li>
        ))}
      </ul>

      {editing && (
        <div className="space-y-2 rounded-md border border-gray-200 bg-gray-50 p-3 text-xs">
          <label className="block">
            <span className="text-gray-600">ラベル</span>
            <input value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} maxLength={40} className="mt-0.5 w-full rounded-md border border-gray-300 px-2 py-1 text-sm" />
          </label>
          {campaign.variants.length > 0 && (
            <label className="block">
              <span className="text-gray-600">DM型の設定を写す</span>
              <select defaultValue="" onChange={(e) => copyFromDm(e.target.value)} className="mt-0.5 w-full rounded-md border border-gray-300 px-2 py-1 text-sm">
                <option value="">(選ぶと文体4項目を写します)</option>
                {campaign.variants.map((v) => <option key={v.id} value={v.id}>型 {v.label}</option>)}
              </select>
            </label>
          )}
          {([["tone", "トーン", TONE_OPTIONS], ["length", "長さ", LENGTH_OPTIONS], ["appeal", "訴求の軸", APPEAL_OPTIONS], ["strength", "押しの強さ", STRENGTH_OPTIONS]] as const).map(([k, name, opts]) => (
            <label key={k} className="block">
              <span className="text-gray-600">{name}</span>
              <select value={form.options[k]} onChange={(e) => setOpt(k, e.target.value)} className="mt-0.5 w-full rounded-md border border-gray-300 px-2 py-1 text-sm">
                {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          ))}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(null)} disabled={busy} className="rounded border border-gray-300 bg-white px-2.5 py-1 text-gray-600 hover:bg-gray-50 disabled:opacity-50">キャンセル</button>
            <button type="button" onClick={submit} disabled={busy || form.label.trim().length === 0} className="inline-flex items-center gap-1 rounded bg-indigo-600 px-2.5 py-1 text-white hover:bg-indigo-700 disabled:opacity-50">
              {busy && <Loader2 className="h-3 w-3 animate-spin" />} 保存
            </button>
          </div>
        </div>
      )}

      {letterFor && letter && (
        <div className="mt-3 rounded-md border border-indigo-200 bg-indigo-50/40 p-3 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-medium text-gray-700">「{letterFor.label}」の文章</span>
            <button type="button" onClick={() => { setLetterFor(null); setLetter(null); setLetterNotice(null); }} className="text-gray-500 hover:underline">閉じる</button>
          </div>
          {letter.frozen && letter.rawTemplate ? (
            <p className="mt-2 rounded bg-amber-50 px-2 py-1.5 text-amber-800">このLP型はすでに送付の実績があるため、文章は変更できません。文章を変えるときは新しいLP型を追加してください。</p>
          ) : (
            <>
              {letter.frozen && <p className="mt-2 rounded bg-amber-50 px-2 py-1.5 text-amber-800">このLP型には送付の実績がありますが、文章がまだ保存されていません。最初の1回だけ登録できます。</p>}
              <p className="mt-2 text-gray-600">下の指示文をコピーして、お手元のAIに貼り付けてください。返ってきた文章(【見出し】〜【よくある質問】まで)をそのまま下の欄に貼り付けて保存します。</p>
              <div className="mt-1.5 flex items-start gap-2">
                <pre className="max-h-40 flex-1 overflow-auto whitespace-pre-wrap rounded border border-gray-200 bg-white p-2 text-[11px] leading-relaxed text-gray-700">{letter.prompt}</pre>
                <button type="button" onClick={copyPrompt} disabled={busy} className="flex items-center gap-1 rounded border border-indigo-300 bg-white px-2 py-1 text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"><Copy className="h-3.5 w-3.5" />コピー</button>
              </div>
              <textarea value={pasteBody} onChange={(e) => setPasteBody(e.target.value)} placeholder="ここに、お手元のAIで作った文章を貼り付けてください(【見出し】から始まります)" rows={10} className="mt-2 w-full rounded-md border border-gray-300 px-2 py-1 text-sm" />
              <div className="mt-1.5 flex justify-end gap-2">
                <button type="button" onClick={saveTemplate} disabled={busy} className="rounded bg-indigo-600 px-2.5 py-1 text-white hover:bg-indigo-700 disabled:opacity-50">文章を保存</button>
              </div>
            </>
          )}
          {letterNotice && <p className="mt-2 rounded bg-white px-2 py-1.5 text-gray-700">{letterNotice}</p>}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: 作業画面に組み込む**

`page.tsx` の import に `import SaleDmLpVariantManager from "@/components/sale-dm/lp-variant-manager";`。L229-231(DM型パネルの `div`)の直後に:

```tsx
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <SaleDmLpVariantManager campaign={campaign} onChanged={load} />
          </div>
```

- [ ] **Step 7: 配線テスト(`sale-dm-management-ui-wiring.test.ts` に追加)**

```ts
  it("LP型の管理パネルは 作成/更新/削除/プロンプト/貼り戻し の client を呼び、削除と文体変更で確認を出す", () => {
    const src = read("../../components/sale-dm/lp-variant-manager.tsx");
    for (const fn of ["createSaleDmLpVariant", "updateSaleDmLpVariant", "deleteSaleDmLpVariant", "fetchSaleDmLpVariantPrompt", "saveSaleDmLpVariantTemplate"]) {
      expect(src).toContain(fn);
    }
    expect(src).toContain("window.confirm");
    expect(src).not.toContain("bg-blue-600");
  });
  it("作業画面に LP型の管理パネルと3表の集計を組み込んでいる", () => {
    expect(read("../../app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx")).toContain("SaleDmLpVariantManager");
    const agg = read("../../components/sale-dm/aggregate-view.tsx");
    expect(agg).toContain("buildLpVariantRows");
    expect(agg).toContain("buildPairRows");
  });
```

- [ ] **Step 8: 確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-aggregate-view-model.test.ts src/lib/__tests__/sale-dm-management-ui-wiring.test.ts src/lib/__tests__/ui-consistency-wave1.test.ts src/lib/__tests__/ui-consistency-wave2.test.ts src/lib/__tests__/ui-consistency-wave3.test.ts && npx tsc --noEmit && npx eslint src/components/sale-dm/lp-variant-manager.tsx src/components/sale-dm/aggregate-view.tsx src/lib/sale-dm-letter/aggregate-view-model.ts` → PASS(0 error)

- [ ] **Step 9: ローカルで画面を確認(手順は `local-dev-env-setup` メモリ)**: キャンペーン画面で「LP型を追加」→ 文章ボタン → プロンプトをコピー → 4見出しの文章を貼って保存 → 一覧に見出しが出る。DM型パネルの「均等に割り当て」で宛先に両軸が付く(宛先一覧の再取得後、集計3表が出る)。LP型0件のキャンペーンでは従来どおり1表のみ。

- [ ] **Step 10: Commit**

```bash
git add src/lib/sale-dm-letter/aggregate-view-model.ts src/lib/sale-dm-letter/aggregate.ts src/lib/__tests__/sale-dm-aggregate-two-axis.test.ts src/components/sale-dm/aggregate-view.tsx src/components/sale-dm/lp-variant-manager.tsx "src/app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx" src/lib/__tests__/sale-dm-aggregate-view-model.test.ts src/lib/__tests__/sale-dm-management-ui-wiring.test.ts
git commit -m "feat(sale-dm): LP型の管理パネルと集計3表を作業画面に組み込む"
```

---

### Task 12: 使い方ガイドの追記・フルスイート・PR

**Files:**
- Modify: `public/docs/guide.html`(L177 の `<div class="note">…</div>` の直後)
- Modify: `docs/deploy.md`(migration の注意を1段落)

- [ ] **Step 1: ガイド追記(L177 の note の直後に段落を1つ)**

```html
      <div class="note"><b>LP型(ご案内ページのA/B)を追加できます（2026-09）</b>。キャンペーン画面の「LP型」でLP型を作り、DM型と同じ手順（指示文をコピー→お手元のAIに貼る→返ってきた文章を貼り付けて保存）で文章を用意します。返ってきた文章は <b>【見出し】【リード文】【本文】【よくある質問】</b> の4つの見出しで区切られている必要があり、足りない・順番が違うときは保存されず理由が表示されます。「均等に割り当て」を押すと、宛先ごとに<b>DM型とLP型の両方</b>が付きます（DM型2つ×LP型2つなら4組に均等）。集計は「DM型ごと（閲覧率）」「LP型ごと」「組み合わせ」の3表になります。<br>⚠この段階ではQRの飛び先はまだ外部LPのままです（アプリ内のご案内ページは次の段階で公開されます）。LP型を作らなければ今までと何も変わりません。</div>
```

- [ ] **Step 2: deploy.md に追記(「売却DM 外部AI方式リリース」節の直後)**

```markdown
#### 売却DM LP型の土台(2026-09): migration

`20260909000000_add_dm_lp_variants` は additive のみ(表 `dm_lp_variants` 新設・`dm_recipient_drafts.lp_variant_id` 追加・FK は SET NULL)。バックフィル無し。既存キャンペーンは LP型0件=従来どおり(割当・集計・QR転送の結果は変わらない)。rollback は列と表の DROP で戻せる(enum の追加なし)。
```

- [ ] **Step 3: フルスイート・型・lint・build**

Run: `npx vitest run && npx tsc --noEmit && npx eslint $(git diff --name-only origin/main -- "src/**/*.ts" "src/**/*.tsx") && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build`
Expected: 全緑(skipped 0 のまま)。落ちたら直してから次へ。

- [ ] **Step 4: Commit**

```bash
git add public/docs/guide.html docs/deploy.md
git commit -m "docs(sale-dm): LP型の使い方とmigrationの注意"
```

- [ ] **Step 5: @codex 提出前の自己点検(設計書 §6)**

- `assignCrossEvenly(…, [])` が `assignVariantsEvenly` と一致(Task 4 のテストで固定済み)。
- `/t/[token]` は**未変更**であること(`git diff origin/main -- src/app/t` が空)。
- `dm_lp_variants` のロックが常に `dm_variants` の後(Task 9 の走査で固定済み)。
- 監査 detail に `label`/`headline`/`rawTemplate` を載せていない(`grep -n "detail:" src/app/api/properties/sale-dm/campaigns/\[id\]/lp-variants -r`)。
- LP型 PATCH の文体変更で `faqJson` を `Prisma.DbNull` で消している(素の null を渡すと Prisma が拒否)。

- [ ] **Step 6: PR 作成(memory ルール: 専用 Monitor でレビュー到着を監視・`@codex review`・マージはユーザー)**

```bash
git push -u origin feat/sale-dm-lp-variants
gh pr create --title "売却DM: LP型の土台(二軸A/B・貼り戻し切り分け・両軸割当・集計3表)" --body-file docs/superpowers/plans/2026-09-09-sale-dm-lp-variants-foundation.md
```
PR 本文には設計書へのリンクと「所有者側(`/t/`)は無変更」「migration additive」「LP型0件=従来どおり」を明記する。

---

## Self-Review(計画の点検)

- **Spec coverage**: §2.1(LP型・両軸割当・集計3表)=Task 1/4/5/9/10/11。§2.2(LP用プロンプト・切り分け・二重digest・凍結・展開)=Task 2/3/8(展開=表示時なので PR3 の範囲・本PRでは `lpBodyHeadings` のみ用意)。§2.8(凍結・対の凍結印)=Task 4/7/8/9。§2.9(migration 直列・enum 無し)=Task 1。§3-1 の「所有者側に変化なし」=`/t/` 未変更(Task 12 Step 5 で確認)。
- **範囲外(次の PR)**: 写真/図(§2.3)、公開LP表示と `/t/` の分岐(§2.4)、申込(§2.5)、メール(§2.6)。
- **Placeholder scan**: 各 Step にコードあり。「既存テストの期待値を足す」箇所(Task 10 Step 4)は、該当テストがキー集合を固定している場合の条件付き指示で、内容(`lpVariantId: null` を追加)は明記済み。
- **Type consistency**: `assignCrossEvenly` → `Map<string, CrossAssignment>`(Task 4/9)。`markLpVariantsFrozen(tx, Array<string|null|undefined>)`(Task 4/9)。`aggregateTwoAxis` の各行は `deliveredViewed` を持ち(Task 5)、Task 11 の view-model はそれを `formatRate` の分子に使う。`saveSaleDmLpVariantTemplate` の `parts` は route の応答(Task 8)と一致。`SaleDmLpVariant.headline` は campaign GET の include(全列)で届く。
