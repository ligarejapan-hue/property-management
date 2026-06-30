# 販売図面エディタ 計画③：保存＋エディタ土台（自由配置・文字編集） 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 生成済みの図面ドキュメントをアプリ内エディタに読み込み、自由配置（選択/移動/拡縮/重ね順/削除）と文字編集（内容/フォント/サイズ/色）で調整し、再編集可能な「保存デザイン」として永続化し、保存デザインを PDF/画像で再出力できるようにする。

**Architecture:** 計画①のドキュメントモデル＋共通レンダラ（`SalesSheetRenderer`）を土台に、(1) `SalesSheetDesign` テーブルで document を永続化、(2) ブラウザでは `SalesSheetRenderer` を描画しその上に編集オーバーレイ（Moveable）を載せて document(client state) を更新＝即時 WYSIWYG プレビュー、(3) 保存は /uploads キー参照の軽量 document、(4) **出力時のみ**サーバーが保存 document の全画像キーを `authorizeUploadAccess` で認可→data: 化→計画①/②の出力パイプラインで PDF/画像化。編集ロジックは純関数 reducer に集約し単体テスト可能にする。

**Tech Stack:** Next.js(App Router)/React 19/TypeScript/Prisma(PostgreSQL)/zod/Vitest(env=node)/Tailwind v4/playwright(既存)。新規依存: **react-moveable**（ドラッグ/拡縮オーバーレイ）。

## Global Constraints

- **マージ/＠codexトリガ/VPS反映/本番 `playwright install chromium`/migration 適用/新規npm依存の追加＝ユーザー承認後**（既存運用）。実装中は worktree 内でゲートを緑にするところまで。
- **新規テーブル `SalesSheetDesign` の migration は1本**（このプランで初出。`prisma migrate deploy` 適用は本番反映時にユーザー承認）。
- **新規依存は `react-moveable` のみ**。追加は package.json/lockfile 変更＝ユーザー承認。代替で自作する場合も承認。導入前に context7/公式 docs で当該バージョンの props を確認すること（推測でAPIを書かない）。
- **権限**: 閲覧/一覧/出力＝`property:read` ＋ `canAccessPropertyRecord`（field_staff は自分の物件のみ）。作成/更新/削除＝`property:write` ＋同アクセス判定。新権限リソースは作らない。
- **document 検証**: 保存・読込・出力の各境界で `parseSalesSheetDocument`（計画①）を必ず通す。レンダラ（コンポーネント）は不正 document で throw する既存挙動を維持。
- **画像セキュリティ（最重要）**: 出力時、document 内の全 image 要素について、その src が /uploads/ 形式（自前 storage）なら **`authorizeUploadAccess` で認可してから** data: 化して埋め込む。認可されない/解決不能な src は**画像を落とす**（描画しない・バイトを読まない）。**出力時の DoS 上限：画像数が多すぎる document は read 前に出力拒否（422）・逐次処理＋同一 key dedup・合計バイト上限超過分は drop**。data: src はスキーマ上は data:image 限定で可だが、**保存境界（create/update）では `data:` 画像を src 文字数で上限制限**（極小プレースホルダのみ許容＝巨大 base64 blob を document JSON に直書きして DB を肥大化させるのを防止。`data:` 化は出力時 `authorizeAndInlineDocumentImages` のみ）。**保存境界（create/update の user-supplied document）では `/uploads` 画像も `assertDocumentImagesAuthorized` で **(1) caller 認可 かつ (2) key がその図面の物件に属する（DB逆引き）** の両方を要求し、別物件/未認可/存在しない/解決不能を含む document は 422 で保存拒否**（未認可キーが保存され GET で echo されるのを防ぐ多層防御＝バイトは export＋配信ルートで別途保護。サーバー生成の初期 document は自物件写真ベース＝認可済で解決不能のみ drop）。`http(s)://` 等の外部 src はスキーマ（計画① `isSafeImageSrc`）で既に拒否。出力ブラウザのネットワーク遮断（計画②ガード）は維持。
- **PII/blob キーをログ・レスポンスに出さない**。
- **楽観ロック**: 更新は `updatedAt` 一致を要求し、競合は 409。
- 既存のテスト規約（co-located `__tests__/`・env=node）に従う。`.claude/settings.local.json` 非接触。force-push 禁止。

---

## 計画①/②から利用するインターフェース（既存・このプランで変更しない）

- `src/lib/sales-sheet/document-schema.ts`: `SalesSheetDocument`（page+theme+elements[]）, 要素 discriminated union（text/image/table/badge/shape/qr。各 `id,x,y,w,h,z` mm/pt/int）, `parseSalesSheetDocument(input): SalesSheetDocument`（境界検証）, `A4_LANDSCAPE`/`A4_PORTRAIT`。
- `src/components/sales-sheet/SalesSheetRenderer.tsx`: `<SalesSheetRenderer document={doc} />`（"use client" 無し・先頭で `parseSalesSheetDocument`・要素別描画・全 style 値 `sanitizeCssValue`）。ブラウザ/サーバー共通。プレビューにそのまま使う。
- `src/lib/sales-sheet/css-safety.ts`: `isCssColor`, `isSafeFontFamily`, `sanitizeCssValue`（不変）。⚠`isSafeImageSrc` は**本プランで変更**するため「変更しない」例外＝既存は `data:image` のみ受理だったところに root-relative **`/uploads/`** 受理を追加（`//host`/scheme/`..`/`%2e`/制御文字は拒否）。変更詳細は下記「ファイル構成（作成/変更）」と「Task A Step 0」を参照。[@codex P1反映]
- `src/lib/sales-sheet/build-document.ts`: `buildSaleLandDocument(input): SalesSheetDocument`（純・写真 src は /uploads キーの**未インライン**）, `buildInitialSalesSheetDocument(input): Promise<SalesSheetDocument>`（= 写真を data: にインライン）, `SaleLandInput`, `SaleLandOverrides`(price/access/landArea/landCategory/transactionType/deliveryTiming/remarks)。**計画③では「未インライン版（/uploads キー）」を保存・編集に使う**（`isSafeImageSrc` が `/uploads/` を許可するので保存境界の `parseSalesSheetDocument` を通る＝写真あり土地でも保存OK。出力時に Task C が都度認可して data: 化。@codex P1反映）。⚠本プランで **`toCanonicalUploadsSrc(fileUrl, storage?)` を追加**（保存画像 src を全 storage backend 共通の `/uploads/{key}` へ正規化＝server backend の `/{bucket}/{key}`/絶対URL でも保存境界 `isSafeImageSrc` を通す。下記「ファイル構成（作成/変更）」「Task H 新規作成 API」参照）。
- `src/lib/sales-sheet/inline-images.ts`: `inlineDocumentImages(doc): Promise<SalesSheetDocument>`（非data: img src → `getStorage().keyFromUrl`→read→data:。解決不能はドロップ）。**計画③では認可付きの派生版を作る（下記 Task C）**。
- `src/lib/sales-sheet/render-to-output.ts`: `renderDocumentToPdf(doc)` / `renderDocumentToImage(doc, {format})` / 内部 `isChromiumAvailable()`。
- `src/lib/uploads-authorization.ts`: `authorizeUploadAccess({key, session, permissions}): Promise<"ok"|"forbidden"|"not_found">`（backend 対応 key 解決済み）。
- `src/lib/storage/*`: `getStorage().keyFromUrl(url)`（backend対応）, `isValidStorageKey`。
- `src/lib/api-helpers.ts`: `getApiSession()`, `ApiSession`, `PermissionEntry`, `handleApiError`, `ApiError`。
- `src/lib/permissions.ts`: `hasPermission(perms, resource, action)`。
- `src/lib/property-access.ts`: `canAccessPropertyRecord(property, session)`（要確認・計画②で使用）。

---

## ファイル構成（作成/変更）

- `prisma/schema.prisma`（変更：model `SalesSheetDesign` 追加）
- `prisma/migrations/<ts>_add_sales_sheet_design/migration.sql`（作成）
- `src/lib/sales-sheet/design-service.ts`（作成：DB CRUD＋検証＋アクセス判定の薄いサービス）
- `src/lib/sales-sheet/__tests__/design-service.test.ts`（作成）
- `src/lib/sales-sheet/authorize-document-images.ts`（作成：document 全 image 認可→data: 化）
- `src/lib/sales-sheet/__tests__/authorize-document-images.test.ts`（作成）
- `src/lib/sales-sheet/css-safety.ts`（**変更**：`isSafeImageSrc` に root-relative `/uploads/` 受理を追加。`//host`/scheme/`..`/`%2e`/制御文字は拒否）
- `src/lib/sales-sheet/__tests__/css-safety.test.ts`（**変更**：`/uploads/` 受理・traversal/`%2e`/scheme 拒否のテストを追加）
- `src/app/api/properties/[id]/sales-sheets/route.ts`（作成：POST 作成 / GET 一覧）
- `src/app/api/properties/[id]/sales-sheets/[sheetId]/route.ts`（作成：GET 取得 / PUT 更新 / DELETE 削除）
- `src/app/api/properties/[id]/sales-sheets/[sheetId]/export/route.ts`（作成：POST 出力）
- `src/app/api/properties/[id]/sales-sheets/**/__tests__/route.test.ts`（作成）
- `src/lib/sales-sheet/editor-document.ts`（作成：純 reducer 群＝選択/移動/拡縮/重ね順/削除/文字編集/dirty）
- `src/lib/sales-sheet/__tests__/editor-document.test.ts`（作成）
- `src/components/sales-sheet/editor/SalesSheetEditor.tsx`（作成：エディタ shell＝canvas＋overlay＋panel＋toolbar 統合）
- `src/components/sales-sheet/editor/EditorCanvas.tsx`（作成：`SalesSheetRenderer`＋選択オーバーレイ＋Moveable）
- `src/components/sales-sheet/editor/ElementPanel.tsx`（作成：右パネル＝geometry＋文字編集）
- `src/components/sales-sheet/editor/EditorToolbar.tsx`（作成：保存/出力/削除）
- `src/components/sales-sheet/editor/__tests__/*.test.tsx`（作成：可能な範囲。重いDOMはスキップ可・ロジックは editor-document でカバー）
- `src/app/(dashboard)/properties/[id]/sales-sheets/[sheetId]/edit/page.tsx`（作成：エディタ画面ルート）
- `src/app/api/properties/[id]/sales-sheets/new/route.ts`（作成：作成フォームの上書き項目受領＋代表写真取得＋`toCanonicalUploadsSrc` 正規化＋`localizeOccupancy`→`buildSaleLandDocument`→`createDesign`→`{id}`）
- `src/lib/sales-sheet/build-document.ts`（**変更**：`toCanonicalUploadsSrc` 追加＝保存画像 src を全 backend 共通の `/uploads/{key}` へ正規化）
- `src/lib/property-types.ts`（**変更**：`localizeOccupancy` 追加＝現況 enum→日本語ラベル）
- `src/components/sales-sheet/SaleLandSheetButton.tsx`（変更：直接PDF→「販売図面を作成（売土地）」＝上書き項目フォーム→新規作成→エディタ遷移。計画②の直出力はエディタ内「出力」に統合）
- `src/app/(dashboard)/properties/[id]/page.tsx`（変更：ボタンの意味変更に追従。土地物件のみ表示は維持）
- `package.json` / `package-lock.json`（変更：`react-moveable` 追加・**ユーザー承認**）

---

## Task A: SalesSheetDesign モデル＋migration＋検証サービス

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<ts>_add_sales_sheet_design/migration.sql`
- Create: `src/lib/sales-sheet/design-service.ts`
- Test: `src/lib/sales-sheet/__tests__/design-service.test.ts`

**Interfaces:**
- Produces: `createDesign`, `getDesign`, `listDesigns`, `updateDesign`, `deleteDesign`（下記シグネチャ）。document は保存前後で `parseSalesSheetDocument` を通す。create/update は保存前に `data:` 画像が極小上限（src 文字数）を超えないか検証し、超過は 422 で拒否（巨大 base64 blob の DB 直書き防止・保存は /uploads 参照のみ）。**`/uploads` 参照の認可は route 層（Task B）が `assertDocumentImagesAuthorized` で create/updateDesign 呼び出し前に実施**（design-service は session を持たないため。caller 認可＋key の物件スコープ（その図面の propertyId に属するか）の両方を要求し、別物件/未認可/存在しない/解決不能は 422）。

- [ ] **Step 0: `isSafeImageSrc` を `/uploads/` 受理に拡張**（`src/lib/sales-sheet/css-safety.ts`）。既存は `data:image` のみ受理 → root-relative `/uploads/` も受理（`//host`/scheme/`..`/`%2e`/制御文字は拒否）。保存 document の写真 src は /uploads キー（未インライン）なので、これが無いと保存境界の `parseSalesSheetDocument` が「写真あり土地図面」を弾く。`__tests__/css-safety.test.ts` に `/uploads/` 受理＋traversal/`%2e`/scheme 拒否のテストを失敗先行で追加。[@codex P1反映]

- [ ] **Step 1: schema 追加**

```prisma
model SalesSheetDesign {
  id           String   @id @default(cuid())
  propertyId   String   @map("property_id") @db.Uuid
  title        String   @default("無題の販売図面")
  document     Json
  templateId   String?  @map("template_id")
  thumbnailUrl String?  @map("thumbnail_url")
  createdBy    String   @map("created_by") @db.Uuid
  updatedBy    String   @map("updated_by") @db.Uuid
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")

  property Property @relation(fields: [propertyId], references: [id], onDelete: Cascade)
  creator  User     @relation("SalesSheetDesignCreatedBy", fields: [createdBy], references: [id])
  updater  User     @relation("SalesSheetDesignUpdatedBy", fields: [updatedBy], references: [id])

  @@index([propertyId])
  @@map("sales_sheet_designs")
}
```
`Property` model に `salesSheetDesigns SalesSheetDesign[]`、`User` model に作成者/更新者の逆リレーション（`@relation("SalesSheetDesignCreatedBy")` / `@relation("SalesSheetDesignUpdatedBy")`）を追記。**`propertyId`/`createdBy`/`updatedBy` は参照先（`Property.id` / `User.id` が `@db.Uuid`）に合わせて必ず `@db.Uuid`**（`String` のまま＝`text` だと PostgreSQL が FK を `text→uuid` で張れず migration が失敗する）。

- [ ] **Step 2: migration SQL を生成**（devDB 不要・SQL 手書きで冪等に）

```sql
CREATE TABLE IF NOT EXISTS "sales_sheet_designs" (
  "id" TEXT NOT NULL,
  "property_id" UUID NOT NULL,
  "title" TEXT NOT NULL DEFAULT '無題の販売図面',
  "document" JSONB NOT NULL,
  "template_id" TEXT,
  "thumbnail_url" TEXT,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sales_sheet_designs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "sales_sheet_designs_property_id_idx" ON "sales_sheet_designs"("property_id");
ALTER TABLE "sales_sheet_designs" ADD CONSTRAINT "sales_sheet_designs_property_id_fkey"
  FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_sheet_designs" ADD CONSTRAINT "sales_sheet_designs_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_sheet_designs" ADD CONSTRAINT "sales_sheet_designs_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```
（`properties` の実テーブル名・PK 名は既存 schema を確認して合わせる。FK 重複追加を避けるため適用は migrate deploy に委ねる＝手動 ALTER は冪等 guard 付き。）

- [ ] **Step 3: `npx prisma generate`** でクライアント再生成（tsc が新モデルを認識）。

- [ ] **Step 4: 失敗するテストを書く（design-service）**

```ts
// createDesign: document を検証して保存、不正 document は throw
// getDesign: 他物件の design は返さない（propertyId スコープ）
// updateDesign: updatedAt 不一致は OPTIMISTIC_LOCK で reject
```
prisma はモック注入（計画②の route テスト同様 `db` 引数で注入可能にする）。

- [ ] **Step 5: design-service 実装**

```ts
import prismaDefault from "@/lib/prisma";
import { z } from "zod";
import {
  parseSalesSheetDocument, A4_PORTRAIT, A4_LANDSCAPE,
  type SalesSheetDocument, type SalesSheetPage,
} from "./document-schema";
type PrismaLike = typeof prismaDefault;

// 保存境界の bloat / DoS ガード: (1) 文書全体の JSON 長、(2) 個別 data: 埋め込み画像(image.src / qr.dataUrl)、
// (3) page サイズ（A4 縦/横のみ）、(4) element geometry(x/y/w/h mm) を上限で弾く（保存 doc は /uploads 参照のみ・
// data: 化は出力時のみ）。(3)(4) が無いと巨大 page/element を保存でき、export で Chromium に巨大寸法/レイアウトが
// 渡り CPU/メモリ DoS。ZodError で投げ handleApiError が 422 化（ApiError は next/server を引き込み node テストで
// 解決不可なため ZodError を使う）。
const MAX_INLINE_IMAGE_SRC_LEN = 8192;       // 個別 data: 画像
const MAX_DOCUMENT_JSON_LEN = 512 * 1024;    // 文書全体の JSON 文字数
const MAX_GEOMETRY_MM = 10000;               // x/y/w/h(mm) の絶対上限（A4=297mm に対し十分広く、極端値のみ弾く）
const makeDocumentError = (m: string) =>
  new z.ZodError([{ code: z.ZodIssueCode.custom, message: m, path: ["elements"] }]);
function isAllowedPage(page: SalesSheetPage): boolean { // A4 縦/横のみ許可
  return [A4_PORTRAIT, A4_LANDSCAPE].some(
    (a4) => page.width === a4.width && page.height === a4.height && page.orientation === a4.orientation,
  );
}
function assertSavableDocument(document: SalesSheetDocument): void {
  if (JSON.stringify(document).length > MAX_DOCUMENT_JSON_LEN) throw makeDocumentError("図面データが大きすぎます");
  if (!isAllowedPage(document.page)) throw makeDocumentError("ページサイズが不正です（A4のみ対応）"); // 巨大ページ→422
  for (const el of document.elements) {
    const inlineSrc = el.type === "image" ? el.src : el.type === "qr" ? el.dataUrl : null;
    if (inlineSrc && inlineSrc.startsWith("data:") && inlineSrc.length > MAX_INLINE_IMAGE_SRC_LEN) {
      throw makeDocumentError("埋め込み画像が大きすぎます");
    }
    // element geometry(mm): w/h は正数かつ上限内・x/y は絶対値上限内。極端値は export レンダリングの DoS。
    if (
      !Number.isFinite(el.x) || !Number.isFinite(el.y) || !Number.isFinite(el.w) || !Number.isFinite(el.h) ||
      el.w <= 0 || el.h <= 0 ||
      Math.abs(el.x) > MAX_GEOMETRY_MM || Math.abs(el.y) > MAX_GEOMETRY_MM ||
      el.w > MAX_GEOMETRY_MM || el.h > MAX_GEOMETRY_MM
    ) {
      throw makeDocumentError("要素サイズ・位置が範囲外です");
    }
  }
}

export interface SaveDesignInput {
  propertyId: string; title?: string; document: unknown; templateId?: string | null; userId: string;
}
export async function createDesign(input: SaveDesignInput, db: PrismaLike = prismaDefault) {
  const document = parseSalesSheetDocument(input.document); // 不正は throw
  assertSavableDocument(document);                          // サイズ上限（DB 肥大化防止）
  return db.salesSheetDesign.create({
    data: {
      propertyId: input.propertyId,
      title: input.title?.trim() || "無題の販売図面",
      document,
      templateId: input.templateId ?? null,
      createdBy: input.userId, updatedBy: input.userId,
    },
  });
}
export async function getDesign(propertyId: string, sheetId: string, db: PrismaLike = prismaDefault) {
  const d = await db.salesSheetDesign.findUnique({ where: { id: sheetId } });
  if (!d || d.propertyId !== propertyId) return null; // スコープ外は null
  return d;
}
export async function listDesigns(propertyId: string, db: PrismaLike = prismaDefault) {
  return db.salesSheetDesign.findMany({
    where: { propertyId }, orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, updatedAt: true, createdAt: true, thumbnailUrl: true },
  });
}
export async function updateDesign(
  propertyId: string, sheetId: string,
  patch: { title?: string; document?: unknown; expectedUpdatedAt: string | Date }, userId: string,
  db: PrismaLike = prismaDefault,
) {
  const current = await getDesign(propertyId, sheetId, db);
  if (!current) return { ok: false as const, reason: "not_found" as const }; // 404
  const data: Record<string, unknown> = { updatedBy: userId };
  if (patch.title !== undefined) data.title = patch.title.trim() || "無題の販売図面";
  if (patch.document !== undefined) {
    const parsed = parseSalesSheetDocument(patch.document); // throw→422（書込前）
    assertSavableDocument(parsed);                          // サイズ上限
    data.document = parsed;
  }
  // 楽観ロックはアトミックに（@codex P2反映）: expectedUpdatedAt を WHERE に入れた updateMany で
  // read→compare→update の TOCTOU（同時保存の後勝ち=lost update）を防ぐ。
  const result = await db.salesSheetDesign.updateMany({
    where: { id: sheetId, propertyId, updatedAt: new Date(patch.expectedUpdatedAt) },
    data,
  });
  if (result.count === 0) return { ok: false as const, reason: "conflict" as const }; // 409
  // 並行 DELETE で再 read が null になり得る → conflict 扱い（500 回避）。
  const updated = await db.salesSheetDesign.findUnique({ where: { id: sheetId } });
  if (!updated) return { ok: false as const, reason: "conflict" as const };
  return { ok: true as const, design: updated };
}
export async function deleteDesign(propertyId: string, sheetId: string, db: PrismaLike = prismaDefault) {
  // scope 付きアトミック削除: id と propertyId が一致する行だけ消す。
  // getDesign→delete の TOCTOU（並行二重削除の Prisma P2025→500）を避け、該当無しは count=0→false。
  const result = await db.salesSheetDesign.deleteMany({ where: { id: sheetId, propertyId } });
  return result.count > 0;
}
```

**保存境界テスト（抜粋）:** 不正 document→422 / 文書JSON長・data:画像(image.src・qr.dataUrl)超過→422 / **page が A4 以外（巨大ページ）→ create・update で 422（DB 未呼出）** / **element の w/h 巨大・x/y 極端なページ外→422** / 正常な A4 既存図面（縦・横）は保存可。

- [ ] **Step 6: テスト緑 / tsc / eslint** を確認しコミット。

---

## Task B: 保存/読込 API（CRUD）

**Files:**
- Create: `src/app/api/properties/[id]/sales-sheets/route.ts`（POST/GET）
- Create: `src/app/api/properties/[id]/sales-sheets/[sheetId]/route.ts`（GET/PUT/DELETE）
- Test: 各 `__tests__/route.test.ts`

**Interfaces:**
- Consumes: design-service（Task A）, `getApiSession`, `hasPermission`, `canAccessPropertyRecord`, `handleApiError`/`ApiError`。
- 契約: 401(未認証)/403(権限・物件アクセス不可)/404(物件 or design 無)/409(更新競合)/422(document/入力不正)/200。
- 監査: create / update / delete の**成功時のみ** `writeAuditLog`（他の property mutation と同方式）。**非PIIメタのみ**＝action=`sales_sheet_design_{create,update,delete}`・targetTable=`sales_sheet_designs`・targetId=sheetId（create は新 design.id）・detail=`{ propertyId }`。document 本文・画像 key/URL・overrides・物件住所・顧客情報等の PII は**入れない**。403/404/409/422 等の失敗時は記録しない（delete 対象なしでも存在情報を出さない）。新規作成 route（Task H）の create も同様に記録。

- [ ] **Step 1-2: 失敗するテスト→実装（POST 作成 / GET 一覧）**

共通ガード（計画②の preview route と同型）:
```ts
const session = await getApiSession(req); if (!session) -> 401
if (!hasPermission(session.permissions, "property", "read")) -> 403   // GET
// POST/PUT/DELETE は "property","write"
const property = await prisma.property.findUnique({ where: { id }, select: {…canAccessに必要…} });
if (!property) -> 404
if (!canAccessPropertyRecord(property, session)) -> 403
```
POST body は zod: `{ title?: string(max 120), document: unknown, templateId?: string }`。**保存前に `parseSalesSheetDocument` → `assertDocumentImagesAuthorized`（propertyId を渡し、/uploads 画像が caller 認可かつその物件に属するか検証・別物件/未認可/解決不能は 422）** → `createDesign` 呼び出し（document 不正も `parseSalesSheetDocument` throw → 422）。レスポンス `{ id }`（201）。
GET 一覧は `listDesigns` の結果を返す（200）。

- [ ] **Step 3-4: 失敗するテスト→実装（GET 取得 / PUT 更新 / DELETE）**

GET `[sheetId]`: `getDesign`（スコープ外/無は 404）→ **read 境界でも `parseSalesSheetDocument(design.document)` を必ず通す**（古いバグ・手動修復・partial deploy で壊れた DB document を raw JSON で echo しない・不正は `ZodError`→422）→ `{ id,title,document(検証済),updatedAt,... }`。export route / edit server-component も同様に read 境界で parse 済。
PUT `[sheetId]`: write 権限。body `{ title?, document?, expectedUpdatedAt: string(ISO datetime・`z.string().datetime()` で検証＝不正値は 400) }`。**document 提供時は保存前に `parseSalesSheetDocument` → `assertDocumentImagesAuthorized`（propertyId を渡し /uploads が caller 認可かつその物件に属するか検証・別物件/未認可/解決不能は 422）**。`updateDesign` の戻りで not_found→404 / conflict→409 / ok→200`{ updatedAt }`。
DELETE `[sheetId]`: write 権限。`deleteDesign`→ true:204 / false:404。

**API テスト（抜粋）:** POST/PUT で **別 property の /uploads key（caller は読めるが物件スコープ外）→422** / **`authorizeUploadAccess` ok でも property ownership 不一致→422** / 解決不能 key→422 / 422 に blob key 実値を出さない / **GET は壊れた DB document を raw JSON で返さず 422**（read 境界 parse）/ **create・update・delete の成功で `writeAuditLog` が1件・detail は `{ propertyId }` のみ（document 本文・画像 key を含めない）/ 403・404・409 では記録しない**。

- [ ] **Step 5: 全テスト緑 / tsc / eslint→コミット。**
（注: route の prisma は計画②同様テストでモック。`canAccessPropertyRecord` の正確なシグネチャ・property select は計画②の preview route を参照して合わせる。）

---

## Task C: 出力（保存デザインの認可付きレンダリング）

**Files:**
- Create: `src/lib/sales-sheet/authorize-document-images.ts`
- Test: `src/lib/sales-sheet/__tests__/authorize-document-images.test.ts`
- Create: `src/app/api/properties/[id]/sales-sheets/[sheetId]/export/route.ts`
- Test: `.../export/__tests__/route.test.ts`

**Interfaces:**
- Produces: `authorizeAndInlineDocumentImages(doc, {session, permissions}): Promise<SalesSheetDocument>`（出力時：/uploads を認可→data:化、未認可/非画像MIMEは透明プレースホルダ。**DoS 上限：画像数が上限超なら read 前に出力拒否(422)・逐次処理＋同一 key dedup で storage.read は1回・**合計 budget は raw bytes ではなく実際に HTML へ直列化される data URL サイズ（base64 膨張込み）で計上**（初回 read も cache 再利用も同じ）し上限超過は drop。同一画像を複数回参照しても data URL は出現回数分 HTML に直列化されるため、cache 再利用も出現ごとに serialized サイズを加算し超過する出現は drop**。Chromium fail-fast 順序は不変）。
- Produces: `assertDocumentImagesAuthorized(doc, {session, permissions, propertyId}): Promise<void>`（**保存境界**：各 /uploads 画像について **(1) caller が読める（`authorizeUploadAccess`==="ok"）かつ (2) key がその図面の物件 `propertyId` に属する（`isUploadKeyOwnedByProperty`＝DB逆引き・key 形式から物件推定しない）** の両方を要求。別物件/未認可/存在しない/解決不能なら `ZodError`→422。`data:` はスキップ。CRUD POST/PUT が propertyId を渡し保存前に呼ぶ。key/URL はエラーに出さない。(2) が無いと複数物件を読める管理者が他物件 key を保存→GET echo するため必須）。
- Produces: `isImageKeyAuthorizedForProperty(key, {session, permissions, propertyId}): Promise<boolean>`（上記 (1)＋(2) を判定する共通ヘルパ。保存境界（`assertDocumentImagesAuthorized`＝false で throw）と、新規作成 API の代表写真認可（false で写真 drop）で共用。テスト: 正常な代表写真は初期 document に入る / 別物件・解決不能 key の代表写真は drop し「写真なし初期図面」を作成 / drop 時に key 実値を log・error に出さない）。

- [ ] **Step 1: 失敗するテスト（authorize-document-images）**

```ts
// 1) src が data: の image はそのまま保持
// 2) src が /uploads/<key> で authorizeUploadAccess="ok" → data: にインライン
// 3) authz="forbidden"/"not_found" の image → 要素から画像を除去（src を落とす or 要素削除）= バイト未読込
// 4) PII/key を返り値・ログに出さない（immutable・新 document を返す）
// 5) [DoS] 画像数が上限超なら read 前に出力拒否(422)・非画像MIMEはプレースホルダ・合計バイト上限超過は drop
// 6) [DoS] 同一 key の複数参照は storage.read 1回（dedup）かつ出現ごとに budget 加算し、超過する出現は drop
```

- [ ] **Step 2: 実装**

```ts
import { z } from "zod";
import type { SalesSheetDocument, SalesSheetElement } from "./document-schema";
import { authorizeUploadAccess } from "@/lib/uploads-authorization";
import { getStorage } from "@/lib/storage";
import type { ApiSession, PermissionEntry } from "@/lib/api-helpers";

const MAX_INLINE_IMAGES = 50;                    // /uploads 画像数の上限（超過は出力拒否）
const MAX_TOTAL_INLINE_BYTES = 32 * 1024 * 1024; // data 化後の合計バイト上限（超過分は drop）

export async function authorizeAndInlineDocumentImages(
  doc: SalesSheetDocument,
  ctx: { session: ApiSession; permissions: PermissionEntry[] },
): Promise<SalesSheetDocument> {
  // DoS 防止: 出力対象（data: 以外の image）が多すぎる document は read 前に出力拒否（fail-fast）。
  // ZodError → handleApiError で 422。key/URL はメッセージに出さない。
  const inlineCount = doc.elements.filter((el) => el.type === "image" && !el.src.startsWith("data:")).length;
  if (inlineCount > MAX_INLINE_IMAGES) {
    throw new z.ZodError([{ code: z.ZodIssueCode.custom, message: "図面に含まれる画像が多すぎます", path: ["elements"] }]);
  }
  // 逐次処理（並列 read の fan-out を避ける）＋ 同一 key の重複 read を cache で排除。
  // 合計バイト上限を超えたら以降の画像は drop。
  const cache = new Map<string, string>();
  let totalBytes = 0;
  const elements: SalesSheetElement[] = [];
  for (const el of doc.elements) {
    if (el.type !== "image" || el.src.startsWith("data:")) { elements.push(el); continue; } // data: は安全（スキーマで限定）
    const key = getStorage().keyFromUrl(el.src);               // backend 対応
    if (!key) { elements.push(dropImage(el)); continue; }
    const cached = cache.get(key);
    if (cached) { // 同一 key は read せず再利用（dedup）。ただし出現ごとに serialized size を budget 加算。
      if (totalBytes + cached.length > MAX_TOTAL_INLINE_BYTES) { elements.push(dropImage(el)); continue; } // 超過出現は drop
      totalBytes += cached.length;
      elements.push({ ...el, src: cached }); continue;
    }
    const decision = await authorizeUploadAccess({ key, session: ctx.session, permissions: ctx.permissions });
    if (decision !== "ok") { elements.push(dropImage(el)); continue; } // 認可外は描画しない・バイト未読込
    const bytes = await getStorage().read(key).catch(() => null);
    if (!bytes) { elements.push(dropImage(el)); continue; }
    if (!bytes.contentType.startsWith("image/")) { elements.push(dropImage(el)); continue; } // 非画像MIMEは data:image/ 検証に弾かれ全体422→該当のみdrop
    // budget は raw bytes ではなく、実際に HTML へ直列化される data URL のサイズで数える
    // （base64 で約 4/3 + prefix 分膨らむ）。初回も cache 再利用も同じ serialized 長で計上。
    const dataUrl = toDataUrl(bytes);                          // mime は read 結果 or 既存 util
    if (totalBytes + dataUrl.length > MAX_TOTAL_INLINE_BYTES) { elements.push(dropImage(el)); continue; } // serialized 合計上限超過→drop
    totalBytes += dataUrl.length;
    cache.set(key, dataUrl);
    elements.push({ ...el, src: dataUrl });
  }
  return { ...doc, elements };
}
// dropImage: image 要素の src を **有効な data: 透明1pxプレースホルダ** に差し替える（@codex P2反映）。
//   空 src は不可＝`isSafeImageSrc`/`parseSalesSheetDocument` を通らず出力が検証で落ちるため。
//   要素自体は残してレイアウト/重ね順を維持（要素削除だと重ね順がずれる）。
```
（`getStorage().read` の戻り型・mime 取得は計画②の inline-images 実装に合わせる。data: 化 util を共通化してよい。）

- [ ] **Step 3-4: 失敗するテスト→実装（export route）**

```ts
// POST /api/properties/[id]/sales-sheets/[sheetId]/export?format=pdf|png
// 認証→property:read→property取得→canAccessPropertyRecord→getDesign(404)→
// parseSalesSheetDocument(design.document)→isChromiumAvailable() 無→503
//   （fail-fast: storage 読込・画像認可の前に判定。preview route と同順＝503 経路で storage を読まない）→
// authorizeAndInlineDocumentImages→renderDocumentToPdf|Image→bytes 返却(no-store)
```
契約: 401/403/404/422(document破損)/503(chromium無)/200(application/pdf | image/png)。format 既定 pdf。

- [ ] **Step 5: 全テスト緑 / tsc / eslint→コミット。**

---

## Task D: エディタ document reducer（純ロジック・UI 無し）

**Files:**
- Create: `src/lib/sales-sheet/editor-document.ts`
- Test: `src/lib/sales-sheet/__tests__/editor-document.test.ts`

**Interfaces:**
- Produces: `EditorState`（`{ document, selectedId: string|null, dirty: boolean }`）と純 reducer:
  - `selectElement(state, id|null)`
  - `moveElement(state, id, {x,y})`（mm・ページ境界クランプ）
  - `resizeElement(state, id, {w,h})`（最小サイズ guard）
  - `bringToFront(state,id)` / `sendToBack(state,id)` / `setZ(state,id,z)`
  - `deleteElement(state,id)`
  - `editText(state, id, patch:{content?:string; fontSizePt?:number; color?:string; fontFamily?:string})`（text 要素のみ・色/フォントは `isCssColor`/`isSafeFontFamily` で弾く）
  - `markSaved(state)`（dirty=false）
  - `markSavedIfCurrent(state, savedDocument)`（保存応答時に呼ぶ＝`state.document === savedDocument` のときのみ dirty=false。保存 in-flight 中に編集された新 document は別参照ゆえ dirty 維持＝保存中の編集を取りこぼさない）
- すべて新 state を返す（immutable）。各操作後 document は依然 `parseSalesSheetDocument` を通せる形を保つ（テストで検証）。

- [ ] **Step 1: 失敗するテスト**（代表）

```ts
// moveElement: x,y 更新 + dirty=true + ページ外は 0..(page-size - element-size) にクランプ
// resizeElement: w,h 最小(例 5mm)以上にクランプ
// bringToFront: 当該 z が最大+1
// deleteElement: 要素消滅 + selectedId が当該なら null
// editText: 不正 color("expression(...)") は無視 or throw（弾く）。content 反映。非 text 要素には no-op
// 各操作で parseSalesSheetDocument(result.document) が成功する
```

- [ ] **Step 2: 実装**（純関数群。document-schema の型・mm/pt 規約に従う。色/フォントは css-safety を再利用）。

- [ ] **Step 3: テスト緑 / tsc / eslint→コミット。**

---

## Task E: エディタ canvas（レンダラ＋選択オーバーレイ）

**Files:**
- Create: `src/components/sales-sheet/editor/EditorCanvas.tsx`
- Create: `src/components/sales-sheet/editor/SalesSheetEditor.tsx`（shell 骨組み・以降のタスクで肉付け）
- Test: `src/components/sales-sheet/editor/__tests__/editor-canvas.test.tsx`（軽量。重い DOM は skip 可・ロジックは Task D でカバー済）

**Interfaces:**
- `<EditorCanvas document selectedId onSelect />`：`<SalesSheetRenderer document />` を mm→px スケールの台紙（A4横）に載せ、各要素の当たり判定枠を重ね、クリックで `onSelect(id)`。選択要素に枠線ハイライト。
- `<SalesSheetEditor initial={{document,sheetId,propertyId,updatedAt}} />`："use client"。`useReducer`/`useState` で `EditorState`（Task D）を保持。canvas＋（後続で panel/toolbar）を配置。

- [ ] **Step 1-3:** canvas 実装（mm→px は 1mm=約3.78px @96dpi。A4横=297×210mm。台紙 transform: scale で画面に収める）。選択は要素の絶対座標枠を被せてクリック取得（Moveable 導入前の素の選択）。テストは「要素枠が要素数ぶん描画」「クリックで onSelect 呼ぶ」程度。`SalesSheetRenderer` は計画①のまま流用。

- [ ] **Step 4: コミット。**

---

## Task F: Moveable によるドラッグ/拡縮/重ね順（承認: 新規依存）

**Files:**
- Modify: `package.json` / `package-lock.json`（`react-moveable` 追加・**ユーザー承認**）
- Modify: `EditorCanvas.tsx`（選択要素に `<Moveable>` を装着）
- Modify: `SalesSheetEditor.tsx`（drag/resize/z を Task D reducer に接続）
- Test: 既存の editor-document テストで論理は担保。Moveable のDOM挙動はE2E領域＝単体では薄く。

**Interfaces:**
- Consumes: Task D reducer（`moveElement`/`resizeElement`/`bringToFront` 等）。

- [ ] **Step 1: 依存追加の承認を取得**（コントローラがユーザーに確認）。承認後 `npm i react-moveable`。**導入バージョンの props を context7/公式 docs で確認**（`onDrag`/`onResize`/`target`/`bounds`/`snappable` 等）。
- [ ] **Step 2-4:** 選択要素へ Moveable を装着。`onDragEnd`/`onResizeEnd`（px）→ mm に逆変換 → `moveElement`/`resizeElement`。重ね順ボタン（前面/背面）→ `bringToFront`/`sendToBack`。bounds=台紙でページ外移動を抑制（reducer 側クランプと二重防御）。**クリックとキーボード（Enter/Space）の双方で当該 hit-box を Moveable target にセット**（キーボード選択でもハンドルが正しい要素に付く＝a11y）。
- [ ] **Step 5: ゲート（tsc/eslint/build）→コミット。**（build はバンドルに新依存が乗るので必須。）

---

## Task G: 右パネル（geometry＋文字編集）

**Files:**
- Create: `src/components/sales-sheet/editor/ElementPanel.tsx`
- Modify: `SalesSheetEditor.tsx`（パネル接続）
- Test: `__tests__/element-panel.test.tsx`（軽量）

**Interfaces:**
- `<ElementPanel element selected onChange />`：選択要素の編集 UI。
  - 全要素: x/y/w/h（数値入力・mm）/ 重ね順（前面/背面）/ 削除。
  - text 要素: 内容（textarea）/ フォント（許可リストの select）/ サイズ（pt）/ 色（color picker・`isCssColor` で検証）。
  - 変更は `onChange(patch)` → `SalesSheetEditor` が Task D reducer（`moveElement`/`resizeElement`/`editText`/`setZ`/`deleteElement`）へ。

- [ ] **Step 1-3:** 実装。色/フォントは css-safety の許可リストに準拠（不正値は適用しない）。テストは「text 選択時に文字編集 UI が出る」「数値変更で onChange」程度。
- [ ] **Step 4: コミット。**

---

## Task H: ツールバー（保存/出力/削除）＋導線切替

**Files:**
- Create: `src/components/sales-sheet/editor/EditorToolbar.tsx`
- Modify: `SalesSheetEditor.tsx`（保存/出力 API 配線・dirty 表示）
- Create: `src/app/(dashboard)/properties/[id]/sales-sheets/[sheetId]/edit/page.tsx`（エディタ画面：認証/権限/物件アクセス→design 読込→`<SalesSheetEditor initial=.../>`）
- Create: 新規作成 API（`src/app/api/properties/[id]/sales-sheets/new/route.ts`）：`property:write`＋`canAccessPropertyRecord`＋土地ゲート→**作成フォームの上書き項目を `overridesSchema`(zod)＋`parseJsonBody` で受領**→写真は **`orderBy:[{isPrimary:desc},{sortOrder:asc}]`** で代表優先取得し **`toCanonicalUploadsSrc`** で `/uploads/{key}` 正規化（server backend の `/{bucket}/{key}`/絶対URL も /uploads 形へ・key 解決不可/src 不適合なら写真なし）→**保存前に `isImageKeyAuthorizedForProperty`（caller 認可＋この物件所属）で認可し、NG/別物件/存在しないなら写真を document に入れない（サーバ生成は 422 でなく drop＝未認可 raw key を保存/GET echo させない）**→**現況は `localizeOccupancy`**（enum→空室/入居中/不明）→`buildSaleLandDocument`（**未インライン**・overrides 反映）で初期 document→`createDesign`→`{ id }`(201)。
- Modify: `src/components/sales-sheet/SaleLandSheetButton.tsx`（「販売図面を作成（売土地）」→ **入力フォーム（価格/交通/土地面積/地目/取引態様/引渡/備考＝システムに無い項目）をモーダルで収集**し `buildCreateRequest` で `POST .../sales-sheets/new` へ送信→成功後 `[sheetId]/edit` へ遷移。直接PDFは廃止しエディタ内「出力」に統合。※これら6項目は table 行ゆえ**作成時のみ入力可**＝エディタでの table セル編集は計画④以降）
- Modify: `src/app/(dashboard)/properties/[id]/page.tsx`（ボタン意味変更に追従・土地物件のみ表示は維持。**`property:write` を持たない read-only ユーザーには作成ボタンを表示しない**＝`SaleLandSheetButton` に `canWrite`（=`canWriteProperty`）を渡し false なら `null` 描画。`/sales-sheets/new` は write 必須ゆえ 403 dead-end を防ぐ・route 側の write チェックは維持）
- Test: toolbar/保存配線の薄いテスト＋ route(new) のテスト。**`SaleLandSheetButton` は `canWrite=false`（read-only）で何も描画しない／`canWrite=true` で作成ボタンを描画／土地以外は page 側で非表示**。

**Interfaces:**
- `<EditorToolbar dirty onSave onExport onDelete />`。
- 保存: `PUT .../[sheetId]`（`expectedUpdatedAt` 同送）→ 200 で `markSavedIfCurrent`（送信時 document と一致時のみ dirty 解除＝保存 in-flight 中の編集を取りこぼさない）＋updatedAt 更新 / 409 で「他で更新されました。再読込してください」。
- 出力: 未保存があれば先に保存→ `POST .../[sheetId]/export?format=pdf|png` → blob ダウンロード。chromium 無は 503 を「PDF生成エンジン未準備」と表示。
- 削除: `DELETE .../[sheetId]`→一覧 or 物件詳細へ。

- [ ] **Step 1-5:** 実装＋配線。新規作成は土地物件のみ（計画②の land ゲート流用）。`getApiSession`/権限/`canAccessPropertyRecord` を edit page と new route の双方で課す（サーバー側で防御）。
- [ ] **Step 6: 全ゲート（vitest/tsc/eslint/build）→コミット。**

---

## 完了基準（このプランの「動く増分」）

- 土地物件で「販売図面を作成」→ 物件データ＋写真が入った状態でエディタが開く。
- 要素を選択し、ドラッグ移動／拡縮／重ね順変更／削除、文字の内容・フォント・サイズ・色を編集できる（即時プレビュー）。
- 「保存」で再編集可能なデザインとして永続化（再訪で続きを編集）。
- 「出力」で保存デザインを PDF/画像ダウンロード（サーバーが全画像を認可してから描画＝他物件画像は出ない）。
- 全ゲート緑（vitest/tsc/eslint/build）。新規依存＝react-moveable のみ。migration＝SalesSheetDesign 1本（適用は本番反映時にユーザー承認）。

## 申し送り（後続プランへ）

- 単一レンダラ収束（出力の文字列 serializer ↔ プレビュー `SalesSheetRenderer`。計画②からの繰越・standalone worker 化）はこのプランでも未対応。エディタプレビューはブラウザ側 `SalesSheetRenderer`、出力はサーバー側パイプラインのまま（parity テストで漂流検知）。
- 写真の追加/差し替え/トリミング/パノラマ＝計画④。テンプレ・ギャラリー＝計画⑤。自動レイアウト＝計画⑥。バッジ＝計画⑦。QR/テーマ/表示項目/複製＝計画⑧。
- thumbnailUrl 生成（一覧サムネ）は任意。出力 PNG を縮小保存する形で後続可。
- undo/redo は v1 範囲外（reducer 設計上は履歴スタックを後付け可能）。
- モーダル/エディタの a11y（フォーカス/キーボード操作）は UI 実装時に最低限を入れ、本格対応は仕上げ計画で。
