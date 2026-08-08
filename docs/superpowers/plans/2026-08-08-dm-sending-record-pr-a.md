# DM送付管理 PR-A(送付の記録) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 宛名CSV出力を「POSTで控え作成→GETでダウンロード」の2段階に置き換え、投函後に控え単位で送付記録(PropertyDmLog)を確定できるようにする。個別記録・売却DMブリッジ・名寄せ/物件削除の整合も同時に守る。

**Architecture:** 正本は設計書 `docs/superpowers/specs/2026-08-08-dm-sending-management-design.md` §2(@codex 53巡クリーン・発注者承認済み)。新テーブル5つ+PropertyDmLog列追加(migration-A・additive)。CSVは常に控えのitemsから生成し、初回DLで集合を凍結(downloadedAt+csvDigest)。全writerのロック順序は「Owner→(variant)→物件親行→子行」。

**Tech Stack:** Next.js App Router route handlers / Prisma + PostgreSQL / vitest(node env・prisma mock)/ 既存lib(dm-export.ts, property-record-guard.ts, audit.ts)。

## Global Constraints

- **PR順序は A→B→C→D 固定**。本計画はPR-Aのみ。反響列(reaction_*)・孤児記録管理(orphan-dm-logs)・再送候補述語はPR-B/Cで実装(本計画の資格検査は (1)(3)(4)(6) を実装し、(2)terminal反響・(5)候補再評価は列が生まれるPR-B/Cで**同じ共通述語関数に追加**する)。
- 1タスク=TDD(失敗テスト→最小実装→GREEN)。「緑」報告前はフルスイート `npx vitest run`(対象限定不可)。
- 全ゲート: `npx tsc --noEmit` / `npx vitest run` / `npx eslint <変更ファイル>` / `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build`。
- **`crypto.randomUUID` 禁止**(本番HTTP)→ クライアントは `src/lib/random-id.ts` の `safeRandomId` を使う。サーバは `node:crypto` の `randomUUID`/`createHash` 可。
- migration は additive のみ(DROP禁止・enum新設禁止=TEXT+アプリallowlist)。migration SQL先頭に業務意図の日本語コメント。
- 監査 detail にPII(氏名・住所・note本文)を載せない。新actionは `ACTION_EXTRA_KEYS` 登録必須。
- UI文言は平易な日本語。PR説明・コミットも日本語(機能名で説明)。
- コミット末尾: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session: <現行セッションURL>`。
- 新規依存の追加なし。

## 事前セットアップ(Task 0)

```bash
cd C:\Users\issin\Desktop\Claude\property-management
git fetch origin main
git worktree add ../property-management-worktrees/dm-sending-record -b feat/dm-sending-record origin/main
cd ../property-management-worktrees/dm-sending-record
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
npx prisma generate
npx vitest run src/lib/__tests__/properties-dm-export-route.test.ts src/lib/__tests__/dm-logs-route.test.ts   # baseline緑を確認
```

※設計書2本はPR #363(未マージでも可)にあるため、この worktree には無くてよい。計画・設計の参照は絶対パス `C:\Users\issin\Desktop\Claude\property-management-worktrees\dm-mgmt-design\docs\superpowers\specs\` で行う。

---

### Task 1: migration-A(スキーマ+SQL+配線テスト)

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260808120000_add_dm_sending_records/migration.sql`
- Test: `src/lib/__tests__/dm-batch-migration-source.test.ts`

**Interfaces:**
- Produces: Prismaモデル `DmExportBatch` / `DmExportBatchItem` / `DmExportBatchItemOwner` / `PropertyDmLogOwner` / `DmRecipientDraftOwner`、`PropertyDmLog` の新列(`ownerId`/`dmType`/`batchId`/`draftId`/`updatedAt`、`propertyId` nullable化)。後続タスクはすべてこの型を使う。

- [ ] **Step 1: 配線テストを先に書く(migration SQLの安全性ピン)**

```ts
// src/lib/__tests__/dm-batch-migration-source.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const read = (p: string) =>
  readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const SQL = read(
  "prisma/migrations/20260808120000_add_dm_sending_records/migration.sql",
);
const SCHEMA = read("prisma/schema.prisma");

describe("migration-A(DM送付記録)の安全性", () => {
  it("additive のみ(DROP/型変更を含まない)", () => {
    expect(SQL).not.toMatch(/DROP (TABLE|COLUMN|INDEX)/i);
    expect(SQL).not.toMatch(/CREATE TYPE|ALTER TYPE/i); // enum 新設禁止(#361 方針)
  });
  it("PropertyDmLog: property_id が nullable + SetNull(削除で履歴を道連れにしない=R49)", () => {
    expect(SQL).toMatch(/ALTER TABLE "property_dm_logs" ALTER COLUMN "property_id" DROP NOT NULL/);
    expect(SQL).toMatch(/property_dm_logs_property_id_fkey/);
    expect(SQL).toMatch(/ON DELETE SET NULL/);
    expect(SCHEMA).toMatch(/model PropertyDmLog[\s\S]*?propertyId String\?/);
  });
  it("既存行の updated_at は DEFAULT now() で埋める(NOT NULL 追加で落ちない)", () => {
    expect(SQL).toMatch(/ADD COLUMN\s+"updated_at" TIMESTAMP\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP/);
  });
  it("連関3表すべてに owner_id 先頭の索引(R46)", () => {
    for (const t of [
      "dm_export_batch_item_owners",
      "property_dm_log_owners",
      "dm_recipient_draft_owners",
    ]) {
      expect(SQL).toMatch(new RegExp(`CREATE INDEX "${t}_owner_id_idx" ON "${t}"\\("owner_id"\\)`));
    }
  });
  it("PropertyDmLog の新索引: [property_id, sent_at] / [owner_id] / [draft_id](R45)", () => {
    expect(SQL).toMatch(/"property_dm_logs_property_id_sent_at_idx"/);
    expect(SQL).toMatch(/"property_dm_logs_owner_id_idx"/);
    expect(SQL).toMatch(/"property_dm_logs_draft_id_idx"/);
  });
  it("バッチ item の property FK は SetNull(R49)・owner FK は SetNull", () => {
    expect(SQL).toMatch(/"dm_export_batch_items"[\s\S]*?"property_id"[\s\S]*?ON DELETE SET NULL/);
    expect(SQL).toMatch(/"dm_export_batch_items"[\s\S]*?"owner_id"[\s\S]*?ON DELETE SET NULL/);
  });
});
```

- [ ] **Step 2: `npx vitest run src/lib/__tests__/dm-batch-migration-source.test.ts` → FAIL(ファイル無し)を確認**

- [ ] **Step 3: schema.prisma を編集**

`PropertyDmLog` を以下に置き換え(既存モデルの変更):

```prisma
model PropertyDmLog {
  id         String    @id @default(uuid()) @db.Uuid
  propertyId String?   @map("property_id") @db.Uuid // R49: 物件削除で null 化(履歴は所有者側に残す)
  sentAt     DateTime  @map("sent_at") @db.Date
  method     String?
  sentBy     String    @map("sent_by") @db.Uuid
  note       String?
  createdAt  DateTime  @default(now()) @map("created_at")
  // --- PR-A 追加列 ---
  ownerId    String?   @map("owner_id") @db.Uuid    // 代表所有者。個別記録・旧行は null
  dmType     String?   @map("dm_type")              // "owner_address"/"property_address"。旧行・sale_dmブリッジは null(TEXT+アプリallowlist)
  batchId    String?   @map("batch_id") @db.Uuid    // 一括確定のトレース(FKは張らない=バッチ削除と独立)
  draftId    String?   @map("draft_id") @db.Uuid    // 売却DMブリッジ(反響同期用・FKは張らない)
  updatedAt  DateTime  @updatedAt @map("updated_at")

  property Property? @relation(fields: [propertyId], references: [id], onDelete: SetNull)
  owner    Owner?    @relation(fields: [ownerId], references: [id], onDelete: SetNull)
  sender   User      @relation(fields: [sentBy], references: [id])
  logOwners PropertyDmLogOwner[]

  @@index([propertyId])
  @@index([propertyId, sentAt])
  @@index([ownerId])
  @@index([draftId])
  @@map("property_dm_logs")
}
```

新モデル5つを追加(`PropertyDmLog` の直後):

```prisma
model DmExportBatch {
  id          String    @id @default(uuid()) @db.Uuid
  dmType      String    @map("dm_type")             // "owner_address"(現行UIはこれのみ)
  filters     Json?                                  // 監査用の出力条件(allowlist済みキーのみ)
  rowCount    Int       @map("row_count")            // CSV行数(=宛先件数)
  createdBy   String    @map("created_by") @db.Uuid
  createdAt   DateTime  @default(now()) @map("created_at")
  attemptKey  String    @unique @map("attempt_key")  // 押下ごとの冪等キー
  downloadedAt DateTime? @map("downloaded_at")       // 初回DLの刻印(凍結境界・確定の前提)
  csvDigest   String?   @map("csv_digest")           // 初回DLのCSVのsha256(PIIは持たない)
  resendFilterApplied Boolean @default(false) @map("resend_filter_applied") // PR-Cで使用
  confirmedAt DateTime? @map("confirmed_at")         // null=未確定
  confirmedBy String?   @map("confirmed_by") @db.Uuid
  sentOn      DateTime? @map("sent_on") @db.Date     // 投函日(確定時に入力)
  items       DmExportBatchItem[]
  creator     User      @relation("DmExportBatchCreator", fields: [createdBy], references: [id])
  @@index([createdAt])
  @@map("dm_export_batches")
}

model DmExportBatchItem {
  id         String  @id @default(uuid()) @db.Uuid
  batchId    String  @map("batch_id") @db.Uuid
  propertyId String? @map("property_id") @db.Uuid  // R49: 物件削除で null 化
  ownerId    String? @map("owner_id") @db.Uuid     // 代表所有者。物件宛は null
  batch      DmExportBatch @relation(fields: [batchId], references: [id], onDelete: Cascade)
  property   Property?     @relation(fields: [propertyId], references: [id], onDelete: SetNull)
  owner      Owner?        @relation(fields: [ownerId], references: [id], onDelete: SetNull)
  itemOwners DmExportBatchItemOwner[]
  @@index([batchId])
  @@map("dm_export_batch_items")
}

model DmExportBatchItemOwner {
  itemId  String @map("item_id") @db.Uuid
  ownerId String @map("owner_id") @db.Uuid
  item    DmExportBatchItem @relation(fields: [itemId], references: [id], onDelete: Cascade)
  owner   Owner             @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  @@id([itemId, ownerId])
  @@index([ownerId])
  @@map("dm_export_batch_item_owners")
}

model PropertyDmLogOwner {
  logId   String @map("log_id") @db.Uuid
  ownerId String @map("owner_id") @db.Uuid
  log     PropertyDmLog @relation(fields: [logId], references: [id], onDelete: Cascade)
  owner   Owner         @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  @@id([logId, ownerId])
  @@index([ownerId])
  @@map("property_dm_log_owners")
}

model DmRecipientDraftOwner {
  draftId String @map("draft_id") @db.Uuid
  ownerId String @map("owner_id") @db.Uuid
  draft   DmRecipientDraft @relation(fields: [draftId], references: [id], onDelete: Cascade)
  owner   Owner            @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  @@id([draftId, ownerId])
  @@index([ownerId])
  @@map("dm_recipient_draft_owners")
}
```

逆リレーションの追加(既存モデルに1行ずつ):
- `Property`: `dmExportBatchItems DmExportBatchItem[]`
- `Owner`: `dmLogs PropertyDmLog[]` / `dmBatchItems DmExportBatchItem[]` / `dmBatchItemOwners DmExportBatchItemOwner[]` / `dmLogOwners PropertyDmLogOwner[]` / `dmDraftOwners DmRecipientDraftOwner[]`
- `User`: `dmExportBatches DmExportBatch[] @relation("DmExportBatchCreator")`
- `DmRecipientDraft`: `draftOwners DmRecipientDraftOwner[]`

- [ ] **Step 4: migration.sql を手書きで作成**(#361 のスタイル。先頭コメント+CreateTable/CreateIndex/AddForeignKey)

```sql
-- DM送付管理 PR-A(送付の記録)。控えバッチ2表+共有者連関3表+PropertyDmLog列追加。
-- additive・新enumなし(dm_type/method は TEXT+アプリ側allowlist)。
-- property_dm_logs.property_id は nullable 化+SET NULL(物件削除で拒否/宛先不明の
-- 履歴を道連れにしない=所有者横断の再送除外を守る)。既存データは変更しない。

-- AlterTable: property_dm_logs 列追加
ALTER TABLE "property_dm_logs" ADD COLUMN "owner_id" UUID;
ALTER TABLE "property_dm_logs" ADD COLUMN "dm_type" TEXT;
ALTER TABLE "property_dm_logs" ADD COLUMN "batch_id" UUID;
ALTER TABLE "property_dm_logs" ADD COLUMN "draft_id" UUID;
ALTER TABLE "property_dm_logs" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable: property_id nullable 化+FK を SET NULL へ(R49)
ALTER TABLE "property_dm_logs" ALTER COLUMN "property_id" DROP NOT NULL;
ALTER TABLE "property_dm_logs" DROP CONSTRAINT "property_dm_logs_property_id_fkey";
ALTER TABLE "property_dm_logs" ADD CONSTRAINT "property_dm_logs_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: owner_id
ALTER TABLE "property_dm_logs" ADD CONSTRAINT "property_dm_logs_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex: property_dm_logs
CREATE INDEX "property_dm_logs_property_id_sent_at_idx" ON "property_dm_logs"("property_id", "sent_at");
CREATE INDEX "property_dm_logs_owner_id_idx" ON "property_dm_logs"("owner_id");
CREATE INDEX "property_dm_logs_draft_id_idx" ON "property_dm_logs"("draft_id");

-- CreateTable
CREATE TABLE "dm_export_batches" (
    "id" UUID NOT NULL,
    "dm_type" TEXT NOT NULL,
    "filters" JSONB,
    "row_count" INTEGER NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempt_key" TEXT NOT NULL,
    "downloaded_at" TIMESTAMP(3),
    "csv_digest" TEXT,
    "resend_filter_applied" BOOLEAN NOT NULL DEFAULT false,
    "confirmed_at" TIMESTAMP(3),
    "confirmed_by" UUID,
    "sent_on" DATE,
    CONSTRAINT "dm_export_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dm_export_batch_items" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "property_id" UUID,
    "owner_id" UUID,
    CONSTRAINT "dm_export_batch_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable(連関3表: 複合PK+owner_id先頭索引)
CREATE TABLE "dm_export_batch_item_owners" (
    "item_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    CONSTRAINT "dm_export_batch_item_owners_pkey" PRIMARY KEY ("item_id", "owner_id")
);
CREATE TABLE "property_dm_log_owners" (
    "log_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    CONSTRAINT "property_dm_log_owners_pkey" PRIMARY KEY ("log_id", "owner_id")
);
CREATE TABLE "dm_recipient_draft_owners" (
    "draft_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    CONSTRAINT "dm_recipient_draft_owners_pkey" PRIMARY KEY ("draft_id", "owner_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dm_export_batches_attempt_key_key" ON "dm_export_batches"("attempt_key");
CREATE INDEX "dm_export_batches_created_at_idx" ON "dm_export_batches"("created_at");
CREATE INDEX "dm_export_batch_items_batch_id_idx" ON "dm_export_batch_items"("batch_id");
CREATE INDEX "dm_export_batch_item_owners_owner_id_idx" ON "dm_export_batch_item_owners"("owner_id");
CREATE INDEX "property_dm_log_owners_owner_id_idx" ON "property_dm_log_owners"("owner_id");
CREATE INDEX "dm_recipient_draft_owners_owner_id_idx" ON "dm_recipient_draft_owners"("owner_id");

-- AddForeignKey
ALTER TABLE "dm_export_batches" ADD CONSTRAINT "dm_export_batches_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dm_export_batch_items" ADD CONSTRAINT "dm_export_batch_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "dm_export_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dm_export_batch_items" ADD CONSTRAINT "dm_export_batch_items_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "dm_export_batch_items" ADD CONSTRAINT "dm_export_batch_items_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "dm_export_batch_item_owners" ADD CONSTRAINT "dm_export_batch_item_owners_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "dm_export_batch_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dm_export_batch_item_owners" ADD CONSTRAINT "dm_export_batch_item_owners_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "property_dm_log_owners" ADD CONSTRAINT "property_dm_log_owners_log_id_fkey" FOREIGN KEY ("log_id") REFERENCES "property_dm_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "property_dm_log_owners" ADD CONSTRAINT "property_dm_log_owners_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dm_recipient_draft_owners" ADD CONSTRAINT "dm_recipient_draft_owners_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "dm_recipient_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dm_recipient_draft_owners" ADD CONSTRAINT "dm_recipient_draft_owners_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 5: `npx prisma generate` → `npx vitest run src/lib/__tests__/dm-batch-migration-source.test.ts` → PASS**
- [ ] **Step 6: `npx tsc --noEmit` = 0 を確認**(既存コードは新列を参照していないので通るはず)
- [ ] **Step 7: Commit** `feat(dm): 送付記録の土台(バッチ控え・共有者連関・PropertyDmLog列追加)`

---

### Task 2: 共通lib(ロックヘルパー+資格述語+CSV組み立て+methodラベル)

**Files:**
- Create: `src/lib/dm-batch/locks.ts`
- Create: `src/lib/dm-batch/eligibility.ts`
- Create: `src/lib/dm-batch/csv.ts`
- Create: `src/lib/dm-method-labels.ts`
- Test: `src/lib/dm-batch/__tests__/eligibility.test.ts`, `src/lib/dm-batch/__tests__/csv.test.ts`, `src/lib/__tests__/dm-method-labels.test.ts`

**Interfaces:**
- Consumes: `groupPropertyOwnersByAddress` / `selectGroupRepresentative` / `buildDmRow` / `DM_EXPORT_HEADERS` / `DmRowPropertyOwner`(`@/lib/dm-export`)
- Produces(後続タスクが使う正確な型):

```ts
// locks.ts
export type RawTx = { $queryRaw: <T>(q: TemplateStringsArray, ...v: unknown[]) => Promise<T> };
export async function lockOwnersForShare(tx: RawTx, ownerIds: string[]): Promise<void>;
export async function lockOwnersForUpdate(tx: RawTx, ownerIds: string[]): Promise<void>;
export async function lockPropertiesForShare(tx: RawTx, propertyIds: string[]): Promise<void>;
export async function lockPropertiesForUpdate(tx: RawTx, propertyIds: string[]): Promise<void>;
// ↑ すべて: ids を uniq + 昇順ソートし、空なら no-op。
//   SELECT id FROM <table> WHERE id = ANY(...) ORDER BY id FOR SHARE/FOR UPDATE。
//   全呼び出し元が同一形の文を使うことで取得順を揃える(順序規約 Owner→親→子)。

// eligibility.ts
export interface BatchItemForCheck {
  id: string;
  propertyId: string | null;
  ownerId: string | null;
  groupOwnerIds: string[]; // item_owners 全員(代表含む)
}
export interface PropertyStateForCheck {
  id: string;
  dmStatus: string;
  isArchived: boolean;
  createdBy: string;
  assignedTo: string | null;
  // 現在の PropertyOwner(非アーカイブ)→ groupPropertyOwnersByAddress 再計算用
  propertyOwners: Array<{ isPrimary: boolean; relationship: string | null;
    owner: { id: string; name: string | null; nameKana: string | null; zip: string | null;
             address: string | null; corporateNumber: string | null } }>;
}
export interface EligibilityResult {
  prunedItemIds: string[];   // (4) owner/property 削除で null の item(初回GETのみ物理削除)
  scopeMissingCount: number; // (1) record scope 欠け → 403
  stateIssueCount: number;   // (3) リンク切れ or 送付不能(dmStatus!=send / isArchived) → 409
  groupMismatchCount: number; // (6) 住所グループ再計算と不一致 → 409
}
export function checkBatchEligibility(
  items: BatchItemForCheck[],
  properties: Map<string, PropertyStateForCheck>,
  session: { id: string; role: string },
): EligibilityResult;
// (2)terminal反響 と (5)候補再評価 は PR-B/PR-C で本関数に引数と検査を追加する(設計書§2.1)。

// csv.ts
export interface BatchCsvSource {
  items: Array<{ id: string; propertyId: string; ownerId: string; groupOwnerIds: string[] }>;
  properties: Map<string, PropertyStateForCheck>; // eligibility.ts の型を再利用
  importSourceMap: Map<string, string>;
  ownerDisplayConfig: import("@/lib/api-helpers").OwnerDisplayConfig;
}
export function buildBatchCsv(src: BatchCsvSource): string; // BOM+CRLF・formula無害化済み
export function sha256Hex(text: string): string;            // node:crypto createHash("sha256")

// dm-method-labels.ts
export const DM_METHOD_LABELS: Readonly<Record<string, string>> = {
  mail: "郵送", sale_dm: "売却DM", hand_delivery: "手渡し", other: "その他",
};
export function dmMethodLabel(method: string | null): string; // 不明値は生値のまま返す(旧データ互換)・null は ""
```

- [ ] **Step 1: eligibility の失敗テストを書く**(純関数・prisma不要)

```ts
// src/lib/dm-batch/__tests__/eligibility.test.ts
import { describe, it, expect } from "vitest";
import { checkBatchEligibility, type BatchItemForCheck, type PropertyStateForCheck } from "../eligibility";

const ADMIN = { id: "u-admin", role: "admin" };
const FIELD = { id: "u-field", role: "field_staff" };

function prop(over: Partial<PropertyStateForCheck> = {}): PropertyStateForCheck {
  return {
    id: "p1", dmStatus: "send", isArchived: false, createdBy: "u-admin", assignedTo: null,
    propertyOwners: [
      { isPrimary: true, relationship: null,
        owner: { id: "o1", name: "甲", nameKana: null, zip: "100-0001", address: "東京都A", corporateNumber: null } },
    ],
    ...over,
  };
}
const item = (over: Partial<BatchItemForCheck> = {}): BatchItemForCheck => ({
  id: "i1", propertyId: "p1", ownerId: "o1", groupOwnerIds: ["o1"], ...over,
});

describe("checkBatchEligibility", () => {
  it("問題なしなら全カウント0", () => {
    const r = checkBatchEligibility([item()], new Map([["p1", prop()]]), ADMIN);
    expect(r).toEqual({ prunedItemIds: [], scopeMissingCount: 0, stateIssueCount: 0, groupMismatchCount: 0 });
  });
  it("(4) owner/property が null の item は pruned に入る(他の検査対象にしない)", () => {
    const r = checkBatchEligibility(
      [item({ id: "i-null", ownerId: null })], new Map([["p1", prop()]]), ADMIN);
    expect(r.prunedItemIds).toEqual(["i-null"]);
    expect(r.stateIssueCount).toBe(0);
  });
  it("(1) field_staff のスコープ外物件は scopeMissing", () => {
    const r = checkBatchEligibility([item()], new Map([["p1", prop()]]), FIELD);
    expect(r.scopeMissingCount).toBe(1);
  });
  it("(3) dmStatus=hold / isArchived / リンク切れは stateIssue(R48/R52)", () => {
    expect(checkBatchEligibility([item()], new Map([["p1", prop({ dmStatus: "hold" })]]), ADMIN).stateIssueCount).toBe(1);
    expect(checkBatchEligibility([item()], new Map([["p1", prop({ isArchived: true })]]), ADMIN).stateIssueCount).toBe(1);
    // リンク切れ: 現在の propertyOwners に o1 がいない
    const unlinked = prop({ propertyOwners: [{ isPrimary: true, relationship: null,
      owner: { id: "o9", name: "乙", nameKana: null, zip: "100-0001", address: "東京都A", corporateNumber: null } }] });
    expect(checkBatchEligibility([item()], new Map([["p1", unlinked]]), ADMIN).stateIssueCount).toBe(1);
  });
  it("(6) 所有者追加でグループ構成が変わったら groupMismatch(R51)", () => {
    const grown = prop({ propertyOwners: [
      { isPrimary: true, relationship: null, owner: { id: "o1", name: "甲", nameKana: null, zip: "100-0001", address: "東京都A", corporateNumber: null } },
      { isPrimary: false, relationship: null, owner: { id: "o2", name: "乙", nameKana: null, zip: "100-0001", address: "東京都A", corporateNumber: null } },
    ] });
    const r = checkBatchEligibility([item()], new Map([["p1", grown]]), ADMIN);
    expect(r.groupMismatchCount).toBe(1);
  });
  it("物件が Map に無い item は pruned 扱い(物件削除直後)", () => {
    const r = checkBatchEligibility([item()], new Map(), ADMIN);
    expect(r.prunedItemIds).toEqual(["i1"]);
  });
});
```

- [ ] **Step 2: RED 確認 → 実装**

`eligibility.ts` の実装要点(コードで示す):

```ts
import { groupPropertyOwnersByAddress, selectGroupRepresentative, type DmRowPropertyOwner } from "@/lib/dm-export";
import { canAccessPropertyRecord } from "@/lib/property-access";

export function checkBatchEligibility(items, properties, session): EligibilityResult {
  const prunedItemIds: string[] = [];
  let scopeMissingCount = 0, stateIssueCount = 0, groupMismatchCount = 0;
  for (const it of items) {
    const prop = it.propertyId ? properties.get(it.propertyId) : undefined;
    if (!it.ownerId || !it.propertyId || !prop) { prunedItemIds.push(it.id); continue; }
    if (!canAccessPropertyRecord(session, prop)) { scopeMissingCount++; continue; }
    if (prop.dmStatus !== "send" || prop.isArchived) { stateIssueCount++; continue; }
    const linked = new Set(prop.propertyOwners.map((po) => po.owner.id));
    if (!it.groupOwnerIds.every((oid) => linked.has(oid))) { stateIssueCount++; continue; }
    // (6) 現在値でグループ再計算し、この item の代表の属すグループが保存集合と完全一致するか
    const { groups } = groupPropertyOwnersByAddress(prop.propertyOwners as DmRowPropertyOwner[]);
    const current = groups.find((g) =>
      (selectGroupRepresentative(g).owner as { id: string }).id === it.ownerId);
    const currentIds = current
      ? new Set(current.map((po) => (po.owner as { id: string }).id)) : new Set<string>();
    const saved = new Set(it.groupOwnerIds);
    const same = currentIds.size === saved.size && [...saved].every((x) => currentIds.has(x));
    if (!same) { groupMismatchCount++; }
  }
  return { prunedItemIds, scopeMissingCount, stateIssueCount, groupMismatchCount };
}
```

※`DmRowPropertyOwner.owner` に `id` を含めて渡す(型は `owner: DmRowOwner & { id: string }` 相当。`groupPropertyOwnersByAddress` は追加プロパティを保持する)。

- [ ] **Step 3: csv.ts のテスト→実装**(`buildBatchCsv` は既存 `buildDmRow`+`encodeCsv`+`sanitizeCsvCellForExcel` を items 順で呼ぶだけ。`sha256Hex` は `createHash("sha256").update(text,"utf8").digest("hex")`。テストは「同一入力→同一digest」「1文字違い→別digest」「BOMで始まる」「数式インジェクション無害化(`=SUM` 先頭セルが `'=` になる)」の4本)
- [ ] **Step 4: dm-method-labels のテスト→実装**(sale_dm→売却DM / mail→郵送 / 未知値 "fax" は "fax" のまま / null→"")
- [ ] **Step 5: locks.ts の実装**(純SQL側は結合テスト不能のためユニットは省略し、Task 12 の配線テストでソース固定する。ids の uniq+sort+空no-opのみ `describe("lockヘルパーの前処理")` でテスト可能なら `sortUniqueIds(ids: string[]): string[]` をexportしてテストする)

```ts
export function sortUniqueIds(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}
export async function lockOwnersForShare(tx: RawTx, ownerIds: string[]): Promise<void> {
  const ids = sortUniqueIds(ownerIds);
  if (ids.length === 0) return;
  await tx.$queryRaw`SELECT id FROM owners WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR SHARE`;
}
// lockOwnersForUpdate / lockPropertiesForShare / lockPropertiesForUpdate も同形(FOR UPDATE / properties)。
```

- [ ] **Step 6: フル `npx vitest run` → PASS → Commit** `feat(dm): バッチ控えの共通lib(ロック順序・宛先資格述語・CSV組み立て)`

---

### Task 3: POST /api/properties/dm-batches(控え作成・旧GET撤去)

**Files:**
- Create: `src/app/api/properties/dm-batches/route.ts`(POST と、Task 5 の GET を後で同居)
- Delete: `src/app/api/properties/dm-export/route.ts`
- Modify: `src/lib/__tests__/properties-dm-export-route.test.ts`(POST 向けに改修)
- Modify: `src/lib/audit-log-detail-safety.ts`(`property_dm_csv_export` に `batchId` 登録 ほか)

**Interfaces:**
- Consumes: `buildPropertyListWhere` / `buildPropertyListOrderBy` / `propertyListQuerySchema` / `groupPropertyOwnersByAddress` / `selectGroupRepresentative` / `MAX_DM_EXPORT_ROWS`(すべて既存)
- Produces: `POST /api/properties/dm-batches` body=`{ filters: Record<string,string>, attemptKey: string }` → 200 `{ batchId: string, rowCount: number, skippedCount: number, skippedAddressMissingCount: number, reused: boolean }`。403(4権限+plain欠け)/400(上限1万・zod)/409(attemptKey が確定済みバッチ)。

- [ ] **Step 1: 既存テストの改修方針を先に固定**(RED)

`src/lib/__tests__/properties-dm-export-route.test.ts` を `dm-batches-post-route.test.ts` にリネームし、import を `import { POST } from "../../app/api/properties/dm-batches/route";` に変更。維持するピン(呼び方だけPOSTに変える): 4権限それぞれの403・表示レベル403・dmStatus=send/isArchived=false 強制・上限1万の400・mgmtShortCircuitEmpty。**「PropertyDmLog にはどの段でも書かない」ピンは維持**し、新ピン「POST は dmExportBatch/dmExportBatchItem/dmExportBatchItemOwner を書く」を追加:

```ts
  it("POST は控え(バッチ+items+共有者連関)を書き、PropertyDmLog は書かない", async () => {
    pm.property.findMany.mockResolvedValue([makeProp({ propertyOwners: [
      makePropertyOwner({ owner: { id: "o1", name: "親 太郎", zip: "100-0001", address: "東京都港区3-3" } }),
      makePropertyOwner({ owner: { id: "o2", name: "子 次郎", zip: "100-0001", address: "東京都港区3-3" }, isPrimary: false }),
    ] })]);
    const res = await POST(makeRequest({ filters: {}, attemptKey: "k-1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.batchId).toBeTruthy();
    expect(body.rowCount).toBe(1);            // 同一住所グループ=1通
    expect(pm.dmExportBatch.create).toHaveBeenCalledTimes(1);
    // 連関はグループ全員(o1,o2)
    const itemOwnersArg = pm.dmExportBatchItemOwner.createMany.mock.calls[0][0];
    expect(itemOwnersArg.data.map((d: { ownerId: string }) => d.ownerId).sort()).toEqual(["o1", "o2"]);
    expect(pm.propertyDmLog.create).not.toHaveBeenCalled();
    expect(pm.propertyDmLog.createMany).not.toHaveBeenCalled();
  });
  it("attemptKey 再POSTは未確定なら既存バッチを再利用(reused=true)・確定済みは409", async () => { /* FOR UPDATE 照会をmock */ });
```

- [ ] **Step 2: POST 実装**(旧 dm-export GET のロジックを移植)

流れ(旧routeの§2〜7と同一+バッチ保存):
1. 4権限+plain ゲート(旧routeの検査を逐語移植)
2. `z.object({ filters: z.record(z.string(), z.string()), attemptKey: z.string().min(8).max(128) })` で body parse → `propertyListQuerySchema.parse(filters)`
3. attemptKey 既存照会: `$transaction` 内で `SELECT id, confirmed_at FROM dm_export_batches WHERE attempt_key = ${attemptKey} FOR UPDATE` → 行あり: `confirmed_at` null なら `{ batchId, reused: true }` を返して終了・非null なら 409 `ALREADY_CONFIRMED`
4. `buildPropertyListWhere` + `dmStatus="send"` / `isArchived=false` 強制 + mailable owners + `take: MAX+1` + 上限2段ガード(旧ロジックそのまま。**select に owner.id を追加**)
5. グルーピング → items 組み立て(1グループ=1item: propertyId+代表ownerId+グループ全員)
6. tx で `dmExportBatch.create`(dmType:"owner_address"・filters=旧 `AUDIT_FILTER_KEYS` allowlist 済みJSON・rowCount・attemptKey)→ `dmExportBatchItem.createMany`(id はアプリ側で `randomUUID()`(node:crypto)を割り当て)→ `dmExportBatchItemOwner.createMany`。P2002(attempt_key)は catch して勝者を取り直す(3.と同じ応答)
7. 監査はここでは書かない(PII開示はGET時=Task 4)
8. 200 `{ batchId, rowCount, skippedCount, skippedAddressMissingCount, reused: false }`

- [ ] **Step 3: 旧 `src/app/api/properties/dm-export/route.ts` を削除**(UI 呼び出しは Task 10 で差し替え。他に参照が無いことを `grep -rn "dm-export" src/` で確認——`src/lib/dm-export.ts`(lib)と区別すること)
- [ ] **Step 4: `ACTION_EXTRA_KEYS` 追記**(Task 4 の監査で使うキーを先に登録):

```ts
  // DM送付記録(PR-A)。batchId/attempt系のUUID・ISO日時のみ。氏名・住所はdetailに載せない。
  property_dm_csv_export: new Set(["batchId", "retry", "exportedAt"]),
  dm_batch_create: new Set(["batchId", "reused", "createdAt"]),
```

(既存 `property_dm_csv_export` は未登録だった=exportedAt等はALWAYS_SAFEで見えていた。`skippedAddressMissingCount` が `/addr/i` denylist で潰れる既存問題は `ACTION_NUMERIC_FORCE_SAFE_KEYS` に `property_dm_csv_export: new Set(["skippedAddressMissingCount"])` を足して同時に直す)
- [ ] **Step 5: POST 完了時に `writeAuditLog({ action: "dm_batch_create", targetTable: "dm_export_batches", targetId: batchId, detail: { batchId, count: rowCount, reused, createdAt } })` を追加**(検索条件は batch.filters 列に保存済みのため detail 重複不要)
- [ ] **Step 6: フル `npx vitest run` → PASS → Commit** `feat(dm): 宛名CSV出力を2段階化(POSTで控え作成・旧GET撤去)`

---

### Task 4: GET /api/properties/dm-batches/[id]/csv(初回凍結+再試行)

**Files:**
- Create: `src/app/api/properties/dm-batches/[id]/csv/route.ts`
- Test: `src/lib/__tests__/dm-batch-csv-route.test.ts`

**Interfaces:**
- Consumes: Task 2 の `lockOwnersForShare` / `lockPropertiesForShare` / `checkBatchEligibility` / `buildBatchCsv` / `sha256Hex`、既存 `getOwnerDisplayConfig` / `isPlainOwnerLevel` / `loadImportSourceMap`
- Produces: `GET /api/properties/dm-batches/[id]/csv` → 200 text/csv(no-store・`dm_merge_<YYYYMMDD>.csv`)。404(他人/不存在)・403(4権限/plain/スコープ欠け)・409(資格・グループ・digest不一致。bodyの `error.code` は `REEXPORT_REQUIRED`)。

- [ ] **Step 1: 失敗テストを書く**(mockは sale-dm-variants 方式: `db.$transaction = vi.fn(async (fn) => fn(db)); db.$queryRaw = vi.fn(async () => [])`)

必須ケース:
1. 作成者本人以外は 404(存在を漏らさない)
2. 4権限欠け/plain欠けは 403・prisma未呼び出し(fail-closed)
3. 初回GET成功: `$queryRaw` が Owner FOR SHARE→property FOR SHARE→batch FOR UPDATE の順で呼ばれ(呼び出し順を `mock.calls` のSQL文字列で検証)、`dmExportBatch.update` が `{ downloadedAt, csvDigest, rowCount }` を書く。レスポンスは text/csv+BOM
4. 初回GET: null item(owner削除)は `dmExportBatchItem.deleteMany` されて rowCount 再計算(R45)
5. 初回GET: dmStatus=hold の物件が混ざると 409・**凍結もdigest保存もしない**(R48/R52)
6. 初回GET: グループ構成が変わったら 409(R51)
7. field_staff スコープ欠け 403(R44)
8. 再試行GET(downloadedAt 設定済み): 内容一致なら 200・resendFilterApplied に関わらず資格検査を毎回実施(R53)・digest不一致なら 409(R43)
9. 監査: 成功時のみ `property_dm_csv_export` が `{ batchId, retry, count, exportedAt }` で書かれる

- [ ] **Step 2: 実装**(骨子)

```ts
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: batchId } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    // 旧 dm-export と同じ 4権限+plain ゲート(Task 3 と共通化して helper 化してよい)
    requireDmExportGates(permissions);                       // 403
    const ownerDisplayConfig = await getOwnerDisplayConfig(session.id, permissions);
    requirePlainOwnerLevels(ownerDisplayConfig);             // 403

    // 作成者本人のみ(404 で存在を漏らさない)
    const batch0 = await prisma.dmExportBatch.findFirst({
      where: { id: batchId, createdBy: session.id },
      select: { id: true, downloadedAt: true },
    });
    if (!batch0) throw new ApiError(404, "出力の控えが見つかりません", "NOT_FOUND");

    const result = await prisma.$transaction(async (tx) => {
      // 先読み(ロックなし)→ 順序規約: Owner(FOR SHARE)→物件親行(FOR SHARE)→バッチ行(FOR UPDATE)→items再読取
      const pre = await readItemsWithOwners(tx, batchId);    // items+item_owners
      await lockOwnersForShare(tx, pre.allOwnerIds);
      await lockPropertiesForShare(tx, pre.allPropertyIds);
      const batchRow = await tx.$queryRaw<{ id: string; downloaded_at: Date | null; csv_digest: string | null; resend_filter_applied: boolean }[]>`
        SELECT id, downloaded_at, csv_digest, resend_filter_applied FROM dm_export_batches WHERE id = ${batchId}::uuid FOR UPDATE`;
      const items = await readItemsWithOwners(tx, batchId);  // 再読取
      if (!sameItemSets(pre, items)) throw new ApiError(409, "宛先の状態が変わりました。もう一度開いてください", "RETRY");
      const properties = await loadPropertyStates(tx, items.allPropertyIds); // dmStatus/isArchived/scope/propertyOwners(owner.id込み)
      const elig = checkBatchEligibility(items.forCheck, properties, session);
      if (elig.scopeMissingCount > 0)
        throw new ApiError(403, `担当範囲が変わったため出力できません(${elig.scopeMissingCount}件)。再出力してください`, "FORBIDDEN");
      if (elig.stateIssueCount > 0 || elig.groupMismatchCount > 0)
        throw new ApiError(409, "宛先の状態が変わったため、この控えは使えません。再出力してください", "REEXPORT_REQUIRED");

      const isFirst = batchRow[0].downloaded_at == null;
      if (isFirst && elig.prunedItemIds.length > 0) {
        await tx.dmExportBatchItem.deleteMany({ where: { id: { in: elig.prunedItemIds } } });
      }
      if (!isFirst && elig.prunedItemIds.length > 0)  // DL後の削除で描画不能=digest不一致確定
        throw new ApiError(409, "内容が変わったため再出力してください", "REEXPORT_REQUIRED");

      const survive = items.forCsv.filter((it) => !elig.prunedItemIds.includes(it.id));
      const importSourceMap = await loadImportSourceMap(tx, survive.map((it) => it.propertyId));
      const csv = buildBatchCsv({ items: survive, properties, importSourceMap, ownerDisplayConfig });
      const digest = sha256Hex(csv);
      if (isFirst) {
        await tx.dmExportBatch.update({ where: { id: batchId },
          data: { downloadedAt: new Date(), csvDigest: digest, rowCount: survive.length } });
      } else if (digest !== batchRow[0].csv_digest) {
        throw new ApiError(409, "内容が変わったため再出力してください", "REEXPORT_REQUIRED");
      }
      return { csv, retry: !isFirst, count: survive.length };
    });

    await writeAuditLog({ userId: session.id, action: "property_dm_csv_export",
      targetTable: "dm_export_batches", targetId: batchId,
      detail: { batchId, retry: result.retry, count: result.count, exportedAt: new Date().toISOString() } });
    const fileDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return new NextResponse(result.csv, { status: 200, headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="dm_merge_${fileDate}.csv"`,
      "Cache-Control": "no-store" } });
  } catch (error) { return handleApiError(error); }
}
```

※(2)terminal反響・(5)候補再評価はPR-B/Cで `checkBatchEligibility` 内に追加する(この route は関数呼び出しのまま変えない)。resendFilterApplied はこのPRでは常に false。
- [ ] **Step 3: RED→GREEN、フル `npx vitest run` → Commit** `feat(dm): 控えCSVダウンロード(初回凍結+digest再試行+宛先資格の再検証)`

---

### Task 5: 未確定一覧GET+確定POST

**Files:**
- Modify: `src/app/api/properties/dm-batches/route.ts`(GET 追加)
- Create: `src/app/api/properties/dm-batches/[id]/confirm/route.ts`
- Test: `src/lib/__tests__/dm-batch-confirm-route.test.ts`

**Interfaces:**
- Consumes: Task 2 の `lockOwnersForShare` / `lockPropertiesForUpdate`、既存 `canAccessPropertyRecord`
- Produces:
  - `GET /api/properties/dm-batches?unconfirmed=1` → `{ data: [{ id, createdAt, rowCount, downloadedAt, confirmedAt }] }`(作成者本人の分のみ・宛先は返さない・直近50件)
  - `POST /api/properties/dm-batches/[id]/confirm` body=`{ sentOn: "YYYY-MM-DD" }` → `{ confirmed: number }`。409=二重確定/未DL/日付範囲外、403=スコープ外item あり(件数入りメッセージ)

- [ ] **Step 1: 失敗テスト**(必須ケース)
1. 未DL(downloadedAt null)の確定は 409「先にCSVを出力してください」
2. sentOn が downloadedAt の JST 暦日より前 → 400 / 未来日 → 400(境界値: downloadedAt=UTC 2026-08-07T16:00(JST 8/8 01:00)のとき sentOn "2026-08-08" は可・"2026-08-07" は不可)
3. field_staff でスコープ外 item が1件でもあれば 403(メッセージに件数)
4. 冪等: `updateMany({ where: { id, confirmedAt: null }, data: {...} })` の勝者のみログ生成・敗者は 409
5. ロック順: Owner FOR SHARE → property FOR UPDATE → バッチ/items FOR UPDATE → createMany(SQL呼び出し順で検証)
6. 生成行: `{ propertyId, ownerId, dmType: "owner_address", batchId, sentAt: <sentOn+00:00Z>, method: "mail", sentBy: session.id }` + `propertyDmLogOwner.createMany` で連関コピー・owner null の item は `ownerId: null` で記録(R42)・property null の item は `propertyId: null` で記録(R49)
7. 監査 `dm_sent_confirm` detail `{ batchId, count, sentOn }`
8. 確定は本人以外 404(バッチは作成者スコープ)

- [ ] **Step 2: 実装**(確定 tx の骨子)

```ts
const body = confirmSchema.parse(await request.json()); // { sentOn: /^\d{4}-\d{2}-\d{2}$/ }
// 権限: 4権限+plain(閲覧系)+ property:write(書込)
// batch = findFirst({ id, createdBy: session.id }) → 404
// downloadedAt null → 409 "先にCSVを出力してください"
// JST範囲検査: dlDayJst = new Date(batch.downloadedAt.getTime() + 9*3600*1000).toISOString().slice(0,10);
//   todayJst = new Date(Date.now() + 9*3600*1000).toISOString().slice(0,10);
//   sentOn < dlDayJst || sentOn > todayJst → 400
const confirmed = await prisma.$transaction(async (tx) => {
  const pre = await readItemsWithOwners(tx, batchId);
  await lockOwnersForShare(tx, pre.allOwnerIds);
  await lockPropertiesForUpdate(tx, pre.allPropertyIds);   // R49: 全ロール統一(削除とのデッドロック回避)
  const won = await tx.dmExportBatch.updateMany({
    where: { id: batchId, confirmedAt: null },
    data: { confirmedAt: new Date(), confirmedBy: session.id, sentOn: new Date(`${body.sentOn}T00:00:00Z`) } });
  if (won.count === 0) throw new ApiError(409, "この控えは確定済みです", "ALREADY_CONFIRMED");
  const items = await lockAndRereadItems(tx, batchId);      // items FOR UPDATE + 連関再読取
  if (!sameOwnerSets(pre, items)) throw new ApiError(409, "宛先の状態が変わりました。もう一度お試しください", "RETRY");
  if (session.role === "field_staff") {
    const props = await loadScopeFields(tx, items.allPropertyIds); // createdBy/assignedTo(親行ロック保持中に検証=R4)
    const outOfScope = items.forConfirm.filter((it) =>
      it.propertyId != null && !canAccessPropertyRecord(session, props.get(it.propertyId)!)).length;
    if (outOfScope > 0)
      throw new ApiError(403, `担当外の宛先が ${outOfScope} 件あります。管理者または事務担当で確定してください`, "FORBIDDEN");
  }
  // ログ生成(id はアプリ採番して連関コピーに使う)
  const logs = items.forConfirm.map((it) => ({ id: randomUUID(), propertyId: it.propertyId,
    ownerId: it.ownerId, dmType: "owner_address", batchId, draftId: null,
    sentAt: new Date(`${body.sentOn}T00:00:00Z`), method: "mail", sentBy: session.id }));
  await tx.propertyDmLog.createMany({ data: logs });
  const linkRows = items.forConfirm.flatMap((it, i) =>
    it.groupOwnerIds.map((ownerId) => ({ logId: logs[i].id, ownerId })));
  if (linkRows.length > 0) await tx.propertyDmLogOwner.createMany({ data: linkRows });
  return logs.length;
});
// 監査は tx 外: dm_sent_confirm { batchId, count: confirmed, sentOn }
```

※`sentAt` は `@db.Date`+「UTC 00:00 の Date を渡す」= mark-sent の +9h 規約と同じ「UTC暦日=JST暦日」に揃う(sentOn は既に JST の日付文字列)。
- [ ] **Step 3: GET 一覧を同 route に追加**(`unconfirmed=1` なら `confirmedAt: null` で filter・`createdBy: session.id`・orderBy createdAt desc・take 50・select は id/createdAt/rowCount/downloadedAt/confirmedAt のみ=宛先PIIなし)
- [ ] **Step 4: RED→GREEN、フル vitest → Commit** `feat(dm): 送付の一括確定(控え単位・投函日入力・共有者連関コピー)`

---

### Task 6: 個別記録 POST/DELETE + 監査登録 + property_dm_log_view 修正

**Files:**
- Modify: `src/app/api/properties/[id]/dm-logs/route.ts`(POST 追加)
- Create: `src/app/api/properties/[id]/dm-logs/[logId]/route.ts`(DELETE)
- Modify: `src/lib/audit-log-detail-safety.ts`
- Test: `src/lib/__tests__/dm-log-record-route.test.ts`

**Interfaces:**
- Consumes: `lockPropertyRecordForWrite` / `assertPropertyRecordAccess`(既存)
- Produces:
  - `POST /api/properties/[id]/dm-logs` body=`{ sentOn: "YYYY-MM-DD", method?: "mail"|"hand_delivery"|"other", note?: string(max 500) }` → 201 `{ id }`
  - `DELETE /api/properties/[id]/dm-logs/[logId]` → 200 `{ deleted: true }`。sale_dm 行は 409

- [ ] **Step 1: 失敗テスト**(必須ケース)
1. POST: property:write 欠け 403・record scope 外 403(`assertPropertyRecordAccess`)
2. POST: 未来日 400(過去日は可=設計)・method allowlist 外 422
3. POST: tx が `lockPropertyRecordForWrite` で始まる(SQL/呼び出し順検証)・作成行は `{ propertyId, ownerId: null, dmType: null, sentAt: <sentOn UTC00:00>, method, note, sentBy }`
4. DELETE: method="sale_dm" は 409(メッセージに「売却DM画面から」)
5. DELETE: 削除は record scope 内のみ・`lockPropertyRecordForWrite` 先頭
6. 監査 `dm_sent_record`{propertyId,sentOn} / `dm_sent_record_delete`{logId}(note はdetailに載せない)
7. 既存 GET の挙動不変(既存テスト `dm-logs-route.test.ts` が緑のまま)

- [ ] **Step 2: 実装**。DELETE の宛先不明フラグ再計算(R8)は反響列がまだ無いPR-Aでは「returned_undeliverable の売却DM下書きが残っているか」だけを数える:

```ts
await prisma.$transaction(async (tx) => {
  await lockPropertyRecordForWrite(tx, propertyId, session);
  const log = await tx.propertyDmLog.findFirst({ where: { id: logId, propertyId }, select: { id: true, method: true } });
  if (!log) throw new ApiError(404, "送付記録が見つかりません", "NOT_FOUND");
  if (log.method === "sale_dm")
    throw new ApiError(409, "売却DMの送付記録はここでは取り消せません。売却DMの画面から操作してください", "SALE_DM_LOG");
  await tx.propertyDmLog.delete({ where: { id: logId } });
  // 反響列導入(PR-B)後、この位置に undeliverable ログ残数の再計算を追加する(設計§2.3)
});
```

- [ ] **Step 3: `ACTION_EXTRA_KEYS` へ登録**(同ファイル1箇所にまとめて):

```ts
  // DM送付記録(PR-A)
  dm_sent_confirm: new Set(["batchId", "count", "sentOn"]),
  dm_sent_record: new Set(["propertyId", "sentOn"]),
  dm_sent_record_delete: new Set(["logId"]),
  // 既存バグ修正: property_dm_log_view の viewedAt が [REDACTED] に潰れていた(設計§2.5)
  property_dm_log_view: new Set(["viewedAt"]),
```

(count/total/page は ALWAYS_SAFE のため viewedAt のみで足りる。テストで `sanitizeAuditDetail("property_dm_log_view", { viewedAt: "..." })` が素通りすることをピン)
- [ ] **Step 4: RED→GREEN、フル vitest → Commit** `feat(dm): 個別の送付記録・取消(物件ページ用)+監査キー登録`

---

### Task 7: 売却DMブリッジ(mark-sent 拡張+宛先生成のグループ保存)

**Files:**
- Modify: `src/app/api/properties/sale-dm/drafts/[id]/mark-sent/route.ts`
- Modify: `src/app/api/properties/sale-dm/campaigns/route.ts`
- Test: `src/lib/__tests__/sale-dm-mark-sent-bridge.test.ts`(新規。既存 mark-sent テストがあれば同時に更新)

**Interfaces:**
- Consumes: Task 2 の `lockOwnersForShare`、Task 1 の `DmRecipientDraftOwner` / `PropertyDmLogOwner`
- Produces: mark-sent が作る PropertyDmLog 行に `ownerId`(代表)+`draftId` が入り、`property_dm_log_owners` に共有者全員がコピーされる。宛先生成が `dm_recipient_draft_owners` を保存する。

- [ ] **Step 1: 失敗テスト**(必須ケース)
1. mark-sent の tx 順序: 先読み→Owner FOR SHARE→**物件親行 FOR UPDATE**→条件付き updateMany→draft 再読取(`$queryRaw` 呼び出し順+`SELECT ... FROM properties ... FOR UPDATE` を検証。R50 P2)
2. tx 内で再読取した `representativeOwnerId` が log の `ownerId` に入る(tx 前スナップショット不使用=R13。テスト: 再読取mockに別ownerを返させ、そちらが記録されること)
3. draft_owners(連関)がある draft → `property_dm_log_owners` に全員コピー。**連関が空の旧 draft → 代表のみ記録+監査 detail `legacyGroup: true`**(R34)
4. 再読取で所有者集合が先読みと不一致 → 409(中止・ログを作らない)
5. 宛先生成(campaigns POST): draft作成 tx が Owner FOR SHARE→物件親行 FOR SHARE→リンク再検証→`dmRecipientDraftOwner.createMany` の順(R49 P2)。リンクが消えた物件の宛先は生成せず件数報告
6. 既存挙動の維持: 二重 mark-sent の冪等応答・JST +9h の sentAt

- [ ] **Step 2: mark-sent 実装**(現行 tx を置き換え)

```ts
const result = await prisma.$transaction(async (tx) => {
  // 先読み(ロックなし)
  const pre = await tx.dmRecipientDraft.findUnique({ where: { id },
    select: { representativeOwnerId: true, propertyId: true,
      draftOwners: { select: { ownerId: true } } } });
  if (!pre) return "not_sent" as const;
  const preOwners = [pre.representativeOwnerId, ...pre.draftOwners.map((o) => o.ownerId)]
    .filter((v): v is string => v != null);
  await lockOwnersForShare(tx, preOwners);                          // Owner 先頭
  await tx.$queryRaw`SELECT id FROM properties WHERE id = ${pre.propertyId}::uuid FOR UPDATE`; // 親行(R50 P2)
  const transitioned = await tx.dmRecipientDraft.updateMany({
    where: { id, status: "confirmed" }, data: { status: "sent", sentAt: now } });
  if (transitioned.count === 0) { /* 既存の already_sent / not_sent 判別をそのまま */ }
  // 勝者決定後に再読取(R13)
  const fresh = await tx.dmRecipientDraft.findUnique({ where: { id },
    select: { representativeOwnerId: true, propertyId: true, draftOwners: { select: { ownerId: true } } } });
  const freshOwners = [fresh!.representativeOwnerId, ...fresh!.draftOwners.map((o) => o.ownerId)]
    .filter((v): v is string => v != null);
  if (!sameSet(preOwners, freshOwners)) throw new ApiError(409, "宛先の所有者が変わりました。もう一度お試しください", "RETRY");
  const logId = randomUUID();
  await tx.propertyDmLog.create({ data: { id: logId, propertyId: fresh!.propertyId,
    ownerId: fresh!.representativeOwnerId, dmType: null, draftId: id,
    sentAt: sentOnJst, method: "sale_dm", sentBy: session.id } });
  const group = fresh!.draftOwners.map((o) => o.ownerId);
  const linkTargets = group.length > 0 ? group
    : (fresh!.representativeOwnerId ? [fresh!.representativeOwnerId] : []);
  if (linkTargets.length > 0)
    await tx.propertyDmLogOwner.createMany({ data: linkTargets.map((ownerId) => ({ logId, ownerId })), skipDuplicates: true });
  return { kind: "won" as const, legacyGroup: group.length === 0 };
});
// 監査 detail に legacyGroup を追加(sale_dm_draft_mark_sent の ACTION_EXTRA_KEYS に "legacyGroup" を追記)
```

- [ ] **Step 3: 宛先生成の実装**(campaigns POST の draft 作成 tx を修正): `buildRecipientsFromProperties` の `meta` に `groupOwnerIds: string[]`(グループ全員の owner.id)を追加 → tx 冒頭で `lockOwnersForShare(tx, 全ownerIds)` → `lockPropertiesForShare(tx, 全propertyIds)` → `tx.propertyOwner.findMany` で現在リンクを再検証(消えた物件はskip+skippedByUnlink 件数を応答へ) → draft create 後に `tx.dmRecipientDraftOwner.createMany({ data: groupOwnerIds.map(...) })`
- [ ] **Step 4: RED→GREEN、フル vitest → Commit** `feat(dm): 売却DMブリッジ(送付記録に代表所有者と下書きを紐づけ・共有者全員を保存)`

---

### Task 8: 名寄せ(owner merge)の付け替え

**Files:**
- Modify: `src/app/api/admin/owners/correction/merge/route.ts`
- Test: `src/lib/__tests__/owner-merge-dm-repoint.test.ts`

**Interfaces:**
- Consumes: Task 1 の新モデル群
- Produces: 統合 tx が `PropertyDmLog.ownerId` / `DmExportBatchItem.ownerId` / `DmRecipientDraft.representativeOwnerId` / 連関3表の `ownerId` を source→master へ付け替える(重複は畳む)。

- [ ] **Step 1: 失敗テスト**(必須ケース)
1. 統合 tx 内(source archive の**前**)に、次の6つの付け替えが行われる:
   - `tx.propertyDmLog.updateMany({ where: { ownerId: source }, data: { ownerId: master } })`
   - `tx.dmExportBatchItem.updateMany`(同形)
   - `tx.dmRecipientDraft.updateMany({ where: { representativeOwnerId: source }, data: { representativeOwnerId: master } })`
   - 連関3表: master 側に同じ行がある source 行は `deleteMany`(複合PK衝突回避)→ 残りを `updateMany`(item_owners → log_owners → draft_owners の順)
2. 付け替え件数が監査 detail(`owner_correction_merge`)に載る: `dmLogsMoved` / `dmBatchItemsMoved` / `dmDraftsMoved` / `dmAssociationsMoved`(ACTION_EXTRA_KEYS の `owner_correction_merge` に4キー追記。既存エントリが無ければ新設)
3. 既存の安全判定(checkOwnerMergeSafety)・version検査・ChangeLog は不変(既存テストが緑のまま)

- [ ] **Step 2: 実装**(既存 step 7(PropertyOwner 付け替え)の直後に挿入。連関のデデュープは:

```ts
// 例: property_dm_log_owners。source と master が同じ log に両方連関している行は source 側を消してから移す。
await tx.$queryRaw`DELETE FROM property_dm_log_owners s
  WHERE s.owner_id = ${sourceFresh.id}::uuid
    AND EXISTS (SELECT 1 FROM property_dm_log_owners m
                WHERE m.log_id = s.log_id AND m.owner_id = ${masterFresh.id}::uuid)`;
const logOwnersMoved = await tx.propertyDmLogOwner.updateMany({
  where: { ownerId: sourceFresh.id }, data: { ownerId: masterFresh.id } });
```

item_owners / draft_owners も同形)
- [ ] **Step 3: RED→GREEN、フル vitest → Commit** `feat(dm): 所有者の名寄せでDM記録・控え・下書きの紐づけを引き継ぐ`

---

### Task 9: 物件削除の整合(所有者ゼロ行の掃除+ダイアログ注意書き)

**Files:**
- Modify: `src/app/api/properties/[id]/route.ts`(DELETE の tx)
- Modify: `src/app/(dashboard)/properties/[id]/page.tsx`(削除確認文言)
- Modify: `src/app/(dashboard)/properties/page.tsx`(一括削除確認文言)
- Test: `src/lib/__tests__/property-delete-dm-logs.test.ts`

**Interfaces:**
- Consumes: Task 1 の SetNull FK(スキーマ側で自動)
- Produces: 物件削除 tx が「ownerId=null かつ連関0 の PropertyDmLog」を行ごと削除(R52)。それ以外の行は SetNull で所有者側に残る(R49)。

- [ ] **Step 1: 失敗テスト**
1. DELETE tx 内に `tx.propertyDmLog.deleteMany({ where: { propertyId: id, ownerId: null, logOwners: { none: {} } } })` がある(mock 検証)
2. 削除順: dm ログ掃除 → attachment ゴミ箱 → property.delete(既存の attachment 処理は不変)
3. UI: 確認文言に「DMの反響・送付履歴は所有者情報に引き継がれます」を含む(`page.tsx` のソース文字列ピン)

- [ ] **Step 2: 実装**(tx 冒頭の photos 取得の後に deleteMany を1行追加。UI は `confirm(...)` 文言の変更のみ)
- [ ] **Step 3: RED→GREEN、フル vitest → Commit** `feat(dm): 物件削除時のDM履歴整合(所有者に引き継ぎ・無用行の掃除)`

---

### Task 10: UI — 2段階出力+確定モーダル

**Files:**
- Modify: `src/app/(dashboard)/properties/page.tsx`
- Create: `src/components/properties/dm-batch-confirm-modal.tsx`
- Modify: `src/lib/api-client.ts`
- Test: `src/lib/__tests__/dm-batch-ui-wiring.test.ts`

**Interfaces:**
- Consumes: Task 3/5 の API、`safeRandomId`(`@/lib/random-id`)
- Produces(api-client に追加。USE_MOCK 分岐込み・既存ヘルパーと同形):

```ts
export async function createDmBatch(filters: Record<string, string>): Promise<{ batchId: string; rowCount: number; reused: boolean }>;
// 内部で attemptKey = safeRandomId() を採番して POST /api/properties/dm-batches
export async function fetchUnconfirmedDmBatches(): Promise<{ data: Array<{ id: string; createdAt: string; rowCount: number; downloadedAt: string | null; confirmedAt: string | null }> }>;
export async function confirmDmBatch(batchId: string, sentOn: string): Promise<{ confirmed: number }>;
```

- [ ] **Step 1: 配線テスト**(ソース文字列ピン。jsdom が無いためUIはこの方式=リポ規約)
1. `page.tsx`: `handleExportDm` が `createDmBatch` を呼び、成功時 `window.location.href = \`/api/properties/dm-batches/${batchId}/csv\`` へ遷移する(旧 `/api/properties/dm-export` への参照が**ソースから消えている**)
2. `page.tsx`: 「送付の確定」ボタンが出力ボタンの隣にあり、`DmBatchConfirmModal` を開く。表示ゲートは既存の DM 出力可否(`canExportDm` 相当の既存 state)と同一
3. `dm-batch-confirm-modal.tsx`: 一覧が `fetchUnconfirmedDmBatches` を使い、`<input type="date">` の既定値が今日、確定が `confirmDmBatch` を呼ぶ。**未DLのバッチは「未ダウンロード」バッジを出し確定ボタンを無効化**(サーバ 409 の事前案内)
4. `api-client.ts`: `createDmBatch` が `safeRandomId` を import している(`crypto.randomUUID` がソースに現れない)
5. rowCount が 0 のときは 出力ボタンハンドラがモーダル/遷移せず「対象がありません」トースト(既存のエラー表示 state を再利用)

- [ ] **Step 2: 実装**(モーダルは `next-action-tab.tsx` のフォーム/一覧スタイルを踏襲。エラーは既存の赤枠ボックス。文言例: 見出し「送付の確定」・行=「8/8 14:02 出力・12通」+「確定」ボタン・日付ラベル「投函日」・完了トースト「12件の送付を記録しました」)
- [ ] **Step 3: RED→GREEN、フル vitest → `npm run build` で新route一覧を目視 → Commit** `feat(dm): 出力ボタンの2段階化と「送付の確定」モーダル`

---

### Task 11: UI — DM送付履歴の強化(種別・何通目・ラベル・個別記録)

**Files:**
- Modify: `src/app/api/properties/[id]/dm-logs/route.ts`(GET 応答に `dmType`/`sequence`/`ownerName` 追加)
- Modify: `src/components/properties/dm-logs-view.tsx`
- Test: 既存 `src/lib/__tests__/dm-logs-route.test.ts` 拡張+`src/lib/__tests__/dm-logs-view-ui-wiring.test.ts`

**Interfaces:**
- Consumes: Task 2 の `dmMethodLabel`、Task 6 の POST/DELETE
- Produces: GET 応答 data 行に `dmType: string | null` と `sequence: number`(物件内の時系列連番=sentAt,createdAt,id 昇順)を追加。

- [ ] **Step 1: 失敗テスト**
1. GET: 3件(sentAt 8/1, 8/5, 8/1(createdAt遅))を返す mock で、sequence が時系列順(1,3,2 のように**古い順の連番**)になる。ページングしても番号が変わらない(全件の順位から計算)
2. GET: 応答に dmType が含まれ、note マスク・監査は従来どおり(既存テスト緑のまま)
3. view: `dmMethodLabel` を使い生値の英字を出さない(`log.method ?? ` の生表示がソースから消えている)・「何通目」列(表示は「3通目」)・「種別」列(owner_address→「所有者宛」・null→「-」)
4. view: 追加フォーム(投函日=今日既定・方法セレクト 郵送/手渡し/その他・メモ任意)と行の削除ボタンがあり、Task 6 のAPIを `api-client` 経由で呼ぶ(直接fetchの既存 GET は維持でよい)。削除は `confirm("この送付記録を取り消しますか？")` を挟む
5. sale_dm 行には削除ボタンを出さない(サーバ409の事前案内)

- [ ] **Step 2: 実装**(sequence はGET内で `findMany({ where: { propertyId }, select: { id: true }, orderBy: [{ sentAt: "asc" }, { createdAt: "asc" }, { id: "asc" }] })` の全件で index+1 の Map を作りページ分に付与。1物件の記録は少数のため許容=設計§2.2)
- [ ] **Step 3: RED→GREEN、フル vitest → Commit** `feat(dm): 送付履歴の表示強化(種別・何通目・日本語ラベル・個別記録UI)`

---

### Task 12: 横断配線テスト+全ゲート+提出

**Files:**
- Create: `src/lib/__tests__/dm-writer-lock-order.test.ts`
- Modify: (前タスクの漏れ修正のみ)

- [ ] **Step 1: ロック順序の横断ソーステスト**(`property-record-scope-align.test.ts` の型を踏襲):

```ts
// 対象: dm-batches/[id]/csv(初回GET)・dm-batches/[id]/confirm・sale-dm mark-sent・sale-dm campaigns POST
// 各ファイルの $transaction ブロックについて:
//   lockOwnersForShare のindex < properties の FOR SHARE/FOR UPDATE のindex < バッチ/draft 子行操作のindex
// を assertLockFirst 方式(indexOf 比較)で固定する。
// 個別記録 POST/DELETE は lockPropertyRecordForWrite が tx 先頭にあることを固定する。
```

- [ ] **Step 2: 全ゲート実行**
1. `npx tsc --noEmit` = 0
2. `npx vitest run`(フル)= 全緑
3. `npx eslint <全変更ファイル>` = 0(ベースライン比較で自分の差分か判別)
4. `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build` = 成功・route 一覧に `/api/properties/dm-batches` 系が載る
- [ ] **Step 3: 提出前レビュー** — `git add -A` 後、feature-dev:code-reviewer(sonnet)に staged diff をレビューさせる。ホットスポット指定: (a) 認可・PII(バッチ一覧/CSV/監査detail) (b) ロック順序と FOR SHARE/FOR UPDATE の対応 (c) attemptKey/confirm の冪等性とレース (d) `safeRandomId` 使用(HTTP本番) (e) JST暦日境界(sentOn 検査・sentAt 保存) (f) 旧 dm-export 撤去の取り残し参照
- [ ] **Step 4: PR 作成** — `gh pr create --title "feat(dm): 送付記録(宛名CSVの控え化・一括/個別の送付記録)"`。本文は平易な日本語で Summary/実装/テスト/セキュリティ+migration の内容(additive・新テーブル5・PropertyDmLog列追加・FK SetNull化)を明記 → `gh pr comment <PR> --body "@codex review"` → codex-triage スキルで収束まで対応。**マージはユーザー**。

---

## PR-B/C/D の扱い(本計画の範囲外)

- **PR-B(反響)**: migration-B(reaction_* 4列+JSONB shadow+[reactionStatus]索引)・反響PATCH・同期共通ヘルパー(outcome route/recordTrackingHit・親行ロック+terminal時Owner FOR UPDATE)・orphan-dm-logs 管理・照合スクリプト。`checkBatchEligibility` に (2)terminal を追加。
- **PR-C(再送候補)**: 候補述語 `decideResendCandidacy`・一覧UI・resendFilterApplied の設定・`checkBatchEligibility` に (5) を追加。
- **PR-D(外部AI方式)**: 別紙設計書。PR-A の後なら A〜C と並行可。
- 各PRの詳細計画は**前段のマージ後に**同形式で作成する(着地したコードの実測を前提にするため)。

## Self-Review(執筆時実施済み)

- 設計書§2の全要素との突き合わせ: 2.1(POST/GET/凍結/資格(1)(3)(4)(6)/連関/攻めない(2)(5)の明示)=Task 2-4、2.2(一覧/確定/sentOn/スコープ403/冪等/ロック順/ブリッジ/宛先生成)=Task 5・7、2.3(個別)=Task 6、2.4(migration)=Task 1、2.5(監査)=Task 3・6、2.6(表示)=Task 11、R49物件削除=Task 9、R51グループ検査=Task 2/4、名寄せ5b=Task 8。UI導線=Task 10。
- 型整合: `checkBatchEligibility`/`lockOwnersForShare` 等のシグネチャは Task 2 定義を後続タスクがそのまま使用。
- 残余リスク(実装時に確定): `readItemsWithOwners` 等の route 内 private helper の分割粒度は実装者裁量(公開インターフェースは本計画のとおり)。
