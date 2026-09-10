# 売却DM LP型「写真と図」(第1段 PR2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LP型に「写真と図」を付けられるようにする。全キャンペーン共通の写真ライブラリ(選択・ドラッグ&ドロップ・Ctrl+V貼り付け)、推測できない番号だけで1枚ずつ返す公開口、アプリが描く図5種、生成AI用の画像プロンプト、LP型の「ヒーロー1枚+■小見出しごとに写真か図」の枠。公開LP自体はまだ出さない(PR3)。

**Architecture:** 写真は既存 storage backend(`getStorage()`・public外)に `lp-assets/<uuid>.<ext>` で保存し、`DmLpAsset` 行(`publicId` 32hex)で管理する。**縮小は画面側**(既存の現地写真準備と同じ canvas 方式・長辺1600px・JPEG)で行い、サーバーは EXIF GPS 除去(既存 `stripFieldSurveyPhotoMetadata`)+ 純関数のヘッダ解析で寸法と上限を検査する(新しい依存を足さない)。LP型と写真/図の対応は正規化した `DmLpVariantMedia` 表(ヒーロー1行+小見出しごとの行)で持つ。公開口 `GET /lp-assets/[publicId]` は「いずれかのLP型が参照している資産」だけを長期キャッシュで返す。図は `renderFigureSvg(kind)` の純関数(日本語文字はSVG `<text>`)。判定(寸法・整合・プロンプト組立)はすべて純関数に隔離する。

**Tech Stack:** Next.js App Router route handlers, Prisma(PostgreSQL・`@/generated/prisma`), zod, vitest(`src/lib/__tests__/`), React client components(Tailwind), 既存 storage adapter(local/server/s3)。**新規 npm 依存なし。**

**Spec:** `docs/superpowers/specs/2026-09-08-sale-dm-lp-autobuild-design.md` §2.3(写真と図)・§2.7(権限・監査)・§2.8(凍結)・§3-2。

## Global Constraints

- **新規 npm 依存を足さない**(sharp 等の画像ライブラリは使わない。`src/lib/field-survey/exif-strip.ts` の方針に合わせる)。縮小は画面側の canvas、寸法検査は純関数のヘッダ解析。
- 受け付ける画像: `image/jpeg` / `image/png` / `image/webp` のみ(HEIC は画面側で JPEG に変換してから送る)。1枚 **8MB** 以下(`MAX_FILE_SIZE`)。**長辺 1600px 以下**(超えたら 422・画面側が縮小して送る)。LP型1つにつき参照は **10枚** まで。
- 保存前に **EXIF GPS 除去**(`stripFieldSurveyPhotoMetadata`)。失敗(`malformed`)は 422 fail-closed。
- 保存キーは `lp-assets/<randomUUID()>.<ext>`(ext は mime から: jpg/png/webp)。**`/uploads/` の URL は画面へ返さない**(認証済み `/uploads` 経路は LP 資産を知らず 404 のまま=意図どおり)。画面は `/lp-assets/<publicId>` だけを使う。
- `publicId` = `randomBytes(16).toString("hex")`(32桁・`@unique`)。
- 公開口 `GET /lp-assets/[publicId]`: `src/proxy.ts` の `PUBLIC_PATHS` に `"/lp-assets/"` を追加(近接パス `/lp-assets` `/lp` は非公開のまま=テストで固定)。返すのは **参照中の資産だけ**(`DmLpVariantMedia` に行がある)。ヘッダ `Cache-Control: public, max-age=31536000, immutable`・`X-Content-Type-Options: nosniff`・`Content-Type` は保存時 mime。レート制限 300/分(IP)・超過は 429・`onOverflow:"allow"`。未知・未参照・削除済みは 404(本文なし・no-store)。
- 写真の登録(アップロード)・LP型への割り付け: `requireSaleDmWriteAccess`。**ライブラリからの削除: 管理者のみ**(`hasPermission(perms, "user_management", "write")`・sale-dm-settings と同じ門)。参照中の資産は削除不可(409 `REFERENCED`)。
- 凍結: LP型が凍結(列 OR 配下に confirmed/sent)なら写真と図の割り付けは変更不可(409 `VARIANT_FROZEN`)。判定は `dm_lp_variants` FOR UPDATE の下(既存 template route と同じ)。
- 監査 detail は id/件数/枠種別/ISO日時のみ。ファイル名・ラベル・見出し文字列・プロンプト本文は載せない。新 action は `src/lib/audit-log-detail-safety.ts` の allowlist に足し、`sale-dm-external-audit-visible.test.ts` に CASES を足す。
- 走査テストの縛り: 書き込み route は `requireSaleDmWriteAccess`(または `hasPermission(..."user_management","write")` の inline 判定=`WRITE_GATE_EXCEPTIONS` に理由付きで登録); `src/` に文字列 `saleDmLetter` を書かない; Tailwind `bg-blue-600` 禁止・`fixed inset-0` モーダル/`border-b-2` タブの手書き禁止(モーダルは `src/components/ui/modal-shell.tsx` の `ModalShell`・確認は `ConfirmDialog`); dashboard の page.tsx に生の `<h1` を書かない(`PageHeader`)。`variant-manager.tsx` は触らない。
- `model DmLpAsset` / `model DmLpVariantMedia` は schema.prisma で **`model DmLpVariant {` の後・`model SaleDmConfig {` の前**に置く(`sale-dm-lp-variant-columns.test.ts` の切り出しは `DmLpVariant`〜`SaleDmConfig` なので、**その走査の列名 regex に当たらない列名**にする=下記 Task 1 の注意)。
- LF 改行(既存 CRLF のファイルはそのまま)・`git add` は変更ファイルを列挙・各 commit 末尾に `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。
- 「緑」の前に `npx vitest run`(フル)+`npx tsc --noEmit`+`npx eslint <変更ファイル>`+`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build`。
- 専用 worktree(`feat/sale-dm-lp-media`・base `origin/main`)。

### 設計書からの読み替え(controller ruling・計画で確定)
1. **縮小は画面側**(設計書 §2.3「表示用に長辺1600pxへ縮小した派生」)。サーバーは派生を作らず、**受け取った(縮小済み)1枚だけ**を保存し公開する=「原寸は公開しない」より強い形。理由: 新規依存なし・既存の現地写真準備(`field-survey-photo-prepare.ts`)と同じ方式。
2. **`heroAssetId`/`sectionMediaJson` 列は作らず、正規化表 `DmLpVariantMedia`** で持つ。理由: 「参照中か」の判定と削除ガードを JSON 検索でなく行の有無で決められる。
3. nginx のログ除外は **しない**(`/t/` にも無い。`publicId` は権限ではなく単なる不透明な番号)。

---

## File Structure

| 種別 | パス | 責務 |
|---|---|---|
| 変更 | `prisma/schema.prisma` | `DmLpAsset`・`DmLpVariantMedia` 新設、relations |
| 作成 | `prisma/migrations/20260910100000_add_dm_lp_assets/migration.sql` | additive のみ |
| 作成 | `src/lib/image-dimensions.ts` | JPEG/PNG/WebP のヘッダから幅・高さを読む純関数 |
| 作成 | `src/lib/sale-dm-letter/lp-figures.ts` | 図5種の SVG を描く純関数・種類の一覧と表示名 |
| 作成 | `src/lib/sale-dm-letter/lp-media.ts` | 枠の型・`reconcileSectionMedia`・`validateMediaPlan`・`buildImagePrompt`(純関数) |
| 変更 | `src/lib/validators-sale-dm.ts` | media PUT・画像プロンプト query の zod |
| 変更 | `src/lib/audit-log-detail-safety.ts` | 新 action の allowlist |
| 作成 | `src/app/api/properties/sale-dm/lp-assets/route.ts` | GET 一覧 / POST アップロード(multipart) |
| 作成 | `src/app/api/properties/sale-dm/lp-assets/[assetId]/route.ts` | DELETE(管理者・参照中は409) |
| 作成 | `src/app/lp-assets/[publicId]/route.ts` | 公開口 |
| 変更 | `src/proxy.ts` | `PUBLIC_PATHS` に `/lp-assets/` |
| 作成 | `.../lp-variants/[lpId]/media/route.ts` | GET(現在の枠+小見出し一覧)/ PUT(枠の保存) |
| 作成 | `.../lp-variants/[lpId]/image-prompt/route.ts` | GET(画像プロンプト) |
| 変更 | `.../lp-variants/[lpId]/template/route.ts` | 貼り直し時に `reconcileSectionMedia` で枠を引き継ぐ |
| 変更 | `src/lib/api-client.ts` | 型と関数 |
| 作成 | `src/lib/lp-asset-prepare.ts` | 画面側の縮小(長辺1600・JPEG)純関数+canvas 処理 |
| 作成 | `src/components/sale-dm/lp-asset-library.tsx` | ライブラリ(一覧・選ぶ・アップロード・ドロップ・Ctrl+V) |
| 作成 | `src/components/sale-dm/lp-media-panel.tsx` | LP型の「写真と図」欄(ヒーロー/小見出しごと/図/AIで作る) |
| 変更 | `src/components/sale-dm/lp-variant-manager.tsx` | 文章パネルに「写真と図」欄を組み込む |
| 作成 | `src/app/(dashboard)/admin/lp-assets/page.tsx` + `src/components/layout/sidebar-model.tsx` | 管理者の写真置き場(削除) |
| 変更 | `public/docs/guide.html`, `public/docs/manual.html`, `docs/deploy.md` | 使い方・反映の注意 |
| テスト | `src/lib/__tests__/sale-dm-lp-asset*.test.ts`, `sale-dm-lp-figures.test.ts`, `sale-dm-lp-media*.test.ts`, `image-dimensions.test.ts`, `lp-assets-public-route.test.ts`, `sale-dm-proxy-public-path.test.ts`(追記) | 各 task に記載 |

---

### Task 1: スキーマと migration(写真ライブラリ・LP型の枠)

**Files:**
- Modify: `prisma/schema.prisma`(`model DmLpVariant` の relations と、その直後)
- Create: `prisma/migrations/20260910100000_add_dm_lp_assets/migration.sql`
- Test: `src/lib/__tests__/sale-dm-lp-asset-columns.test.ts`

**Interfaces:**
- Produces: `prisma.dmLpAsset`(`id, publicId, storageKey, mime, width, height, bytes, label?, createdBy, createdAt, deletedAt?`)、`prisma.dmLpVariantMedia`(`id, lpVariantId, slot: "hero"|"section", heading?, assetId?, figureKind?, sortOrder, createdAt`)、relations `DmLpVariant.media`, `DmLpAsset.media`, `DmLpVariantMedia.asset`。

⚠既存走査 `sale-dm-lp-variant-columns.test.ts` は `model DmLpVariant {`〜`model SaleDmConfig {` を切り出して `\n\s+(tone|length|appeal|strength|promptText|rawTemplate|headline|lead|bodyText|faqJson|templateFrozenAt)\s` を探す。新モデルをその間に置いても **これらの列名を新モデルで使わなければ**影響しない(本 task の列名はどれも該当しない: `label` は regex に無い)。

- [ ] **Step 1: 走査テスト**

```ts
// src/lib/__tests__/sale-dm-lp-asset-columns.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const schema = readFileSync(path.resolve(process.cwd(), "prisma/schema.prisma"), "utf-8").replace(/\r\n/g, "\n");
const slice = (from: string, to: string) => schema.slice(schema.indexOf(from), schema.indexOf(to));
const asset = slice("model DmLpAsset {", "model DmLpVariantMedia {");
const media = slice("model DmLpVariantMedia {", "model SaleDmConfig {");
const sql = readFileSync(
  path.resolve(process.cwd(), "prisma/migrations/20260910100000_add_dm_lp_assets/migration.sql"),
  "utf-8",
).replace(/\r\n/g, "\n");

describe("DmLpAsset / DmLpVariantMedia の表", () => {
  it("DmLpVariant の後・SaleDmConfig の前に並ぶ", () => {
    const a = schema.indexOf("model DmLpVariant {");
    const b = schema.indexOf("model DmLpAsset {");
    const c = schema.indexOf("model DmLpVariantMedia {");
    const d = schema.indexOf("model SaleDmConfig {");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(d).toBeGreaterThan(c);
  });
  it("DmLpAsset: publicId は @unique、寸法と保存キーを持つ、論理削除列がある", () => {
    expect(asset).toMatch(/publicId\s+String\s+@unique\s+@map\("public_id"\)/);
    for (const col of ["storageKey", "mime", "width", "height", "bytes", "createdBy", "deletedAt"]) {
      expect(asset, `${col} が無い`).toMatch(new RegExp(`\\n\\s+${col}\\s`));
    }
    expect(asset).toMatch(/@@map\("dm_lp_assets"\)/);
  });
  it("DmLpVariantMedia: 枠(slot)・小見出し・写真か図のどちらか・LP型ごとの索引", () => {
    for (const col of ["lpVariantId", "slot", "heading", "assetId", "figureKind", "sortOrder"]) {
      expect(media, `${col} が無い`).toMatch(new RegExp(`\\n\\s+${col}\\s`));
    }
    expect(media).toMatch(/@@index\(\[lpVariantId\]\)/);
    expect(media).toMatch(/@@index\(\[assetId\]\)/);
    expect(media).toMatch(/@@map\("dm_lp_variant_media"\)/);
  });
  it("migration は additive のみ(文頭の UPDATE/DELETE/DROP を含まない)", () => {
    expect(sql).toMatch(/CREATE TABLE "dm_lp_assets"/);
    expect(sql).toMatch(/CREATE TABLE "dm_lp_variant_media"/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "dm_lp_assets_public_id_key"/);
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|DROP)\b/m);
  });
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-asset-columns.test.ts` → FAIL

- [ ] **Step 3: schema.prisma**

`model DmLpVariant` の relations に `media DmLpVariantMedia[]` を足す:

```prisma
  campaign   DmCampaign         @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  recipients DmRecipientDraft[]
  media      DmLpVariantMedia[]
```

`model DmLpVariant { … }` の直後(`model SaleDmConfig {` の前)に追加:

```prisma
/// LP用の写真ライブラリ(設計 2026-09-08 §2.3)。全キャンペーン共通。画面側で長辺1600pxへ縮小した
/// 1枚だけを保存する(原寸は保存しない)。公開口は publicId(32hex乱数)だけで1枚を返す。
model DmLpAsset {
  id         String    @id @default(uuid()) @db.Uuid
  publicId   String    @unique @map("public_id")
  storageKey String    @map("storage_key")
  mime       String
  width      Int
  height     Int
  bytes      Int
  label      String?
  createdBy  String    @map("created_by") @db.Uuid
  createdAt  DateTime  @default(now()) @map("created_at")
  deletedAt  DateTime? @map("deleted_at")

  creator User               @relation("DmLpAssetCreator", fields: [createdBy], references: [id])
  media   DmLpVariantMedia[]

  @@index([createdAt])
  @@map("dm_lp_assets")
}

/// LP型の「写真と図」の枠。slot="hero"(ヒーロー1枚・heading は null)か slot="section"(■小見出しごと・
/// heading=小見出しの文字列)。写真(assetId)か図(figureKind)のどちらか一方を持つ(アプリ側で保証)。
model DmLpVariantMedia {
  id          String   @id @default(uuid()) @db.Uuid
  lpVariantId String   @map("lp_variant_id") @db.Uuid
  slot        String
  heading     String?
  assetId     String?  @map("asset_id") @db.Uuid
  figureKind  String?  @map("figure_kind")
  sortOrder   Int      @default(0) @map("sort_order")
  createdAt   DateTime @default(now()) @map("created_at")

  lpVariant DmLpVariant @relation(fields: [lpVariantId], references: [id], onDelete: Cascade)
  asset     DmLpAsset?  @relation(fields: [assetId], references: [id], onDelete: Restrict)

  @@index([lpVariantId])
  @@index([assetId])
  @@map("dm_lp_variant_media")
}
```

`model User` の relations に `lpAssets DmLpAsset[] @relation("DmLpAssetCreator")` を足す。

- [ ] **Step 4: migration.sql**

```sql
-- LP用の写真ライブラリと LP型の枠(設計 2026-09-08 §2.3)。additive のみ・バックフィルなし。
-- CreateTable
CREATE TABLE "dm_lp_assets" (
    "id" UUID NOT NULL,
    "public_id" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "label" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "dm_lp_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dm_lp_variant_media" (
    "id" UUID NOT NULL,
    "lp_variant_id" UUID NOT NULL,
    "slot" TEXT NOT NULL,
    "heading" TEXT,
    "asset_id" UUID,
    "figure_kind" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dm_lp_variant_media_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dm_lp_assets_public_id_key" ON "dm_lp_assets"("public_id");
CREATE INDEX "dm_lp_assets_created_at_idx" ON "dm_lp_assets"("created_at");
CREATE INDEX "dm_lp_variant_media_lp_variant_id_idx" ON "dm_lp_variant_media"("lp_variant_id");
CREATE INDEX "dm_lp_variant_media_asset_id_idx" ON "dm_lp_variant_media"("asset_id");

-- AddForeignKey
ALTER TABLE "dm_lp_assets" ADD CONSTRAINT "dm_lp_assets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dm_lp_variant_media" ADD CONSTRAINT "dm_lp_variant_media_lp_variant_id_fkey" FOREIGN KEY ("lp_variant_id") REFERENCES "dm_lp_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dm_lp_variant_media" ADD CONSTRAINT "dm_lp_variant_media_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "dm_lp_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

- [ ] **Step 5: 確認** — Run: `npx prisma generate && npx vitest run src/lib/__tests__/sale-dm-lp-asset-columns.test.ts src/lib/__tests__/sale-dm-lp-variant-columns.test.ts src/lib/__tests__/sale-dm-variant-template-columns.test.ts && npx tsc --noEmit` → PASS

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260910100000_add_dm_lp_assets/migration.sql src/lib/__tests__/sale-dm-lp-asset-columns.test.ts
git commit -m "feat(sale-dm): LP用写真ライブラリ(dm_lp_assets)と LP型の枠(dm_lp_variant_media)を追加(additive)"
```

---

### Task 2: 画像の寸法をヘッダから読む純関数 `readImageDimensions`

**Files:**
- Create: `src/lib/image-dimensions.ts`
- Test: `src/lib/__tests__/image-dimensions.test.ts`

**Interfaces:**
- Produces: `export function readImageDimensions(buf: Buffer, mime: string): { width: number; height: number } | null`(読めない/対応外は null)。対応: JPEG(SOF0/1/2 の高さ・幅)、PNG(IHDR)、WebP(VP8 / VP8L / VP8X)。

- [ ] **Step 1: テスト(合成バイト列のみ・実画像は使わない)**

```ts
// src/lib/__tests__/image-dimensions.test.ts
import { describe, it, expect } from "vitest";
import { readImageDimensions } from "../image-dimensions";

function jpeg(width: number, height: number, sof = 0xc0): Buffer {
  const sofSeg = Buffer.alloc(2 + 2 + 1 + 2 + 2 + 1);
  sofSeg[0] = 0xff; sofSeg[1] = sof;
  sofSeg.writeUInt16BE(sofSeg.length - 2, 2);
  sofSeg[4] = 8;
  sofSeg.writeUInt16BE(height, 5);
  sofSeg.writeUInt16BE(width, 7);
  sofSeg[9] = 3;
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sofSeg, Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.from([0xff, 0xd9])]);
}
function png(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(8 + 13 + 4);
  ihdr.writeUInt32BE(13, 0); ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8); ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([sig, ihdr]);
}
function webpVp8x(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(22, 4); b.write("WEBP", 8, "latin1");
  b.write("VP8X", 12, "latin1"); b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3); b.writeUIntLE(height - 1, 27, 3);
  return b;
}
function webpVp8l(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(22, 4); b.write("WEBP", 8, "latin1");
  b.write("VP8L", 12, "latin1"); b.writeUInt32LE(10, 16); b[20] = 0x2f;
  const bits = (width - 1) | ((height - 1) << 14);
  b.writeUInt32LE(bits >>> 0, 21);
  return b;
}
function webpVp8(width: number, height: number): Buffer {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(32, 4); b.write("WEBP", 8, "latin1");
  b.write("VP8 ", 12, "latin1"); b.writeUInt32LE(20, 16);
  b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a;
  b.writeUInt16LE(width & 0x3fff, 26); b.writeUInt16LE(height & 0x3fff, 28);
  return b;
}

describe("readImageDimensions", () => {
  it("JPEG(SOF0/SOF2)", () => {
    expect(readImageDimensions(jpeg(1600, 900), "image/jpeg")).toEqual({ width: 1600, height: 900 });
    expect(readImageDimensions(jpeg(640, 480, 0xc2), "image/jpeg")).toEqual({ width: 640, height: 480 });
  });
  it("PNG(IHDR)", () => {
    expect(readImageDimensions(png(1200, 1600), "image/png")).toEqual({ width: 1200, height: 1600 });
  });
  it("WebP(VP8X / VP8L / VP8)", () => {
    expect(readImageDimensions(webpVp8x(1024, 768), "image/webp")).toEqual({ width: 1024, height: 768 });
    expect(readImageDimensions(webpVp8l(300, 200), "image/webp")).toEqual({ width: 300, height: 200 });
    expect(readImageDimensions(webpVp8(320, 240), "image/webp")).toEqual({ width: 320, height: 240 });
  });
  it("壊れている・短い・対応外の mime は null(例外を投げない)", () => {
    expect(readImageDimensions(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg")).toBeNull();
    expect(readImageDimensions(Buffer.alloc(0), "image/png")).toBeNull();
    expect(readImageDimensions(png(1, 1).subarray(0, 12), "image/png")).toBeNull();
    expect(readImageDimensions(jpeg(10, 10), "image/heic")).toBeNull();
    expect(readImageDimensions(Buffer.from("RIFF....WEBPXXXX", "latin1"), "image/webp")).toBeNull();
  });
  it("JPEG は mime と中身が食い違えば null(PNG の中身に image/jpeg)", () => {
    expect(readImageDimensions(png(10, 10), "image/jpeg")).toBeNull();
  });
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/image-dimensions.test.ts` → FAIL

- [ ] **Step 3: 実装**

```ts
// src/lib/image-dimensions.ts
/**
 * 画像のヘッダから幅・高さを読む純関数(依存なし・Node Buffer のみ)。
 * LP用写真の上限(長辺1600px)をサーバー側でも検査するために使う。
 * 対応: JPEG(SOF0..SOF15 のうち寸法を持つもの)・PNG(IHDR)・WebP(VP8 / VP8L / VP8X)。
 * 読めない・対応外は null(例外は投げない=呼び出し側が 422 にする)。
 */
export interface ImageDimensions { width: number; height: number }

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpeg(buf: Buffer): ImageDimensions | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) return null;
    while (pos < buf.length && buf[pos] === 0xff) pos += 1;
    if (pos >= buf.length) return null;
    const marker = buf[pos];
    pos += 1;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (pos + 2 > buf.length) return null;
    const len = buf.readUInt16BE(pos);
    if (len < 2 || pos + len > buf.length) return null;
    if (SOF_MARKERS.has(marker)) {
      if (len < 7) return null;
      const height = buf.readUInt16BE(pos + 3);
      const width = buf.readUInt16BE(pos + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    pos += len;
  }
  return null;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function png(buf: Buffer): ImageDimensions | null {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  if (buf.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function webp(buf: Buffer): ImageDimensions | null {
  if (buf.length < 30) return null;
  if (buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WEBP") return null;
  const chunk = buf.toString("latin1", 12, 16);
  if (chunk === "VP8X") {
    const width = buf.readUIntLE(24, 3) + 1;
    const height = buf.readUIntLE(27, 3) + 1;
    return { width, height };
  }
  if (chunk === "VP8L") {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return { width, height };
  }
  if (chunk === "VP8 ") {
    if (buf.length < 30 || buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

export function readImageDimensions(buf: Buffer, mime: string): ImageDimensions | null {
  try {
    switch (mime.toLowerCase()) {
      case "image/jpeg": return jpeg(buf);
      case "image/png": return png(buf);
      case "image/webp": return webp(buf);
      default: return null;
    }
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 確認** — Run: `npx vitest run src/lib/__tests__/image-dimensions.test.ts && npx tsc --noEmit && npx eslint src/lib/image-dimensions.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/image-dimensions.ts src/lib/__tests__/image-dimensions.test.ts
git commit -m "feat: 画像ヘッダから寸法を読む純関数 readImageDimensions(JPEG/PNG/WebP・依存なし)"
```

---

### Task 3: アプリが描く図5種 `renderFigureSvg`

**Files:**
- Create: `src/lib/sale-dm-letter/lp-figures.ts`
- Test: `src/lib/__tests__/sale-dm-lp-figures.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const FIGURE_KINDS = ["sale_flow", "cost_breakdown", "inheritance_deadlines", "vacant_burden", "timing_by_type"] as const;
  export type FigureKind = (typeof FIGURE_KINDS)[number];
  export const FIGURE_LABELS: Record<FigureKind, string>;   // 画面に出す日本語名
  export function isFigureKind(v: unknown): v is FigureKind;
  export function renderFigureSvg(kind: FigureKind): string;  // 完結した <svg …>…</svg>(外部参照なし・viewBox 640x360)
  ```

- [ ] **Step 1: テスト**

```ts
// src/lib/__tests__/sale-dm-lp-figures.test.ts
import { describe, it, expect } from "vitest";
import { FIGURE_KINDS, FIGURE_LABELS, isFigureKind, renderFigureSvg } from "../sale-dm-letter/lp-figures";

describe("renderFigureSvg", () => {
  it("5種すべてが完結した SVG を返し、日本語の名前を持つ", () => {
    expect(FIGURE_KINDS.length).toBe(5);
    for (const k of FIGURE_KINDS) {
      const svg = renderFigureSvg(k);
      expect(svg.startsWith("<svg ")).toBe(true);
      expect(svg.endsWith("</svg>")).toBe(true);
      expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(svg).toContain('viewBox="0 0 640 360"');
      expect(svg).toContain("<text");
      expect(FIGURE_LABELS[k].length).toBeGreaterThan(0);
    }
  });
  it("外部参照(url()/href=http/script)を含まない", () => {
    for (const k of FIGURE_KINDS) {
      const svg = renderFigureSvg(k);
      expect(svg).not.toMatch(/<script|href="http|url\(|<image/i);
    }
  });
  it("同じ種類は常に同じ文字列(決定的)", () => {
    expect(renderFigureSvg("sale_flow")).toBe(renderFigureSvg("sale_flow"));
  });
  it("図ごとの要点の文字が入っている", () => {
    expect(renderFigureSvg("sale_flow")).toContain("査定");
    expect(renderFigureSvg("sale_flow")).toContain("引渡し");
    expect(renderFigureSvg("cost_breakdown")).toContain("仲介手数料");
    expect(renderFigureSvg("inheritance_deadlines")).toContain("3年");
    expect(renderFigureSvg("inheritance_deadlines")).toContain("10か月");
    expect(renderFigureSvg("vacant_burden")).toContain("固定資産税");
    expect(renderFigureSvg("timing_by_type")).toContain("戸建");
  });
  it("isFigureKind", () => {
    expect(isFigureKind("sale_flow")).toBe(true);
    expect(isFigureKind("nope")).toBe(false);
    expect(isFigureKind(null)).toBe(false);
  });
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-figures.test.ts` → FAIL

- [ ] **Step 3: 実装**

```ts
// src/lib/sale-dm-letter/lp-figures.ts
/**
 * LP に載せる「図」をアプリが描く(設計 2026-09-08 §2.3)。画像AIは日本語の文字を崩すため、
 * 文字が要る図はここで SVG として描く。純関数・外部参照なし・決定的。
 * すべて viewBox 640x360(4:3 に近い横長)。色は控えめな2色+文字色。
 */
export const FIGURE_KINDS = ["sale_flow", "cost_breakdown", "inheritance_deadlines", "vacant_burden", "timing_by_type"] as const;
export type FigureKind = (typeof FIGURE_KINDS)[number];

export const FIGURE_LABELS: Record<FigureKind, string> = {
  sale_flow: "売却の流れ",
  cost_breakdown: "売却にかかる費用の内訳",
  inheritance_deadlines: "相続した不動産の期限",
  vacant_burden: "空き家のまま持ち続けたときの負担",
  timing_by_type: "種別ごとの売り時の目安",
};

export function isFigureKind(v: unknown): v is FigureKind {
  return typeof v === "string" && (FIGURE_KINDS as readonly string[]).includes(v);
}

const INK = "#1f2937";
const MUTED = "#6b7280";
const ACCENT = "#2e5c8a";
const SOFT = "#e4edf6";
const FONT = 'font-family="\'Hiragino Sans\',\'Noto Sans JP\',\'Yu Gothic\',sans-serif"';

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function wrap(inner: string, title: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" width="640" height="360" role="img" aria-label="${esc(title)}">` +
    `<rect x="0" y="0" width="640" height="360" fill="#ffffff"/>` +
    `<text x="24" y="40" ${FONT} font-size="20" font-weight="700" fill="${INK}">${esc(title)}</text>` +
    inner + `</svg>`;
}
function text(x: number, y: number, s: string, size = 15, fill = INK, anchor = "start", weight = "400"): string {
  return `<text x="${x}" y="${y}" ${FONT} font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
}

/** 横に並んだ段階(矢印つき) */
function steps(items: string[], y: number, sub?: string[]): string {
  const n = items.length;
  const w = Math.floor((640 - 48 - (n - 1) * 20) / n);
  let out = "";
  items.forEach((label, i) => {
    const x = 24 + i * (w + 20);
    out += `<rect x="${x}" y="${y}" width="${w}" height="64" rx="10" fill="${SOFT}" stroke="${ACCENT}" stroke-width="1.5"/>`;
    out += text(x + w / 2, y + 30, `${i + 1}`, 12, ACCENT, "middle", "700");
    out += text(x + w / 2, y + 50, label, 15, INK, "middle", "700");
    if (sub?.[i]) out += text(x + w / 2, y + 90, sub[i], 12, MUTED, "middle");
    if (i < n - 1) out += `<path d="M${x + w + 4} ${y + 32} l12 0 m-4 -4 l4 4 -4 4" stroke="${ACCENT}" stroke-width="2" fill="none"/>`;
  });
  return out;
}

/** 横棒(割合の目安) */
function bars(rows: Array<[string, number, string]>, y0: number): string {
  let out = "";
  rows.forEach(([label, ratio, note], i) => {
    const y = y0 + i * 48;
    out += text(24, y + 18, label, 14, INK);
    out += `<rect x="200" y="${y}" width="380" height="24" rx="6" fill="${SOFT}"/>`;
    out += `<rect x="200" y="${y}" width="${Math.round(380 * ratio)}" height="24" rx="6" fill="${ACCENT}"/>`;
    out += text(590, y + 18, note, 12, MUTED, "start");
  });
  return out;
}

const RENDERERS: Record<FigureKind, () => string> = {
  sale_flow: () =>
    wrap(
      steps(["無料査定", "媒介契約", "販売活動", "売買契約", "引渡し"], 120, ["価格の目安", "販売の依頼", "内見・広告", "条件の合意", "代金と鍵"]) +
      text(24, 300, "目安: 査定から引渡しまで 3〜6か月ほど(物件と条件で変わります)", 13, MUTED),
      FIGURE_LABELS.sale_flow,
    ),
  cost_breakdown: () =>
    wrap(
      bars([
        ["仲介手数料", 0.62, "価格×3%+6万円+税"],
        ["印紙税", 0.06, "契約書に貼付"],
        ["登記費用", 0.1, "抵当権抹消など"],
        ["譲渡所得税", 0.22, "利益が出た場合"],
      ], 84) + text(24, 300, "※割合は目安です。実際の額は物件・条件により異なります", 13, MUTED),
      FIGURE_LABELS.cost_breakdown,
    ),
  inheritance_deadlines: () =>
    wrap(
      `<line x1="48" y1="180" x2="592" y2="180" stroke="${ACCENT}" stroke-width="3"/>` +
      [["相続の開始", 48, "被相続人の死亡"], ["10か月", 240, "相続税の申告・納付"], ["3年", 420, "相続登記の期限(義務)"], ["3年目の年末", 592, "空き家特例の目安"]]
        .map(([label, x, sub]) => `<circle cx="${x}" cy="180" r="8" fill="${ACCENT}"/>` + text(Number(x), 150, String(label), 15, INK, "middle", "700") + text(Number(x), 214, String(sub), 12, MUTED, "middle"))
        .join("") +
      text(24, 300, "※期限は一般的な目安です。個別の事情は専門家にご確認ください", 13, MUTED),
      FIGURE_LABELS.inheritance_deadlines,
    ),
  vacant_burden: () =>
    wrap(
      [["固定資産税・都市計画税", "毎年かかり続ける"], ["管理・草刈り・見回り", "手間と費用"], ["老朽化・修繕", "放置するほど価値が下がる"], ["特定空家の指定", "税の優遇が外れることも"]]
        .map(([t, s], i) => {
          const y = 84 + i * 50;
          return `<rect x="24" y="${y}" width="592" height="40" rx="8" fill="${SOFT}"/>` + text(40, y + 26, t, 15, INK, "start", "700") + text(600, y + 26, s, 13, MUTED, "end");
        }).join("") +
      text(24, 320, "持ち続ける負担と、売却で得られる余裕を比べてみましょう", 13, MUTED),
      FIGURE_LABELS.vacant_burden,
    ),
  timing_by_type: () =>
    wrap(
      bars([
        ["戸建", 0.7, "築年数が浅いほど有利"],
        ["区分マンション", 0.8, "大規模修繕の前後が目安"],
        ["一棟(アパート・マンション)", 0.6, "満室時・利回りが良い時"],
        ["土地", 0.5, "地価と周辺開発の動き"],
      ], 84) + text(24, 300, "※棒の長さは「売りやすさの目安」で、価格を示すものではありません", 13, MUTED),
      FIGURE_LABELS.timing_by_type,
    ),
};

export function renderFigureSvg(kind: FigureKind): string {
  return RENDERERS[kind]();
}
```

- [ ] **Step 4: 確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-figures.test.ts && npx tsc --noEmit && npx eslint src/lib/sale-dm-letter/lp-figures.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/sale-dm-letter/lp-figures.ts src/lib/__tests__/sale-dm-lp-figures.test.ts
git commit -m "feat(sale-dm): LP に載せる図5種をアプリが描く純関数 renderFigureSvg"
```

---

### Task 4: 枠の純関数 `lp-media.ts`(整合・引き継ぎ・画像プロンプト)

**Files:**
- Create: `src/lib/sale-dm-letter/lp-media.ts`
- Test: `src/lib/__tests__/sale-dm-lp-media.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const LP_MEDIA_MAX_ASSETS = 10;
  export type MediaRef = { kind: "asset"; assetId: string } | { kind: "figure"; figureKind: FigureKind };
  export interface MediaPlan { hero: { assetId: string } | null; sections: Array<{ heading: string; media: MediaRef | null }> }
  export type MediaPlanIssue =
    | { code: "UNKNOWN_HEADING"; heading: string }
    | { code: "DUPLICATE_HEADING"; heading: string }
    | { code: "TOO_MANY_ASSETS"; limit: number }
    | { code: "UNKNOWN_FIGURE"; figureKind: string };
  export function validateMediaPlan(plan: MediaPlan, headings: string[]): MediaPlanIssue | null;
  export function mediaPlanIssueMessage(issue: MediaPlanIssue): string;
  export function reconcileSectionMedia(oldHeadings: string[], newHeadings: string[], sections: MediaPlan["sections"]): MediaPlan["sections"];
  export function referencedAssetIds(plan: MediaPlan): string[];   // 重複なし・ソート
  export type ImageSlot = { kind: "hero" } | { kind: "section"; heading: string };
  export type ImageStyle = "photo" | "illustration" | "flat";
  export interface ImagePromptInput { slot: ImageSlot; leadSummary: string | null; appeal: string; propertyKind: string | null; style: ImageStyle }
  export function buildImagePrompt(input: ImagePromptInput): string;
  ```

- [ ] **Step 1: テスト**

```ts
// src/lib/__tests__/sale-dm-lp-media.test.ts
import { describe, it, expect } from "vitest";
import { validateMediaPlan, mediaPlanIssueMessage, reconcileSectionMedia, referencedAssetIds, buildImagePrompt, LP_MEDIA_MAX_ASSETS, type MediaPlan } from "../sale-dm-letter/lp-media";

const H = ["売却の進め方", "費用について", "よくある不安"];
const plan = (over: Partial<MediaPlan> = {}): MediaPlan => ({
  hero: { assetId: "a1" },
  sections: [
    { heading: "売却の進め方", media: { kind: "figure", figureKind: "sale_flow" } },
    { heading: "費用について", media: { kind: "asset", assetId: "a2" } },
  ],
  ...over,
});

describe("validateMediaPlan", () => {
  it("小見出しが本文に無ければ UNKNOWN_HEADING、重複は DUPLICATE_HEADING", () => {
    expect(validateMediaPlan(plan({ sections: [{ heading: "無い見出し", media: null }] }), H)).toEqual({ code: "UNKNOWN_HEADING", heading: "無い見出し" });
    expect(validateMediaPlan(plan({ sections: [{ heading: "費用について", media: null }, { heading: "費用について", media: null }] }), H)).toEqual({ code: "DUPLICATE_HEADING", heading: "費用について" });
  });
  it("写真は合計10枚まで(ヒーロー含む・同じ写真の再利用は1枚と数える)", () => {
    const many = Array.from({ length: LP_MEDIA_MAX_ASSETS }, (_, i) => ({ heading: `h${i}`, media: { kind: "asset" as const, assetId: `x${i}` } }));
    const headings = many.map((s) => s.heading);
    expect(validateMediaPlan({ hero: { assetId: "hero" }, sections: many }, headings)).toEqual({ code: "TOO_MANY_ASSETS", limit: 10 });
    expect(validateMediaPlan({ hero: { assetId: "x0" }, sections: many }, headings)).toBeNull();
  });
  it("知らない図の種類は UNKNOWN_FIGURE", () => {
    const p = plan({ sections: [{ heading: "売却の進め方", media: { kind: "figure", figureKind: "nope" as never } }] });
    expect(validateMediaPlan(p, H)).toEqual({ code: "UNKNOWN_FIGURE", figureKind: "nope" });
  });
  it("正常なら null・メッセージは日本語", () => {
    expect(validateMediaPlan(plan(), H)).toBeNull();
    expect(mediaPlanIssueMessage({ code: "TOO_MANY_ASSETS", limit: 10 })).toContain("10");
  });
});

describe("reconcileSectionMedia(貼り直しで小見出しが変わったとき)", () => {
  it("見出しが一致する行だけ引き継ぎ、無くなった行は落とし、新しい見出しは未設定で足す", () => {
    const out = reconcileSectionMedia(H, ["費用について", "新しい節", "売却の進め方"], plan().sections);
    expect(out).toEqual([
      { heading: "費用について", media: { kind: "asset", assetId: "a2" } },
      { heading: "新しい節", media: null },
      { heading: "売却の進め方", media: { kind: "figure", figureKind: "sale_flow" } },
    ]);
  });
  it("見出しが全部消えたら空", () => {
    expect(reconcileSectionMedia(H, [], plan().sections)).toEqual([]);
  });
});

describe("referencedAssetIds", () => {
  it("ヒーローと節の写真を重複なしで返す(図は含めない)", () => {
    expect(referencedAssetIds(plan())).toEqual(["a1", "a2"]);
    expect(referencedAssetIds({ hero: null, sections: [] })).toEqual([]);
  });
});

describe("buildImagePrompt", () => {
  const base = { leadSummary: "ご所有の{{物件種別}}の相場と進め方", appeal: "inheritance", propertyKind: "house", style: "photo" as const };
  it("枠に合った縦横比と画風・決まり文句・英語の定型行を含む", () => {
    const hero = buildImagePrompt({ ...base, slot: { kind: "hero" } });
    expect(hero).toContain("16:9");
    expect(hero).toContain("文字を入れない");
    expect(hero).toContain("ロゴ");
    expect(hero).toContain("no text");
    expect(hero).toContain("photo");
    const sec = buildImagePrompt({ ...base, slot: { kind: "section", heading: "費用について" }, style: "flat" });
    expect(sec).toContain("4:3");
    expect(sec).toContain("費用について");
    expect(sec).toContain("flat");
  });
  it("差し込み記号は要旨から取り除く・所有者情報を渡す口が無い", () => {
    const p = buildImagePrompt({ ...base, slot: { kind: "hero" } });
    expect(p).not.toContain("{{");
    expect(buildImagePrompt.length).toBe(1);
    expect(buildImagePrompt({ ...base, slot: { kind: "hero" }, ownerName: "山田" } as never)).not.toContain("山田");
  });
  it("訴求の軸と種別を日本語で反映(生の値は出ない)", () => {
    const p = buildImagePrompt({ ...base, slot: { kind: "hero" } });
    expect(p).toContain("相続");
    expect(p).toContain("戸建");
    expect(p).not.toContain("inheritance");
  });
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-media.test.ts` → FAIL

- [ ] **Step 3: 実装**

```ts
// src/lib/sale-dm-letter/lp-media.ts
/**
 * LP型の「写真と図」の枠(設計 2026-09-08 §2.3)。DB を触らない純関数のみ。
 *  - validateMediaPlan: 枠の整合(本文に無い小見出し・重複・写真10枚・未知の図)
 *  - reconcileSectionMedia: 貼り直しで小見出しが変わったとき、同じ見出しの行だけ引き継ぐ
 *  - buildImagePrompt: 生成AI向けの画像プロンプト(所有者・物件の事実は引数に無い)
 */
import { FIGURE_KINDS, type FigureKind } from "./lp-figures";
import { APPEAL_JA } from "./prompt";
import { LETTER_TAGS, propertyTypeLabel } from "./tags";

export const LP_MEDIA_MAX_ASSETS = 10;

export type MediaRef = { kind: "asset"; assetId: string } | { kind: "figure"; figureKind: FigureKind };
export interface MediaPlan {
  hero: { assetId: string } | null;
  sections: Array<{ heading: string; media: MediaRef | null }>;
}

export type MediaPlanIssue =
  | { code: "UNKNOWN_HEADING"; heading: string }
  | { code: "DUPLICATE_HEADING"; heading: string }
  | { code: "TOO_MANY_ASSETS"; limit: number }
  | { code: "UNKNOWN_FIGURE"; figureKind: string };

export function referencedAssetIds(plan: MediaPlan): string[] {
  const ids = new Set<string>();
  if (plan.hero) ids.add(plan.hero.assetId);
  for (const s of plan.sections) if (s.media?.kind === "asset") ids.add(s.media.assetId);
  return [...ids].sort();
}

export function validateMediaPlan(plan: MediaPlan, headings: string[]): MediaPlanIssue | null {
  const known = new Set(headings);
  const seen = new Set<string>();
  for (const s of plan.sections) {
    if (!known.has(s.heading)) return { code: "UNKNOWN_HEADING", heading: s.heading };
    if (seen.has(s.heading)) return { code: "DUPLICATE_HEADING", heading: s.heading };
    seen.add(s.heading);
    if (s.media?.kind === "figure" && !(FIGURE_KINDS as readonly string[]).includes(s.media.figureKind)) {
      return { code: "UNKNOWN_FIGURE", figureKind: String(s.media.figureKind) };
    }
  }
  if (referencedAssetIds(plan).length > LP_MEDIA_MAX_ASSETS) return { code: "TOO_MANY_ASSETS", limit: LP_MEDIA_MAX_ASSETS };
  return null;
}

export function mediaPlanIssueMessage(issue: MediaPlanIssue): string {
  switch (issue.code) {
    case "UNKNOWN_HEADING": return `小見出し「${issue.heading}」は本文にありません。文章を保存し直してから写真を選んでください`;
    case "DUPLICATE_HEADING": return `小見出し「${issue.heading}」に2つ以上の写真や図が付いています`;
    case "TOO_MANY_ASSETS": return `写真は1つのLP型につき ${issue.limit} 枚までです`;
    case "UNKNOWN_FIGURE": return "知らない図の種類です";
  }
}

/** 貼り直し後の小見出し列に合わせて枠を引き継ぐ(見出し文字列の完全一致のみ)。 */
export function reconcileSectionMedia(
  _oldHeadings: string[],
  newHeadings: string[],
  sections: MediaPlan["sections"],
): MediaPlan["sections"] {
  const byHeading = new Map(sections.map((s) => [s.heading, s.media] as const));
  return newHeadings.map((heading) => ({ heading, media: byHeading.get(heading) ?? null }));
}

export type ImageSlot = { kind: "hero" } | { kind: "section"; heading: string };
export type ImageStyle = "photo" | "illustration" | "flat";
export interface ImagePromptInput {
  slot: ImageSlot;
  leadSummary: string | null;
  appeal: string;
  propertyKind: string | null;
  style: ImageStyle;
}

const STYLE_JA: Record<ImageStyle, string> = { photo: "写真風", illustration: "イラスト風", flat: "フラットな図解" };
const STYLE_EN: Record<ImageStyle, string> = { photo: "photorealistic photograph", illustration: "soft illustration", flat: "flat vector illustration" };

function stripTags(s: string): string {
  return LETTER_TAGS.reduce((acc, tag) => acc.split(`{{${tag}}}`).join(""), s).replace(/\s{2,}/g, " ").trim();
}

/** 生成AI(画像)へ貼るプロンプト。引数は LP型の設定値と文章の要旨だけ(所有者・物件の事実は渡せない)。 */
export function buildImagePrompt(input: ImagePromptInput): string {
  const aspect = input.slot.kind === "hero" ? "16:9(横長)" : "4:3";
  const aspectEn = input.slot.kind === "hero" ? "16:9" : "4:3";
  const kind = input.propertyKind ? propertyTypeLabel(input.propertyKind) : null;
  const scene = input.slot.kind === "hero" ? "ページの一番上に出る、印象を決める1枚" : `「${stripTags(input.slot.heading)}」の節の下に置く1枚`;
  const summary = input.leadSummary ? stripTags(input.leadSummary) : "";
  return [
    `不動産の売却をご案内するページに載せる画像を作ってください。用途: ${scene}。`,
    `画風: ${STYLE_JA[input.style]}。縦横比: ${aspect}。`,
    `雰囲気: 日本の住宅街。${kind ? `${kind}をお持ちの方が` : "所有者の方が"}安心して相談できる、明るく落ち着いた印象。`,
    `訴求の軸: ${APPEAL_JA[input.appeal] ?? input.appeal}。`,
    summary ? `ページの要旨: ${summary}` : "",
    "",
    "【必ず守ること】",
    "- 画像の中に文字を入れない(看板・標識・書類の文字も読めない程度に)。",
    "- 実在の人物・企業のロゴ・実在の住所や地名が分かるものを出さない。",
    "- 特定の家を写した写真のように見せない(一般的な街並み・室内・相談風景にする)。",
    "",
    `English: ${STYLE_EN[input.style]}, Japanese residential neighborhood, warm natural light, aspect ratio ${aspectEn}, no text, no logos, no readable signage, no identifiable real people.`,
  ].filter((l) => l !== "").join("\n");
}
```

- [ ] **Step 4: 確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-media.test.ts && npx tsc --noEmit && npx eslint src/lib/sale-dm-letter/lp-media.ts` → PASS(`propertyTypeLabel("house")` が「戸建」を含むことを `src/lib/sale-dm-letter/tags.ts` で確認してから書く。違えばテストの期待語を実値に合わせる)

- [ ] **Step 5: Commit**

```bash
git add src/lib/sale-dm-letter/lp-media.ts src/lib/__tests__/sale-dm-lp-media.test.ts
git commit -m "feat(sale-dm): LP型の写真と図の枠(整合・引き継ぎ・画像プロンプト)の純関数"
```

---

### Task 5: zod と監査 allowlist と api-client の型

**Files:**
- Modify: `src/lib/validators-sale-dm.ts`(末尾)
- Modify: `src/lib/audit-log-detail-safety.ts`(`sale_dm_lp_body_paste` の直後)
- Modify: `src/lib/__tests__/sale-dm-external-audit-visible.test.ts`(CASES 追加)
- Modify: `src/lib/api-client.ts`(型のみ・関数は Task 9)
- Test: `src/lib/__tests__/sale-dm-lp-validators.test.ts`(追記)

**Interfaces:**
- Produces:
  ```ts
  export const saleDmLpMediaPutSchema = z.object({
    hero: z.object({ assetId: z.string().uuid() }).nullable(),
    sections: z.array(z.object({ heading: z.string().min(1).max(200), media: z.union([z.object({ kind: z.literal("asset"), assetId: z.string().uuid() }), z.object({ kind: z.literal("figure"), figureKind: z.string().min(1).max(40) })]).nullable() })).max(50),
  });
  export const saleDmLpImagePromptQuerySchema = z.object({ slot: z.enum(["hero", "section"]), heading: z.string().max(200).optional(), style: z.enum(["photo", "illustration", "flat"]).default("photo") });
  export const saleDmLpAssetLabelSchema = z.string().trim().max(80);
  ```
  監査 action: `sale_dm_lp_asset_upload`(`bytes`,`width`,`height`,`uploadedAt`)・`sale_dm_lp_asset_delete`(`deletedAt`)・`sale_dm_lp_media_update`(`assetCount`,`figureCount`,`updatedAt`)・`sale_dm_lp_image_prompt_view`(`slot`,`viewedAt`)。
  api-client 型: `SaleDmLpAsset { id; publicId; mime; width; height; bytes; label: string | null; createdAt: string; referenced: boolean }`、`SaleDmLpMediaPlan`(= `MediaPlan` と同形・`figureKind: string`)、`SaleDmLpMediaResponse { plan: SaleDmLpMediaPlan; headings: string[]; frozen: boolean; assets: SaleDmLpAsset[] }`。

- [ ] **Step 1: テスト(既存 `sale-dm-lp-validators.test.ts` に追記)**

```ts
import { saleDmLpMediaPutSchema, saleDmLpImagePromptQuerySchema, saleDmLpAssetLabelSchema } from "../validators-sale-dm";

describe("LP型 写真と図の zod", () => {
  const U = "11111111-1111-4111-8111-111111111111";
  it("枠: hero は uuid か null、節は写真か図か null", () => {
    const r = saleDmLpMediaPutSchema.parse({ hero: { assetId: U }, sections: [{ heading: "h", media: { kind: "figure", figureKind: "sale_flow" } }, { heading: "g", media: null }] });
    expect(r.sections.length).toBe(2);
    expect(() => saleDmLpMediaPutSchema.parse({ hero: { assetId: "x" }, sections: [] })).toThrow();
    expect(() => saleDmLpMediaPutSchema.parse({ hero: null, sections: [{ heading: "", media: null }] })).toThrow();
  });
  it("画像プロンプトの query: style は既定 photo", () => {
    expect(saleDmLpImagePromptQuerySchema.parse({ slot: "hero" })).toEqual({ slot: "hero", style: "photo" });
    expect(() => saleDmLpImagePromptQuerySchema.parse({ slot: "nope" })).toThrow();
  });
  it("写真のラベルは80字まで(空可)", () => {
    expect(saleDmLpAssetLabelSchema.parse("  会社の外観 ")).toBe("会社の外観");
    expect(() => saleDmLpAssetLabelSchema.parse("あ".repeat(81))).toThrow();
  });
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-validators.test.ts` → FAIL

- [ ] **Step 3: 実装(validators 末尾)**

```ts
// ---- LP型の写真と図(設計 2026-09-08 §2.3)
const lpMediaRefSchema = z.union([
  z.object({ kind: z.literal("asset"), assetId: z.string().uuid() }),
  z.object({ kind: z.literal("figure"), figureKind: z.string().min(1).max(40) }),
]);
export const saleDmLpMediaPutSchema = z.object({
  hero: z.object({ assetId: z.string().uuid() }).nullable(),
  sections: z
    .array(z.object({ heading: z.string().min(1).max(200), media: lpMediaRefSchema.nullable() }))
    .max(50),
});
export type SaleDmLpMediaPut = z.infer<typeof saleDmLpMediaPutSchema>;

export const saleDmLpImagePromptQuerySchema = z.object({
  slot: z.enum(["hero", "section"]),
  heading: z.string().max(200).optional(),
  style: z.enum(["photo", "illustration", "flat"]).default("photo"),
});

export const saleDmLpAssetLabelSchema = z.string().trim().max(80);
```

監査 allowlist(`sale_dm_lp_body_paste` の直後):

```ts
  // LP型の写真と図(設計 2026-09-08 §2.3)。ファイル名・ラベル・見出し・プロンプト本文は載せない。
  sale_dm_lp_asset_upload: new Set(["bytes", "width", "height", "uploadedAt"]),
  sale_dm_lp_asset_delete: new Set(["deletedAt"]),
  sale_dm_lp_media_update: new Set(["assetCount", "figureCount", "updatedAt"]),
  sale_dm_lp_image_prompt_view: new Set(["slot", "viewedAt"]),
```

`sale-dm-external-audit-visible.test.ts` の CASES に追加:

```ts
    { action: "sale_dm_lp_asset_upload", detail: { bytes: 1234, width: 1600, height: 900, uploadedAt: "2026-09-10T00:00:00.000Z" } },
    { action: "sale_dm_lp_media_update", detail: { campaignId: "c1", assetCount: 2, figureCount: 1, updatedAt: "2026-09-10T00:00:00.000Z" } },
    { action: "sale_dm_lp_image_prompt_view", detail: { campaignId: "c1", slot: "hero", viewedAt: "2026-09-10T00:00:00.000Z" } },
```

api-client(`SaleDmLpVariant` の直後):

```ts
// LP用の写真(設計 2026-09-08 §2.3)。画面は /lp-assets/<publicId> だけを使う(/uploads/ は返さない)。
export interface SaleDmLpAsset {
  id: string;
  publicId: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  label: string | null;
  createdAt: string;
  referenced: boolean;
}
export type SaleDmLpMediaRef = { kind: "asset"; assetId: string } | { kind: "figure"; figureKind: string };
export interface SaleDmLpMediaPlan {
  hero: { assetId: string } | null;
  sections: Array<{ heading: string; media: SaleDmLpMediaRef | null }>;
}
export interface SaleDmLpMediaResponse {
  plan: SaleDmLpMediaPlan;
  headings: string[];
  frozen: boolean;
  assets: SaleDmLpAsset[];
}
export const LP_ASSET_URL = (publicId: string) => `/lp-assets/${publicId}`;
```

- [ ] **Step 4: 確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-validators.test.ts src/lib/__tests__/sale-dm-external-audit-visible.test.ts && npx tsc --noEmit` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/validators-sale-dm.ts src/lib/audit-log-detail-safety.ts src/lib/__tests__/sale-dm-external-audit-visible.test.ts src/lib/api-client.ts src/lib/__tests__/sale-dm-lp-validators.test.ts
git commit -m "feat(sale-dm): 写真と図の zod・監査 allowlist・client 型"
```

---

### Task 6: 写真ライブラリの受け口(一覧・アップロード・削除)

**Files:**
- Create: `src/app/api/properties/sale-dm/lp-assets/route.ts`(GET/POST)
- Create: `src/app/api/properties/sale-dm/lp-assets/[assetId]/route.ts`(DELETE)
- Modify: `src/lib/__tests__/sale-dm-write-permission-guard.test.ts`(存在すれば: DELETE は inline `hasPermission(..."user_management","write")` なので `WRITE_GATE_EXCEPTIONS` に理由付きで登録。ファイル名は `ls src/lib/__tests__ | grep -i gate` で確認)
- Test: `src/lib/__tests__/sale-dm-lp-assets-route.test.ts`

**Interfaces:**
- Consumes: `readImageDimensions`(Task 2)、`stripFieldSurveyPhotoMetadata`(`@/lib/field-survey/exif-strip`)、`getStorage`/`validateFile`(`@/lib/storage`)、`saleDmLpAssetLabelSchema`(Task 5)。
- Produces: `GET → { assets: SaleDmLpAsset[] }`(`deletedAt null`・新しい順・`referenced` は media 行の有無)、`POST(multipart: file, label?) → { asset: SaleDmLpAsset }`(201)、`DELETE → { deleted: id }`。エラー: 422 `VALIDATION_ERROR`(mime/size/寸法/EXIF失敗)、409 `REFERENCED`、403、404 `ASSET_NOT_FOUND`。

- [ ] **Step 1: テスト**

```ts
// src/lib/__tests__/sale-dm-lp-assets-route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
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
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
const { storageStub } = vi.hoisted(() => ({ storageStub: { upload: vi.fn(), delete: vi.fn(), getUrl: vi.fn(), read: vi.fn(), keyFromUrl: vi.fn() } }));
vi.mock("@/lib/storage", () => {
  const MAX = 8 * 1024 * 1024;
  return {
    getStorage: () => storageStub,
    MAX_FILE_SIZE: MAX,
    ALLOWED_PHOTO_MIMES: new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]),
    validateFile: (size: number, mime: string, allowed: Set<string>) => (size > MAX ? "大きすぎます" : !allowed.has(mime) ? `許可されていないファイル形式です: ${mime}` : null),
  };
});
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    dmLpAsset: { findMany: vi.fn(async () => []), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    dmLpVariantMedia: { count: vi.fn(async () => 0) },
    $queryRaw: vi.fn(async () => []),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { GET, POST } from "../../app/api/properties/sale-dm/lp-assets/route";
import { DELETE } from "../../app/api/properties/sale-dm/lp-assets/[assetId]/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  dmLpAsset: { findMany: Fn; findUnique: Fn; create: Fn; update: Fn };
  dmLpVariantMedia: { count: Fn };
};
const READS = ["property", "csv_export", "csv_export_personal", "owner"];

// 合成 JPEG(実画像なし): SOI + APP0 + SOF0(width×height) + SOS + EOI。APP1(EXIF)を付ける版も作る。
function jpegBytes(width: number, height: number, withExif = false): Buffer {
  const sof = Buffer.alloc(10); sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(8, 2); sof[4] = 8; sof.writeUInt16BE(height, 5); sof.writeUInt16BE(width, 7); sof[9] = 3;
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const exifPayload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from("II*\0\x08\0\0\0\0\0", "latin1")]);
  const app1 = withExif ? Buffer.concat([Buffer.from([0xff, 0xe1]), (() => { const l = Buffer.alloc(2); l.writeUInt16BE(exifPayload.length + 2, 0); return l; })(), exifPayload]) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, app1, sof, Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.from([0xff, 0xd9])]);
}
function multipart(bytes: Buffer, mime: string, name = "a.jpg", label?: string): Request {
  const fd = new FormData();
  fd.append("file", new File([bytes], name, { type: mime }));
  if (label !== undefined) fd.append("label", label);
  return new Request("http://x/api/properties/sale-dm/lp-assets", { method: "POST", body: fd });
}
const perms = (admin: boolean) => [
  ...READS.map((r) => ({ resource: r, action: "read", granted: true })),
  { resource: "property", action: "write", granted: true },
  ...(admin ? [{ resource: "user_management", action: "write", granted: true }] : []),
];

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Fn).mockResolvedValue(perms(true));
  (getOwnerDisplayConfig as Fn).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
  storageStub.upload.mockResolvedValue({ url: "/uploads/lp-assets/x.jpg", key: "lp-assets/x.jpg" });
  pm.dmLpAsset.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "a1", createdAt: new Date(), deletedAt: null, ...data }));
  pm.dmLpAsset.findUnique.mockResolvedValue({ id: "a1", publicId: "p".repeat(32), storageKey: "lp-assets/x.jpg", deletedAt: null });
  pm.dmLpVariantMedia.count.mockResolvedValue(0);
});

describe("POST lp-assets(アップロード)", () => {
  it("JPEG を EXIF を除いて保存し、publicId(32hex)と寸法を返す。/uploads の URL は返さない", async () => {
    const res = await POST(multipart(jpegBytes(1600, 900, true), "image/jpeg", "会社の外観.jpg", "外観") as never);
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.asset.publicId).toMatch(/^[0-9a-f]{32}$/);
    expect(j.asset).toMatchObject({ width: 1600, height: 900, mime: "image/jpeg", label: "外観" });
    expect(JSON.stringify(j)).not.toContain("/uploads/");
    expect(JSON.stringify(j)).not.toContain("storageKey");
    const uploaded: Buffer = storageStub.upload.mock.calls[0][0];
    expect(uploaded.includes(Buffer.from("Exif\0\0", "latin1"))).toBe(false);
    expect(storageStub.upload.mock.calls[0][1].key).toMatch(/^lp-assets\/[0-9a-f-]{36}\.jpg$/);
    expect(writeAuditLog.mock.calls[0][0].action).toBe("sale_dm_lp_asset_upload");
    expect(JSON.stringify(writeAuditLog.mock.calls[0][0].detail)).not.toContain("外観");
  });
  it("長辺が1600を超えると 422(画面側で縮小して送る前提)", async () => {
    const res = await POST(multipart(jpegBytes(2000, 1000), "image/jpeg") as never);
    expect(res.status).toBe(422);
    expect(storageStub.upload).not.toHaveBeenCalled();
  });
  it("HEIC は 422(JPEG に変換してから送る)・multipart 以外も 422", async () => {
    expect((await POST(multipart(jpegBytes(10, 10), "image/heic", "a.heic") as never)).status).toBe(422);
    expect((await POST(new Request("http://x", { method: "POST", body: "{}" }) as never)).status).toBe(422);
  });
  it("壊れた画像(寸法が読めない)は 422 で保存しない", async () => {
    const res = await POST(multipart(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg") as never);
    expect(res.status).toBe(422);
    expect(storageStub.upload).not.toHaveBeenCalled();
  });
  it("DB 保存に失敗したら保存した実ファイルを消す", async () => {
    pm.dmLpAsset.create.mockRejectedValue(new Error("db down"));
    const res = await POST(multipart(jpegBytes(100, 100), "image/jpeg") as never);
    expect(res.status).toBe(500);
    expect(storageStub.delete).toHaveBeenCalledWith("lp-assets/x.jpg");
  });
  it("書き込み権限が無ければ 403", async () => {
    (getUserPermissions as Fn).mockResolvedValue(READS.map((r) => ({ resource: r, action: "read", granted: true })));
    expect((await POST(multipart(jpegBytes(10, 10), "image/jpeg") as never)).status).toBe(403);
  });
});

describe("GET lp-assets(一覧)", () => {
  it("削除済みを除き新しい順、referenced を付ける、storageKey は返さない", async () => {
    pm.dmLpAsset.findMany.mockResolvedValue([
      { id: "a1", publicId: "p1", mime: "image/jpeg", width: 1, height: 1, bytes: 10, label: null, createdAt: new Date(), storageKey: "k", _count: { media: 2 } },
    ]);
    const res = await GET(new Request("http://x") as never);
    const j = await res.json();
    expect(pm.dmLpAsset.findMany.mock.calls[0][0].where).toEqual({ deletedAt: null });
    expect(j.assets[0]).toMatchObject({ id: "a1", referenced: true });
    expect(JSON.stringify(j)).not.toContain("storageKey");
  });
});

describe("DELETE lp-assets/[assetId]", () => {
  const ctx = { params: Promise.resolve({ assetId: "a1" }) };
  it("管理者のみ(user_management:write)。参照中は 409 REFERENCED", async () => {
    (getUserPermissions as Fn).mockResolvedValue(perms(false));
    expect((await DELETE(new Request("http://x", { method: "DELETE" }) as never, ctx)).status).toBe(403);
    (getUserPermissions as Fn).mockResolvedValue(perms(true));
    pm.dmLpVariantMedia.count.mockResolvedValue(1);
    const r = await DELETE(new Request("http://x", { method: "DELETE" }) as never, ctx);
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("REFERENCED");
  });
  it("参照が無ければ論理削除し、実ファイルは best-effort で消す", async () => {
    pm.dmLpAsset.update.mockResolvedValue({ id: "a1" });
    storageStub.delete.mockRejectedValue(new Error("nfs"));
    const r = await DELETE(new Request("http://x", { method: "DELETE" }) as never, ctx);
    expect(r.status).toBe(200);
    expect(pm.dmLpAsset.update.mock.calls[0][0].data.deletedAt).toBeInstanceOf(Date);
    expect(writeAuditLog.mock.calls[0][0].action).toBe("sale_dm_lp_asset_delete");
  });
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-assets-route.test.ts` → FAIL

- [ ] **Step 3: `lp-assets/route.ts`**

```ts
import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { getStorage, validateFile, MAX_FILE_SIZE } from "@/lib/storage";
import { stripFieldSurveyPhotoMetadata } from "@/lib/field-survey/exif-strip";
import { readImageDimensions } from "@/lib/image-dimensions";
import { requireSaleDmAccess, requireSaleDmWriteAccess } from "@/lib/sale-dm-letter/route-guard";
import { saleDmLpAssetLabelSchema } from "@/lib/validators-sale-dm";

/** LP用の写真ライブラリ(設計 2026-09-08 §2.3)。全キャンペーン共通。 */
export const LP_ASSET_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
export const LP_ASSET_MAX_EDGE = 1600;
const MIME_TO_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

const SELECT = { id: true, publicId: true, mime: true, width: true, height: true, bytes: true, label: true, createdAt: true } as const;

export async function GET() {
  try {
    await requireSaleDmAccess();
    const rows = await prisma.dmLpAsset.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: { ...SELECT, _count: { select: { media: true } } },
    });
    const assets = rows.map(({ _count, ...a }) => ({ ...a, referenced: _count.media > 0 }));
    return NextResponse.json({ assets }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { session } = await requireSaleDmWriteAccess();
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      throw new ApiError(422, "画像は multipart/form-data で送信してください", "VALIDATION_ERROR");
    }
    const formData = await request.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof Blob)) throw new ApiError(422, "ファイルが必要です", "VALIDATION_ERROR");
    const labelRaw = formData.get("label");
    const label = typeof labelRaw === "string" && labelRaw.trim() !== "" ? saleDmLpAssetLabelSchema.parse(labelRaw) : null;

    const mimeType = file.type;
    if (!LP_ASSET_MIMES.has(mimeType)) {
      throw new ApiError(422, "JPEG / PNG / WebP の画像を使用してください(HEIC は画面側で変換されます)", "VALIDATION_ERROR");
    }
    const sizeIssue = validateFile(file.size, mimeType, LP_ASSET_MIMES);
    if (sizeIssue) throw new ApiError(422, sizeIssue, "VALIDATION_ERROR");

    const raw = Buffer.from(await file.arrayBuffer());
    // 保存前に EXIF(位置情報を含む)を除く。失敗は fail-closed。
    const stripped = stripFieldSurveyPhotoMetadata(raw, mimeType);
    if (!stripped.ok) throw new ApiError(422, "画像ファイルを処理できませんでした", "VALIDATION_ERROR");
    const buffer = stripped.buffer;
    if (buffer.length > MAX_FILE_SIZE) throw new ApiError(422, "ファイルサイズが上限を超えています", "VALIDATION_ERROR");

    const dims = readImageDimensions(buffer, mimeType);
    if (!dims) throw new ApiError(422, "画像の大きさを読み取れませんでした", "VALIDATION_ERROR");
    if (Math.max(dims.width, dims.height) > LP_ASSET_MAX_EDGE) {
      throw new ApiError(422, `画像の長辺は ${LP_ASSET_MAX_EDGE}px 以下にしてください(画面から登録すると自動で縮小されます)`, "VALIDATION_ERROR");
    }

    const key = `lp-assets/${randomUUID()}.${MIME_TO_EXT[mimeType]}`;
    const storage = getStorage();
    const stored = await storage.upload(buffer, { key, mimeType, fileName: `lp-asset.${MIME_TO_EXT[mimeType]}` });

    let asset;
    try {
      asset = await prisma.dmLpAsset.create({
        data: {
          publicId: randomBytes(16).toString("hex"),
          storageKey: stored.key,
          mime: mimeType,
          width: dims.width,
          height: dims.height,
          bytes: buffer.length,
          label,
          createdBy: session.id,
        },
        select: SELECT,
      });
    } catch (dbError) {
      try { await storage.delete(stored.key); } catch { /* best-effort */ }
      throw dbError;
    }

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_lp_asset_upload",
      targetTable: "dm_lp_assets",
      targetId: asset.id,
      // 非PII: 寸法・バイト数・日時のみ(ファイル名・ラベルは載せない)。
      detail: { bytes: buffer.length, width: dims.width, height: dims.height, uploadedAt: new Date().toISOString() },
    });
    return NextResponse.json({ asset: { ...asset, referenced: false } }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: `lp-assets/[assetId]/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { getStorage } from "@/lib/storage";

/**
 * ライブラリからの削除は管理者のみ(設計 §2.7・sale-dm-settings と同じ門 user_management:write)。
 * どこかのLP型が参照していれば 409(参照を外してから)。実ファイルの削除は best-effort。
 */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ assetId: string }> }) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "user_management", "write")) {
      throw new ApiError(403, "写真の削除は管理者のみ行えます", "FORBIDDEN");
    }
    const { assetId } = await params;
    const asset = await prisma.dmLpAsset.findUnique({ where: { id: assetId }, select: { id: true, storageKey: true, deletedAt: true } });
    if (!asset || asset.deletedAt) throw new ApiError(404, "写真が見つかりません", "ASSET_NOT_FOUND");
    const referenced = await prisma.dmLpVariantMedia.count({ where: { assetId } });
    if (referenced > 0) {
      throw new ApiError(409, "この写真はLP型で使われています。先にLP型から外してください", "REFERENCED");
    }
    await prisma.dmLpAsset.update({ where: { id: assetId }, data: { deletedAt: new Date() } });
    try { await getStorage().delete(asset.storageKey); } catch { /* best-effort: 論理削除が正 */ }
    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_lp_asset_delete",
      targetTable: "dm_lp_assets",
      targetId: assetId,
      detail: { deletedAt: new Date().toISOString() },
    });
    return NextResponse.json({ deleted: assetId }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 5: 走査テストの登録** — 書き込み門の走査(`ls src/lib/__tests__ | grep -i gate` で見つかるファイル)の `WRITE_GATE_EXCEPTIONS` に `"src/app/api/properties/sale-dm/lp-assets/[assetId]/route.ts": "管理者(user_management:write)限定の削除。requireSaleDmWriteAccess より強い門を inline で通す"` を追加(その走査が `hasPermission(...\"property\"...\"write\"` も許容する形なら不要=実行して判断)。

- [ ] **Step 6: 確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-assets-route.test.ts src/lib/__tests__/sale-dm-*gate*.test.ts src/lib/__tests__/sale-dm-write-permission-guard.test.ts && npx tsc --noEmit && npx eslint src/app/api/properties/sale-dm/lp-assets` → PASS(存在しないテストファイル名は外す)

- [ ] **Step 7: Commit**

```bash
git add src/app/api/properties/sale-dm/lp-assets src/lib/__tests__/sale-dm-lp-assets-route.test.ts
git commit -m "feat(sale-dm): LP用写真ライブラリの受け口(一覧・EXIF除去つきアップロード・管理者削除)"
```

---

### Task 7: 公開口 `GET /lp-assets/[publicId]` と proxy の公開パス

**Files:**
- Create: `src/app/lp-assets/[publicId]/route.ts`
- Modify: `src/proxy.ts`(`PUBLIC_PATHS` に `"/lp-assets/"`)
- Modify: `src/lib/__tests__/sale-dm-proxy-public-path.test.ts`(追記)
- Test: `src/lib/__tests__/lp-assets-public-route.test.ts`

**Interfaces:**
- Produces: `GET /lp-assets/<publicId>` → 200(本文=画像・`Content-Type`=保存時 mime・`Content-Length`・`Cache-Control: public, max-age=31536000, immutable`・`X-Content-Type-Options: nosniff`)。未知/削除済み/未参照/形式不正 → 404(no-store)。レート超過 → 429。

- [ ] **Step 1: テスト**

```ts
// src/lib/__tests__/lp-assets-public-route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response { static json = (b: unknown, init?: ResponseInit) => Response.json(b, init); }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
const { storageStub } = vi.hoisted(() => ({ storageStub: { read: vi.fn(), upload: vi.fn(), delete: vi.fn(), getUrl: vi.fn(), keyFromUrl: vi.fn() } }));
vi.mock("@/lib/storage", () => ({ getStorage: () => storageStub }));
vi.mock("@/lib/prisma", () => ({ default: { dmLpAsset: { findUnique: vi.fn() } } }));

import prismaMock from "@/lib/prisma";
import { GET } from "../../app/lp-assets/[publicId]/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as { dmLpAsset: { findUnique: Fn } };
const PID = "a".repeat(32);
const ctx = (publicId: string) => ({ params: Promise.resolve({ publicId }) });
const req = (ip = "10.0.0.1") => new Request(`http://x/lp-assets/${PID}`, { headers: { "x-real-ip": ip } }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  pm.dmLpAsset.findUnique.mockResolvedValue({ storageKey: "lp-assets/k.jpg", mime: "image/jpeg", deletedAt: null, _count: { media: 1 } });
  storageStub.read.mockResolvedValue({ body: Buffer.from([1, 2, 3]), contentType: "application/octet-stream", size: 3 });
});

describe("GET /lp-assets/[publicId]", () => {
  it("参照中の資産を長期キャッシュで返す(Content-Type は保存時の mime)", async () => {
    const res = await GET(req(), ctx(PID));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-length")).toBe("3");
    expect(pm.dmLpAsset.findUnique.mock.calls[0][0].where).toEqual({ publicId: PID });
  });
  it("未参照・削除済み・未知・形式不正は 404(本文なし・no-store・DB/storage を叩かない場合も)", async () => {
    pm.dmLpAsset.findUnique.mockResolvedValue({ storageKey: "k", mime: "image/jpeg", deletedAt: null, _count: { media: 0 } });
    expect((await GET(req("10.0.0.2"), ctx(PID))).status).toBe(404);
    pm.dmLpAsset.findUnique.mockResolvedValue({ storageKey: "k", mime: "image/jpeg", deletedAt: new Date(), _count: { media: 1 } });
    expect((await GET(req("10.0.0.3"), ctx(PID))).status).toBe(404);
    pm.dmLpAsset.findUnique.mockResolvedValue(null);
    expect((await GET(req("10.0.0.4"), ctx(PID))).status).toBe(404);
    pm.dmLpAsset.findUnique.mockClear();
    const bad = await GET(req("10.0.0.5"), ctx("../etc/passwd"));
    expect(bad.status).toBe(404);
    expect(bad.headers.get("cache-control")).toBe("no-store");
    expect(pm.dmLpAsset.findUnique).not.toHaveBeenCalled();
  });
  it("storage に実体が無ければ 404", async () => {
    storageStub.read.mockResolvedValue(null);
    expect((await GET(req("10.0.0.6"), ctx(PID))).status).toBe(404);
  });
  it("同じ端末から1分に300回を超えると 429", async () => {
    let last = 200;
    for (let i = 0; i < 301; i++) last = (await GET(req("10.9.9.9"), ctx(PID))).status;
    expect(last).toBe(429);
  });
});
```

`sale-dm-proxy-public-path.test.ts` に追記:

```ts
  it("/lp-assets/<publicId> は公開(LP の写真は未認証の所有者が見る)", () => {
    expect(isPublicPath("/lp-assets/abcdef")).toBe(true);
    expect(isPublicPath("/lp-assets/")).toBe(true);
  });
  it("/lp-assets/ に前方一致しない近接パスは公開しない", () => {
    expect(isPublicPath("/lp-assets")).toBe(false);
    expect(isPublicPath("/lp")).toBe(false);
    expect(isPublicPath("/api/properties/sale-dm/lp-assets")).toBe(false);
  });
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/lp-assets-public-route.test.ts src/lib/__tests__/sale-dm-proxy-public-path.test.ts` → FAIL

- [ ] **Step 3: 実装**

`src/proxy.ts`:

```ts
// "/lp-assets/" = LP用写真の公開口(設計 2026-09-08 §2.3)。publicId(32hex乱数)だけで1枚を返し、
// 一覧は取れない。どこかのLP型が参照している資産だけを返す(route 側で判定)。
const PUBLIC_PATHS = ["/login", "/api/auth", "/_next", "/favicon.ico", "/uploads", "/t/", "/u/", "/lp-assets/"];
```

`src/app/lp-assets/[publicId]/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { clientRateKey, createRateLimiter } from "@/lib/public-rate-limit";

/**
 * LP用写真の公開口(設計 2026-09-08 §2.3)。認証なし。
 *  - publicId(32hex)以外は DB を引かずに 404
 *  - 削除済み・どのLP型からも参照されていない資産は 404(ライブラリに入れただけの写真は出ない)
 *  - Content-Type は保存時の mime 固定・nosniff・長期キャッシュ(内容は不変。差し替えは別の publicId)
 */
const limiter = createRateLimiter({ limit: 300, windowMs: 60_000 }, { onOverflow: "allow" });
const PUBLIC_ID = /^[0-9a-f]{32}$/;
const NOT_FOUND = () => new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(req: NextRequest, { params }: { params: Promise<{ publicId: string }> }) {
  if (!limiter.hit(`lp-asset:${clientRateKey(req.headers)}`)) {
    return new NextResponse(null, { status: 429, headers: { "Cache-Control": "no-store" } });
  }
  const { publicId } = await params;
  if (!PUBLIC_ID.test(publicId)) return NOT_FOUND();
  const asset = await prisma.dmLpAsset.findUnique({
    where: { publicId },
    select: { storageKey: true, mime: true, deletedAt: true, _count: { select: { media: true } } },
  });
  if (!asset || asset.deletedAt || asset._count.media === 0) return NOT_FOUND();
  const file = await getStorage().read(asset.storageKey);
  if (!file) return NOT_FOUND();
  return new NextResponse(file.body as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": asset.mime,
      "Content-Length": String(file.size),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
```

- [ ] **Step 4: 確認** — Run: `npx vitest run src/lib/__tests__/lp-assets-public-route.test.ts src/lib/__tests__/sale-dm-proxy-public-path.test.ts src/lib/__tests__/*proxy*.test.ts && npx tsc --noEmit && npx eslint "src/app/lp-assets/[publicId]/route.ts" src/proxy.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add "src/app/lp-assets/[publicId]/route.ts" src/proxy.ts src/lib/__tests__/lp-assets-public-route.test.ts src/lib/__tests__/sale-dm-proxy-public-path.test.ts
git commit -m "feat(sale-dm): LP用写真の公開口 /lp-assets/[publicId](参照中のみ・長期キャッシュ・レート制限)"
```

---

### Task 8: LP型の枠の受け口(media GET/PUT・画像プロンプト)と貼り直し時の引き継ぎ

**Files:**
- Create: `src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/media/route.ts`(GET/PUT)
- Create: `src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/image-prompt/route.ts`(GET)
- Modify: `src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/template/route.ts`(`tx.dmLpVariant.update` の直後に引き継ぎ)
- Modify: `src/lib/__tests__/sale-dm-freeze-guard.test.ts`(EXCEPTIONS に media route を理由付きで登録=「凍結済みなら 409 で断る側」。image-prompt は GET のみなので走査対象外のはず=実行して判断)
- Test: `src/lib/__tests__/sale-dm-lp-media-route.test.ts`
- Test: `src/lib/__tests__/sale-dm-lp-template-route.test.ts`(存在すれば追記。無ければ media-route テストの中に「貼り直しで引き継ぐ」ケースを置く)

**Interfaces:**
- Consumes: `validateMediaPlan`/`mediaPlanIssueMessage`/`reconcileSectionMedia`/`referencedAssetIds`/`buildImagePrompt`(Task 4)、`lpBodyHeadings(body)`(`@/lib/sale-dm-letter/lp-template`・PR1)、`isFigureKind`(Task 3)、`saleDmLpMediaPutSchema`/`saleDmLpImagePromptQuerySchema`(Task 5)、`SETTLED_DRAFT_STATUSES`/`isVariantFrozen`(`@/lib/sale-dm-letter/freeze`)。
- Produces:
  - `GET media → SaleDmLpMediaResponse`(`plan`=DB行から組み立て・`headings`=`lpBodyHeadings(bodyText ?? "")`・`frozen`・`assets`=ライブラリ全件(削除済み除く))
  - `PUT media(body: SaleDmLpMediaPlan) → { plan, assetCount, figureCount }`。409 `VARIANT_FROZEN`(初期化の例外なし=写真図は凍結後いっさい変更不可・設計§2.8)、409 `TEMPLATE_MISSING`(文章未保存)、400 `INVALID_MEDIA_PLAN`、422 `ASSET_NOT_FOUND`(削除済み/未知の写真)、403(field_staff 担当外)。
  - `GET image-prompt?slot=hero|section&heading=…&style=… → { prompt: string }`。400 `HEADING_NOT_FOUND`。
  - template PUT の応答 `parts` に `mediaDropped: number`(引き継げず外した節の数)。
- DB行 ⇄ plan の対応: hero = `{slot:"hero", heading:null, assetId, sortOrder:0}` 1行以下。節 = `{slot:"section", heading, assetId|null, figureKind|null, sortOrder:i}`(`media:null` の節は**行を作らない**)。

- [ ] **Step 1: テスト**

```ts
// src/lib/__tests__/sale-dm-lp-media-route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
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
    parseJsonBody: vi.fn(async (r: Request) => JSON.parse(await r.text())),
    handleApiError: vi.fn((e: unknown) => e instanceof MockApiError ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status }) : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 })),
  };
});
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    dmCampaign: { findFirst: vi.fn(async () => ({ id: "c1", createdBy: "u1" })) },
    dmLpVariant: { findFirst: vi.fn() },
    dmLpVariantMedia: { findMany: vi.fn(async () => []), deleteMany: vi.fn(async () => ({ count: 0 })), createMany: vi.fn(async () => ({ count: 0 })) },
    dmLpAsset: { findMany: vi.fn(async () => []) },
    dmRecipientDraft: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
    property: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { GET, PUT } from "../../app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/media/route";
import { GET as PROMPT } from "../../app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/image-prompt/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  dmLpVariant: { findFirst: Fn };
  dmLpVariantMedia: { findMany: Fn; deleteMany: Fn; createMany: Fn };
  dmLpAsset: { findMany: Fn };
  dmRecipientDraft: { count: Fn; findMany: Fn };
  property: { findMany: Fn };
  $queryRaw: Fn;
};
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const ctx = { params: Promise.resolve({ id: "c1", lpId: "lp1" }) };
const BODY = "■売却の進め方\n流れの説明\n■費用について\n費用の説明";
const variant = (over: Record<string, unknown> = {}) => ({ id: "lp1", campaignId: "c1", appeal: "inheritance", lead: "ご所有の{{物件種別}}について", bodyText: BODY, templateFrozenAt: null, ...over });
const put = (plan: unknown) => PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(plan) }) as never, ctx);
const okPlan = { hero: { assetId: U1 }, sections: [{ heading: "売却の進め方", media: { kind: "figure", figureKind: "sale_flow" } }, { heading: "費用について", media: { kind: "asset", assetId: U2 } }] };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Fn).mockResolvedValue([
    ...["property", "csv_export", "csv_export_personal", "owner"].map((r) => ({ resource: r, action: "read", granted: true })),
    { resource: "property", action: "write", granted: true },
  ]);
  (getOwnerDisplayConfig as Fn).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
  pm.dmLpVariant.findFirst.mockResolvedValue(variant());
  pm.dmLpAsset.findMany.mockResolvedValue([{ id: U1 }, { id: U2 }]);
  pm.dmRecipientDraft.count.mockResolvedValue(0);
});

describe("GET media", () => {
  it("DB行を枠に組み立て、本文の小見出し一覧と凍結状態とライブラリを返す", async () => {
    pm.dmLpVariantMedia.findMany.mockResolvedValue([
      { slot: "hero", heading: null, assetId: U1, figureKind: null, sortOrder: 0 },
      { slot: "section", heading: "費用について", assetId: null, figureKind: "cost_breakdown", sortOrder: 1 },
    ]);
    pm.dmLpAsset.findMany.mockResolvedValue([{ id: U1, publicId: "p", mime: "image/jpeg", width: 1, height: 1, bytes: 1, label: null, createdAt: new Date(), _count: { media: 1 } }]);
    const j = await (await GET(new Request("http://x") as never, ctx)).json();
    expect(j.plan).toEqual({ hero: { assetId: U1 }, sections: [{ heading: "売却の進め方", media: null }, { heading: "費用について", media: { kind: "figure", figureKind: "cost_breakdown" } }] });
    expect(j.headings).toEqual(["売却の進め方", "費用について"]);
    expect(j.frozen).toBe(false);
    expect(j.assets[0]).toMatchObject({ id: U1, referenced: true });
    expect(JSON.stringify(j)).not.toContain("storageKey");
  });
});

describe("PUT media", () => {
  it("LP型行をロックし、行を入れ替えて保存し、監査に件数だけ残す", async () => {
    const res = await put(okPlan);
    expect(res.status).toBe(200);
    expect(String(pm.$queryRaw.mock.calls[0][0])).toContain("dm_lp_variants");
    expect(pm.dmLpVariantMedia.deleteMany.mock.calls[0][0].where).toEqual({ lpVariantId: "lp1" });
    const rows = pm.dmLpVariantMedia.createMany.mock.calls[0][0].data;
    expect(rows).toEqual([
      { lpVariantId: "lp1", slot: "hero", heading: null, assetId: U1, figureKind: null, sortOrder: 0 },
      { lpVariantId: "lp1", slot: "section", heading: "売却の進め方", assetId: null, figureKind: "sale_flow", sortOrder: 0 },
      { lpVariantId: "lp1", slot: "section", heading: "費用について", assetId: U2, figureKind: null, sortOrder: 1 },
    ]);
    expect(writeAuditLog.mock.calls[0][0]).toMatchObject({ action: "sale_dm_lp_media_update", detail: { campaignId: "c1", assetCount: 2, figureCount: 1 } });
    expect(JSON.stringify(writeAuditLog.mock.calls[0][0].detail)).not.toContain("売却の進め方");
  });
  it("凍結済み(確定/送付あり または 凍結印)は初期化でも 409 VARIANT_FROZEN", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(1);
    let r = await put(okPlan);
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("VARIANT_FROZEN");
    pm.dmRecipientDraft.count.mockResolvedValue(0);
    pm.dmLpVariant.findFirst.mockResolvedValue(variant({ templateFrozenAt: new Date() }));
    r = await put(okPlan);
    expect(r.status).toBe(409);
    expect(pm.dmLpVariantMedia.deleteMany).not.toHaveBeenCalled();
  });
  it("本文に無い小見出しは 400 INVALID_MEDIA_PLAN、削除済みの写真は 422 ASSET_NOT_FOUND", async () => {
    let r = await put({ hero: null, sections: [{ heading: "無い", media: null }] });
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("INVALID_MEDIA_PLAN");
    pm.dmLpAsset.findMany.mockResolvedValue([{ id: U1 }]);
    r = await put(okPlan);
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe("ASSET_NOT_FOUND");
    expect(pm.dmLpVariantMedia.deleteMany).not.toHaveBeenCalled();
  });
  it("field_staff は担当外の宛先を含むLP型に写真を付けられない(送付済みも対象・物件行をロックして読み直す)", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: "u9", role: "field_staff" });
    pm.dmRecipientDraft.findMany.mockResolvedValue([{ propertyId: "p1" }, { propertyId: "p2" }]);
    pm.property.findMany.mockResolvedValue([{ id: "p1" }]);
    const r = await put(okPlan);
    expect(r.status).toBe(403);
    expect(pm.dmRecipientDraft.findMany.mock.calls[0][0].where).toEqual({ campaignId: "c1", lpVariantId: "lp1" });
    expect(String(pm.$queryRaw.mock.calls[1][0])).toContain("properties");
  });
  it("文章が未保存(本文なし)のLP型には枠を付けられない", async () => {
    pm.dmLpVariant.findFirst.mockResolvedValue(variant({ bodyText: null }));
    const r = await put({ hero: { assetId: U1 }, sections: [] });
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("TEMPLATE_MISSING");
  });
});

describe("GET image-prompt", () => {
  const q = (qs: string) => PROMPT(new Request(`http://x/?${qs}`) as never, ctx);
  it("ヒーロー用: 訴求と要旨から組み立て、監査に slot だけ残す。所有者情報は出ない", async () => {
    const j = await (await q("slot=hero&style=photo")).json();
    expect(j.prompt).toContain("16:9");
    expect(j.prompt).toContain("相続");
    expect(j.prompt).not.toContain("{{");
    expect(writeAuditLog.mock.calls[0][0]).toMatchObject({ action: "sale_dm_lp_image_prompt_view", detail: { campaignId: "c1", slot: "hero" } });
    expect(JSON.stringify(writeAuditLog.mock.calls[0][0].detail)).not.toContain("prompt");
  });
  it("節用: 本文に無い小見出しは 400 HEADING_NOT_FOUND", async () => {
    expect((await q("slot=section&heading=" + encodeURIComponent("費用について"))).status).toBe(200);
    const r = await q("slot=section&heading=" + encodeURIComponent("無い"));
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("HEADING_NOT_FOUND");
  });
});
```

貼り直しの引き継ぎ(既存の template route テストへ追記。ファイルが無ければ上のテストの末尾に同じ mock で置く):

```ts
describe("template PUT: 貼り直しで小見出しが変わると枠を引き継ぐ", () => {
  it("同じ見出しの行は残し、消えた見出しの行は落とし、mediaDropped に数える", async () => {
    // 既存の節: 「売却の進め方」(図)・「費用について」(写真)。新本文には「費用について」だけ残る。
    pm.dmLpVariantMedia.findMany.mockResolvedValue([
      { heading: "売却の進め方", assetId: null, figureKind: "sale_flow" },
      { heading: "費用について", assetId: U2, figureKind: null },
    ]);
    // 既存テストの流儀で rawTemplate / promptDigest / baseBodyDigest を揃え、本文を
    // 「【見出し】…【本文】■費用について…」だけにして PUT する。
    // 期待:
    //   deleteMany の where は { lpVariantId: "lp1", slot: "section" }(ヒーロー行は触らない)
    //   createMany は [{ lpVariantId:"lp1", slot:"section", heading:"費用について", assetId:U2, figureKind:null, sortOrder:0 }] のみ
    //   応答 parts.mediaDropped === 1
  });
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-media-route.test.ts` → FAIL

- [ ] **Step 3: `media/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess, requireSaleDmWriteAccess, assertSaleDmCampaignOwned } from "@/lib/sale-dm-letter/route-guard";
import { SETTLED_DRAFT_STATUSES, isVariantFrozen } from "@/lib/sale-dm-letter/freeze";
import { lpBodyHeadings } from "@/lib/sale-dm-letter/lp-template";
import { isFigureKind } from "@/lib/sale-dm-letter/lp-figures";
import { validateMediaPlan, mediaPlanIssueMessage, referencedAssetIds, type MediaPlan } from "@/lib/sale-dm-letter/lp-media";
import { saleDmLpMediaPutSchema } from "@/lib/validators-sale-dm";

type Ctx = { params: Promise<{ id: string; lpId: string }> };
type MediaRow = { slot: string; heading: string | null; assetId: string | null; figureKind: string | null; sortOrder: number };

const ASSET_SELECT = { id: true, publicId: true, mime: true, width: true, height: true, bytes: true, label: true, createdAt: true, _count: { select: { media: true } } } as const;

/** DB行 → 枠。節は本文の小見出し順に並べ、行が無い節は media:null。 */
export function rowsToPlan(rows: MediaRow[], headings: string[]): MediaPlan {
  const hero = rows.find((r) => r.slot === "hero" && r.assetId);
  const byHeading = new Map(rows.filter((r) => r.slot === "section" && r.heading).map((r) => [r.heading as string, r] as const));
  return {
    hero: hero ? { assetId: hero.assetId as string } : null,
    sections: headings.map((heading) => {
      const r = byHeading.get(heading);
      const media = !r ? null : r.assetId ? { kind: "asset" as const, assetId: r.assetId } : r.figureKind && isFigureKind(r.figureKind) ? { kind: "figure" as const, figureKind: r.figureKind } : null;
      return { heading, media };
    }),
  };
}

/** 枠 → DB行(media:null の節は行を作らない)。 */
export function planToRows(lpVariantId: string, plan: MediaPlan): Prisma.DmLpVariantMediaCreateManyInput[] {
  const rows: Prisma.DmLpVariantMediaCreateManyInput[] = [];
  if (plan.hero) rows.push({ lpVariantId, slot: "hero", heading: null, assetId: plan.hero.assetId, figureKind: null, sortOrder: 0 });
  plan.sections.forEach((s, i) => {
    if (!s.media) return;
    rows.push({
      lpVariantId,
      slot: "section",
      heading: s.heading,
      assetId: s.media.kind === "asset" ? s.media.assetId : null,
      figureKind: s.media.kind === "figure" ? s.media.figureKind : null,
      sortOrder: i,
    });
  });
  return rows;
}

async function listAssets() {
  const rows = await prisma.dmLpAsset.findMany({ where: { deletedAt: null }, orderBy: { createdAt: "desc" }, select: ASSET_SELECT });
  return rows.map(({ _count, ...a }) => ({ ...a, referenced: _count.media > 0 }));
}

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id, lpId } = await params;
    await assertSaleDmCampaignOwned(id, session.id);
    const v = await prisma.dmLpVariant.findFirst({ where: { id: lpId, campaignId: id }, select: { id: true, bodyText: true, templateFrozenAt: true } });
    if (!v) throw new ApiError(404, "指定されたLP型が見つかりません", "LP_VARIANT_NOT_FOUND");
    const [rows, settledCount, assets] = await Promise.all([
      prisma.dmLpVariantMedia.findMany({ where: { lpVariantId: lpId }, orderBy: { sortOrder: "asc" }, select: { slot: true, heading: true, assetId: true, figureKind: true, sortOrder: true } }),
      prisma.dmRecipientDraft.count({ where: { campaignId: id, lpVariantId: lpId, status: { in: [...SETTLED_DRAFT_STATUSES] } } }),
      listAssets(),
    ]);
    const headings = lpBodyHeadings(v.bodyText ?? "");
    return NextResponse.json(
      { plan: rowsToPlan(rows, headings), headings, frozen: isVariantFrozen({ templateFrozenAt: v.templateFrozenAt, settledCount }), assets },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * 枠の保存(設計 §2.3/§2.8)。template route と同じ順序: dm_lp_variants FOR UPDATE → 凍結なら 409
 * (写真図は初期化の例外なし=送付後は一切変えない)→ 本文の小見出しと照合 → 写真の実在 →
 * 担当範囲(field_staff は物件親行をロックして読み直す。送付済み宛先も含める=template と同じ理由)→ 行を入れ替え。
 */
export async function PUT(request: NextRequest, { params }: Ctx) {
  try {
    const { session } = await requireSaleDmWriteAccess();
    const { id, lpId } = await params;
    await assertSaleDmCampaignOwned(id, session.id);
    const plan = saleDmLpMediaPutSchema.parse(await parseJsonBody(request)) as MediaPlan;

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM dm_lp_variants WHERE id = ${lpId}::uuid AND campaign_id = ${id}::uuid FOR UPDATE`;
      const v = await tx.dmLpVariant.findFirst({ where: { id: lpId, campaignId: id }, select: { id: true, bodyText: true, templateFrozenAt: true } });
      if (!v) throw new ApiError(404, "指定されたLP型が見つかりません", "LP_VARIANT_NOT_FOUND");
      if (!v.bodyText || v.bodyText.trim().length === 0) {
        throw new ApiError(409, "先に文章を保存してください(写真や図は本文の小見出しに付けます)", "TEMPLATE_MISSING");
      }
      const settledCount = await tx.dmRecipientDraft.count({ where: { campaignId: id, lpVariantId: lpId, status: { in: [...SETTLED_DRAFT_STATUSES] } } });
      if (isVariantFrozen({ templateFrozenAt: v.templateFrozenAt, settledCount })) {
        throw new ApiError(409, "送付実績のあるLP型の写真や図は変更できません。変えるときは新しいLP型を追加してください", "VARIANT_FROZEN");
      }
      const headings = lpBodyHeadings(v.bodyText);
      const issue = validateMediaPlan(plan, headings);
      if (issue) throw new ApiError(400, mediaPlanIssueMessage(issue), "INVALID_MEDIA_PLAN");
      const assetIds = referencedAssetIds(plan);
      if (assetIds.length > 0) {
        const found = await tx.dmLpAsset.findMany({ where: { id: { in: assetIds }, deletedAt: null }, select: { id: true } });
        if (found.length !== assetIds.length) throw new ApiError(422, "選んだ写真の一部が削除されています。選び直してください", "ASSET_NOT_FOUND");
      }
      if (session.role === "field_staff") {
        const targets = await tx.dmRecipientDraft.findMany({ where: { campaignId: id, lpVariantId: lpId }, select: { propertyId: true } });
        const propertyIds = [...new Set(targets.map((d) => d.propertyId))].sort();
        if (propertyIds.length > 0) {
          await tx.$queryRaw`SELECT id FROM properties WHERE id = ANY(${propertyIds}::uuid[]) ORDER BY id FOR UPDATE`;
          const visible = await tx.property.findMany({ where: { id: { in: propertyIds }, OR: [{ createdBy: session.id }, { assignedTo: session.id }] }, select: { id: true } });
          if (visible.length !== propertyIds.length) throw new ApiError(403, "担当外の宛先を含むLP型は写真や図を変更できません", "FORBIDDEN");
        }
      }
      const rows = planToRows(lpId, plan);
      await tx.dmLpVariantMedia.deleteMany({ where: { lpVariantId: lpId } });
      if (rows.length > 0) await tx.dmLpVariantMedia.createMany({ data: rows });
      return { headings, assetCount: assetIds.length, figureCount: rows.filter((r) => r.figureKind).length };
    });

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_lp_media_update",
      targetTable: "dm_lp_variants",
      targetId: lpId,
      // 非PII: 件数と日時のみ(見出し・ラベルは残さない)。
      detail: { campaignId: id, assetCount: result.assetCount, figureCount: result.figureCount, updatedAt: new Date().toISOString() },
    });
    return NextResponse.json({ plan, assetCount: result.assetCount, figureCount: result.figureCount }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: `image-prompt/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess, assertSaleDmCampaignOwned } from "@/lib/sale-dm-letter/route-guard";
import { lpBodyHeadings } from "@/lib/sale-dm-letter/lp-template";
import { buildImagePrompt } from "@/lib/sale-dm-letter/lp-media";
import { saleDmLpImagePromptQuerySchema } from "@/lib/validators-sale-dm";

/**
 * 生成AI(画像)向けプロンプト(設計 §2.3)。材料は LP型の設定(訴求)・リード文・小見出し・
 * 宛先で最も多い物件種別だけ。所有者名・住所などは構造上渡らない(buildImagePrompt の引数に無い)。
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; lpId: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id, lpId } = await params;
    await assertSaleDmCampaignOwned(id, session.id);
    const url = new URL(request.url);
    const q = saleDmLpImagePromptQuerySchema.parse({
      slot: url.searchParams.get("slot") ?? undefined,
      heading: url.searchParams.get("heading") ?? undefined,
      style: url.searchParams.get("style") ?? undefined,
    });
    const v = await prisma.dmLpVariant.findFirst({ where: { id: lpId, campaignId: id }, select: { appeal: true, lead: true, bodyText: true } });
    if (!v) throw new ApiError(404, "指定されたLP型が見つかりません", "LP_VARIANT_NOT_FOUND");
    if (q.slot === "section") {
      if (!q.heading || !lpBodyHeadings(v.bodyText ?? "").includes(q.heading)) {
        throw new ApiError(400, "その小見出しは本文にありません", "HEADING_NOT_FOUND");
      }
    }
    // 宛先で最も多い種別(種別は文面の差し込みにも使う非PII)。relation 名は schema の DmRecipientDraft.property を確認して合わせる。
    const kinds = await prisma.dmRecipientDraft.findMany({ where: { campaignId: id }, select: { property: { select: { propertyType: true } } }, take: 500 });
    const tally = new Map<string, number>();
    for (const k of kinds) { const t = k.property?.propertyType; if (t) tally.set(t, (tally.get(t) ?? 0) + 1); }
    const propertyKind = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    const prompt = buildImagePrompt({
      slot: q.slot === "hero" ? { kind: "hero" } : { kind: "section", heading: q.heading as string },
      leadSummary: v.lead,
      appeal: v.appeal,
      propertyKind,
      style: q.style,
    });
    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_lp_image_prompt_view",
      targetTable: "dm_lp_variants",
      targetId: lpId,
      detail: { campaignId: id, slot: q.slot, viewedAt: new Date().toISOString() },
    });
    return NextResponse.json({ prompt }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 5: template route の引き継ぎ(`tx.dmLpVariant.update` の直後)**

```ts
      // 写真と図の枠を新しい小見出しに引き継ぐ(設計 §2.3)。見出しの完全一致だけ残し、
      // 消えた見出しの行は落とす。ヒーロー行は本文と無関係なので触らない。
      const oldRows = await tx.dmLpVariantMedia.findMany({
        where: { lpVariantId: lpId, slot: "section" },
        orderBy: { sortOrder: "asc" },
        select: { heading: true, assetId: true, figureKind: true },
      });
      const oldSections = oldRows.map((r) => ({
        heading: r.heading ?? "",
        media: r.assetId ? { kind: "asset" as const, assetId: r.assetId } : r.figureKind && isFigureKind(r.figureKind) ? { kind: "figure" as const, figureKind: r.figureKind } : null,
      }));
      const newHeadings = lpBodyHeadings(parts.body);
      const kept = reconcileSectionMedia(lpBodyHeadings(v.bodyText ?? ""), newHeadings, oldSections);
      const mediaDropped = oldSections.filter((s) => s.media && !newHeadings.includes(s.heading)).length;
      await tx.dmLpVariantMedia.deleteMany({ where: { lpVariantId: lpId, slot: "section" } });
      const keptRows = kept.flatMap((s, i) => s.media ? [{
        lpVariantId: lpId, slot: "section", heading: s.heading,
        assetId: s.media.kind === "asset" ? s.media.assetId : null,
        figureKind: s.media.kind === "figure" ? s.media.figureKind : null,
        sortOrder: i,
      }] : []);
      if (keptRows.length > 0) await tx.dmLpVariantMedia.createMany({ data: keptRows });
```

`select` に `bodyText: true` を追加し、`parts` の戻りに `mediaDropped` を足す。import: `reconcileSectionMedia`(lp-media)・`isFigureKind`(lp-figures)・`lpBodyHeadings`(lp-template)。`src/lib/api-client.ts` の `saveSaleDmLpVariantTemplate` の戻り型 `parts` に `mediaDropped?: number` を追加。

- [ ] **Step 6: 走査テストの登録** — `sale-dm-freeze-guard.test.ts` の EXCEPTIONS に `"src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/media/route.ts": "凍結済みなら 409 で断るため、確定を戻す処理に到達しない"`(走査が `confirmedAt` を書く route だけを対象にするなら不要=実行して落ちた場合のみ)。`sale-dm-lock-order-guard.test.ts` は dm_lp_variants → properties の順なので通るはず。

- [ ] **Step 7: 確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-media-route.test.ts src/lib/__tests__/sale-dm-lp-template-route.test.ts src/lib/__tests__/sale-dm-freeze-guard.test.ts src/lib/__tests__/sale-dm-lock-order-guard.test.ts src/lib/__tests__/sale-dm-write-permission-guard.test.ts && npx tsc --noEmit && npx eslint "src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]"` → PASS(存在しないテストファイル名は外す)

- [ ] **Step 8: Commit**

```bash
git add "src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/media" "src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/image-prompt" "src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/template/route.ts" src/lib/api-client.ts src/lib/__tests__/sale-dm-lp-media-route.test.ts src/lib/__tests__/sale-dm-freeze-guard.test.ts
git commit -m "feat(sale-dm): LP型の写真と図の枠(保存・凍結・担当範囲)と画像プロンプト、貼り直し時の引き継ぎ"
```

---

### Task 9: api-client の関数と、端末側の縮小(長辺1600・JPEG)

**Files:**
- Modify: `src/lib/api-client.ts`(`saveSaleDmLpVariantTemplate` の直後)
- Create: `src/lib/lp-asset-prepare.ts`
- Test: `src/lib/__tests__/lp-asset-prepare.test.ts`

**Interfaces:**
- Consumes: `fitWithinMaxEdge`(`@/lib/field-survey-photo-prepare`)、`MAX_FILE_SIZE`(`@/lib/storage/types`)、型 `SaleDmLpAsset`/`SaleDmLpMediaPlan`/`SaleDmLpMediaResponse`(Task 5)。
- Produces:
  ```ts
  // api-client
  export async function fetchSaleDmLpAssets(): Promise<{ assets: SaleDmLpAsset[] }>;
  export async function uploadSaleDmLpAsset(blob: Blob, fileName: string, label?: string): Promise<{ asset: SaleDmLpAsset }>;
  export async function deleteSaleDmLpAsset(assetId: string): Promise<{ deleted: string }>;
  export async function fetchSaleDmLpMedia(campaignId: string, lpId: string): Promise<SaleDmLpMediaResponse>;
  export async function saveSaleDmLpMedia(campaignId: string, lpId: string, plan: SaleDmLpMediaPlan): Promise<{ plan: SaleDmLpMediaPlan; assetCount: number; figureCount: number }>;
  export async function fetchSaleDmLpImagePrompt(campaignId: string, lpId: string, q: { slot: "hero" | "section"; heading?: string; style?: "photo" | "illustration" | "flat" }): Promise<{ prompt: string }>;
  // lp-asset-prepare
  export const LP_ASSET_MAX_EDGE = 1600;
  export const LP_ASSET_PASS_THROUGH_MIMES: readonly string[];   // jpeg/png/webp
  export type LpAssetAction = "pass" | "convert" | "unsupported";
  export function classifyLpAsset(input: { mime: string; width: number; height: number; size: number }): LpAssetAction;
  export function lpAssetFileName(name: string, action: LpAssetAction): string;   // convert なら拡張子を .jpg
  export type PreparedLpAsset = { ok: true; blob: Blob; fileName: string } | { ok: false; message: string };
  export async function prepareLpAssetForUpload(file: File): Promise<PreparedLpAsset>;   // browser API(createImageBitmap/canvas)は本体のみ
  ```

- [ ] **Step 1: テスト(純関数のみ)**

```ts
// src/lib/__tests__/lp-asset-prepare.test.ts
import { describe, it, expect } from "vitest";
import { classifyLpAsset, lpAssetFileName, LP_ASSET_MAX_EDGE } from "../lp-asset-prepare";

describe("classifyLpAsset", () => {
  it("JPEG/PNG/WebP で長辺1600以下・8MB以下なら無変換", () => {
    expect(classifyLpAsset({ mime: "image/jpeg", width: 1600, height: 900, size: 100 })).toBe("pass");
    expect(classifyLpAsset({ mime: "image/webp", width: 100, height: 1600, size: 100 })).toBe("pass");
  });
  it("長辺が超える・大きすぎる・HEIC は変換", () => {
    expect(classifyLpAsset({ mime: "image/jpeg", width: 1601, height: 900, size: 100 })).toBe("convert");
    expect(classifyLpAsset({ mime: "image/png", width: 100, height: 100, size: 8 * 1024 * 1024 + 1 })).toBe("convert");
    expect(classifyLpAsset({ mime: "image/heic", width: 100, height: 100, size: 100 })).toBe("convert");
  });
  it("画像でないものは unsupported", () => {
    expect(classifyLpAsset({ mime: "application/pdf", width: 0, height: 0, size: 1 })).toBe("unsupported");
    expect(classifyLpAsset({ mime: "", width: 0, height: 0, size: 1 })).toBe("unsupported");
  });
  it("変換時のファイル名は .jpg・pass はそのまま", () => {
    expect(lpAssetFileName("IMG_001.HEIC", "convert")).toBe("IMG_001.jpg");
    expect(lpAssetFileName("a.png", "pass")).toBe("a.png");
    expect(lpAssetFileName("", "convert")).toBe("image.jpg");
    expect(LP_ASSET_MAX_EDGE).toBe(1600);
  });
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/lp-asset-prepare.test.ts` → FAIL

- [ ] **Step 3: `lp-asset-prepare.ts`**

```ts
/**
 * LP用写真の端末側前処理(設計 2026-09-08 §2.3)。
 *  - サーバーは JPEG/PNG/WebP・8MB以下・長辺1600px以下だけ受ける(画像ライブラリを入れない方針)。
 *  - ここで長辺1600に縮小し JPEG(品質0.85)へ再エンコードする。HEIC もここで吸収する。
 *  - canvas 経由で EXIF は消える(サーバーの EXIF strip と二重防御)。
 *  - 判定と名前は純関数(node で検証)。browser API は prepare 本体だけが触る。
 *  - 画像内容・ファイル名を console に出さない。
 */
import { MAX_FILE_SIZE } from "@/lib/storage/types";
import { fitWithinMaxEdge } from "@/lib/field-survey-photo-prepare";

export const LP_ASSET_MAX_EDGE = 1600;
export const LP_ASSET_PASS_THROUGH_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
const JPEG_QUALITY = 0.85;

export type LpAssetAction = "pass" | "convert" | "unsupported";

export function classifyLpAsset(input: { mime: string; width: number; height: number; size: number }): LpAssetAction {
  if (!input.mime.startsWith("image/")) return "unsupported";
  const passMime = (LP_ASSET_PASS_THROUGH_MIMES as readonly string[]).includes(input.mime);
  const fits = Math.max(input.width, input.height) <= LP_ASSET_MAX_EDGE && input.size <= MAX_FILE_SIZE;
  return passMime && fits ? "pass" : "convert";
}

export function lpAssetFileName(name: string, action: LpAssetAction): string {
  if (action !== "convert") return name;
  const base = name.replace(/\.[^.]+$/, "");
  return `${base || "image"}.jpg`;
}

export type PreparedLpAsset = { ok: true; blob: Blob; fileName: string } | { ok: false; message: string };

const UNSUPPORTED = "画像ファイル(JPEG / PNG / WebP / HEIC)を選んでください";
const DECODE_FAILED = "この画像はこの端末では読み込めませんでした。iPhone は「設定 > カメラ > フォーマット > 互換性優先」、Android は HEIF をオフにして撮り直すか、JPEG に変換してからお試しください";

export async function prepareLpAssetForUpload(file: File): Promise<PreparedLpAsset> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    return { ok: false, message: "この端末では画像を処理できません" };
  }
  if (!file.type.startsWith("image/")) return { ok: false, message: UNSUPPORTED };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, message: DECODE_FAILED };
  }
  try {
    const action = classifyLpAsset({ mime: file.type, width: bitmap.width, height: bitmap.height, size: file.size });
    if (action === "unsupported") return { ok: false, message: UNSUPPORTED };
    if (action === "pass") return { ok: true, blob: file, fileName: lpAssetFileName(file.name, "pass") };
    const { width, height } = fitWithinMaxEdge(bitmap.width, bitmap.height, LP_ASSET_MAX_EDGE);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { ok: false, message: "この端末では画像を処理できません" };
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    if (!blob) return { ok: false, message: "画像の変換に失敗しました" };
    if (blob.size > MAX_FILE_SIZE) return { ok: false, message: "縮小しても 8MB を超えます。別の写真をお試しください" };
    return { ok: true, blob, fileName: lpAssetFileName(file.name, "convert") };
  } finally {
    bitmap.close?.();
  }
}
```

- [ ] **Step 4: api-client の関数(`saveSaleDmLpVariantTemplate` の直後)**

`apiFetch` が `FormData` の body を JSON 扱いしないことを `grep -n "FormData\|Content-Type" src/lib/api-client.ts` で確認する(調査ピン写真のアップロード関数が既にある形に合わせる)。JSON ヘッダを固定で付ける実装なら、写真の upload だけ `fetch` 直呼び+同じエラー整形にする。

```ts
// ---- LP用の写真と図(設計 2026-09-08 §2.3)
export async function fetchSaleDmLpAssets() {
  if (USE_MOCK) { await mockDelay(); return { assets: [] as SaleDmLpAsset[] }; }
  return apiFetch<{ assets: SaleDmLpAsset[] }>(`/api/properties/sale-dm/lp-assets`);
}

export async function uploadSaleDmLpAsset(blob: Blob, fileName: string, label?: string) {
  if (USE_MOCK) {
    await mockDelay();
    return { asset: { id: "mock-asset", publicId: "0".repeat(32), mime: "image/jpeg", width: 1, height: 1, bytes: blob.size, label: label ?? null, createdAt: new Date().toISOString(), referenced: false } as SaleDmLpAsset };
  }
  const fd = new FormData();
  fd.append("file", blob, fileName);
  if (label && label.trim()) fd.append("label", label.trim());
  // multipart は Content-Type を付けない(ブラウザが boundary 付きで付ける)。
  return apiFetch<{ asset: SaleDmLpAsset }>(`/api/properties/sale-dm/lp-assets`, { method: "POST", body: fd });
}

export async function deleteSaleDmLpAsset(assetId: string) {
  if (USE_MOCK) { await mockDelay(); return { deleted: assetId }; }
  return apiFetch<{ deleted: string }>(`/api/properties/sale-dm/lp-assets/${assetId}`, { method: "DELETE" });
}

export async function fetchSaleDmLpMedia(campaignId: string, lpId: string) {
  if (USE_MOCK) { await mockDelay(); return { plan: { hero: null, sections: [] }, headings: [], frozen: false, assets: [] } as SaleDmLpMediaResponse; }
  return apiFetch<SaleDmLpMediaResponse>(`/api/properties/sale-dm/campaigns/${campaignId}/lp-variants/${lpId}/media`);
}

export async function saveSaleDmLpMedia(campaignId: string, lpId: string, plan: SaleDmLpMediaPlan) {
  if (USE_MOCK) { await mockDelay(); return { plan, assetCount: 0, figureCount: 0 }; }
  return apiFetch<{ plan: SaleDmLpMediaPlan; assetCount: number; figureCount: number }>(
    `/api/properties/sale-dm/campaigns/${campaignId}/lp-variants/${lpId}/media`,
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(plan) },
  );
}

export async function fetchSaleDmLpImagePrompt(campaignId: string, lpId: string, q: { slot: "hero" | "section"; heading?: string; style?: "photo" | "illustration" | "flat" }) {
  if (USE_MOCK) { await mockDelay(); return { prompt: "（モック）画像プロンプト" }; }
  const p = new URLSearchParams({ slot: q.slot });
  if (q.heading) p.set("heading", q.heading);
  if (q.style) p.set("style", q.style);
  return apiFetch<{ prompt: string }>(`/api/properties/sale-dm/campaigns/${campaignId}/lp-variants/${lpId}/image-prompt?${p.toString()}`);
}
```

- [ ] **Step 5: 確認** — Run: `npx vitest run src/lib/__tests__/lp-asset-prepare.test.ts && npx tsc --noEmit && npx eslint src/lib/lp-asset-prepare.ts src/lib/api-client.ts` → PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/lp-asset-prepare.ts src/lib/__tests__/lp-asset-prepare.test.ts src/lib/api-client.ts
git commit -m "feat(sale-dm): 写真と図の api-client と端末側の縮小(長辺1600・JPEG)"
```

---

### Task 10: 画面(写真ライブラリ・枠パネル・LP型パネルへの組み込み・管理ページ・サイドバー)

**Files:**
- Create: `src/components/sale-dm/lp-media-panel-model.ts`(純関数: 行の組み立て・変更・写真数)
- Create: `src/components/sale-dm/lp-asset-library.tsx`(選択/追加: ファイル選択・ドロップ・**Ctrl+V 貼り付け**)
- Create: `src/components/sale-dm/lp-media-panel.tsx`(ヒーロー1枠+節ごとの枠・図の見本・画像プロンプトのコピー・保存)
- Modify: `src/components/sale-dm/lp-variant-manager.tsx`(LP型ごとに「写真と図」ボタン→パネル)
- Create: `src/app/(dashboard)/admin/lp-assets/page.tsx`(管理者: ライブラリ一覧と削除)
- Modify: `src/components/layout/sidebar-model.tsx:110`(「売却DM設定」の直後に `{ label: "LPの写真", href: "/admin/lp-assets", icon: ic(ImageIcon), minRole: "admin" }`。lucide-react の `Image` を `ImageIcon` として import)
- Test: `src/lib/__tests__/sale-dm-lp-media-panel-model.test.ts`
- Test: `src/lib/__tests__/sale-dm-lp-media-ui-scan.test.ts`(画面ソースの走査: `/uploads/` を書かない・`dangerouslySetInnerHTML` を使わない・写真の `src` は `LP_ASSET_URL(`/`figureDataUrl(` 経由のみ・`onPaste` がある)

**Interfaces:**
- Consumes: Task 9 の api-client 関数・`prepareLpAssetForUpload`、Task 5 の型・`LP_ASSET_URL`、Task 3 の `FIGURE_KINDS`/`FIGURE_LABELS`/`isFigureKind`/`renderFigureSvg`、Task 4 の `LP_MEDIA_MAX_ASSETS`、`ModalShell`/`ConfirmDialog`/`Button`/`PageHeader`(`@/components/ui/*`)。
- Produces:
  ```ts
  // lp-media-panel-model.ts
  export type SlotChoice = { kind: "none" } | { kind: "asset"; assetId: string } | { kind: "figure"; figureKind: string };
  export function choiceFromMedia(m: SaleDmLpMediaRef | null): SlotChoice;
  export function mediaFromChoice(c: SlotChoice): SaleDmLpMediaRef | null;
  export function setSectionChoice(plan: SaleDmLpMediaPlan, heading: string, c: SlotChoice): SaleDmLpMediaPlan;
  export function setHero(plan: SaleDmLpMediaPlan, assetId: string | null): SaleDmLpMediaPlan;
  export function assetCountOf(plan: SaleDmLpMediaPlan): number;   // 重複なし
  export function figureDataUrl(kind: FigureKind): string;         // "data:image/svg+xml;charset=utf-8," + encodeURIComponent(renderFigureSvg(kind))
  export function isPlanDirty(saved: SaleDmLpMediaPlan, current: SaleDmLpMediaPlan): boolean;
  ```
  - `LpAssetLibrary` props: `{ open: boolean; onClose: () => void; onPick: (asset: SaleDmLpAsset) => void; assets: SaleDmLpAsset[]; onAssetsChanged: () => void }`。ライブラリは `ModalShell`。貼り付けは modal のルート要素の `onPaste`(`e.clipboardData.files` の `image/*`)。追加した写真は `prepareLpAssetForUpload` → `uploadSaleDmLpAsset` → `onAssetsChanged()`。
  - `LpMediaPanel` props: `{ campaignId: string; lpId: string; label: string; onClose: () => void }`。開いたら `fetchSaleDmLpMedia`。`frozen` なら読み取り専用(保存ボタン非表示・説明文)。各枠のプロンプトは `fetchSaleDmLpImagePrompt` → `navigator.clipboard.writeText`。
  - 画像の表示は `<img src={LP_ASSET_URL(asset.publicId)} …>`。⚠ライブラリに入れただけ(未参照)の写真は公開口が404を返すので、**未参照の写真の見本は保存されるまで出ない**。端末の objectURL も使わない(他の端末では見えず、見え方が端末で変わるため)。→ ルール: 未参照の写真は「ラベル・寸法」の**文字カードで表示**し、`referenced` の写真だけ `<img>`。保存後に再取得して差し替える。文言:「LP型に付けて保存すると見本が出ます」。

- [ ] **Step 1: テスト(純関数と走査)**

```ts
// src/lib/__tests__/sale-dm-lp-media-panel-model.test.ts
import { describe, it, expect } from "vitest";
import { choiceFromMedia, mediaFromChoice, setSectionChoice, setHero, assetCountOf, figureDataUrl, isPlanDirty } from "../../components/sale-dm/lp-media-panel-model";
import type { SaleDmLpMediaPlan } from "../api-client";

const plan: SaleDmLpMediaPlan = { hero: { assetId: "a1" }, sections: [{ heading: "h1", media: null }, { heading: "h2", media: { kind: "asset", assetId: "a1" } }] };

describe("lp-media-panel-model", () => {
  it("枠の値と選択肢を相互変換する", () => {
    expect(choiceFromMedia(null)).toEqual({ kind: "none" });
    expect(choiceFromMedia({ kind: "figure", figureKind: "sale_flow" })).toEqual({ kind: "figure", figureKind: "sale_flow" });
    expect(mediaFromChoice({ kind: "none" })).toBeNull();
    expect(mediaFromChoice({ kind: "asset", assetId: "x" })).toEqual({ kind: "asset", assetId: "x" });
  });
  it("節の変更は元を壊さず、その見出しだけ変える", () => {
    const next = setSectionChoice(plan, "h1", { kind: "figure", figureKind: "vacant_burden" });
    expect(next.sections[0].media).toEqual({ kind: "figure", figureKind: "vacant_burden" });
    expect(next.sections[1]).toEqual(plan.sections[1]);
    expect(plan.sections[0].media).toBeNull();
  });
  it("ヒーローの差し替え/解除・写真数は重複なし", () => {
    expect(setHero(plan, null).hero).toBeNull();
    expect(setHero(plan, "a2").hero).toEqual({ assetId: "a2" });
    expect(assetCountOf(plan)).toBe(1);
    expect(assetCountOf(setHero(plan, "a2"))).toBe(2);
  });
  it("図の見本は data URL の SVG(外部参照なし)", () => {
    const u = figureDataUrl("sale_flow");
    expect(u.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(u.slice(u.indexOf(",") + 1))).toContain("<svg");
    expect(u).not.toContain("http");
  });
  it("変更の有無", () => {
    expect(isPlanDirty(plan, { ...plan })).toBe(false);
    expect(isPlanDirty(plan, setHero(plan, null))).toBe(true);
  });
});
```

```ts
// src/lib/__tests__/sale-dm-lp-media-ui-scan.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const FILES = [
  "src/components/sale-dm/lp-asset-library.tsx",
  "src/components/sale-dm/lp-media-panel.tsx",
  "src/app/(dashboard)/admin/lp-assets/page.tsx",
].map((f) => [f, readFileSync(path.resolve(process.cwd(), f), "utf8").replace(/\r\n/g, "\n")] as const);

describe("LP写真の画面: 公開口だけを使い、生HTMLを流し込まない", () => {
  for (const [f, src] of FILES) {
    it(`${f}: /uploads/ を書かない・dangerouslySetInnerHTML を使わない・img src は LP_ASSET_URL か figureDataUrl 経由`, () => {
      expect(src).not.toContain("/uploads/");
      expect(src).not.toContain("dangerouslySetInnerHTML");
      const imgs = [...src.matchAll(/<img[^>]*\bsrc=\{([^}]+)\}/g)];
      expect(imgs.length).toBeGreaterThan(0);
      for (const m of imgs) expect(m[1]).toMatch(/LP_ASSET_URL\(|figureDataUrl\(/);
    });
  }
  it("ライブラリは貼り付け(Ctrl+V)とドロップを受け、端末側で縮小してから送る", () => {
    const src = FILES[0][1];
    expect(src).toContain("onPaste");
    expect(src).toContain("onDrop");
    expect(src).toContain("prepareLpAssetForUpload(");
  });
  it("サイドバーに管理者向け「LPの写真」がある", () => {
    const side = readFileSync(path.resolve(process.cwd(), "src/components/layout/sidebar-model.tsx"), "utf8");
    expect(side).toMatch(/href:\s*"\/admin\/lp-assets"[^}]*minRole:\s*"admin"/);
  });
});
```

- [ ] **Step 2: 落ちることを確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-media-panel-model.test.ts src/lib/__tests__/sale-dm-lp-media-ui-scan.test.ts` → FAIL

- [ ] **Step 3: `lp-media-panel-model.ts`**

```ts
import type { SaleDmLpMediaPlan, SaleDmLpMediaRef } from "@/lib/api-client";
import { renderFigureSvg, type FigureKind } from "@/lib/sale-dm-letter/lp-figures";

export type SlotChoice = { kind: "none" } | { kind: "asset"; assetId: string } | { kind: "figure"; figureKind: string };

export function choiceFromMedia(m: SaleDmLpMediaRef | null): SlotChoice {
  return m ?? { kind: "none" };
}
export function mediaFromChoice(c: SlotChoice): SaleDmLpMediaRef | null {
  return c.kind === "none" ? null : c;
}
export function setSectionChoice(plan: SaleDmLpMediaPlan, heading: string, c: SlotChoice): SaleDmLpMediaPlan {
  return { ...plan, sections: plan.sections.map((s) => (s.heading === heading ? { heading, media: mediaFromChoice(c) } : s)) };
}
export function setHero(plan: SaleDmLpMediaPlan, assetId: string | null): SaleDmLpMediaPlan {
  return { ...plan, hero: assetId ? { assetId } : null };
}
export function assetCountOf(plan: SaleDmLpMediaPlan): number {
  const ids = new Set<string>();
  if (plan.hero) ids.add(plan.hero.assetId);
  for (const s of plan.sections) if (s.media?.kind === "asset") ids.add(s.media.assetId);
  return ids.size;
}
export function figureDataUrl(kind: FigureKind): string {
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(renderFigureSvg(kind));
}
export function isPlanDirty(saved: SaleDmLpMediaPlan, current: SaleDmLpMediaPlan): boolean {
  return JSON.stringify(saved) !== JSON.stringify(current);
}
```

- [ ] **Step 4: `lp-asset-library.tsx`**

```tsx
"use client";

import { useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { Loader2, Upload, ImagePlus } from "lucide-react";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import { uploadSaleDmLpAsset, LP_ASSET_URL, type SaleDmLpAsset } from "@/lib/api-client";
import { prepareLpAssetForUpload } from "@/lib/lp-asset-prepare";

/**
 * LP用の写真ライブラリ(全キャンペーン共通・設計 §2.3)。
 *  選ぶ: 一覧から1枚。追加: ファイル選択 / ドロップ / Ctrl+V 貼り付け(画像をコピーしてこの窓で貼る)。
 *  見本: どこかのLP型に付いて保存された写真だけ画像が出る(公開口は参照中しか返さない)。
 *  それまでは文字カード(寸法とラベル)。
 */
export default function LpAssetLibrary({ open, onClose, onPick, assets, onAssetsChanged }: {
  open: boolean; onClose: () => void; onPick: (asset: SaleDmLpAsset) => void; assets: SaleDmLpAsset[]; onAssetsChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) { setError("画像ファイルを選んでください"); return; }
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      for (const f of images.slice(0, 5)) {
        const prepared = await prepareLpAssetForUpload(f);
        if (!prepared.ok) { setError(prepared.message); continue; }
        await uploadSaleDmLpAsset(prepared.blob, prepared.fileName, label || undefined);
      }
      setLabel("");
      onAssetsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "写真を追加できませんでした");
    } finally {
      setBusy(false);
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    void addFiles(files);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    void addFiles(Array.from(e.dataTransfer?.files ?? []));
  };

  if (!open) return null;
  return (
    <ModalShell title="LPの写真" onClose={onClose}>
      <div tabIndex={0} onPaste={onPaste} onDrop={onDrop} onDragOver={(e) => e.preventDefault()} className="space-y-3 outline-none">
        <div className="rounded-md border border-dashed border-gray-300 bg-gray-50 p-3 text-xs text-gray-600">
          <p>写真をここに<strong>貼り付け(Ctrl+V)</strong>するか、ドラッグして置くか、「ファイルを選ぶ」で追加します。JPEG / PNG / WebP / HEIC。大きい写真は自動で縮小されます(長辺1600px)。</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="ラベル(任意・例: 会社の外観)" className="rounded border border-gray-300 px-2 py-1 text-xs" />
            <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} ファイルを選ぶ
            </Button>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
          </div>
          {error && <p className="mt-2 text-red-600">{error}</p>}
        </div>
        {assets.length === 0 ? (
          <p className="text-xs text-gray-500">まだ写真がありません。</p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {assets.map((a) => (
              <li key={a.id}>
                <button type="button" onClick={() => onPick(a)} className="block w-full overflow-hidden rounded-md border border-gray-200 text-left hover:border-indigo-400">
                  {a.referenced ? (
                    <img src={LP_ASSET_URL(a.publicId)} alt={a.label ?? "写真"} width={a.width} height={a.height} className="aspect-video w-full object-cover" loading="lazy" />
                  ) : (
                    <div className="flex aspect-video w-full flex-col items-center justify-center bg-gray-100 text-gray-500"><ImagePlus className="h-5 w-5" /><span className="mt-1 text-[10px]">LP型に付けて保存すると見本が出ます</span></div>
                  )}
                  <div className="truncate px-2 py-1 text-[11px] text-gray-700">{a.label ?? "(ラベルなし)"} · {a.width}×{a.height}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </ModalShell>
  );
}
```

`ModalShell` の props は `src/components/ui/modal-shell.tsx:28-46` を読んで実際の名前(`title`/`onClose`/幅の指定)に合わせる。

- [ ] **Step 5: `lp-media-panel.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { Loader2, Copy, Image as ImageIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  fetchSaleDmLpMedia, saveSaleDmLpMedia, fetchSaleDmLpImagePrompt, fetchSaleDmLpAssets, LP_ASSET_URL,
  type SaleDmLpAsset, type SaleDmLpMediaPlan, type SaleDmLpMediaResponse,
} from "@/lib/api-client";
import { FIGURE_KINDS, FIGURE_LABELS, isFigureKind } from "@/lib/sale-dm-letter/lp-figures";
import { LP_MEDIA_MAX_ASSETS } from "@/lib/sale-dm-letter/lp-media";
import { choiceFromMedia, setSectionChoice, setHero, assetCountOf, figureDataUrl, isPlanDirty, type SlotChoice } from "./lp-media-panel-model";
import LpAssetLibrary from "./lp-asset-library";

type Style = "photo" | "illustration" | "flat";
type Slot = { kind: "hero" } | { kind: "section"; heading: string };

/** LP型1件の「写真と図」(設計 §2.3)。ヒーロー1枠+小見出しごとの枠。凍結中は読むだけ。 */
export default function LpMediaPanel({ campaignId, lpId, label, onClose }: { campaignId: string; lpId: string; label: string; onClose: () => void }) {
  const [data, setData] = useState<SaleDmLpMediaResponse | null>(null);
  const [plan, setPlan] = useState<SaleDmLpMediaPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState<Slot | null>(null);
  const [style, setStyle] = useState<Style>("photo");

  useEffect(() => {
    let alive = true;
    setError(null);
    fetchSaleDmLpMedia(campaignId, lpId)
      .then((d) => { if (alive) { setData(d); setPlan(d.plan); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : "読み込みに失敗しました"); });
    return () => { alive = false; };
  }, [campaignId, lpId]);

  const reload = async () => {
    const d = await fetchSaleDmLpMedia(campaignId, lpId);
    setData(d);
    setPlan(d.plan);
  };
  const assetById = (id: string): SaleDmLpAsset | undefined => data?.assets.find((a) => a.id === id);
  const refreshAssets = async () => {
    const r = await fetchSaleDmLpAssets();
    setData((d) => (d ? { ...d, assets: r.assets } : d));
  };
  const pick = (a: SaleDmLpAsset) => {
    if (!plan || !picking) return;
    const next = picking.kind === "hero" ? setHero(plan, a.id) : setSectionChoice(plan, picking.heading, { kind: "asset", assetId: a.id });
    if (assetCountOf(next) > LP_MEDIA_MAX_ASSETS) { setError(`写真は ${LP_MEDIA_MAX_ASSETS} 枚までです`); setPicking(null); return; }
    setPlan(next);
    setPicking(null);
  };
  const save = async () => {
    if (!plan || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await saveSaleDmLpMedia(campaignId, lpId, plan);
      setNotice(`保存しました(写真 ${r.assetCount} 枚・図 ${r.figureCount} 点)`);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally { setBusy(false); }
  };
  const copyPrompt = async (slot: Slot) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const r = await fetchSaleDmLpImagePrompt(campaignId, lpId, { slot: slot.kind, heading: slot.kind === "section" ? slot.heading : undefined, style });
      await navigator.clipboard.writeText(r.prompt);
      setNotice("画像の指示文をコピーしました。お手元の画像生成AIに貼り付け、できた画像をこの画面の「写真を選ぶ…」で貼り付け(Ctrl+V)てください");
    } catch (e) {
      setError(e instanceof Error ? e.message : "指示文を取得できませんでした");
    } finally { setBusy(false); }
  };

  const thumb = (assetId: string) => {
    const a = assetById(assetId);
    if (!a) return <span className="text-red-600">(削除された写真)</span>;
    return a.referenced
      ? <img src={LP_ASSET_URL(a.publicId)} alt={a.label ?? "写真"} width={a.width} height={a.height} className="h-16 w-28 rounded object-cover" />
      : <span className="inline-flex h-16 w-28 items-center justify-center rounded bg-gray-100 text-center text-[10px] text-gray-500">{a.label ?? "写真"}(保存後に見本)</span>;
  };
  const sectionChoice = (heading: string, choice: SlotChoice) => (
    <div className="flex flex-wrap items-center gap-2">
      <select value={choice.kind === "figure" ? `figure:${choice.figureKind}` : choice.kind} disabled={!!data?.frozen || busy}
        onChange={(e) => {
          if (!plan) return;
          const v = e.target.value;
          if (v === "none") setPlan(setSectionChoice(plan, heading, { kind: "none" }));
          else if (v === "asset") setPicking({ kind: "section", heading });
          else if (v.startsWith("figure:") && isFigureKind(v.slice(7))) setPlan(setSectionChoice(plan, heading, { kind: "figure", figureKind: v.slice(7) }));
        }}
        className="rounded border border-gray-300 px-2 py-1 text-xs">
        <option value="none">なし</option>
        <option value="asset">写真を選ぶ…</option>
        {FIGURE_KINDS.map((k) => <option key={k} value={`figure:${k}`}>図: {FIGURE_LABELS[k]}</option>)}
      </select>
      {choice.kind === "asset" && thumb(choice.assetId)}
      {choice.kind === "figure" && isFigureKind(choice.figureKind) && <img src={figureDataUrl(choice.figureKind)} alt={FIGURE_LABELS[choice.figureKind]} width={640} height={360} className="h-16 w-28 rounded border border-gray-200 object-contain" />}
      {!data?.frozen && <button type="button" onClick={() => void copyPrompt({ kind: "section", heading })} disabled={busy} className="inline-flex items-center gap-1 text-indigo-700 hover:underline disabled:opacity-50"><Copy className="h-3 w-3" />画像の指示文</button>}
    </div>
  );

  return (
    <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50/40 p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium text-gray-700"><ImageIcon className="mr-1 inline h-3.5 w-3.5" />「{label}」の写真と図</span>
        <button type="button" onClick={onClose} className="text-gray-500 hover:underline"><X className="inline h-3 w-3" /> 閉じる</button>
      </div>
      {!data || !plan ? (
        error ? <p className="mt-2 text-red-600">{error}</p> : <p className="mt-2 text-gray-500"><Loader2 className="inline h-3 w-3 animate-spin" /> 読み込み中</p>
      ) : (
        <>
          {data.frozen && <p className="mt-2 rounded bg-amber-50 px-2 py-1.5 text-amber-800">このLP型はすでに送付の実績があるため、写真と図は変更できません。変えるときは新しいLP型を追加してください。</p>}
          {data.headings.length === 0 && <p className="mt-2 text-gray-600">先に文章を保存してください(写真や図は本文の小見出しに付けます)。</p>}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-gray-600">画像の指示文の画風:</span>
            {(["photo", "illustration", "flat"] as const).map((s) => (
              <label key={s} className="inline-flex items-center gap-1"><input type="radio" name="lp-style" checked={style === s} onChange={() => setStyle(s)} />{s === "photo" ? "写真風" : s === "illustration" ? "イラスト風" : "図解"}</label>
            ))}
          </div>
          <div className="mt-2 rounded border border-gray-200 bg-white p-2">
            <div className="font-medium text-gray-700">一番上の写真(ヒーロー)</div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {plan.hero ? thumb(plan.hero.assetId) : <span className="text-gray-500">なし</span>}
              {!data.frozen && (
                <>
                  <button type="button" onClick={() => setPicking({ kind: "hero" })} disabled={busy} className="text-indigo-700 hover:underline disabled:opacity-50">写真を選ぶ…</button>
                  {plan.hero && <button type="button" onClick={() => setPlan(setHero(plan, null))} disabled={busy} className="text-gray-600 hover:underline">外す</button>}
                  <button type="button" onClick={() => void copyPrompt({ kind: "hero" })} disabled={busy} className="inline-flex items-center gap-1 text-indigo-700 hover:underline disabled:opacity-50"><Copy className="h-3 w-3" />画像の指示文</button>
                </>
              )}
            </div>
          </div>
          {plan.sections.map((s) => (
            <div key={s.heading} className="mt-2 rounded border border-gray-200 bg-white p-2">
              <div className="font-medium text-gray-700">■ {s.heading}</div>
              <div className="mt-1">{sectionChoice(s.heading, choiceFromMedia(s.media))}</div>
            </div>
          ))}
          <div className="mt-2 flex items-center justify-between">
            <span className="text-gray-500">写真 {assetCountOf(plan)} / {LP_MEDIA_MAX_ASSETS} 枚</span>
            {!data.frozen && (
              <Button type="button" size="sm" onClick={() => void save()} disabled={busy || !isPlanDirty(data.plan, plan)}>
                {busy && <Loader2 className="h-3 w-3 animate-spin" />} 写真と図を保存
              </Button>
            )}
          </div>
          {notice && <p className="mt-2 rounded bg-white px-2 py-1.5 text-gray-700">{notice}</p>}
          {error && <p className="mt-2 text-red-600">{error}</p>}
          <LpAssetLibrary open={picking !== null} onClose={() => setPicking(null)} onPick={pick} assets={data.assets} onAssetsChanged={() => void refreshAssets()} />
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 6: `lp-variant-manager.tsx` への組み込み**

- import に `import LpMediaPanel from "./lp-media-panel";` と lucide-react の `Image as ImageIcon` を追加。
- state に `const [mediaFor, setMediaFor] = useState<SaleDmLpVariant | null>(null);`。
- LP型の各行の操作ボタン(「文章」ボタンの隣)に:
  ```tsx
  <button type="button" onClick={() => { setLetterFor(null); setLetter(null); setMediaFor(v); }} disabled={busy || !v.headline} title={v.headline ? "写真と図" : "先に文章を保存してください"} className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-0.5 text-gray-700 hover:bg-gray-50 disabled:opacity-50"><ImageIcon className="h-3.5 w-3.5" />写真と図</button>
  ```
  (`headline` が null = 文章未保存。`SaleDmLpVariant` に `headline` が無ければ api-client の型と campaign GET の select を確認して足す)
- 文章パネル(`{letterFor && letter && (…)}`)の直後に: `{mediaFor && <LpMediaPanel campaignId={campaign.id} lpId={mediaFor.id} label={mediaFor.label} onClose={() => setMediaFor(null)} />}`。
- `openLetter` の冒頭で `setMediaFor(null)`(2つのパネルを同時に開かない)。
- 文章の保存(`saveTemplate`)の通知に、`r.parts?.mediaDropped` が 1 以上なら `・小見出しが変わったため写真や図を外した節 ${r.parts.mediaDropped}` を足す。

- [ ] **Step 7: 管理ページ `admin/lp-assets/page.tsx` とサイドバー**

```tsx
"use client";

import { useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { fetchSaleDmLpAssets, deleteSaleDmLpAsset, LP_ASSET_URL, type SaleDmLpAsset } from "@/lib/api-client";

/** LP用写真ライブラリの管理(管理者)。追加は売却DMの各LP型の「写真と図」から。ここは一覧と削除だけ。 */
export default function AdminLpAssetsPage() {
  const [assets, setAssets] = useState<SaleDmLpAsset[] | null>(null);
  const [target, setTarget] = useState<SaleDmLpAsset | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try { setAssets((await fetchSaleDmLpAssets()).assets); }
    catch (e) { setError(e instanceof Error ? e.message : "読み込みに失敗しました"); }
  };
  useEffect(() => { void load(); }, []);

  const remove = async () => {
    if (!target || busy) return;
    setBusy(true); setError(null);
    try { await deleteSaleDmLpAsset(target.id); setTarget(null); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "削除に失敗しました"); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <PageHeader title="LPの写真" description="売却DMのご案内ページ(LP)で使う写真の一覧です。追加は各キャンペーンのLP型「写真と図」から行います。LP型で使われている写真は削除できません。" />
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {assets === null ? (
        <p className="text-sm text-gray-500"><Loader2 className="inline h-4 w-4 animate-spin" /> 読み込み中</p>
      ) : assets.length === 0 ? (
        <p className="text-sm text-gray-500">写真はまだありません。</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {assets.map((a) => (
            <li key={a.id} className="overflow-hidden rounded-md border border-gray-200 bg-white">
              {a.referenced
                ? <img src={LP_ASSET_URL(a.publicId)} alt={a.label ?? "写真"} width={a.width} height={a.height} className="aspect-video w-full object-cover" loading="lazy" />
                : <div className="flex aspect-video w-full items-center justify-center bg-gray-100 text-xs text-gray-500">未使用(LP型に付けると見本が出ます)</div>}
              <div className="flex items-center justify-between px-2 py-1.5 text-xs">
                <span className="truncate text-gray-700">{a.label ?? "(ラベルなし)"} · {a.width}×{a.height} · {Math.round(a.bytes / 1024)}KB</span>
                <button type="button" onClick={() => setTarget(a)} disabled={a.referenced} title={a.referenced ? "LP型で使われています" : "削除"} className="text-red-600 disabled:opacity-40"><Trash2 className="h-4 w-4" /></button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {target && <ConfirmDialog title="写真を削除しますか？" message="ライブラリから消えます。LP型で使われている写真は削除できません。" busy={busy} onCancel={() => setTarget(null)} onConfirm={() => void remove()} />}
    </div>
  );
}
```

サイドバー(`src/components/layout/sidebar-model.tsx:110` の直後):

```ts
      { label: "LPの写真", href: "/admin/lp-assets", icon: ic(ImageIcon), minRole: "admin" },
```

(`import { …, Image as ImageIcon } from "lucide-react"` を既存 import に足す。サイドバーの走査テスト(`src/components/layout/__tests__` 等)が項目数や並びを固定していれば、その期待も更新する。)

- [ ] **Step 8: 確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-lp-media-panel-model.test.ts src/lib/__tests__/sale-dm-lp-media-ui-scan.test.ts src/components && npx tsc --noEmit && npx eslint src/components/sale-dm "src/app/(dashboard)/admin/lp-assets" src/components/layout/sidebar-model.tsx` → PASS。`@next/next/no-img-element` が出る場合は `grep -rn "no-img-element" src | head` で既存の扱い(調査ピン写真の表示)を確認し、同じ形で `{/* eslint-disable-next-line @next/next/no-img-element */}` を付ける(公開口は参照判定を伴う動的URLで next/image の最適化対象にしない)。

- [ ] **Step 9: 実機確認(ローカル)** — [[local-dev-env-setup]] の手順で dev を起動(worktree 専用ポート)。管理者で: LP型を作り文章を保存→「写真と図」→ライブラリで **Ctrl+V** 貼り付け→ヒーローに選ぶ→節に図を選ぶ→保存→見本が出る→画像の指示文をコピー→`/lp-assets/<publicId>` を**別のシークレット窓(未ログイン)**で開けること→未参照の写真の publicId は 404→管理ページで使用中は削除不可・未使用は削除可。field_staff で担当外を含むLP型の保存が 403。終わったら dev を止める。

- [ ] **Step 10: Commit**

```bash
git add src/components/sale-dm/lp-media-panel-model.ts src/components/sale-dm/lp-asset-library.tsx src/components/sale-dm/lp-media-panel.tsx src/components/sale-dm/lp-variant-manager.tsx "src/app/(dashboard)/admin/lp-assets/page.tsx" src/components/layout/sidebar-model.tsx src/lib/__tests__/sale-dm-lp-media-panel-model.test.ts src/lib/__tests__/sale-dm-lp-media-ui-scan.test.ts
git commit -m "feat(sale-dm): LP型の「写真と図」画面(ライブラリ・Ctrl+V・枠・図の見本・画像プロンプト)と管理ページ"
```

---

### Task 11: 文書・全ゲート・PR

**Files:**
- Modify: 使い方ガイド/取扱マニュアル(`ls docs | grep -i "guide\|manual"` で実名を確認)…「LP型の写真と図」節を追加(ライブラリ/Ctrl+V/枠/図5種/画像の指示文/凍結/管理ページ「LPの写真」)。管理者向けに「削除は管理者のみ・使用中は削除不可」
- Modify: `public/docs/*.html`(アプリ内複製。`<body>` 欠落に注意=[[system-docs-guide-manual]])
- Modify: `docs/deploy.md`…migration `20260910100000_add_dm_lp_assets` の行、`/lp-assets/` は認証なし公開口(参照中の写真だけ・publicId は乱数)、`STORAGE_BACKEND=server` で `lp-assets/` 配下が増える、nginx のログ除外は**しない**

- [ ] **Step 1: 文書を更新して commit**

```bash
git add docs public/docs
git commit -m "docs(sale-dm): LP型の写真と図(ライブラリ・枠・図・画像の指示文)と反映手順"
```

- [ ] **Step 2: 全ゲート**(worktree で。「緑」と言う前にフルスイート=[[run-full-test-suite-not-targeted]])

```bash
npx prisma generate && npx tsc --noEmit && npx eslint . && npx vitest run && npm run build
```

制御文字スキャン(NUL 混入=[[generated-code-control-char-scan]])と CRLF 混在:

```bash
git diff --stat main...HEAD | grep -i " Bin " ; for f in $(git diff main...HEAD --name-only); do grep -lP "[\x00-\x08\x0B\x0C\x0E-\x1F]" "$f" && echo "CTRL:$f"; done; echo scan-done
```

```bash
git diff main...HEAD | grep -c $'^+.*\r$'
```

(0 でなければ正規化してから commit)

- [ ] **Step 3: PR**(`ship` スキル)。本文に設計書 §2.3/§2.7/§2.8/§6 の自己点検結果と **@codex への論点**(公開口が参照中だけ返すこと・publicId の推測不能性・EXIF strip の fail-closed・凍結の初期化例外なし・field_staff の担当範囲(送付済み含む)・削除の Restrict と論理削除・端末側縮小と受け口の長辺検査の二重化・Ctrl+V の経路・貼り直しでの枠の引き継ぎ)を列挙。PR 作成後は必ず Monitor(`gh -R ligarejapan-hue/property-management`)を張る=[[always-monitor-codex-reviews]]。マージは発注者。

---

## Self-Review(計画作成時に実施)

**1. 設計書との対応(§2.3 / §2.7 / §2.8 / §2.9 / §3-2 / §6)**
- 共有ライブラリ・publicId・`/lp-assets/[publicId]`(参照中のみ)→ Task 1/6/7 ✅
- 図5種(`sale_flow` `cost_breakdown` `inheritance_deadlines` `vacant_burden` `timing_by_type`)・アプリが描く SVG → Task 3 ✅(公開LPへの埋め込みは PR3)
- 枠=ヒーロー1+小見出しごと・`reconcileSectionMedia` → Task 4/8 ✅
- 画像プロンプト(文字なし/ロゴ・実在物なし/日本の住宅街/英語定型行/なるべくコピペ) → Task 4/8/10 ✅
- Ctrl+V 貼り付け・端末側縮小(画像ライブラリを入れない) → Task 9/10 ✅
- 凍結(写真図含む・初期化例外なし) → Task 8 ✅。貼り直しでの引き継ぎ → Task 8 Step 5 ✅
- 権限(書き込み=property:write・削除=管理者)・監査(非PII) → Task 5/6/8 ✅
- EXIF 除去(fail-closed)・`/uploads/` を画面に出さない → Task 6/10(走査) ✅
- §2.9 データ変更=2表 additive・`onDelete: Restrict` → Task 1 ✅
- 対象外(PR3 以降に持ち越し・本PRでは作らない): 公開LPでの写真図の描画、`/t/` の LP分岐、申込フォーム、メール
- ⚠設計にない判断(本計画で確定・PR本文に明記): (a) 未参照の写真は公開口が 404 なので**画面の見本は保存後に出る**(端末の objectURL は使わない=他端末で見えないため)。(b) 写真の上限 10 枚は**重複なしの枚数**。(c) 図は節にのみ(ヒーローは写真のみ)。(d) 画像プロンプトの種別は宛先で最も多い物件種別(先頭500件)。(e) 文章未保存のLP型には枠を付けられない(`TEMPLATE_MISSING`)。

**2. プレースホルダー走査**: "TBD/TODO/後で/適宜/同様に" なし。Task 8 の template テストだけ既存テストの流儀に合わせる指示(mock の組み方が既存ファイルに依存するため、期待値は明記済み)。

**3. 型の一貫性**
- `MediaPlan`(lp-media) と `SaleDmLpMediaPlan`(api-client) は同形(figureKind の型幅だけ違う)。route は zod 出力を `as MediaPlan` で渡す(Task 8)。
- `readImageDimensions(buf, mime)`(Task 2)=Task 6 の呼び出しと一致。`renderFigureSvg(kind)`/`FIGURE_KINDS`/`FIGURE_LABELS`/`isFigureKind`(Task 3)=Task 4/8/10 と一致。
- `SaleDmLpAsset.referenced`(Task 5)=Task 6 GET・Task 8 GET・Task 10 の表示判定で同じ名前。
- `LP_ASSET_URL`(Task 5)=Task 10 走査テストの正規表現と一致。
- `saveSaleDmLpVariantTemplate` の `parts.mediaDropped?`(Task 8)=Task 10 Step 6 の通知。
- 監査 action 4 種(Task 5)=Task 6/8 の `writeAuditLog` と一致。
- `LP_MEDIA_MAX_ASSETS`(Task 4)=Task 10 パネルの上限表示と一致。
