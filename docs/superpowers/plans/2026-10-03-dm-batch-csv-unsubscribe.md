# 宛名CSVの手紙に配信停止QR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 宛名CSV(物件一覧「DM差込CSV出力」)の各行に、署名付きの「配信停止URL」を入れ、そのURLから受け手が停止すると、その手紙の宛先全員に「拒否」が記録されるようにする。

**Architecture:** 署名は売却DMの停止と同じ鍵(NEXTAUTH_SECRET 由来)を用途ラベルだけ分けて使う。公開の受け口は既存の `/u/[token]` を共有し、トークンの形(`c<32桁16進>.<署名>`)で宛名CSVの1通へ振り分ける。停止の記録は既存の反響の規則(`applyManualReaction`)と送付記録(`PropertyDmLog`)をそのまま使い、控えの行と送付記録を新しい列 `dm_export_batch_items.log_id` で結ぶ。

**Tech Stack:** Next.js 16 route handlers / Prisma 7(生成先 `@/generated/prisma`)/ PostgreSQL / vitest(env=node・jsdom なし)

**Spec:** `docs/superpowers/specs/2026-10-03-dm-batch-csv-unsubscribe-design.md`

## Global Constraints

- migration は追加のみ(DROP/ALTER COLUMN TYPE/UPDATE/DELETE なし)。名前 `20261003100000_add_dm_batch_unsubscribe`。
- CSV の既存列の順・名前・値は変えない。足すのは**末尾**の「配信停止URL」1列だけ。
- トークン = `c` + 控えの行の UUID から `-` を除いた32桁の小文字16進 + `.` + 署名22文字。署名 = 停止専用鍵の HMAC-SHA256(`dm-unsub-batch-item:<itemId>`)先頭16バイトの base64url。
- 監査 action 名 `dm_batch_qr_unsubscribe`、detail キーは `result` `batchId` `itemId` `createdLog` `at` だけ。氏名・住所・URL・トークンは載せない。
- 停止で付けるメモは既存と同じ文字列「QRコードからの配信停止申込」。
- 公開経路(`/u/`)の既存の守り(per-IP 10/分・Origin 検査・トークン単位 5/時・全体 60/時・GET は DB 無アクセス)を宛名CSVのトークンにも同じく効かせる。
- 新規依存なし・新規 env なし。
- コードは Write/Edit ツールだけで書く(Bash の heredoc で `\n` などを含むコードを書かない=実改行に化ける事故が2回あった)。

## Review Focus

1. **確定前に停止→あとで確定**: 送付記録が2件にならず、1件の sentAt が投函日に直り、拒否が残る(Task 4 のテスト)。
2. **確定のあとに停止**: 確定で作った記録に拒否が付く(新しい記録を作らない)(Task 5 のテスト)。
3. **追跡URLを変えたあとの再ダウンロード**: 初回の追跡URLで同じCSVが出て digest 一致(Task 3 のテスト)。
4. **売却DMのトークン**: 既存の停止がそのまま動く(Task 6 で既存テストが全部通ることを確認+形の判別テスト)。
5. **同じQRの二度押し・別の宛先の署名の流用**: 二度目は already、別 itemId の署名は無効画面(Task 1・Task 5 のテスト)。

---

## File Structure

| ファイル | 役割 |
|---|---|
| Create `src/lib/dm-batch/unsubscribe-token.ts` | 宛名CSVの1通用トークンの作成・判別・検証・URL組み立て |
| Create `src/lib/dm-batch/qr-unsubscribe.ts` | 停止の記録(1つの取引)と、どの送付記録に付けるかの純関数 |
| Create `prisma/migrations/20261003100000_add_dm_batch_unsubscribe/migration.sql` | 列2本+FK+索引 |
| Modify `prisma/schema.prisma` | `DmExportBatch.unsubscribeBaseUrl` / `DmExportBatchItem.logId` + `PropertyDmLog` 側の逆関係 |
| Modify `src/lib/dm-export.ts` | `DM_EXPORT_HEADERS` 末尾に「配信停止URL」/ `buildDmRow` の戻り値に空の列 |
| Modify `src/lib/dm-batch/csv.ts` | 行ごとに配信停止URLを入れる |
| Modify `src/app/api/properties/dm-batches/[id]/csv/route.ts` | 初回で追跡URLを固定・再DLは固定値で組む |
| Modify `src/app/api/properties/dm-batches/[id]/confirm/route.ts` | logId の書き込み・停止で作った記録の再利用 |
| Modify `src/app/api/properties/dm-batches/route.ts` | 応答に `unsubscribeUrlAvailable` |
| Modify `src/app/u/[token]/route.ts` | 宛名CSVトークンの振り分け |
| Modify `src/lib/audit-log-detail-safety.ts` / `src/app/(dashboard)/admin/audit-logs/page.tsx` | 監査の許可キーと表示名 |
| Modify `src/lib/api-client.ts` / `src/app/(dashboard)/properties/page.tsx` | 追跡URL未設定の注意 |
| Modify `public/docs/guide.html` / `public/docs/manual.html` | Word と業者向けの手順 |

---

### Task 1: トークン(作成・判別・検証・URL)

**Files:**
- Create: `src/lib/dm-batch/unsubscribe-token.ts`
- Test: `src/lib/dm-batch/__tests__/unsubscribe-token.test.ts`

**Interfaces:**
- Consumes: `deriveUnsubscribeKey`, `buildUnsubscribeUrl`, `parseUnsubscribeToken`(既存 `src/lib/sale-dm-letter/unsubscribe-token.ts`)
- Produces:
  - `isBatchItemUnsubscribeToken(raw: string): boolean`
  - `buildBatchItemUnsubscribeToken(itemId: string, key: Buffer): string`
  - `verifyBatchItemUnsubscribeToken(raw: string, key: Buffer): string | null`(正しければ itemId=ハイフン付き小文字UUID)
  - `buildBatchItemUnsubscribeUrl(itemId: string, baseUrl: string, key: Buffer): string`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import crypto from "crypto";
import {
  buildBatchItemUnsubscribeToken,
  buildBatchItemUnsubscribeUrl,
  isBatchItemUnsubscribeToken,
  verifyBatchItemUnsubscribeToken,
} from "../unsubscribe-token";
import {
  buildUnsubscribeToken,
  parseUnsubscribeToken,
  verifyUnsubscribeToken,
} from "@/lib/sale-dm-letter/unsubscribe-token";

const KEY = crypto.randomBytes(32);
const OTHER_KEY = crypto.randomBytes(32);
const ITEM = "0b7e3c1a-5d2f-4a6b-9c8d-1e2f3a4b5c6d";

describe("宛名CSVの1通の配信停止トークン", () => {
  it("c+32桁16進.署名22文字 の形で、既存の形式門前払いを通る", () => {
    const t = buildBatchItemUnsubscribeToken(ITEM, KEY);
    expect(t).toMatch(/^c[0-9a-f]{32}\.[A-Za-z0-9_-]{22}$/);
    expect(parseUnsubscribeToken(t)).not.toBeNull();
    expect(isBatchItemUnsubscribeToken(t)).toBe(true);
  });

  it("往復で itemId(ハイフン付き小文字)が戻る・大文字のUUIDでも同じトークン", () => {
    const t = buildBatchItemUnsubscribeToken(ITEM, KEY);
    expect(verifyBatchItemUnsubscribeToken(t, KEY)).toBe(ITEM);
    expect(buildBatchItemUnsubscribeToken(ITEM.toUpperCase(), KEY)).toBe(t);
  });

  it("別の鍵・別の itemId の署名・改ざんは無効", () => {
    const t = buildBatchItemUnsubscribeToken(ITEM, KEY);
    expect(verifyBatchItemUnsubscribeToken(t, OTHER_KEY)).toBeNull();
    const other = buildBatchItemUnsubscribeToken("11111111-2222-4333-8444-555555555555", KEY);
    const swapped = `${t.split(".")[0]}.${other.split(".")[1]}`;
    expect(verifyBatchItemUnsubscribeToken(swapped, KEY)).toBeNull();
    expect(verifyBatchItemUnsubscribeToken(t.slice(0, -1) + (t.endsWith("A") ? "B" : "A"), KEY)).toBeNull();
  });

  it("売却DMのトークンとは判別でき、互いの検証を通らない(用途ラベルが違う)", () => {
    const sale = buildUnsubscribeToken("AbCdEfGhIjK", KEY); // 売却DMの追跡トークンは11文字
    expect(isBatchItemUnsubscribeToken(sale)).toBe(false);
    expect(verifyBatchItemUnsubscribeToken(sale, KEY)).toBeNull();
    const batch = buildBatchItemUnsubscribeToken(ITEM, KEY);
    // 売却DMの検証は形だけなら通り得るので、署名で必ず落ちることを確かめる。
    expect(verifyUnsubscribeToken(batch, KEY)).toBeNull();
  });

  it("形が違うものは判別で false(大文字の16進・長さ違い・接頭辞違い)", () => {
    const sig = "A".repeat(22);
    expect(isBatchItemUnsubscribeToken(`c${"A".repeat(32)}.${sig}`)).toBe(false);
    expect(isBatchItemUnsubscribeToken(`c${"a".repeat(31)}.${sig}`)).toBe(false);
    expect(isBatchItemUnsubscribeToken(`d${"a".repeat(32)}.${sig}`)).toBe(false);
  });

  it("URL は base の末尾スラッシュを1つにそろえて /u/<token>", () => {
    const url = buildBatchItemUnsubscribeUrl(ITEM, "https://app.ligarejapan.com/", KEY);
    expect(url).toBe(`https://app.ligarejapan.com/u/${buildBatchItemUnsubscribeToken(ITEM, KEY)}`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/dm-batch/__tests__/unsubscribe-token.test.ts`
Expected: FAIL(`Cannot find module '../unsubscribe-token'`)

- [ ] **Step 3: Write minimal implementation**

```ts
import crypto from "crypto";
import { buildUnsubscribeUrl } from "@/lib/sale-dm-letter/unsubscribe-token";

/**
 * 宛名CSV(DM差込CSV出力)の1通ごとの配信停止トークン。
 *
 * 形 = `c<控えの行 UUID から '-' を除いた32桁の小文字16進>.<署名22文字>`。
 *  - 先頭の `c` と長さで売却DMのトークン(追跡トークン=11文字)と判別する。既存の形式門前払い
 *    (`parseUnsubscribeToken`)の内側に収まるので、`/u/` の入口はそのまま使える。
 *  - 署名は売却DMと同じ停止専用鍵(`deriveUnsubscribeKey`)で、**用途ラベルを分ける**
 *    (`dm-unsub-batch-item:`)。片方の署名をもう片方へ流用できない。
 */

const PREFIX = "c";
const SIG_BYTES = 16;
const BATCH_TOKEN_RE = /^c([0-9a-f]{32})\.([A-Za-z0-9_-]{22})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function compact(itemId: string): string {
  const lower = itemId.toLowerCase();
  if (!UUID_RE.test(lower)) throw new Error("itemId は UUID であること");
  return lower.replace(/-/g, "");
}

function expand(hex32: string): string {
  return `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-${hex32.slice(12, 16)}-${hex32.slice(16, 20)}-${hex32.slice(20)}`;
}

function sign(itemId: string, key: Buffer): string {
  return crypto
    .createHmac("sha256", key)
    .update(`dm-unsub-batch-item:${itemId}`, "utf8")
    .digest()
    .subarray(0, SIG_BYTES)
    .toString("base64url");
}

export function isBatchItemUnsubscribeToken(raw: string): boolean {
  return BATCH_TOKEN_RE.test(raw);
}

export function buildBatchItemUnsubscribeToken(itemId: string, key: Buffer): string {
  const hex = compact(itemId);
  return `${PREFIX}${hex}.${sign(expand(hex), key)}`;
}

/** 署名を timing-safe に検証し、正しければ itemId(ハイフン付き小文字)を返す。 */
export function verifyBatchItemUnsubscribeToken(raw: string, key: Buffer): string | null {
  const m = BATCH_TOKEN_RE.exec(raw);
  if (!m) return null;
  const itemId = expand(m[1]);
  const expected = Buffer.from(sign(itemId, key), "utf8");
  const actual = Buffer.from(m[2], "utf8");
  if (expected.length !== actual.length) return null;
  if (!crypto.timingSafeEqual(expected, actual)) return null;
  return itemId;
}

export function buildBatchItemUnsubscribeUrl(itemId: string, baseUrl: string, key: Buffer): string {
  return buildUnsubscribeUrl(buildBatchItemUnsubscribeToken(itemId, key), baseUrl);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/dm-batch/__tests__/unsubscribe-token.test.ts`
Expected: PASS(6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/dm-batch/unsubscribe-token.ts src/lib/dm-batch/__tests__/unsubscribe-token.test.ts
git commit -m "feat(dm-batch): 宛名CSVの1通ごとの配信停止トークン"
```

---

### Task 2: migration と schema

**Files:**
- Create: `prisma/migrations/20261003100000_add_dm_batch_unsubscribe/migration.sql`
- Modify: `prisma/schema.prisma`(model `DmExportBatch`・`DmExportBatchItem`・`PropertyDmLog`)
- Test: `src/lib/__tests__/dm-batch-unsubscribe-schema.test.ts`

**Interfaces:**
- Produces: Prisma の `DmExportBatch.unsubscribeBaseUrl: string | null`、`DmExportBatchItem.logId: string | null`(関係名 `log`)、`PropertyDmLog.batchItems DmExportBatchItem[]`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
const schema = read("prisma/schema.prisma");
const sql = read("prisma/migrations/20261003100000_add_dm_batch_unsubscribe/migration.sql");
const block = (name: string) => {
  const start = schema.indexOf(`model ${name} {`);
  expect(start, `model ${name}`).toBeGreaterThan(-1);
  return schema.slice(start, schema.indexOf("\n}", start));
};

describe("宛名CSVの配信停止のスキーマ", () => {
  it("控えに追跡URLの固定値、控えの行に送付記録への結び付き(SetNull)", () => {
    expect(block("DmExportBatch")).toMatch(/unsubscribeBaseUrl\s+String\?\s+@map\("unsubscribe_base_url"\)/);
    const item = block("DmExportBatchItem");
    expect(item).toMatch(/logId\s+String\?\s+@map\("log_id"\) @db\.Uuid/);
    expect(item).toMatch(/log\s+PropertyDmLog\?\s+@relation\(fields: \[logId\], references: \[id\], onDelete: SetNull\)/);
    expect(item).toMatch(/@@index\(\[logId\]\)/);
    expect(block("PropertyDmLog")).toMatch(/batchItems\s+DmExportBatchItem\[\]/);
  });

  it("migration は追加のみ", () => {
    expect(sql).toContain('ALTER TABLE "dm_export_batches" ADD COLUMN "unsubscribe_base_url" TEXT;');
    expect(sql).toContain('ALTER TABLE "dm_export_batch_items" ADD COLUMN "log_id" UUID;');
    expect(sql).toContain('CREATE INDEX "dm_export_batch_items_log_id_idx" ON "dm_export_batch_items"("log_id");');
    expect(sql).toMatch(/ADD CONSTRAINT "dm_export_batch_items_log_id_fkey" FOREIGN KEY \("log_id"\) REFERENCES "property_dm_logs"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE;/);
    expect(sql).not.toMatch(/^\s*(DROP|UPDATE|DELETE)\b/im);
    expect(sql).not.toMatch(/ALTER COLUMN/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/dm-batch-unsubscribe-schema.test.ts`
Expected: FAIL(migration.sql が無い)

- [ ] **Step 3: Write minimal implementation**

`prisma/migrations/20261003100000_add_dm_batch_unsubscribe/migration.sql`:

```sql
-- 宛名CSVの手紙に配信停止QR(設計 2026-10-03)。追加のみ。
-- 本番の宛名CSVの控えは 0件(2026-10-03 実測)=索引は通常の CREATE INDEX でよい。

-- 初回ダウンロード時の追跡URL(配信停止URLの頭)を控えに固定する(再ダウンロードで同じCSVを出すため)。
ALTER TABLE "dm_export_batches" ADD COLUMN "unsubscribe_base_url" TEXT;

-- 控えの行(1通)と、その送付記録を結ぶ。確定時、または確定前の停止で記録を作ったときに書く。
ALTER TABLE "dm_export_batch_items" ADD COLUMN "log_id" UUID;
CREATE INDEX "dm_export_batch_items_log_id_idx" ON "dm_export_batch_items"("log_id");
ALTER TABLE "dm_export_batch_items" ADD CONSTRAINT "dm_export_batch_items_log_id_fkey" FOREIGN KEY ("log_id") REFERENCES "property_dm_logs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

`prisma/schema.prisma` の `model DmExportBatch` の `sentOn` 行の直後に:

```prisma
  // 初回ダウンロードで固定した追跡URL(CSVの「配信停止URL」の頭)。再ダウンロードはこの値で組む
  // (設定画面で追跡URLを変えても、配ったCSVと同じ内容を出す)。未設定のまま初回なら null=列は空。
  unsubscribeBaseUrl  String?   @map("unsubscribe_base_url")
```

`model DmExportBatchItem` の `ownerId` 行の直後に:

```prisma
  // この1通の送付記録。確定時、または確定前の配信停止で記録を作ったときに書く(設計 2026-10-03 §5)。
  logId      String? @map("log_id") @db.Uuid
```

同じ model の `owner Owner? ...` 行の直後に:

```prisma
  log        PropertyDmLog?           @relation(fields: [logId], references: [id], onDelete: SetNull)
```

同じ model の `@@index([batchId])` の直後に:

```prisma
  @@index([logId])
```

`model PropertyDmLog` の `logOwners PropertyDmLogOwner[]` の直後に:

```prisma
  batchItems DmExportBatchItem[]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx prisma generate && npx vitest run src/lib/__tests__/dm-batch-unsubscribe-schema.test.ts && npx tsc --noEmit`
Expected: PASS・tsc 0

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261003100000_add_dm_batch_unsubscribe src/lib/__tests__/dm-batch-unsubscribe-schema.test.ts
git commit -m "feat(dm-batch): 配信停止用に控えの追跡URL固定と送付記録への結び付きの列"
```

---

### Task 3: CSV に配信停止URL の列(初回で追跡URLを固定)

**Files:**
- Modify: `src/lib/dm-export.ts`(`DM_EXPORT_HEADERS`・`buildDmRow`)
- Modify: `src/lib/dm-batch/csv.ts`
- Modify: `src/app/api/properties/dm-batches/[id]/csv/route.ts`
- Test: `src/lib/dm-batch/__tests__/csv.test.ts`(追記)・`src/lib/__tests__/dm-batch-csv-route.test.ts`(追記)

**Interfaces:**
- Consumes: `buildBatchItemUnsubscribeUrl`(Task 1)、`DmExportBatch.unsubscribeBaseUrl`(Task 2)、既存 `loadSaleDmPublicPageConfig().trackingBaseUrl`(`src/lib/sale-dm-letter/config-store.ts`)、`deriveUnsubscribeKey`
- Produces: `BatchCsvSource.unsubscribeUrlFor?: (itemId: string) => string`(省略時は列を空)

- [ ] **Step 1: Write the failing tests**

`src/lib/dm-batch/__tests__/csv.test.ts` の末尾に追記(ファイル冒頭の既存の組み立て関数 `src()` 相当を使う。無ければ下の最小の材料で):

```ts
describe("配信停止URLの列", () => {
  it("見出しの末尾が「配信停止URL」で、既存の見出しの並びは変わらない", async () => {
    const { DM_EXPORT_HEADERS } = await import("@/lib/dm-export");
    expect(DM_EXPORT_HEADERS[DM_EXPORT_HEADERS.length - 1]).toBe("配信停止URL");
    expect(DM_EXPORT_HEADERS.slice(0, 13)).toEqual([
      "管理ID", "物件住所", "所有者名", "敬称", "郵便番号", "所有者住所", "物件種別",
      "所有者名カナ", "代表者", "続柄", "DM判断", "送付先所有者名一覧", "共有者数",
    ]);
  });

  it("unsubscribeUrlFor を渡すと行ごとのURL、渡さなければ空", () => {
    const base = minimalSource();
    const withUrl = buildBatchCsv({ ...base, unsubscribeUrlFor: (id) => `https://x.example/u/${id}` });
    const lastCells = withUrl.trim().split("\r\n").slice(1).map((l) => l.split(",").at(-1));
    expect(lastCells).toEqual(["https://x.example/u/item-1"]);
    const without = buildBatchCsv(base);
    expect(without.trim().split("\r\n")[1].endsWith(",")).toBe(true);
  });
});

function minimalSource() {
  const owner = { id: "o1", name: "山田太郎", nameKana: null, zip: "1500001", address: "東京都渋谷区神宮前1-1", currentZip: null, currentAddress: null, corporateNumber: null };
  return {
    items: [{ id: "item-1", propertyId: "p1", ownerId: "o1", groupOwnerIds: ["o1"] }],
    properties: new Map([["p1", {
      id: "p1", dmStatus: "send", isArchived: false, createdBy: "u1", assignedTo: null,
      address: "東京都渋谷区神宮前1-1", propertyType: "house",
      propertyOwners: [{ isPrimary: true, relationship: null, owner }],
    }]]) as never,
    importSourceMap: new Map<string, string>(),
    ownerDisplayConfig: { name: "full", zip: "full", address: "full", phone: "full", email: "full" } as never,
  };
}
```

(`buildBatchCsv` は同ファイル冒頭で import 済み。無ければ `import { buildBatchCsv } from "../csv";` を足す。`ownerDisplayConfig` の正確な形は `src/lib/api-helpers.ts` の `OwnerDisplayConfig` に合わせて「平文」の値を入れる=既存の csv.test.ts の値を写す。)

`src/lib/__tests__/dm-batch-csv-route.test.ts` に追記(既存の mock の作法に合わせる。`@/lib/sale-dm-letter/config-store` を `vi.mock` して `loadSaleDmPublicPageConfig` を返す):

```ts
it("初回ダウンロードで追跡URLを控えに固定し、CSV末尾に配信停止URLが入る", async () => {
  // 既存の「初回GET成功」テストと同じ準備(downloaded_at=null の控え・資格を満たす1件)
  arrangeFirstDownloadOk();
  loadPublicCfg.mockResolvedValue({ trackingBaseUrl: "https://app.example.com", senderName: null, senderContact: null, lpPublicEnabled: true, privacyText: null });
  const res = await GET(req(), ctx());
  expect(res.status).toBe(200);
  const csv = await res.text();
  expect(csv.split("\r\n")[0].endsWith("配信停止URL")).toBe(true);
  expect(csv.split("\r\n")[1]).toMatch(/https:\/\/app\.example\.com\/u\/c[0-9a-f]{32}\.[A-Za-z0-9_-]{22}$/);
  const update = (prisma.dmExportBatch.update as Mock).mock.calls[0][0];
  expect(update.data.unsubscribeBaseUrl).toBe("https://app.example.com");
});

it("再ダウンロードは控えに固定した追跡URLで組む(設定が変わっても同じCSV)", async () => {
  arrangeRetryDownload({ unsubscribe_base_url: "https://app.example.com" });
  loadPublicCfg.mockResolvedValue({ trackingBaseUrl: "https://changed.example.com", senderName: null, senderContact: null, lpPublicEnabled: true, privacyText: null });
  const res = await GET(req(), ctx());
  const csv = await res.text();
  expect(csv).toContain("https://app.example.com/u/c");
  expect(csv).not.toContain("changed.example.com");
});

it("初回に追跡URLが未設定なら列は空・固定値も null", async () => {
  arrangeFirstDownloadOk();
  loadPublicCfg.mockResolvedValue({ trackingBaseUrl: undefined, senderName: null, senderContact: null, lpPublicEnabled: true, privacyText: null });
  const res = await GET(req(), ctx());
  const csv = await res.text();
  expect(csv.split("\r\n")[1].endsWith(",")).toBe(true);
  const update = (prisma.dmExportBatch.update as Mock).mock.calls[0][0];
  expect(update.data.unsubscribeBaseUrl).toBeNull();
});
```

(`arrangeFirstDownloadOk` / `arrangeRetryDownload` は既存テストの「初回GET成功」「再試行GET成功」の準備部分を関数に括り出したもの。括り出しは同じファイル内で行う。`arrangeRetryDownload` の digest は「固定URLで組んだCSV」の sha256 を `sha256Hex` で作って渡す。NEXTAUTH_SECRET は `beforeEach` で退避→テスト用の値→`afterEach` で復元。)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/dm-batch/__tests__/csv.test.ts src/lib/__tests__/dm-batch-csv-route.test.ts`
Expected: FAIL(見出しが13列のまま・`unsubscribeBaseUrl` が書かれない)

- [ ] **Step 3: Implement**

`src/lib/dm-export.ts`: `DM_EXPORT_HEADERS` の `"共有者数",` の次に `"配信停止URL",` を足す。`buildDmRow` の戻り値オブジェクトの最後に `配信停止URL: "",` を足す(この列は控えの行ごとに `buildBatchCsv` が上書きする。`buildDmRow` は物件と所有者しか知らない)。

`src/lib/dm-batch/csv.ts`:

```ts
export interface BatchCsvSource {
  items: BatchCsvItem[];
  properties: Map<string, PropertyStateForCheck & { address?: string | null; propertyType?: string }>;
  importSourceMap: Map<string, string>;
  ownerDisplayConfig: OwnerDisplayConfig;
  /** 1通ごとの配信停止URL。省略(追跡URL未設定)なら列は空。 */
  unsubscribeUrlFor?: (itemId: string) => string;
}
```

`rows.push(buildDmRow(...))` を次に置き換える:

```ts
    const row = buildDmRow(
      {
        address: property.address ?? "",
        propertyType: property.propertyType ?? "unknown",
      },
      group,
      src.ownerDisplayConfig,
      src.importSourceMap.get(it.propertyId) ?? "",
    );
    row["配信停止URL"] = src.unsubscribeUrlFor ? src.unsubscribeUrlFor(it.id) : "";
    rows.push(row);
```

`src/app/api/properties/dm-batches/[id]/csv/route.ts`:
- import に `import { loadSaleDmPublicPageConfig } from "@/lib/sale-dm-letter/config-store";`・`import { deriveUnsubscribeKey } from "@/lib/sale-dm-letter/unsubscribe-token";`・`import { buildBatchItemUnsubscribeUrl } from "@/lib/dm-batch/unsubscribe-token";` を足す。
- バッチ行の `SELECT` に `unsubscribe_base_url` を足し、型に `unsubscribe_base_url: string | null;` を足す。
- `const isFirst = ...` の直後に:

```ts
      // 配信停止URLの頭は初回で固定する(設計 §4)。初回は今の追跡URL、再DLは固定値。
      let unsubscribeBaseUrl: string | null = batchRow.unsubscribe_base_url;
      if (isFirst) {
        try {
          unsubscribeBaseUrl = (await loadSaleDmPublicPageConfig()).trackingBaseUrl ?? null;
        } catch {
          unsubscribeBaseUrl = null;
        }
      }
      let unsubscribeKey: Buffer | null = null;
      try {
        unsubscribeKey = deriveUnsubscribeKey();
      } catch {
        unsubscribeKey = null; // NEXTAUTH_SECRET 不在=アプリ自体が動かない。列は空(安全側)。
      }
      const unsubscribeUrlFor =
        unsubscribeBaseUrl && unsubscribeKey
          ? (itemId: string) => buildBatchItemUnsubscribeUrl(itemId, unsubscribeBaseUrl as string, unsubscribeKey as Buffer)
          : undefined;
```

- `buildBatchCsv({ ... })` に `unsubscribeUrlFor,` を足す。
- 初回の `tx.dmExportBatch.update` の `data` に `unsubscribeBaseUrl,` を足す。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/dm-batch src/lib/__tests__/dm-batch-csv-route.test.ts src/lib/__tests__/dm-batches-post-route.test.ts && npx tsc --noEmit`
Expected: PASS・tsc 0(既存の見出し数を前提にしたテストが落ちたら、その期待値に「配信停止URL」を足す)

- [ ] **Step 5: Commit**

```bash
git add src/lib/dm-export.ts src/lib/dm-batch/csv.ts "src/app/api/properties/dm-batches/[id]/csv/route.ts" src/lib/dm-batch/__tests__/csv.test.ts src/lib/__tests__/dm-batch-csv-route.test.ts
git commit -m "feat(dm-batch): 宛名CSVの末尾に配信停止URL(初回で追跡URLを固定)"
```

---

### Task 4: 確定で logId を書き、確定前の停止で作った記録を再利用

**Files:**
- Create: `src/lib/dm-batch/confirm-plan.ts`
- Modify: `src/app/api/properties/dm-batches/[id]/confirm/route.ts`
- Test: `src/lib/dm-batch/__tests__/confirm-plan.test.ts`・`src/lib/__tests__/dm-batch-confirm-route.test.ts`(追記)

**Interfaces:**
- Produces: `planConfirmLogs(items: Array<{ id: string; logId: string | null; logExists: boolean }>): { reuse: Array<{ itemId: string; logId: string }>; create: string[] }`

- [ ] **Step 1: Write the failing tests**

`src/lib/dm-batch/__tests__/confirm-plan.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { planConfirmLogs } from "../confirm-plan";

describe("確定で送付記録を作る/再利用する", () => {
  it("logId が無い行は作る・あり(残っている)行は再利用", () => {
    expect(
      planConfirmLogs([
        { id: "a", logId: null, logExists: false },
        { id: "b", logId: "L1", logExists: true },
      ]),
    ).toEqual({ reuse: [{ itemId: "b", logId: "L1" }], create: ["a"] });
  });

  it("logId が指す記録が消えていたら作り直す(物件削除で記録ごと消えた場合)", () => {
    expect(planConfirmLogs([{ id: "a", logId: "L9", logExists: false }])).toEqual({ reuse: [], create: ["a"] });
  });

  it("並びは入力順を保つ", () => {
    const r = planConfirmLogs([
      { id: "c", logId: null, logExists: false },
      { id: "a", logId: null, logExists: false },
    ]);
    expect(r.create).toEqual(["c", "a"]);
  });
});
```

`dm-batch-confirm-route.test.ts` の prisma mock に `dmExportBatchItem.findMany` の2回目(logId 読み)・`propertyDmLog.findMany`・`propertyDmLog.updateMany`・`$executeRaw` を足し、追記:

```ts
it("確定前の停止で作った記録は作り直さず、sentAt を投函日に直す。新しく作った記録は logId で結ぶ", async () => {
  arrangeConfirmable({ items: [itemA, itemB] }); // 既存の成功テストの準備を括り出したもの
  (prisma.dmExportBatchItem.findMany as Mock)
    .mockResolvedValueOnce(preItems)   // 先読み
    .mockResolvedValueOnce(preItems)   // ロック後の再読取
    .mockResolvedValueOnce([{ id: itemA.id, logId: null }, { id: itemB.id, logId: "L-B" }]);
  (prisma.propertyDmLog.findMany as Mock).mockResolvedValue([{ id: "L-B" }]);
  const res = await POST(req({ sentOn: TODAY }), ctx());
  expect(res.status).toBe(200);
  const created = (prisma.propertyDmLog.createMany as Mock).mock.calls[0][0].data;
  expect(created).toHaveLength(1);
  expect(created[0].propertyId).toBe(itemA.propertyId);
  expect(prisma.propertyDmLog.updateMany).toHaveBeenCalledWith({
    where: { id: { in: ["L-B"] } },
    data: { sentAt: new Date(`${TODAY}T00:00:00Z`) },
  });
  // 作った記録の id を控えの行へ書く(1文の UPDATE ... FROM unnest)。
  const exec = (prisma.$executeRaw as Mock).mock.calls[0];
  expect(exec[0].join("?")).toContain("UPDATE dm_export_batch_items");
  expect(exec[1]).toEqual([itemA.id]);
  expect(exec[2]).toEqual([created[0].id]);
  expect(await res.json()).toMatchObject({ confirmed: 2 });
});
```

(`itemA` `itemB` `preItems` `TODAY` `arrangeConfirmable` は既存テストの値を括り出して作る。`confirmed` は「この控えで送付記録が付いた通数」=再利用+新規。)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/dm-batch/__tests__/confirm-plan.test.ts src/lib/__tests__/dm-batch-confirm-route.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

`src/lib/dm-batch/confirm-plan.ts`:

```ts
/**
 * 確定で、控えの行ごとに送付記録を「作る」か「再利用する」かを決める(設計 2026-10-03 §5.2)。
 * 再利用=確定前に配信停止が来て、その1通の記録を先に作ってあった行。作り直すと記録が2件になり、
 * 「何通目」が狂い、拒否が付いていない方の記録が残る。
 */
export function planConfirmLogs(
  items: Array<{ id: string; logId: string | null; logExists: boolean }>,
): { reuse: Array<{ itemId: string; logId: string }>; create: string[] } {
  const reuse: Array<{ itemId: string; logId: string }> = [];
  const create: string[] = [];
  for (const it of items) {
    if (it.logId && it.logExists) reuse.push({ itemId: it.id, logId: it.logId });
    else create.push(it.id);
  }
  return { reuse, create };
}
```

`confirm/route.ts` の「記録の生成」ブロック(`const sentAtDate = ...` から `return logs.length;` まで)を置き換える:

```ts
      const sentAtDate = new Date(`${body.sentOn}T00:00:00Z`);
      // 確定前の停止で先に作った記録があれば再利用する(§5.2)。items は FOR UPDATE 済み。
      const linkRowsNow = await tx.dmExportBatchItem.findMany({
        where: { batchId },
        select: { id: true, logId: true },
      });
      const linkedIds = linkRowsNow.map((r) => r.logId).filter((v): v is string => v != null);
      const existingLogs =
        linkedIds.length > 0
          ? await tx.propertyDmLog.findMany({ where: { id: { in: linkedIds } }, select: { id: true } })
          : [];
      const existing = new Set(existingLogs.map((l) => l.id));
      const logIdByItem = new Map(linkRowsNow.map((r) => [r.id, r.logId]));
      const plan = planConfirmLogs(
        items.map((it) => {
          const logId = logIdByItem.get(it.id) ?? null;
          return { id: it.id, logId, logExists: logId != null && existing.has(logId) };
        }),
      );
      if (plan.reuse.length > 0) {
        await tx.propertyDmLog.updateMany({
          where: { id: { in: plan.reuse.map((r) => r.logId) } },
          data: { sentAt: sentAtDate },
        });
      }
      const createSet = new Set(plan.create);
      const toCreate = items.filter((it) => createSet.has(it.id));
      const logs = toCreate.map((it) => ({
        id: randomUUID(),
        propertyId: it.propertyId,
        ownerId: it.ownerId,
        dmType: "owner_address",
        batchId,
        draftId: null,
        sentAt: sentAtDate,
        method: "mail",
        sentBy: session.id,
      }));
      if (logs.length > 0) {
        await tx.propertyDmLog.createMany({ data: logs });
        const linkRows = toCreate.flatMap((it, i) =>
          it.groupOwnerIds.map((ownerId) => ({ logId: logs[i].id, ownerId })),
        );
        if (linkRows.length > 0) {
          await tx.propertyDmLogOwner.createMany({ data: linkRows, skipDuplicates: true });
        }
        // 控えの行 → 送付記録(以後の配信停止がこの記録に拒否を付ける)。1文でまとめて書く。
        const itemIds = toCreate.map((it) => it.id);
        const logIds = logs.map((l) => l.id);
        await tx.$executeRaw`UPDATE dm_export_batch_items AS i SET log_id = v.log_id FROM (SELECT unnest(${itemIds}::uuid[]) AS id, unnest(${logIds}::uuid[]) AS log_id) AS v WHERE i.id = v.id`;
      }
      return logs.length + plan.reuse.length;
```

import に `import { planConfirmLogs } from "@/lib/dm-batch/confirm-plan";` を足す。⚠`tx.$executeRaw` はメソッドとして呼ぶ(関数を取り出して渡すと this が外れ、実DBでだけ必ず失敗する=過去の実例)。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/dm-batch src/lib/__tests__/dm-batch-confirm-route.test.ts && npx tsc --noEmit`
Expected: PASS・tsc 0

- [ ] **Step 5: Commit**

```bash
git add src/lib/dm-batch/confirm-plan.ts src/lib/dm-batch/__tests__/confirm-plan.test.ts "src/app/api/properties/dm-batches/[id]/confirm/route.ts" src/lib/__tests__/dm-batch-confirm-route.test.ts
git commit -m "feat(dm-batch): 確定で送付記録を控えの行に結び、確定前の停止で作った記録は再利用"
```

---

### Task 5: 停止の記録(1つの取引)

**Files:**
- Create: `src/lib/dm-batch/qr-unsubscribe.ts`
- Test: `src/lib/dm-batch/__tests__/qr-unsubscribe-decide.test.ts`・`src/lib/__tests__/dm-batch-qr-unsubscribe.test.ts`

**Interfaces:**
- Consumes: `lockOwnersForUpdate`(`@/lib/dm-batch/locks`)、`lockPropertyRow`(`@/lib/property-record-guard`)、`applyManualReaction` `isRefusalProtected` `jstCalendarDay`(`@/lib/dm-reaction/core`)
- Produces:
  - `type BatchUnsubscribeResult = { kind: "recorded"; batchId: string; createdLog: boolean } | { kind: "already"; batchId: string } | { kind: "unsent"; batchId: string | null } | { kind: "missing" } | { kind: "conflict"; batchId: string }`
  - `decideBatchUnsubscribeTarget(s: { logId: string | null; logExists: boolean; confirmed: boolean }): "use" | "create" | "legacy_lookup"`
  - `recordBatchItemUnsubscribe(itemId: string, now?: Date): Promise<BatchUnsubscribeResult>`
  - `BATCH_UNSUBSCRIBE_NOTE = "QRコードからの配信停止申込"`

- [ ] **Step 1: Write the failing tests**

`src/lib/dm-batch/__tests__/qr-unsubscribe-decide.test.ts`(総当たり):

```ts
import { describe, it, expect } from "vitest";
import { decideBatchUnsubscribeTarget } from "../qr-unsubscribe";

describe("停止でどの送付記録に拒否を付けるか(状態の総当たり)", () => {
  const cases: Array<[string | null, boolean, boolean, string]> = [
    // logId,  logExists, confirmed, 期待
    [null, false, false, "create"],        // 確定前・未記録 → この1通の記録を作る
    [null, false, true, "legacy_lookup"],  // 確定済みなのに結び付き無し=本機能より前の控え
    ["L", true, false, "use"],             // 確定前に一度停止済み(二度目の押下)
    ["L", true, true, "use"],              // 確定済み(確定で結んだ記録)
    ["L", false, false, "create"],         // 結んだ記録が消えた(物件削除)・確定前 → 作り直す
    ["L", false, true, "legacy_lookup"],   // 結んだ記録が消えた・確定済み → 引き当てを試す
  ];
  it.each(cases)("logId=%s logExists=%s confirmed=%s → %s", (logId, logExists, confirmed, expected) => {
    expect(decideBatchUnsubscribeTarget({ logId, logExists, confirmed })).toBe(expected);
  });
});
```

`src/lib/__tests__/dm-batch-qr-unsubscribe.test.ts`(prisma を状態つきの偽物にして、取引の中の動きを確かめる):

```ts
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn() }));
vi.mock("@/lib/dm-batch/locks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dm-batch/locks")>();
  return { ...actual, lockOwnersForUpdate: vi.fn() };
});

type Log = { id: string; ownerId: string | null; reactionStatus: string; reactedAt: Date | null; reactionNote: string | null; reactionSource: string | null; manualReactionShadow: unknown; logOwners: { ownerId: string }[] };
const state: {
  item: null | { id: string; batchId: string; propertyId: string | null; ownerId: string | null; logId: string | null; itemOwners: { ownerId: string }[]; batch: { downloadedAt: Date | null; confirmedAt: Date | null; createdBy: string } };
  logs: Log[];
} = { item: null, logs: [] };

vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    dmExportBatchItem: {
      findUnique: vi.fn(async () => (state.item ? structuredClone(state.item) : null)),
      update: vi.fn(async (a: { data: { logId: string } }) => { if (state.item) state.item.logId = a.data.logId; return a; }),
    },
    propertyDmLog: {
      findMany: vi.fn(async (a: { where: { id?: string; batchId?: string } }) =>
        a.where.id ? state.logs.filter((l) => l.id === a.where.id) : state.logs),
      create: vi.fn(async (a: { data: { id: string; ownerId: string | null } }) => {
        state.logs.push({ id: a.data.id, ownerId: a.data.ownerId, reactionStatus: "no_response", reactedAt: null, reactionNote: null, reactionSource: null, manualReactionShadow: null, logOwners: [] });
        return a;
      }),
      update: vi.fn(async (a: { where: { id: string }; data: Partial<Log> }) => {
        const l = state.logs.find((x) => x.id === a.where.id);
        if (l) Object.assign(l, a.data);
        return a;
      }),
    },
    propertyDmLogOwner: {
      createMany: vi.fn(async (a: { data: { logId: string; ownerId: string }[] }) => {
        for (const r of a.data) state.logs.find((l) => l.id === r.logId)?.logOwners.push({ ownerId: r.ownerId });
        return { count: a.data.length };
      }),
    },
    $queryRaw: vi.fn(async () => []),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import prisma from "@/lib/prisma";
import { lockOwnersForUpdate } from "@/lib/dm-batch/locks";
import { recordBatchItemUnsubscribe, BATCH_UNSUBSCRIBE_NOTE } from "@/lib/dm-batch/qr-unsubscribe";

const ITEM = "0b7e3c1a-5d2f-4a6b-9c8d-1e2f3a4b5c6d";
const BATCH = "9a9a9a9a-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-03T03:00:00Z"); // JST 12:00

function baseItem(over: Partial<NonNullable<typeof state.item>> = {}) {
  return { id: ITEM, batchId: BATCH, propertyId: "p1", ownerId: "o1", logId: null, itemOwners: [{ ownerId: "o1" }, { ownerId: "o2" }], batch: { downloadedAt: new Date("2026-10-01T00:00:00Z"), confirmedAt: null, createdBy: "u-creator" }, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.item = baseItem();
  state.logs = [];
});

describe("宛名CSVの1通の配信停止", () => {
  it("確定前: この1通の送付記録を作り(今日・作成者・連関)、拒否を付け、控えの行に結ぶ", async () => {
    const r = await recordBatchItemUnsubscribe(ITEM, NOW);
    expect(r).toEqual({ kind: "recorded", batchId: BATCH, createdLog: true });
    const created = (prisma.propertyDmLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(created).toMatchObject({ propertyId: "p1", ownerId: "o1", dmType: "owner_address", batchId: BATCH, draftId: null, method: "mail", sentBy: "u-creator", sentAt: new Date("2026-10-03T00:00:00Z") });
    expect(state.logs[0].logOwners.map((o) => o.ownerId).sort()).toEqual(["o1", "o2"]);
    expect(state.logs[0].reactionStatus).toBe("refused");
    expect(state.logs[0].reactionNote).toBe(BATCH_UNSUBSCRIBE_NOTE);
    expect(state.item?.logId).toBe(state.logs[0].id);
    // 所有者は FOR UPDATE(拒否=terminal を書く)
    expect(lockOwnersForUpdate).toHaveBeenCalledWith(expect.anything(), ["o1", "o1", "o2"]);
  });

  it("二度目の押下は already(記録は増えない)", async () => {
    await recordBatchItemUnsubscribe(ITEM, NOW);
    const r = await recordBatchItemUnsubscribe(ITEM, NOW);
    expect(r).toEqual({ kind: "already", batchId: BATCH });
    expect(state.logs).toHaveLength(1);
  });

  it("確定済み(確定で結んだ記録)には拒否だけ付ける・記録は作らない", async () => {
    state.logs = [{ id: "L1", ownerId: "o1", reactionStatus: "no_response", reactedAt: null, reactionNote: "前のメモ", reactionSource: null, manualReactionShadow: null, logOwners: [{ ownerId: "o1" }, { ownerId: "o2" }] }];
    state.item = baseItem({ logId: "L1", batch: { downloadedAt: new Date("2026-10-01T00:00:00Z"), confirmedAt: new Date("2026-10-02T00:00:00Z"), createdBy: "u-creator" } });
    const r = await recordBatchItemUnsubscribe(ITEM, NOW);
    expect(r).toEqual({ kind: "recorded", batchId: BATCH, createdLog: false });
    expect(prisma.propertyDmLog.create).not.toHaveBeenCalled();
    expect(state.logs[0].reactionStatus).toBe("refused");
    expect(state.logs[0].reactionNote).toBe(`前のメモ／${BATCH_UNSUBSCRIBE_NOTE}`);
  });

  it("未ダウンロードの控え(手紙が存在しない)は unsent・何も書かない", async () => {
    state.item = baseItem({ batch: { downloadedAt: null, confirmedAt: null, createdBy: "u-creator" } });
    expect(await recordBatchItemUnsubscribe(ITEM, NOW)).toEqual({ kind: "unsent", batchId: BATCH });
    expect(prisma.propertyDmLog.create).not.toHaveBeenCalled();
  });

  it("控えの行が無い(控えの削除)は missing", async () => {
    state.item = null;
    expect(await recordBatchItemUnsubscribe(ITEM, NOW)).toEqual({ kind: "missing" });
  });

  it("ロックの間に所有者が増えた(名寄せ)なら conflict・何も書かない", async () => {
    const findUnique = prisma.dmExportBatchItem.findUnique as ReturnType<typeof vi.fn>;
    findUnique
      .mockResolvedValueOnce(baseItem())
      .mockResolvedValueOnce(baseItem({ itemOwners: [{ ownerId: "o1" }, { ownerId: "o2" }, { ownerId: "o3" }] }));
    expect(await recordBatchItemUnsubscribe(ITEM, NOW)).toEqual({ kind: "conflict", batchId: BATCH });
    expect(prisma.propertyDmLog.create).not.toHaveBeenCalled();
  });

  it("確定済みなのに結び付きが無い旧控え: (batchId, propertyId, ownerId)で1件に引ければそれに付ける・2件以上なら unsent", async () => {
    state.item = baseItem({ batch: { downloadedAt: new Date("2026-10-01T00:00:00Z"), confirmedAt: new Date("2026-10-02T00:00:00Z"), createdBy: "u-creator" } });
    state.logs = [{ id: "OLD", ownerId: "o1", reactionStatus: "no_response", reactedAt: null, reactionNote: null, reactionSource: null, manualReactionShadow: null, logOwners: [{ ownerId: "o1" }] }];
    expect(await recordBatchItemUnsubscribe(ITEM, NOW)).toEqual({ kind: "recorded", batchId: BATCH, createdLog: false });
    expect(state.item?.logId).toBe("OLD");
    state.item = baseItem({ batch: { downloadedAt: new Date("2026-10-01T00:00:00Z"), confirmedAt: new Date("2026-10-02T00:00:00Z"), createdBy: "u-creator" } });
    state.logs.push({ ...state.logs[0], id: "OLD2" });
    expect(await recordBatchItemUnsubscribe(ITEM, NOW)).toEqual({ kind: "unsent", batchId: BATCH });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/dm-batch/__tests__/qr-unsubscribe-decide.test.ts src/lib/__tests__/dm-batch-qr-unsubscribe.test.ts`
Expected: FAIL(module not found)

- [ ] **Step 3: Implement**

`src/lib/dm-batch/qr-unsubscribe.ts`:

```ts
import { randomUUID } from "crypto";
import prisma from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { lockOwnersForUpdate, type RawTx } from "@/lib/dm-batch/locks";
import { applyManualReaction, isRefusalProtected, jstCalendarDay } from "@/lib/dm-reaction/core";

/**
 * 宛名CSVの1通の配信停止(設計 2026-10-03 §5.1)。公開の /u/ から署名検証の後に呼ぶ。
 * ロック順は確定(confirm/route.ts)と同じ並び「所有者 → 物件親行 → 控え(バッチ)行 → 控えの行」。
 * 所有者は拒否(terminal)を書くので FOR UPDATE(売却DMの停止と同じ)。
 */

export const BATCH_UNSUBSCRIBE_NOTE = "QRコードからの配信停止申込";

export type BatchUnsubscribeResult =
  | { kind: "recorded"; batchId: string; createdLog: boolean }
  | { kind: "already"; batchId: string }
  | { kind: "unsent"; batchId: string | null }
  | { kind: "missing" }
  | { kind: "conflict"; batchId: string };

export function decideBatchUnsubscribeTarget(s: {
  logId: string | null;
  logExists: boolean;
  confirmed: boolean;
}): "use" | "create" | "legacy_lookup" {
  if (s.logId && s.logExists) return "use";
  return s.confirmed ? "legacy_lookup" : "create";
}

const ITEM_SELECT = {
  id: true,
  batchId: true,
  propertyId: true,
  ownerId: true,
  logId: true,
  itemOwners: { select: { ownerId: true } },
  batch: { select: { downloadedAt: true, confirmedAt: true, createdBy: true } },
} as const;

const LOG_SELECT = {
  id: true,
  ownerId: true,
  reactionStatus: true,
  reactedAt: true,
  reactionNote: true,
  reactionSource: true,
  manualReactionShadow: true,
  logOwners: { select: { ownerId: true } },
} as const;

type ItemRow = {
  id: string;
  batchId: string;
  propertyId: string | null;
  ownerId: string | null;
  logId: string | null;
  itemOwners: { ownerId: string }[];
  batch: { downloadedAt: Date | null; confirmedAt: Date | null; createdBy: string };
};

function ownersOf(it: { ownerId: string | null; itemOwners: { ownerId: string }[] }): string[] {
  return [...(it.ownerId ? [it.ownerId] : []), ...it.itemOwners.map((o) => o.ownerId)];
}

export async function recordBatchItemUnsubscribe(
  itemId: string,
  now: Date = new Date(),
): Promise<BatchUnsubscribeResult> {
  return prisma.$transaction(async (tx) => {
    const pre = (await tx.dmExportBatchItem.findUnique({ where: { id: itemId }, select: ITEM_SELECT })) as ItemRow | null;
    if (!pre) return { kind: "missing" } as const;
    if (!pre.batch.downloadedAt) return { kind: "unsent", batchId: pre.batchId } as const;

    const locked = ownersOf(pre);
    await lockOwnersForUpdate(tx as unknown as RawTx, locked);
    if (pre.propertyId) await lockPropertyRow(tx, pre.propertyId);
    await tx.$queryRaw`SELECT id FROM dm_export_batches WHERE id = ${pre.batchId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM dm_export_batch_items WHERE id = ${itemId}::uuid FOR UPDATE`;

    const it = (await tx.dmExportBatchItem.findUnique({ where: { id: itemId }, select: ITEM_SELECT })) as ItemRow | null;
    if (!it) return { kind: "missing" } as const;
    const lockedSet = new Set(locked);
    if (ownersOf(it).some((id) => !lockedSet.has(id))) return { kind: "conflict", batchId: it.batchId } as const;

    let rows = it.logId ? await tx.propertyDmLog.findMany({ where: { id: it.logId }, select: LOG_SELECT }) : [];
    const decision = decideBatchUnsubscribeTarget({
      logId: it.logId,
      logExists: rows.length > 0,
      confirmed: it.batch.confirmedAt != null,
    });

    let createdLog = false;
    if (decision === "create") {
      const logId = randomUUID();
      await tx.propertyDmLog.create({
        data: {
          id: logId,
          propertyId: it.propertyId,
          ownerId: it.ownerId,
          dmType: "owner_address",
          batchId: it.batchId,
          draftId: null,
          // @db.Date は UTC 00:00 = JST 暦日(確定・反響と同じ規約)。確定時に投函日へ直る(§5.2)。
          sentAt: new Date(`${jstCalendarDay(now)}T00:00:00Z`),
          method: "mail",
          sentBy: it.batch.createdBy,
        },
      });
      const linkTargets = it.itemOwners.length > 0 ? it.itemOwners.map((o) => o.ownerId) : it.ownerId ? [it.ownerId] : [];
      if (linkTargets.length > 0) {
        await tx.propertyDmLogOwner.createMany({
          data: linkTargets.map((ownerId) => ({ logId, ownerId })),
          skipDuplicates: true,
        });
      }
      await tx.dmExportBatchItem.update({ where: { id: itemId }, data: { logId } });
      rows = await tx.propertyDmLog.findMany({ where: { id: logId }, select: LOG_SELECT });
      createdLog = true;
    } else if (decision === "legacy_lookup") {
      // 本機能より前に確定した控え(本番には存在しない)。1件に引けるときだけ使う。
      const found = await tx.propertyDmLog.findMany({
        where: { batchId: it.batchId, propertyId: it.propertyId, ownerId: it.ownerId },
        select: LOG_SELECT,
      });
      if (found.length !== 1) return { kind: "unsent", batchId: it.batchId } as const;
      await tx.dmExportBatchItem.update({ where: { id: itemId }, data: { logId: found[0].id } });
      rows = found;
    }

    // 記録側の所有者も、ロックした集合の内側であること(連関は控えの行から写したもの)。
    for (const r of rows) {
      const ids = [...(r.ownerId ? [r.ownerId] : []), ...r.logOwners.map((o) => o.ownerId)];
      if (ids.some((id) => !lockedSet.has(id))) return { kind: "conflict", batchId: it.batchId } as const;
    }

    const reactedAt = new Date(`${jstCalendarDay(now)}T00:00:00Z`);
    let changed = false;
    for (const row of rows) {
      if (isRefusalProtected(row)) continue; // 冪等: 守られた拒否はそのまま
      const note = row.reactionNote?.includes(BATCH_UNSUBSCRIBE_NOTE)
        ? row.reactionNote
        : row.reactionNote
          ? `${row.reactionNote}／${BATCH_UNSUBSCRIBE_NOTE}`
          : BATCH_UNSUBSCRIBE_NOTE;
      const next = applyManualReaction(row, { status: "refused", reactedAt, note });
      await tx.propertyDmLog.update({
        where: { id: row.id },
        data: {
          reactionStatus: next.reactionStatus,
          reactedAt: next.reactedAt,
          reactionNote: next.reactionNote,
          reactionSource: next.reactionSource,
          manualReactionShadow:
            next.manualReactionShadow == null ? Prisma.DbNull : (next.manualReactionShadow as Prisma.InputJsonValue),
        },
      });
      changed = true;
    }
    return changed
      ? ({ kind: "recorded", batchId: it.batchId, createdLog } as const)
      : ({ kind: "already", batchId: it.batchId } as const);
  });
}
```

(`lockPropertyRow` の引数型が tx と合わなければ、`src/app/u/[token]/route.ts` と同じ渡し方に合わせる。)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/dm-batch src/lib/__tests__/dm-batch-qr-unsubscribe.test.ts && npx tsc --noEmit`
Expected: PASS・tsc 0

- [ ] **Step 5: Commit**

```bash
git add src/lib/dm-batch/qr-unsubscribe.ts src/lib/dm-batch/__tests__/qr-unsubscribe-decide.test.ts src/lib/__tests__/dm-batch-qr-unsubscribe.test.ts
git commit -m "feat(dm-batch): 宛名CSVの1通の配信停止を記録する(確定前は記録を先に作る)"
```

---

### Task 6: 公開 `/u/` で宛名CSVのトークンを振り分け+監査

**Files:**
- Modify: `src/app/u/[token]/route.ts`
- Modify: `src/lib/audit-log-detail-safety.ts`・`src/app/(dashboard)/admin/audit-logs/page.tsx`
- Test: `src/lib/__tests__/dm-batch-unsubscribe-route.test.ts`(新規)・既存 `src/lib/__tests__/sale-dm-unsubscribe-route.test.ts` は無変更で通ること

**Interfaces:**
- Consumes: `isBatchItemUnsubscribeToken` `verifyBatchItemUnsubscribeToken`(Task 1)、`recordBatchItemUnsubscribe`(Task 5)

- [ ] **Step 1: Write the failing test**

```ts
import { vi, describe, it, expect, beforeEach } from "vitest";
import crypto from "crypto";

vi.mock("next/server", () => ({ NextResponse: Response }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/dm-batch/qr-unsubscribe", () => ({ recordBatchItemUnsubscribe: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ default: { dmRecipientDraft: { findUnique: vi.fn() } } }));

import { writeAuditLog } from "@/lib/audit";
import prisma from "@/lib/prisma";
import { recordBatchItemUnsubscribe } from "@/lib/dm-batch/qr-unsubscribe";
import { buildBatchItemUnsubscribeToken } from "@/lib/dm-batch/unsubscribe-token";
import { deriveUnsubscribeKey } from "@/lib/sale-dm-letter/unsubscribe-token";

const record = recordBatchItemUnsubscribe as ReturnType<typeof vi.fn>;
const ITEM = "0b7e3c1a-5d2f-4a6b-9c8d-1e2f3a4b5c6d";
let saved: string | undefined;
let seq = 0;

async function post(token: string) {
  const { POST } = await import("@/app/u/[token]/route");
  seq += 1;
  const req = new Request(`http://localhost:3000/u/${token}`, {
    method: "POST",
    headers: { host: "app.ligarejapan.com", origin: "https://app.ligarejapan.com", "x-forwarded-for": `10.8.0.${seq}` },
  });
  return POST(req as never, { params: Promise.resolve({ token }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  saved = process.env.NEXTAUTH_SECRET;
  process.env.NEXTAUTH_SECRET = "test-secret-for-batch-unsubscribe";
});
afterEach(() => {
  if (saved === undefined) delete process.env.NEXTAUTH_SECRET;
  else process.env.NEXTAUTH_SECRET = saved;
});

describe("/u/ の宛名CSVトークン", () => {
  it("正しい署名なら停止を記録し、完了画面・監査は dm_batch_qr_unsubscribe(PIIなし)", async () => {
    record.mockResolvedValue({ kind: "recorded", batchId: "B1", createdLog: true });
    const token = buildBatchItemUnsubscribeToken(ITEM, deriveUnsubscribeKey());
    const res = await post(token);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("受け付けました");
    expect(record).toHaveBeenCalledWith(ITEM);
    expect(prisma.dmRecipientDraft.findUnique).not.toHaveBeenCalled();
    const audit = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(audit).toMatchObject({ action: "dm_batch_qr_unsubscribe", targetTable: "dm_export_batch_items", targetId: ITEM });
    expect(Object.keys(audit.detail).sort()).toEqual(["at", "batchId", "createdLog", "itemId", "result"]);
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it("署名違い(別の鍵)は無効画面・記録しない", async () => {
    const token = buildBatchItemUnsubscribeToken(ITEM, crypto.randomBytes(32));
    const res = await post(token);
    expect(res.status).toBe(400);
    expect(record).not.toHaveBeenCalled();
  });

  it("unsent は成功と言わない・conflict は 409・missing と already は完了画面", async () => {
    const token = buildBatchItemUnsubscribeToken(ITEM, deriveUnsubscribeKey());
    record.mockResolvedValueOnce({ kind: "unsent", batchId: "B1" });
    expect(await (await post(token)).text()).not.toContain("受け付けました");
    record.mockResolvedValueOnce({ kind: "conflict", batchId: "B1" });
    expect((await post(token)).status).toBe(409);
    record.mockResolvedValueOnce({ kind: "missing" });
    expect(await (await post(token)).text()).toContain("受け付けました");
  });

  it("GET は形だけ見て確認画面(DBに触らない)", async () => {
    const { GET } = await import("@/app/u/[token]/route");
    const token = buildBatchItemUnsubscribeToken(ITEM, deriveUnsubscribeKey());
    const res = await GET(new Request(`http://localhost:3000/u/${token}`) as never, { params: Promise.resolve({ token }) });
    expect(res.status).toBe(200);
    expect(record).not.toHaveBeenCalled();
  });
});
```

(`afterEach` を vitest から import に足す。ルートは回数制限をモジュールで保持するので、`x-forwarded-for` を毎回変え、同じトークンへの POST は 5回/時 以内に収める=このファイルの同一トークンへの POST は計4回。)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/dm-batch-unsubscribe-route.test.ts`
Expected: FAIL(宛名CSVトークンが売却DMの検証で 400 になる)

- [ ] **Step 3: Implement**

`src/app/u/[token]/route.ts`:
- import に足す:

```ts
import {
  isBatchItemUnsubscribeToken,
  verifyBatchItemUnsubscribeToken,
} from "@/lib/dm-batch/unsubscribe-token";
import { recordBatchItemUnsubscribe } from "@/lib/dm-batch/qr-unsubscribe";
```

- POST の `const { token } = await params;` の直後(`verifyUnsubscribeToken` の前)に、宛名CSVの分岐を入れる:

```ts
  // 宛名CSVの1通(`c<32桁16進>.<署名>`)。入口の守り(per-IP・Origin・鍵)は共通、
  // 署名検証・回数制限・記録・監査をこの分岐で行う(売却DMの処理には入らない)。
  if (isBatchItemUnsubscribeToken(token)) {
    const itemId = verifyBatchItemUnsubscribeToken(token, key);
    if (!itemId) return html(renderUnsubscribeInvalidPage(), 400);
    if (!tokenLimiter.hit(`u-token:${itemId}`)) {
      return html(renderUnsubscribeThrottledPage(), 429);
    }
    if (!postGlobalLimiter.hit("global")) {
      if (throttleAuditLimiter.hit("audit")) {
        await writeAuditLog({
          action: "dm_batch_qr_unsubscribe",
          targetTable: "dm_export_batch_items",
          detail: { result: "throttled", at: new Date().toISOString() },
        });
      }
      return html(renderUnsubscribeThrottledPage(), 429);
    }
    const r = await recordBatchItemUnsubscribe(itemId);
    await writeAuditLog({
      action: "dm_batch_qr_unsubscribe",
      targetTable: "dm_export_batch_items",
      targetId: itemId,
      detail: {
        result: r.kind,
        batchId: "batchId" in r ? r.batchId : null,
        itemId,
        createdLog: r.kind === "recorded" ? r.createdLog : false,
        at: new Date().toISOString(),
      },
    });
    if (r.kind === "conflict") return html(renderUnsubscribeBusyPage(), 409);
    if (r.kind === "unsent") return html(renderUnsubscribeInvalidPage(), 200);
    return html(renderUnsubscribeDonePage(), 200);
  }
```

- ファイル冒頭の説明コメントの末尾に1行: `*  9. 宛名CSVの1通(c形式のトークン)は署名の用途ラベルを分けて同じ入口で受ける(src/lib/dm-batch/qr-unsubscribe.ts)。`

`src/lib/audit-log-detail-safety.ts` の `inquiry_auto_reply_skipped` の行の後に:

```ts
  // 宛名CSVの手紙の配信停止(QR)。result=recorded/already/unsent/missing/conflict/throttled・
  // batchId/itemId=UUID・createdLog=確定前の停止で送付記録を作ったか。氏名・住所・URL・トークンは載せない。
  dm_batch_qr_unsubscribe: new Set(["result", "batchId", "itemId", "createdLog", "at"]),
```

`src/app/(dashboard)/admin/audit-logs/page.tsx` の `inquiry_auto_reply_skipped` の行の後に:

```ts
  dm_batch_qr_unsubscribe: "宛名CSVの手紙 配信停止(QR)",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/dm-batch-unsubscribe-route.test.ts src/lib/__tests__/sale-dm-unsubscribe-route.test.ts src/lib/__tests__/audit-log-detail-safety.test.ts && npx tsc --noEmit`
Expected: PASS(売却DMの既存テストは無変更で全部通る)・tsc 0

- [ ] **Step 5: Commit**

```bash
git add "src/app/u/[token]/route.ts" src/lib/audit-log-detail-safety.ts "src/app/(dashboard)/admin/audit-logs/page.tsx" src/lib/__tests__/dm-batch-unsubscribe-route.test.ts
git commit -m "feat(dm-batch): /u/ で宛名CSVの1通の配信停止を受け付ける"
```

---

### Task 7: 画面の注意と使い方ガイド

**Files:**
- Modify: `src/app/api/properties/dm-batches/route.ts`(POST 応答に `unsubscribeUrlAvailable`)
- Modify: `src/lib/api-client.ts`(`createDmBatch` の戻り値型)
- Modify: `src/app/(dashboard)/properties/page.tsx`(`handleExportDm`・ボタンの title)
- Modify: `public/docs/guide.html`・`public/docs/manual.html`
- Test: `src/lib/__tests__/dm-batch-ui-wiring.test.ts`(追記)・`src/lib/__tests__/dm-batches-post-route.test.ts`(追記)

- [ ] **Step 1: Write the failing tests**

`dm-batches-post-route.test.ts` に追記(既存の成功ケースの準備を使い、`@/lib/sale-dm-letter/config-store` を mock):

```ts
it("応答に unsubscribeUrlAvailable(追跡URLの有無)を返す", async () => {
  arrangeCreateOk();
  loadPublicCfg.mockResolvedValue({ trackingBaseUrl: "https://app.example.com", senderName: null, senderContact: null, lpPublicEnabled: true, privacyText: null });
  expect((await (await POST(req())).json()).unsubscribeUrlAvailable).toBe(true);
  arrangeCreateOk();
  loadPublicCfg.mockResolvedValue({ trackingBaseUrl: undefined, senderName: null, senderContact: null, lpPublicEnabled: true, privacyText: null });
  expect((await (await POST(req())).json()).unsubscribeUrlAvailable).toBe(false);
});
```

`dm-batch-ui-wiring.test.ts` に追記:

```ts
it("追跡URLが未設定なら、配信停止URLの列が空になることを知らせる", () => {
  const page = readFileSync(path.join(process.cwd(), "src/app/(dashboard)/properties/page.tsx"), "utf8");
  expect(page).toContain("res.unsubscribeUrlAvailable === false");
  expect(page).toContain("配信停止URLの列は空になります");
  expect(page).toContain("最後の列に1通ごとの配信停止URL");
});

it("使い方ガイドとマニュアルに Word の DISPLAYBARCODE と業者への頼み方", () => {
  for (const f of ["public/docs/guide.html", "public/docs/manual.html"]) {
    const html = readFileSync(path.join(process.cwd(), f), "utf8");
    expect(html).toContain("DISPLAYBARCODE");
    expect(html).toContain("MERGEFIELD 配信停止URL");
    expect(html).toContain("配信停止URL の列を QR コードにして");
  }
});
```

(`readFileSync` / `path` が未 import なら足す。)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/dm-batch-ui-wiring.test.ts src/lib/__tests__/dm-batches-post-route.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

`src/app/api/properties/dm-batches/route.ts` の POST 成功の応答オブジェクトに次を足す(応答を組む直前に読む):

```ts
    let unsubscribeUrlAvailable = false;
    try {
      unsubscribeUrlAvailable = !!(await loadSaleDmPublicPageConfig()).trackingBaseUrl;
    } catch {
      unsubscribeUrlAvailable = false;
    }
```

応答に `unsubscribeUrlAvailable,` を足し、import `import { loadSaleDmPublicPageConfig } from "@/lib/sale-dm-letter/config-store";` を足す。

`src/lib/api-client.ts` の `createDmBatch` の戻り値型に `unsubscribeUrlAvailable?: boolean;` を足す(モック分岐の戻り値にも `unsubscribeUrlAvailable: true`)。

`src/app/(dashboard)/properties/page.tsx` の `handleExportDm` で、`if (excluded > 0) { ... }` の直後に:

```ts
      if (res.unsubscribeUrlAvailable === false) {
        // 配信停止URLの頭(追跡URL)が無いと、列を空のまま配ることになる。黙って配らない。
        window.alert(
          "売却DM設定の追跡URLが未設定のため、配信停止URLの列は空になります(手紙に配信停止のQRを刷れません)",
        );
      }
```

同ファイルのボタンの title(`"現在の検索条件で送付可の物件をDM差込CSV出力(控えが作られ、投函後に送付を確定できます)"`)を次に:

```ts
"現在の検索条件で送付可の物件をDM差込CSV出力(控えが作られ、投函後に送付を確定できます)。最後の列に1通ごとの配信停止URLが入ります(QRの作り方は使い方ガイド)"
```

`public/docs/manual.html` の「メール送信設定」の `<li>` の近く(DMの節)に1項目、`public/docs/guide.html` の売却DMの説明の近くに1項目を足す(文言は両方同じ趣旨):

```html
<li><b>宛名CSVの手紙に配信停止QRを付ける</b>:「DM差込CSV出力」のCSVの最後の列「配信停止URL」に、1通ごとの専用URLが入ります。<b>Wordの差し込み印刷</b>では、QRを置きたい位置で Ctrl+F9 を押して <code>{ DISPLAYBARCODE "{ MERGEFIELD 配信停止URL }" QR \q 3 \s 50 }</code> の形にします(内側の { } も Ctrl+F9 で入れます。Word 2013 以降)。QRの近くに「お手紙が不要な場合は、こちらのQRから配信停止をお申し込みいただけます」と書いておきます。<b>DM業者に渡す</b>ときは「配信停止URL の列を QR コードにして(誤り訂正 M 以上・約15mm角以上)、各通に刷ってください」と頼みます。受け手が停止すると、その手紙の宛先全員の送付記録に「拒否」が付き、以後の宛名CSV・売却DMから自動で外れます。<b>投函後は「送付の確定」を忘れずに</b>(確定の前に停止が来ても記録は残ります)。</li>
```

(⚠この HTML は Edit ツールで足す。`\q` `\s` は文字どおり書く=Bash を経由しない。)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/dm-batch-ui-wiring.test.ts src/lib/__tests__/dm-batches-post-route.test.ts && npx tsc --noEmit`
Expected: PASS・tsc 0

- [ ] **Step 5: Commit**

```bash
git add src/app/api/properties/dm-batches/route.ts src/lib/api-client.ts "src/app/(dashboard)/properties/page.tsx" public/docs/guide.html public/docs/manual.html src/lib/__tests__/dm-batch-ui-wiring.test.ts src/lib/__tests__/dm-batches-post-route.test.ts
git commit -m "feat(dm-batch): 配信停止URLの案内(追跡URL未設定の注意・使い方ガイド)"
```

---

### Task 8: 全ゲートとローカル実機

- [ ] **Step 1: 全ゲート**

```bash
npx tsc --noEmit > ../bcu-tsc.txt 2>&1; echo tsc=$?
npx vitest run > ../bcu-full.txt 2>&1; echo vitest=$?
npx eslint $(git diff --name-only origin/main...HEAD | grep -E "\.(ts|tsx)$") ; echo eslint=$?
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build > ../bcu-build.txt 2>&1; echo build=$?
git diff --stat origin/main...HEAD | grep -c "Bin"   # 0 であること(制御文字の混入なし)
```

Expected: tsc=0 / vitest=0 / eslint=0 errors / build=0 / Bin=0。⚠合否は終了コードで見る(grep で済ませない)。

- [ ] **Step 2: ローカル実機(ローカルDB・main checkout の .env を worktree にコピー)**

1. `npx prisma migrate deploy`(ローカルDBへ本件の migration)
2. `NEXTAUTH_URL=http://localhost:3062 npx next dev -p 3062` を起動
3. Playwright(`channel: "chrome"`)で admin@example.com でログイン → 物件一覧で送付可の物件を条件にして「DM差込CSV出力」→ ダウンロードされた CSV の1行目の末尾が「配信停止URL」、各行の末尾が `<追跡URL>/u/c...` であることを確認
4. その URL(ホストを `http://localhost:3062` に読み替え)を開く → 確認画面 → 「停止する」→「受け付けました」
5. DB: その控えの行の `log_id` が入り、`property_dm_logs` の該当行が `refused`・メモ「QRコードからの配信停止申込」・sentAt=今日
6. 「送付の確定」で投函日=今日を入れて確定 → 同じ記録の sentAt が投函日、送付記録の件数が控えの通数と同じ(停止した1通が2件になっていない)
7. 同じ控えを再ダウンロード → 409「拒否・宛先不明の反響が付いた宛先が含まれています」
8. 確定済みの別の控えで停止 → 確定で作った記録に拒否が付く(記録は増えない)

- [ ] **Step 3: 片付け**

dev サーバーを止める。ローカルDBの試験データは残してよい(ローカルのみ)。
