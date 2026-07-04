# 登記DM取込(exe連携 第1弾) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 外部製登記情報自動化ツールの成果物(所有者事項PDF)を一括アップロードし、サーバ側非同期ジョブで物件へ自動添付する機能と、受付帳Excel→所有者Excel→PDF→サマリの一気通貫ウィザード画面を作る。

**Architecture:** Excel側は既存API(reception-property / reception-owner)をウィザードから呼ぶだけ。新規は (a) `POST /api/import/registry-pdf-bulk`(multipart受付→ImportJob+rows(pending)作成→storageへstaging保存→インプロセス直列ワーカーへenqueue→202) (b) ワーカー(globalThis singleton・1件ずつ処理: 請求番号重複スキップ→所在正規化一致で物件突合→Attachment(type=registry)作成) (c) 再開route (d) 手動添付route (e) ジョブ詳細UIのpending対応 (f) ウィザードページ。

**Tech Stack:** Next.js App Router (route handlers, runtime nodejs) / Prisma / vitest (vi.mock convention) / 既存lib(pdf-extract, pdf-registry-parser, normalize, storage, api-helpers)。新規依存なし。

## Global Constraints

- 作業場所: worktree `C:\Users\issin\Desktop\Claude\property-management-worktrees\registry-dm-import`・branch `feat/registry-dm-import`・base `fbd45ef`。他worktree(特に `sales-sheet-polish`)には触れない。
- 新規 runtime 依存を追加しない。package.json/lock は変更しない。
- DB変更は migration 1本のみ: `ImportJobType` に `registry_pdf_bulk`、`ImportRowStatus` に `pending` を ADD VALUE(additive・IF NOT EXISTS)。
- PII規律: `ImportJobRow.rawData` と audit detail に **所有者の氏名・住所を入れない**(物件所在(location)とファイル名はOK=既存 `propertyAddress` 前例に整合)。
- エラーJSONは既存形状 `{ error: { message, code } }`。route定型: `getApiSession()`→`getUserPermissions()`→`hasPermission(perms, "import", "write")`→403、全体を `try/catch handleApiError`、`params` は `Promise<...>` で `await params`。
- multipart を受ける新routeには `export const runtime = "nodejs";` を付ける。
- UI文言は日本語。ユーザー向け文言にPR番号を書かない。
- 受付制限(承認済み仕様): 最大100ファイル/合計100MB/1ファイル5MB/PDFのみ。
- 完了ゲート: `npx tsc --noEmit` エラー0 / **full** `npx vitest run` 緑 / `npm run build` 成功 / eslint差分0(ベースライン維持)。
- コミットは各タスク末で実施。メッセージ末尾に以下2行を必ず付ける:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01GJ3Y8iGK1LSs9zJcSY6Uas
  ```

---

### Task 1: セットアップ + enum migration + 取込種別ラベル

**Files:**
- Modify: `prisma/schema.prisma:116-129`(enum 2つ)
- Create: `prisma/migrations/20260704000000_add_registry_pdf_bulk_import/migration.sql`
- Modify: `src/lib/import-labels.ts`
- Test: `src/lib/__tests__/import-labels-registry-bulk.test.ts`

**Interfaces:**
- Consumes: なし(最初のタスク)
- Produces: Prisma型 `ImportJobType.registry_pdf_bulk` / `ImportRowStatus.pending`、`IMPORT_TYPE_LABELS["registry_pdf_bulk"] === "所有者事項PDF一括"`、`getImportTypeLabel("registry_pdf_bulk")`。後続タスクは `jobType: "registry_pdf_bulk"` と `status: "pending"` を文字列リテラルで使う。

- [ ] **Step 1: 依存インストール(worktreeにnode_modulesが無い)**

Run: `cd "C:\Users\issin\Desktop\Claude\property-management-worktrees\registry-dm-import" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci`
Expected: exit 0(EBADENGINE warning は既知・非致命)

- [ ] **Step 2: 失敗するテストを書く**

`src/lib/__tests__/import-labels-registry-bulk.test.ts` を新規作成:

```ts
import { describe, it, expect } from "vitest";
import {
  IMPORT_TYPE_LABELS,
  getImportTypeLabel,
  IMPORT_TYPE_FILTER_OPTIONS,
} from "@/lib/import-labels";

describe("import-labels: registry_pdf_bulk", () => {
  it("registry_pdf_bulk のラベルが定義されている", () => {
    expect(IMPORT_TYPE_LABELS.registry_pdf_bulk).toBe("所有者事項PDF一括");
    expect(getImportTypeLabel("registry_pdf_bulk")).toBe("所有者事項PDF一括");
  });

  it("履歴フィルタ選択肢に registry_pdf_bulk が含まれる", () => {
    expect(
      IMPORT_TYPE_FILTER_OPTIONS.some((o) => o.value === "registry_pdf_bulk"),
    ).toBe(true);
  });
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `npx vitest run src/lib/__tests__/import-labels-registry-bulk.test.ts`
Expected: FAIL(`registry_pdf_bulk` が undefined)

- [ ] **Step 4: schema.prisma の enum 2つに値を追加**

`prisma/schema.prisma` の `enum ImportJobType`(L116-122) を:

```prisma
enum ImportJobType {
  property_csv
  owner_csv
  dm_history_csv
  investigation_csv
  property_pdf
  registry_pdf_bulk
}
```

`enum ImportRowStatus`(L124-129) を:

```prisma
enum ImportRowStatus {
  success
  error
  skipped
  needs_review
  pending
}
```

- [ ] **Step 5: migration ファイルを作成**

`prisma/migrations/20260704000000_add_registry_pdf_bulk_import/migration.sql` を新規作成:

```sql
-- AlterEnum: 所有者事項PDF一括取込(registry_pdf_bulk)のジョブ種別と、
-- 非同期処理の未処理行を表す pending 行状態を追加する。
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction on PG < 12.
ALTER TYPE "ImportJobType" ADD VALUE IF NOT EXISTS 'registry_pdf_bulk';
ALTER TYPE "ImportRowStatus" ADD VALUE IF NOT EXISTS 'pending';
```

- [ ] **Step 6: Prisma client 再生成**

Run: `npx prisma generate`
Expected: exit 0・`Generated Prisma Client` 表示

- [ ] **Step 7: import-labels.ts に追記**

`IMPORT_TYPE_LABELS` に1行追加(`investigation_csv` の下):

```ts
  investigation_csv: "調査CSV",
  registry_pdf_bulk: "所有者事項PDF一括",
```

`IMPORT_TYPE_FILTER_OPTIONS` の配列末尾に追加:

```ts
  { value: "investigation_csv", label: IMPORT_TYPE_LABELS.investigation_csv },
  { value: "registry_pdf_bulk", label: IMPORT_TYPE_LABELS.registry_pdf_bulk },
```

- [ ] **Step 8: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/import-labels-registry-bulk.test.ts`
Expected: PASS(2 tests)

- [ ] **Step 9: コミット**

```bash
git add prisma/schema.prisma prisma/migrations/20260704000000_add_registry_pdf_bulk_import/migration.sql src/lib/import-labels.ts src/lib/__tests__/import-labels-registry-bulk.test.ts
git commit -m "feat(import): registry_pdf_bulk 取込種別と pending 行状態を追加(enum migration)"
```

---

### Task 2: ファイル名解析lib(純関数)

**Files:**
- Create: `src/lib/registry-pdf-bulk/filename.ts`
- Test: `src/lib/registry-pdf-bulk/__tests__/filename.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  ```ts
  export interface RegistryPdfBulkFilename {
    location: string;                    // 例: "世田谷区上馬２丁目７５２－３"(原文のまま・trim済)
    kind: "土地" | "建物" | null;
    requestNumber: string;               // 請求番号(数字10〜20桁)
  }
  export function parseRegistryPdfBulkFilename(
    fileName: string | null | undefined,
  ): RegistryPdfBulkFilename | null;     // パターン外は null
  ```

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/registry-pdf-bulk/__tests__/filename.test.ts` を新規作成:

```ts
import { describe, it, expect } from "vitest";
import { parseRegistryPdfBulkFilename } from "../filename";

describe("parseRegistryPdfBulkFilename", () => {
  it("建物所有者事項のファイル名を分解できる", () => {
    const r = parseRegistryPdfBulkFilename(
      "世田谷区上馬２丁目７５２－３不動産登記（建物所有者事項）2024121200118150.PDF",
    );
    expect(r).toEqual({
      location: "世田谷区上馬２丁目７５２－３",
      kind: "建物",
      requestNumber: "2024121200118150",
    });
  });

  it("土地所有者事項のファイル名を分解できる", () => {
    const r = parseRegistryPdfBulkFilename(
      "世田谷区弦巻１丁目３２－３１不動産登記（土地所有者事項）2024121100710215.pdf",
    );
    expect(r?.kind).toBe("土地");
    expect(r?.location).toBe("世田谷区弦巻１丁目３２－３１");
    expect(r?.requestNumber).toBe("2024121100710215");
  });

  it("区分建物(部屋番号付き所在)も location として取れる", () => {
    const r = parseRegistryPdfBulkFilename(
      "世田谷区千歳台６丁目１－７－Ｂ－１３０７不動産登記（建物所有者事項）2024121200071363.PDF",
    );
    expect(r?.location).toBe("世田谷区千歳台６丁目１－７－Ｂ－１３０７");
  });

  it("コピーで付く ' (1)' サフィックスを許容する", () => {
    const r = parseRegistryPdfBulkFilename(
      "世田谷区上馬２丁目７５２－３不動産登記（建物所有者事項）2024121200118150 (1).pdf",
    );
    expect(r?.requestNumber).toBe("2024121200118150");
  });

  it("パターン外・null・空は null を返す", () => {
    expect(parseRegistryPdfBulkFilename("registry.pdf")).toBeNull();
    expect(parseRegistryPdfBulkFilename("所有者一覧.xlsx")).toBeNull();
    expect(parseRegistryPdfBulkFilename(null)).toBeNull();
    expect(parseRegistryPdfBulkFilename("")).toBeNull();
    // location が空になるものは null
    expect(
      parseRegistryPdfBulkFilename(
        "不動産登記（建物所有者事項）2024121200118150.pdf",
      ),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run src/lib/registry-pdf-bulk/__tests__/filename.test.ts`
Expected: FAIL(モジュールが存在しない)

- [ ] **Step 3: 実装を書く**

`src/lib/registry-pdf-bulk/filename.ts` を新規作成:

```ts
/**
 * 外部製「不動産登記情報自動化システム」が出力する所有者事項PDFの
 * ファイル名を分解する純関数。
 *
 * 形式: `{所在}不動産登記（{土地|建物}所有者事項）{請求番号}.PDF`
 *   例: 世田谷区上馬２丁目７５２－３不動産登記（建物所有者事項）2024121200118150.PDF
 *
 * 所在は受付帳Excel由来の文字列で、受付帳取込が作る Property.address と
 * 同一ソースのため、正規化完全一致での物件突合キーとして使える。
 */

export interface RegistryPdfBulkFilename {
  location: string;
  kind: "土地" | "建物" | null;
  requestNumber: string;
}

// 括弧は全角（）。請求番号は実サンプルで16桁だが、桁数変更に備え10〜20桁を許容。
// 末尾の " (1)" はエクスプローラのコピーで付くサフィックスとして許容する。
const FILENAME_PATTERN =
  /^(.+?)不動産登記（(土地|建物)?所有者事項）(\d{10,20})(?:\s*\(\d+\))?\.pdf$/i;

export function parseRegistryPdfBulkFilename(
  fileName: string | null | undefined,
): RegistryPdfBulkFilename | null {
  if (!fileName) return null;
  // macOS由来のNFD分解文字を合成しておく(濁点分離などでの取りこぼし防止)
  const m = fileName.normalize("NFC").trim().match(FILENAME_PATTERN);
  if (!m) return null;
  const location = m[1].trim();
  if (!location) return null;
  return {
    location,
    kind: (m[2] as "土地" | "建物" | undefined) ?? null,
    requestNumber: m[3],
  };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/registry-pdf-bulk/__tests__/filename.test.ts`
Expected: PASS(5 tests)

- [ ] **Step 5: コミット**

```bash
git add src/lib/registry-pdf-bulk/filename.ts src/lib/registry-pdf-bulk/__tests__/filename.test.ts
git commit -m "feat(import): 所有者事項PDFファイル名の解析lib(所在/種別/請求番号)"
```

---

### Task 3: 物件突合インデックスと重複判定lib

**Files:**
- Create: `src/lib/registry-pdf-bulk/match.ts`
- Test: `src/lib/registry-pdf-bulk/__tests__/match.test.ts`

**Interfaces:**
- Consumes: `normalizeAddress`(`@/lib/normalize`)
- Produces:
  ```ts
  export interface PropertyIndexEntry { id: string; }
  export interface PropertyIndex {
    byAddress: Map<string, string[]>;          // normalizeAddress(address) -> propertyId[]
    byRealEstateNumber: Map<string, string[]>; // realEstateNumber -> propertyId[]
  }
  export function buildPropertyIndex(
    properties: Array<{ id: string; address: string; realEstateNumber: string | null }>,
  ): PropertyIndex;
  export type PropertyMatchResult =
    | { status: "matched"; propertyId: string; matchedBy: "address" | "real_estate_number" }
    | { status: "not_found" }
    | { status: "multiple"; count: number };
  export function matchProperty(
    index: PropertyIndex,
    keys: { location?: string | null; realEstateNumber?: string | null },
  ): PropertyMatchResult;
  ```
  優先順: realEstateNumber 完全一致 → 所在の正規化完全一致(既存 Mode B と同じ優先順)。部分一致はしない。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/registry-pdf-bulk/__tests__/match.test.ts` を新規作成:

```ts
import { describe, it, expect } from "vitest";
import { buildPropertyIndex, matchProperty } from "../match";

const PROPS = [
  { id: "p1", address: "世田谷区上馬２丁目７５２－３", realEstateNumber: null },
  { id: "p2", address: "世田谷区弦巻１丁目３２－３１", realEstateNumber: "0123456789012" },
  // p3/p4 は同一所在(重複物件)
  { id: "p3", address: "世田谷区等々力２丁目３４－７３", realEstateNumber: null },
  { id: "p4", address: "世田谷区等々力２丁目３４－７３", realEstateNumber: null },
];

describe("buildPropertyIndex / matchProperty", () => {
  const index = buildPropertyIndex(PROPS);

  it("所在の正規化完全一致で1件に決まる(全角/半角・ハイフン揺れを吸収)", () => {
    // 半角数字+ASCIIハイフンでも NFKC+ハイフン統一で一致する
    const r = matchProperty(index, { location: "世田谷区上馬2丁目752-3" });
    expect(r).toEqual({ status: "matched", propertyId: "p1", matchedBy: "address" });
  });

  it("realEstateNumber があれば所在より優先して一致する", () => {
    const r = matchProperty(index, {
      location: "世田谷区上馬２丁目７５２－３", // p1の所在
      realEstateNumber: "0123456789012",        // p2の番号
    });
    expect(r).toEqual({
      status: "matched",
      propertyId: "p2",
      matchedBy: "real_estate_number",
    });
  });

  it("同一所在が複数あれば multiple", () => {
    const r = matchProperty(index, { location: "世田谷区等々力２丁目３４－７３" });
    expect(r).toEqual({ status: "multiple", count: 2 });
  });

  it("一致なしは not_found", () => {
    expect(matchProperty(index, { location: "杉並区高円寺南１丁目１－１" })).toEqual({
      status: "not_found",
    });
    expect(matchProperty(index, {})).toEqual({ status: "not_found" });
    expect(matchProperty(index, { location: "" })).toEqual({ status: "not_found" });
  });

  it("address が空の物件は index に入らない", () => {
    const idx = buildPropertyIndex([
      { id: "px", address: "", realEstateNumber: null },
    ]);
    expect(idx.byAddress.size).toBe(0);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run src/lib/registry-pdf-bulk/__tests__/match.test.ts`
Expected: FAIL(モジュールが存在しない)

- [ ] **Step 3: 実装を書く**

`src/lib/registry-pdf-bulk/match.ts` を新規作成:

```ts
import { normalizeAddress } from "@/lib/normalize";

/**
 * 所有者事項PDF一括取込の物件突合。
 *
 * ジョブ開始時に全物件を1回だけ読み込んで正規化インデックスを作り、
 * 行ごとの突合は Map lookup のみで行う(行数×全件スキャンを避ける)。
 * 一致判定は既存 Mode B(registry-pdf/process.ts)と同じ優先順:
 *   1. realEstateNumber 完全一致
 *   2. 所在(normalizeAddress)完全一致
 * 部分一致による自動添付は誤紐付けリスクがあるため行わない(0件/複数件は要確認へ)。
 */

export interface PropertyIndex {
  byAddress: Map<string, string[]>;
  byRealEstateNumber: Map<string, string[]>;
}

export function buildPropertyIndex(
  properties: Array<{
    id: string;
    address: string;
    realEstateNumber: string | null;
  }>,
): PropertyIndex {
  const byAddress = new Map<string, string[]>();
  const byRealEstateNumber = new Map<string, string[]>();
  for (const p of properties) {
    const addr = normalizeAddress(p.address);
    if (addr !== "") {
      const list = byAddress.get(addr) ?? [];
      list.push(p.id);
      byAddress.set(addr, list);
    }
    const ren = (p.realEstateNumber ?? "").trim();
    if (ren !== "") {
      const list = byRealEstateNumber.get(ren) ?? [];
      list.push(p.id);
      byRealEstateNumber.set(ren, list);
    }
  }
  return { byAddress, byRealEstateNumber };
}

export type PropertyMatchResult =
  | {
      status: "matched";
      propertyId: string;
      matchedBy: "address" | "real_estate_number";
    }
  | { status: "not_found" }
  | { status: "multiple"; count: number };

export function matchProperty(
  index: PropertyIndex,
  keys: { location?: string | null; realEstateNumber?: string | null },
): PropertyMatchResult {
  const ren = (keys.realEstateNumber ?? "").trim();
  if (ren !== "") {
    const hits = index.byRealEstateNumber.get(ren);
    if (hits && hits.length === 1) {
      return {
        status: "matched",
        propertyId: hits[0],
        matchedBy: "real_estate_number",
      };
    }
    if (hits && hits.length > 1) {
      return { status: "multiple", count: hits.length };
    }
    // 番号不一致は所在フォールバックへ
  }
  const addr = normalizeAddress(keys.location ?? "");
  if (addr === "") return { status: "not_found" };
  const hits = index.byAddress.get(addr);
  if (!hits || hits.length === 0) return { status: "not_found" };
  if (hits.length > 1) return { status: "multiple", count: hits.length };
  return { status: "matched", propertyId: hits[0], matchedBy: "address" };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/registry-pdf-bulk/__tests__/match.test.ts`
Expected: PASS(5 tests)

- [ ] **Step 5: コミット**

```bash
git add src/lib/registry-pdf-bulk/match.ts src/lib/registry-pdf-bulk/__tests__/match.test.ts
git commit -m "feat(import): 所有者事項PDF一括の物件突合インデックス(正規化完全一致のみ)"
```

---

### Task 4: staging キー lib

**Files:**
- Create: `src/lib/registry-pdf-bulk/staging.ts`
- Test: `src/lib/registry-pdf-bulk/__tests__/staging.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  ```ts
  export function registryPdfBulkStagingKey(jobId: string, rowNumber: number): string;
  // -> `import-staging/registry-pdf/${jobId}/${rowNumber}.pdf`
  ```
  staging ファイルの読み書き削除は呼び出し側が `getStorage()` を直接使う(このlibはキー規約のみを固定する)。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/registry-pdf-bulk/__tests__/staging.test.ts` を新規作成:

```ts
import { describe, it, expect } from "vitest";
import { registryPdfBulkStagingKey } from "../staging";

describe("registryPdfBulkStagingKey", () => {
  it("ジョブID/行番号からキーを組み立てる", () => {
    expect(
      registryPdfBulkStagingKey("11111111-2222-3333-4444-555555555555", 3),
    ).toBe(
      "import-staging/registry-pdf/11111111-2222-3333-4444-555555555555/3.pdf",
    );
  });

  it("不正な入力は throw(キーにtraversal要素を入れない)", () => {
    expect(() => registryPdfBulkStagingKey("../etc", 1)).toThrow();
    expect(() => registryPdfBulkStagingKey("", 1)).toThrow();
    expect(() =>
      registryPdfBulkStagingKey("11111111-2222-3333-4444-555555555555", 0),
    ).toThrow();
    expect(() =>
      registryPdfBulkStagingKey("11111111-2222-3333-4444-555555555555", 1.5),
    ).toThrow();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run src/lib/registry-pdf-bulk/__tests__/staging.test.ts`
Expected: FAIL(モジュールが存在しない)

- [ ] **Step 3: 実装を書く**

`src/lib/registry-pdf-bulk/staging.ts` を新規作成:

```ts
/**
 * 所有者事項PDF一括取込の staging 保存キー規約。
 *
 * アップロード直後のPDFは物件が決まるまで
 * `import-staging/registry-pdf/{jobId}/{rowNumber}.pdf` に置く。
 * 添付成功/重複スキップ時に削除し、要確認(needs_review)の間は
 * 手動添付に備えて保持する。
 *
 * jobId は Prisma の uuid、rowNumber は正の整数のみを許可し、
 * storage キーに traversal 要素が混ざらないことをここで保証する。
 */

const SAFE_JOB_ID = /^[0-9a-f-]{8,64}$/i;

export function registryPdfBulkStagingKey(
  jobId: string,
  rowNumber: number,
): string {
  if (!SAFE_JOB_ID.test(jobId)) {
    throw new Error(`Invalid jobId for staging key: ${jobId}`);
  }
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    throw new Error(`Invalid rowNumber for staging key: ${rowNumber}`);
  }
  return `import-staging/registry-pdf/${jobId}/${rowNumber}.pdf`;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/registry-pdf-bulk/__tests__/staging.test.ts`
Expected: PASS(2 tests)

- [ ] **Step 5: コミット**

```bash
git add src/lib/registry-pdf-bulk/staging.ts src/lib/registry-pdf-bulk/__tests__/staging.test.ts
git commit -m "feat(import): 所有者事項PDF一括のstagingキー規約"
```

---

### Task 5: 1行処理パイプライン(process-row)

**Files:**
- Create: `src/lib/registry-pdf-bulk/process-row.ts`
- Test: `src/lib/registry-pdf-bulk/__tests__/process-row.test.ts`

**Interfaces:**
- Consumes: `parseRegistryPdfBulkFilename`(Task 2)、`matchProperty`/`PropertyIndex`(Task 3)、`registryPdfBulkStagingKey` は使わない(stagedKey は rawData から読む)。既存: `prisma`(default export)、`getStorage`、`extractTextFromPdf`/`isPdfBuffer`(不使用)、`parseRegistryText`、`canAccessPropertyRecord`(`@/lib/property-access`)、`writeAuditLog`(`@/lib/audit`)、`validateFile`/`ALLOWED_ATTACHMENT_MIMES`(`@/lib/storage`)。
- Produces:
  ```ts
  export interface BulkRowExecutor { id: string; role: string; }
  export type BulkRowOutcome = "success" | "skipped" | "needs_review" | "error" | "noop";
  export async function processRegistryPdfBulkRow(args: {
    jobId: string;
    rowId: string;
    index: PropertyIndex;      // Task 3
    executor: BulkRowExecutor; // job.executedBy のユーザー
  }): Promise<BulkRowOutcome>;
  ```
  rawData 規約(bulk route が作る): `{ fileName, stagedKey, requestNumber?, location?, kind? }`(全て string)。処理後に `{ ...rawData, matchedBy?, attachmentId?, reason? }` を追記して保存する。**所有者の氏名・住所は絶対に入れない。**

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/registry-pdf-bulk/__tests__/process-row.test.ts` を新規作成(vi.mock 定型は photos route test と同じ「import前にmock」方式):

```ts
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  default: {
    importJobRow: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    attachment: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    property: {
      findUnique: vi.fn(),
    },
  },
}));
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    getStorage: vi.fn(),
  };
});
vi.mock("@/lib/pdf-extract", () => ({
  extractTextFromPdf: vi.fn(),
}));
vi.mock("@/lib/pdf-registry-parser", () => ({
  parseRegistryText: vi.fn(),
}));
vi.mock("@/lib/property-access", () => ({
  canAccessPropertyRecord: vi.fn(() => true),
}));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

import prisma from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { extractTextFromPdf } from "@/lib/pdf-extract";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { processRegistryPdfBulkRow } from "../process-row";
import { buildPropertyIndex } from "../match";

type PM = {
  importJobRow: { findUnique: Mock; updateMany: Mock };
  attachment: { findFirst: Mock; create: Mock };
  property: { findUnique: Mock };
};
const pm = prisma as unknown as PM;

const EXEC = { id: "u1", role: "admin" };
const INDEX = buildPropertyIndex([
  { id: "p1", address: "世田谷区上馬２丁目７５２－３", realEstateNumber: null },
  { id: "p3", address: "世田谷区等々力２丁目３４－７３", realEstateNumber: null },
  { id: "p4", address: "世田谷区等々力２丁目３４－７３", realEstateNumber: null },
]);

// PDFヘッダを持つ最小バッファ
const PDF_BUF = Buffer.from("%PDF-1.4 test");

function makeRow(rawData: Record<string, string>) {
  return {
    id: "r1",
    jobId: "j1",
    rowNumber: 1,
    status: "pending",
    rawData,
    errorMessage: null,
    createdId: null,
  };
}

const storageMock = {
  read: vi.fn(),
  upload: vi.fn(),
  delete: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  (getStorage as Mock).mockReturnValue(storageMock);
  (canAccessPropertyRecord as Mock).mockReturnValue(true);
  pm.importJobRow.updateMany.mockResolvedValue({ count: 1 });
  pm.attachment.findFirst.mockResolvedValue(null);
  pm.property.findUnique.mockResolvedValue({ createdBy: "u1", assignedTo: null });
  storageMock.read.mockResolvedValue({
    body: PDF_BUF,
    contentType: "application/pdf",
    size: PDF_BUF.length,
  });
  storageMock.upload.mockResolvedValue({
    url: "/uploads/properties/p1/registry/x.pdf",
    key: "properties/p1/registry/x.pdf",
  });
  storageMock.delete.mockResolvedValue(undefined);
  pm.attachment.create.mockResolvedValue({ id: "att1" });
});

describe("processRegistryPdfBulkRow", () => {
  it("所在一致で添付し success で確定・stagingを削除する", async () => {
    pm.importJobRow.findUnique.mockResolvedValue(
      makeRow({
        fileName: "世田谷区上馬２丁目７５２－３不動産登記（建物所有者事項）2024121200118150.PDF",
        stagedKey: "import-staging/registry-pdf/j1/1.pdf",
        requestNumber: "2024121200118150",
        location: "世田谷区上馬２丁目７５２－３",
      }),
    );
    const outcome = await processRegistryPdfBulkRow({
      jobId: "j1",
      rowId: "r1",
      index: INDEX,
      executor: EXEC,
    });
    expect(outcome).toBe("success");
    expect(pm.attachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "registry",
          propertyId: "p1",
          uploadedBy: "u1",
          mimeType: "application/pdf",
        }),
        select: { id: true },
      }),
    );
    // 確定は status=pending 条件付き updateMany(atomic)
    const finalize = pm.importJobRow.updateMany.mock.calls.at(-1)![0];
    expect(finalize.where).toEqual({ id: "r1", status: "pending" });
    expect(finalize.data.status).toBe("success");
    expect(finalize.data.createdId).toBe("p1");
    expect(storageMock.delete).toHaveBeenCalledWith(
      "import-staging/registry-pdf/j1/1.pdf",
    );
  });

  it("請求番号が既存添付にあれば skipped(重複)でstagingも削除", async () => {
    pm.attachment.findFirst.mockResolvedValue({ id: "old", propertyId: "p1" });
    pm.importJobRow.findUnique.mockResolvedValue(
      makeRow({
        fileName: "世田谷区上馬２丁目７５２－３不動産登記（建物所有者事項）2024121200118150.PDF",
        stagedKey: "import-staging/registry-pdf/j1/1.pdf",
        requestNumber: "2024121200118150",
        location: "世田谷区上馬２丁目７５２－３",
      }),
    );
    const outcome = await processRegistryPdfBulkRow({
      jobId: "j1", rowId: "r1", index: INDEX, executor: EXEC,
    });
    expect(outcome).toBe("skipped");
    expect(pm.attachment.create).not.toHaveBeenCalled();
    const finalize = pm.importJobRow.updateMany.mock.calls.at(-1)![0];
    expect(finalize.data.status).toBe("skipped");
    expect(String(finalize.data.errorMessage)).toMatch(/^重複/);
    expect(storageMock.delete).toHaveBeenCalled();
  });

  it("所在不一致はPDF内容フォールバックでも0件なら needs_review(staging保持)", async () => {
    (extractTextFromPdf as Mock).mockResolvedValue("dummy text");
    (parseRegistryText as Mock).mockReturnValue({
      address: "杉並区高円寺南１丁目１－１",
      realEstateNumber: null,
    });
    pm.importJobRow.findUnique.mockResolvedValue(
      makeRow({
        fileName: "杉並区高円寺南１丁目１－１不動産登記（土地所有者事項）2024121200999999.PDF",
        stagedKey: "import-staging/registry-pdf/j1/1.pdf",
        requestNumber: "2024121200999999",
        location: "杉並区高円寺南１丁目１－１",
      }),
    );
    const outcome = await processRegistryPdfBulkRow({
      jobId: "j1", rowId: "r1", index: INDEX, executor: EXEC,
    });
    expect(outcome).toBe("needs_review");
    expect(pm.attachment.create).not.toHaveBeenCalled();
    expect(storageMock.delete).not.toHaveBeenCalled();
    const finalize = pm.importJobRow.updateMany.mock.calls.at(-1)![0];
    expect(finalize.data.status).toBe("needs_review");
  });

  it("複数候補は needs_review(候補件数を記録)", async () => {
    pm.importJobRow.findUnique.mockResolvedValue(
      makeRow({
        fileName: "世田谷区等々力２丁目３４－７３不動産登記（土地所有者事項）2024121100711621.PDF",
        stagedKey: "import-staging/registry-pdf/j1/1.pdf",
        requestNumber: "2024121100711621",
        location: "世田谷区等々力２丁目３４－７３",
      }),
    );
    const outcome = await processRegistryPdfBulkRow({
      jobId: "j1", rowId: "r1", index: INDEX, executor: EXEC,
    });
    expect(outcome).toBe("needs_review");
    const finalize = pm.importJobRow.updateMany.mock.calls.at(-1)![0];
    expect(String(finalize.data.errorMessage)).toContain("複数");
  });

  it("staging読取不能は error", async () => {
    storageMock.read.mockResolvedValue(null);
    pm.importJobRow.findUnique.mockResolvedValue(
      makeRow({
        fileName: "世田谷区上馬２丁目７５２－３不動産登記（建物所有者事項）2024121200118151.PDF",
        stagedKey: "import-staging/registry-pdf/j1/1.pdf",
        requestNumber: "2024121200118151",
        // location無し → 内容フォールររバックに行く前に staging read が必要
      }),
    );
    (extractTextFromPdf as Mock).mockResolvedValue("x");
    (parseRegistryText as Mock).mockReturnValue({ address: null, realEstateNumber: null });
    const outcome = await processRegistryPdfBulkRow({
      jobId: "j1", rowId: "r1", index: INDEX, executor: EXEC,
    });
    expect(outcome).toBe("error");
  });

  it("pending以外の行は noop(再enqueue耐性)", async () => {
    pm.importJobRow.findUnique.mockResolvedValue({
      ...makeRow({ fileName: "x", stagedKey: "k" }),
      status: "success",
    });
    const outcome = await processRegistryPdfBulkRow({
      jobId: "j1", rowId: "r1", index: INDEX, executor: EXEC,
    });
    expect(outcome).toBe("noop");
    expect(pm.importJobRow.updateMany).not.toHaveBeenCalled();
  });

  it("アクセス権が無い物件への一致は needs_review", async () => {
    (canAccessPropertyRecord as Mock).mockReturnValue(false);
    pm.importJobRow.findUnique.mockResolvedValue(
      makeRow({
        fileName: "世田谷区上馬２丁目７５２－３不動産登記（建物所有者事項）2024121200118150.PDF",
        stagedKey: "import-staging/registry-pdf/j1/1.pdf",
        requestNumber: "2024121200118150",
        location: "世田谷区上馬２丁目７５２－３",
      }),
    );
    const outcome = await processRegistryPdfBulkRow({
      jobId: "j1", rowId: "r1", index: INDEX, executor: EXEC,
    });
    expect(outcome).toBe("needs_review");
    expect(pm.attachment.create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run src/lib/registry-pdf-bulk/__tests__/process-row.test.ts`
Expected: FAIL(process-row モジュールが存在しない)

- [ ] **Step 3: 実装を書く**

`src/lib/registry-pdf-bulk/process-row.ts` を新規作成:

```ts
import { randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import { getStorage, validateFile, ALLOWED_ATTACHMENT_MIMES } from "@/lib/storage";
import { extractTextFromPdf } from "@/lib/pdf-extract";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { writeAuditLog } from "@/lib/audit";
import { matchProperty, type PropertyIndex } from "./match";

/**
 * 所有者事項PDF一括取込: 1行(=1ファイル)の処理。
 *
 * 流れ: pending確認 → 請求番号の重複スキップ → 物件突合
 *       (ファイル名の所在 → だめならPDF内容の所在/不動産番号) →
 *       Attachment(type=registry)作成 → 行を atomic に確定。
 *
 * - 確定は必ず `updateMany({ where: { id, status: "pending" } })` で行う。
 *   ワーカーは単一直列だが、再開の二重enqueueや再起動後の残骸に対して
 *   「pending の行だけが確定できる」ことで冪等性を担保する。
 * - クラッシュで「添付済みなのに行がpendingのまま」になった場合も、
 *   再処理時に請求番号の重複チェックが skipped に倒すので二重添付されない。
 * - rawData/エラーメッセージに所有者の氏名・住所は入れない(PII規律)。
 */

export interface BulkRowExecutor {
  id: string;
  role: string;
}

export type BulkRowOutcome =
  | "success"
  | "skipped"
  | "needs_review"
  | "error"
  | "noop";

interface BulkRawData {
  fileName?: string;
  stagedKey?: string;
  requestNumber?: string;
  location?: string;
  kind?: string;
  [key: string]: unknown;
}

async function finalizeRow(
  rowId: string,
  data: {
    status: "success" | "skipped" | "needs_review" | "error";
    errorMessage: string | null;
    createdId: string | null;
    rawData: Record<string, unknown>;
  },
): Promise<boolean> {
  const res = await prisma.importJobRow.updateMany({
    where: { id: rowId, status: "pending" },
    data,
  });
  return res.count === 1;
}

export async function processRegistryPdfBulkRow(args: {
  jobId: string;
  rowId: string;
  index: PropertyIndex;
  executor: BulkRowExecutor;
}): Promise<BulkRowOutcome> {
  const { jobId, rowId, index, executor } = args;
  const row = await prisma.importJobRow.findUnique({ where: { id: rowId } });
  if (!row || row.jobId !== jobId || row.status !== "pending") {
    return "noop";
  }
  const raw = ((row.rawData ?? {}) as BulkRawData) ?? {};
  const fileName = typeof raw.fileName === "string" ? raw.fileName : "";
  const stagedKey = typeof raw.stagedKey === "string" ? raw.stagedKey : "";
  const requestNumber =
    typeof raw.requestNumber === "string" && raw.requestNumber !== ""
      ? raw.requestNumber
      : null;
  const location =
    typeof raw.location === "string" && raw.location !== ""
      ? raw.location
      : null;
  const storage = getStorage();

  try {
    if (!stagedKey) {
      await finalizeRow(rowId, {
        status: "error",
        errorMessage: "取込データが不完全です(保管キーなし)",
        createdId: null,
        rawData: { ...raw, reason: "no_staged_key" },
      });
      return "error";
    }

    // 1. 請求番号による重複スキップ(exeの「取得済みはスキップ」と同発想)
    if (requestNumber) {
      const dup = await prisma.attachment.findFirst({
        where: {
          type: "registry",
          isDeleted: false,
          fileName: { contains: requestNumber },
        },
        select: { id: true, propertyId: true },
      });
      if (dup) {
        await finalizeRow(rowId, {
          status: "skipped",
          errorMessage: `重複: 請求番号 ${requestNumber} は取込済みです`,
          createdId: dup.propertyId,
          rawData: { ...raw, reason: "duplicate_request_number" },
        });
        try {
          await storage.delete(stagedKey);
        } catch (e) {
          console.error("registry-pdf-bulk: staging delete failed:", e);
        }
        return "skipped";
      }
    }

    // 2. 物件突合: まずファイル名の所在、だめならPDF内容でフォールバック
    let buffer: Buffer | null = null;
    const readStaged = async (): Promise<Buffer | null> => {
      if (buffer) return buffer;
      const res = await storage.read(stagedKey);
      if (!res) return null;
      buffer = res.body;
      return buffer;
    };

    let match = matchProperty(index, { location });
    let matchedVia: "filename" | "content" = "filename";
    if (match.status === "not_found") {
      const buf = await readStaged();
      if (!buf) {
        await finalizeRow(rowId, {
          status: "error",
          errorMessage:
            "保管中のPDFを読み取れませんでした(整理済みの可能性があります)",
          createdId: null,
          rawData: { ...raw, reason: "staged_file_missing" },
        });
        return "error";
      }
      try {
        const text = await extractTextFromPdf(buf);
        const parsed = parseRegistryText(text);
        const fallback = matchProperty(index, {
          location: parsed.address,
          realEstateNumber: parsed.realEstateNumber,
        });
        if (fallback.status !== "not_found") {
          match = fallback;
          matchedVia = "content";
        }
      } catch (e) {
        // 内容フォールバックの失敗は「一致なし」として扱う(下の needs_review へ)
        console.error("registry-pdf-bulk: content fallback failed:", e);
      }
    }

    if (match.status === "multiple") {
      await finalizeRow(rowId, {
        status: "needs_review",
        errorMessage: `候補が複数あります(${match.count}件)。物件を指定して添付してください`,
        createdId: null,
        rawData: { ...raw, reason: "multiple_candidates" },
      });
      return "needs_review";
    }
    if (match.status === "not_found") {
      await finalizeRow(rowId, {
        status: "needs_review",
        errorMessage:
          "一致する物件が見つかりません。物件を指定して添付してください",
        createdId: null,
        rawData: { ...raw, reason: "not_found" },
      });
      return "needs_review";
    }

    // 3. アクセス権(既存 A-2b と同じ: 書込直前に対象物件の権限を確認)
    const target = await prisma.property.findUnique({
      where: { id: match.propertyId },
      select: { createdBy: true, assignedTo: true },
    });
    if (!target || !canAccessPropertyRecord(executor, target)) {
      await finalizeRow(rowId, {
        status: "needs_review",
        errorMessage:
          "一致した物件へのアクセス権が無いため添付できません。物件を指定して添付してください",
        createdId: null,
        rawData: { ...raw, reason: "no_access" },
      });
      return "needs_review";
    }

    // 4. 添付(既存 A-2b パターン: validate → upload → create → 失敗時は孤児削除)
    const buf = await readStaged();
    if (!buf) {
      await finalizeRow(rowId, {
        status: "error",
        errorMessage:
          "保管中のPDFを読み取れませんでした(整理済みの可能性があります)",
        createdId: null,
        rawData: { ...raw, reason: "staged_file_missing" },
      });
      return "error";
    }
    const validationError = validateFile(
      buf.length,
      "application/pdf",
      ALLOWED_ATTACHMENT_MIMES,
    );
    if (validationError) {
      await finalizeRow(rowId, {
        status: "error",
        errorMessage: validationError,
        createdId: null,
        rawData: { ...raw, reason: "validation_failed" },
      });
      return "error";
    }
    let uploadedKey: string | null = null;
    let attachmentId: string;
    try {
      const key = `properties/${match.propertyId}/registry/${Date.now()}-${randomUUID()}.pdf`;
      const uploaded = await storage.upload(buf, {
        key,
        mimeType: "application/pdf",
        fileName: fileName || "registry.pdf",
      });
      uploadedKey = uploaded.key;
      const attachment = await prisma.attachment.create({
        data: {
          targetType: "property",
          targetId: match.propertyId,
          propertyId: match.propertyId,
          type: "registry",
          fileName: fileName || "registry.pdf",
          fileUrl: uploaded.url,
          fileSize: buf.length,
          mimeType: "application/pdf",
          uploadedBy: executor.id,
        },
        select: { id: true },
      });
      attachmentId = attachment.id;
    } catch (err) {
      if (uploadedKey) {
        try {
          await storage.delete(uploadedKey);
        } catch (delErr) {
          console.error(
            "registry-pdf-bulk: orphan cleanup failed:",
            delErr,
          );
        }
      }
      throw err;
    }

    const finalized = await finalizeRow(rowId, {
      status: "success",
      errorMessage: null,
      createdId: match.propertyId,
      rawData: {
        ...raw,
        attachmentId,
        matchedBy: match.matchedBy,
        matchedVia,
      },
    });
    if (finalized) {
      try {
        await storage.delete(stagedKey);
      } catch (e) {
        console.error("registry-pdf-bulk: staging delete failed:", e);
      }
      try {
        await writeAuditLog({
          userId: executor.id,
          action: "create",
          targetTable: "attachments",
          targetId: attachmentId,
          detail: { propertyId: match.propertyId, fileName, jobId },
        });
      } catch (e) {
        console.error("registry-pdf-bulk: audit failed (non-fatal):", e);
      }
    }
    return "success";
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "PDF処理中に不明なエラーが発生しました";
    try {
      await finalizeRow(rowId, {
        status: "error",
        errorMessage: message.slice(0, 500),
        createdId: null,
        rawData: { ...raw, reason: "unexpected_error" },
      });
    } catch (finalizeErr) {
      console.error("registry-pdf-bulk: finalize failed:", finalizeErr);
    }
    return "error";
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/registry-pdf-bulk/__tests__/process-row.test.ts`
Expected: PASS(7 tests)

- [ ] **Step 5: コミット**

```bash
git add src/lib/registry-pdf-bulk/process-row.ts src/lib/registry-pdf-bulk/__tests__/process-row.test.ts
git commit -m "feat(import): 所有者事項PDF一括の1行処理(重複スキップ/突合/添付/atomic確定)"
```

---

### Task 6: インプロセス直列ワーカー

**Files:**
- Create: `src/lib/registry-pdf-bulk/worker.ts`
- Test: `src/lib/registry-pdf-bulk/__tests__/worker.test.ts`

**Interfaces:**
- Consumes: `processRegistryPdfBulkRow`(Task 5)、`buildPropertyIndex`(Task 3)、`prisma`。
- Produces:
  ```ts
  export function enqueueRegistryPdfBulkJob(jobId: string): void;  // 同一jobIdの重複enqueueは無視
  export function isRegistryPdfBulkWorkerBusy(): boolean;           // テスト/デバッグ用
  export function __resetRegistryPdfBulkWorkerForTest(): void;      // テスト用(globalThis状態をリセット)
  ```
  singleton は prisma.ts と同じ globalThis イディオム(next dev のHMRでも待機列を失わない)。ジョブ処理: status→processing → executor(User)取得 → 物件index構築(1回) → pending行を rowNumber 順に直列処理 → カウンタ確定(status = error行>0 ? failed : completed・errorCount = error+needs_review — reception-property と同じ集計規約)。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/registry-pdf-bulk/__tests__/worker.test.ts` を新規作成:

```ts
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  default: {
    importJob: { findUnique: vi.fn(), update: vi.fn() },
    importJobRow: { findMany: vi.fn() },
    property: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));
vi.mock("../process-row", () => ({
  processRegistryPdfBulkRow: vi.fn(),
}));

import prisma from "@/lib/prisma";
import { processRegistryPdfBulkRow } from "../process-row";
import {
  enqueueRegistryPdfBulkJob,
  isRegistryPdfBulkWorkerBusy,
  __resetRegistryPdfBulkWorkerForTest,
} from "../worker";

type PM = {
  importJob: { findUnique: Mock; update: Mock };
  importJobRow: { findMany: Mock };
  property: { findMany: Mock };
  user: { findUnique: Mock };
};
const pm = prisma as unknown as PM;

/** ワーカーの非同期ループが完了するまで待つ(直列・小規模なのでポーリングで十分) */
async function waitForIdle(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (!isRegistryPdfBulkWorkerBusy()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("worker did not become idle");
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetRegistryPdfBulkWorkerForTest();
  pm.importJob.findUnique.mockResolvedValue({
    id: "j1",
    jobType: "registry_pdf_bulk",
    status: "pending",
    executedBy: "u1",
  });
  pm.importJob.update.mockResolvedValue({});
  pm.user.findUnique.mockResolvedValue({ id: "u1", role: "admin" });
  pm.property.findMany.mockResolvedValue([
    { id: "p1", address: "世田谷区上馬２丁目７５２－３", realEstateNumber: null },
  ]);
});

describe("registry-pdf-bulk worker", () => {
  it("pending行を rowNumber 順に直列処理し、完了時にジョブを completed にする", async () => {
    // 1回目: pending 2行 → 処理 → 2回目(集計): success 2行
    pm.importJobRow.findMany
      .mockResolvedValueOnce([
        { id: "r1", rowNumber: 1 },
        { id: "r2", rowNumber: 2 },
      ])
      .mockResolvedValueOnce([
        { status: "success" },
        { status: "success" },
      ]);
    (processRegistryPdfBulkRow as Mock).mockResolvedValue("success");

    enqueueRegistryPdfBulkJob("j1");
    await waitForIdle();

    expect(processRegistryPdfBulkRow).toHaveBeenCalledTimes(2);
    expect((processRegistryPdfBulkRow as Mock).mock.calls[0][0].rowId).toBe("r1");
    expect((processRegistryPdfBulkRow as Mock).mock.calls[1][0].rowId).toBe("r2");
    // 最初に processing 化
    expect(pm.importJob.update.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        where: { id: "j1" },
        data: expect.objectContaining({ status: "processing" }),
      }),
    );
    // 最後に completed + カウンタ
    const last = pm.importJob.update.mock.calls.at(-1)![0];
    expect(last.data.status).toBe("completed");
    expect(last.data.successCount).toBe(2);
    expect(last.data.errorCount).toBe(0);
    expect(last.data.completedAt).toBeInstanceOf(Date);
  });

  it("error行があればジョブは failed・errorCountはerror+needs_review合算(既存規約)", async () => {
    pm.importJobRow.findMany
      .mockResolvedValueOnce([{ id: "r1", rowNumber: 1 }])
      .mockResolvedValueOnce([
        { status: "success" },
        { status: "error" },
        { status: "needs_review" },
      ]);
    (processRegistryPdfBulkRow as Mock).mockResolvedValue("error");

    enqueueRegistryPdfBulkJob("j1");
    await waitForIdle();

    const last = pm.importJob.update.mock.calls.at(-1)![0];
    expect(last.data.status).toBe("failed");
    expect(last.data.successCount).toBe(1);
    expect(last.data.errorCount).toBe(2);
  });

  it("同一jobIdの重複enqueueは1回として扱う", async () => {
    pm.importJobRow.findMany
      .mockResolvedValueOnce([{ id: "r1", rowNumber: 1 }])
      .mockResolvedValueOnce([{ status: "success" }]);
    (processRegistryPdfBulkRow as Mock).mockResolvedValue("success");

    enqueueRegistryPdfBulkJob("j1");
    enqueueRegistryPdfBulkJob("j1");
    await waitForIdle();

    // findUnique(ジョブ読み)が1回だけ=1回しか処理していない
    expect(pm.importJob.findUnique).toHaveBeenCalledTimes(1);
  });

  it("registry_pdf_bulk 以外のジョブは何もしない", async () => {
    pm.importJob.findUnique.mockResolvedValue({
      id: "j1",
      jobType: "property_csv",
      status: "pending",
      executedBy: "u1",
    });
    enqueueRegistryPdfBulkJob("j1");
    await waitForIdle();
    expect(processRegistryPdfBulkRow).not.toHaveBeenCalled();
    expect(pm.importJob.update).not.toHaveBeenCalled();
  });

  it("executorユーザーが見つからなければジョブをfailedにする", async () => {
    pm.user.findUnique.mockResolvedValue(null);
    pm.importJobRow.findMany.mockResolvedValue([]);
    enqueueRegistryPdfBulkJob("j1");
    await waitForIdle();
    const last = pm.importJob.update.mock.calls.at(-1)![0];
    expect(last.data.status).toBe("failed");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run src/lib/registry-pdf-bulk/__tests__/worker.test.ts`
Expected: FAIL(worker モジュールが存在しない)

- [ ] **Step 3: 実装を書く**

`src/lib/registry-pdf-bulk/worker.ts` を新規作成:

```ts
import prisma from "@/lib/prisma";
import { buildPropertyIndex } from "./match";
import { processRegistryPdfBulkRow } from "./process-row";

/**
 * 所有者事項PDF一括取込のインプロセス直列ワーカー。
 *
 * - 単一プロセス(systemd 1サービス)運用前提。render-gate と同じ思想で
 *   「同時に走る処理は常に1つ」に固定し、サーバ負荷を平準化する。
 * - 待機列は jobId の FIFO。行の処理状態は都度DBに永続化されるため、
 *   プロセス再起動で待機列が消えても「再開」(resume route)で復旧できる。
 * - HMR(next dev)でモジュールが再評価されても待機列を失わないよう、
 *   prisma.ts と同じ globalThis singleton イディオムを使う。
 */

interface WorkerState {
  queue: string[];
  running: boolean;
}

const globalForWorker = globalThis as unknown as {
  __registryPdfBulkWorker?: WorkerState;
};

function state(): WorkerState {
  if (!globalForWorker.__registryPdfBulkWorker) {
    globalForWorker.__registryPdfBulkWorker = { queue: [], running: false };
  }
  return globalForWorker.__registryPdfBulkWorker;
}

export function enqueueRegistryPdfBulkJob(jobId: string): void {
  const s = state();
  if (!s.queue.includes(jobId)) {
    s.queue.push(jobId);
  }
  if (!s.running) {
    s.running = true;
    // fire-and-forget: route ハンドラは 202 を即返す。
    void runLoop().finally(() => {
      state().running = false;
    });
  }
}

export function isRegistryPdfBulkWorkerBusy(): boolean {
  const s = state();
  return s.running || s.queue.length > 0;
}

export function __resetRegistryPdfBulkWorkerForTest(): void {
  globalForWorker.__registryPdfBulkWorker = { queue: [], running: false };
}

async function runLoop(): Promise<void> {
  const s = state();
  while (s.queue.length > 0) {
    const jobId = s.queue.shift()!;
    try {
      await processJob(jobId);
    } catch (err) {
      console.error(`registry-pdf-bulk worker: job ${jobId} failed:`, err);
      try {
        await prisma.importJob.update({
          where: { id: jobId },
          data: { status: "failed", completedAt: new Date() },
        });
      } catch (updateErr) {
        console.error(
          "registry-pdf-bulk worker: job finalize failed:",
          updateErr,
        );
      }
    }
  }
}

async function processJob(jobId: string): Promise<void> {
  const job = await prisma.importJob.findUnique({
    where: { id: jobId },
    select: { id: true, jobType: true, status: true, executedBy: true },
  });
  if (!job || job.jobType !== "registry_pdf_bulk") return;
  if (job.status === "completed" || job.status === "rolled_back") return;

  await prisma.importJob.update({
    where: { id: jobId },
    data: { status: "processing", startedAt: new Date() },
  });

  const executor = await prisma.user.findUnique({
    where: { id: job.executedBy },
    select: { id: true, role: true },
  });
  if (!executor) {
    await prisma.importJob.update({
      where: { id: jobId },
      data: { status: "failed", completedAt: new Date() },
    });
    return;
  }

  // 物件indexはジョブ開始時に1回だけ構築(行ごとの全件スキャンを避ける)
  const properties = await prisma.property.findMany({
    select: { id: true, address: true, realEstateNumber: true },
  });
  const index = buildPropertyIndex(properties);

  const pendingRows = await prisma.importJobRow.findMany({
    where: { jobId, status: "pending" },
    orderBy: { rowNumber: "asc" },
    select: { id: true, rowNumber: true },
  });
  for (const row of pendingRows) {
    await processRegistryPdfBulkRow({
      jobId,
      rowId: row.id,
      index,
      executor,
    });
  }

  // カウンタ確定(reception-property と同じ規約:
  // status は error行>0 で failed、errorCount は error+needs_review 合算)
  const allRows = await prisma.importJobRow.findMany({
    where: { jobId },
    select: { status: true },
  });
  const successCount = allRows.filter((r) => r.status === "success").length;
  const errorRows = allRows.filter((r) => r.status === "error").length;
  const reviewRows = allRows.filter((r) => r.status === "needs_review").length;
  const stillPending = allRows.filter((r) => r.status === "pending").length;
  await prisma.importJob.update({
    where: { id: jobId },
    data: {
      successCount,
      errorCount: errorRows + reviewRows,
      ...(stillPending === 0
        ? {
            status: errorRows > 0 ? "failed" : "completed",
            completedAt: new Date(),
          }
        : {}),
    },
  });
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/registry-pdf-bulk/__tests__/worker.test.ts`
Expected: PASS(5 tests)

- [ ] **Step 5: コミット**

```bash
git add src/lib/registry-pdf-bulk/worker.ts src/lib/registry-pdf-bulk/__tests__/worker.test.ts
git commit -m "feat(import): 所有者事項PDF一括の直列ワーカー(globalThis singleton・FIFO)"
```

---

### Task 7: 一括アップロード route `POST /api/import/registry-pdf-bulk`

**Files:**
- Create: `src/app/api/import/registry-pdf-bulk/route.ts`
- Test: `src/app/api/import/registry-pdf-bulk/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `parseRegistryPdfBulkFilename`(Task 2)、`registryPdfBulkStagingKey`(Task 4)、`enqueueRegistryPdfBulkJob`(Task 6)、既存 `isPdfBuffer`・`getStorage`・api-helpers・`writeAuditLog`。
- Produces: HTTP契約(Task 10/11 のクライアントが依存):
  - Request: multipart、フィールド名 `files`(複数)。
  - Response 202: `{ jobId: string; totalRows: number; acceptedCount: number; rejectedCount: number }`
  - 403 FORBIDDEN / 400 NO_FILE / 422 TOO_MANY_FILES / 413 PAYLOAD_TOO_LARGE。
  - サイズ超過・非PDFの個別ファイルは reject せず **error行として記録**(rejectedCount に計上)。
  - 行 rawData: `{ fileName, stagedKey, requestNumber?, location?, kind? }`(pending行)/`{ fileName, reason }`(error行)。

- [ ] **Step 1: 失敗するテストを書く**

`src/app/api/import/registry-pdf-bulk/__tests__/route.test.ts` を新規作成:

```ts
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/api-helpers", () => ({
  ApiError: class extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  getApiSession: vi.fn(),
  getUserPermissions: vi.fn(),
  apiResponse: vi.fn((body: unknown, status = 200) =>
    Response.json(body as object, { status }),
  ),
  handleApiError: vi.fn(
    (e: { status?: number; message?: string; code?: string }) =>
      Response.json(
        { error: { message: e?.message, code: e?.code } },
        { status: e?.status ?? 500 },
      ),
  ),
}));
vi.mock("@/lib/permissions", () => ({ hasPermission: vi.fn(() => true) }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    importJob: { create: vi.fn() },
    importJobRow: { createMany: vi.fn() },
  },
}));
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: vi.fn() };
});
vi.mock("@/lib/registry-pdf-bulk/worker", () => ({
  enqueueRegistryPdfBulkJob: vi.fn(),
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import prisma from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { enqueueRegistryPdfBulkJob } from "@/lib/registry-pdf-bulk/worker";
import { POST } from "../route";

type PM = {
  importJob: { create: Mock };
  importJobRow: { createMany: Mock };
};
const pm = prisma as unknown as PM;

const storageMock = { upload: vi.fn(), delete: vi.fn() };

function pdfFile(name: string, size = 1024): File {
  const body = Buffer.concat([
    Buffer.from("%PDF-1.4\n"),
    Buffer.alloc(Math.max(0, size - 9), 0x20),
  ]);
  return new File([body], name, { type: "application/pdf" });
}

function textFile(name: string): File {
  return new File([Buffer.from("not a pdf")], name, { type: "text/plain" });
}

function makeRequest(files: File[]): Request {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  return new Request("http://localhost/api/import/registry-pdf-bulk", {
    method: "POST",
    body: fd,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  (hasPermission as Mock).mockReturnValue(true);
  (getStorage as Mock).mockReturnValue(storageMock);
  storageMock.upload.mockResolvedValue({ url: "/uploads/x", key: "x" });
  pm.importJob.create.mockResolvedValue({ id: "11111111-2222-3333-4444-555555555555" });
  pm.importJobRow.createMany.mockResolvedValue({ count: 1 });
});

describe("POST /api/import/registry-pdf-bulk", () => {
  it("PDFを受け付けてジョブ+pending行を作り、ワーカーにenqueueして202", async () => {
    const res = await POST(
      makeRequest([
        pdfFile(
          "世田谷区上馬２丁目７５２－３不動産登記（建物所有者事項）2024121200118150.PDF",
        ),
      ]) as never,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      jobId: string;
      totalRows: number;
      acceptedCount: number;
      rejectedCount: number;
    };
    expect(body.totalRows).toBe(1);
    expect(body.acceptedCount).toBe(1);
    expect(body.rejectedCount).toBe(0);
    expect(pm.importJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          jobType: "registry_pdf_bulk",
          status: "pending",
          totalRows: 1,
          executedBy: "u1",
        }),
      }),
    );
    const rows = pm.importJobRow.createMany.mock.calls[0][0].data as Array<{
      status: string;
      rawData: Record<string, string>;
    }>;
    expect(rows[0].status).toBe("pending");
    expect(rows[0].rawData.requestNumber).toBe("2024121200118150");
    expect(rows[0].rawData.location).toBe("世田谷区上馬２丁目７５２－３");
    expect(rows[0].rawData.stagedKey).toContain("import-staging/registry-pdf/");
    expect(storageMock.upload).toHaveBeenCalledTimes(1);
    expect(enqueueRegistryPdfBulkJob).toHaveBeenCalledWith(
      "11111111-2222-3333-4444-555555555555",
    );
  });

  it("非PDFは当該ファイルのみ error 行として記録(全体は202)", async () => {
    const res = await POST(
      makeRequest([
        pdfFile(
          "世田谷区弦巻１丁目３２－３１不動産登記（土地所有者事項）2024121100710215.pdf",
        ),
        textFile("メモ.txt"),
      ]) as never,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { acceptedCount: number; rejectedCount: number };
    expect(body.acceptedCount).toBe(1);
    expect(body.rejectedCount).toBe(1);
    const rows = pm.importJobRow.createMany.mock.calls[0][0].data as Array<{
      status: string;
    }>;
    expect(rows.filter((r) => r.status === "error")).toHaveLength(1);
    // 非PDFはstagingに保存しない
    expect(storageMock.upload).toHaveBeenCalledTimes(1);
  });

  it("ファイル0件は 400 NO_FILE", async () => {
    const res = await POST(makeRequest([]) as never);
    expect(res.status).toBe(400);
  });

  it("100件超は 422 TOO_MANY_FILES", async () => {
    const files = Array.from({ length: 101 }, (_, i) =>
      pdfFile(`世田谷区上馬２丁目７５２－${i}不動産登記（建物所有者事項）20241212001181${String(i).padStart(2, "0")}.pdf`),
    );
    const res = await POST(makeRequest(files) as never);
    expect(res.status).toBe(422);
    expect(pm.importJob.create).not.toHaveBeenCalled();
  });

  it("権限なしは 403", async () => {
    (hasPermission as Mock).mockReturnValue(false);
    const res = await POST(makeRequest([pdfFile("a.pdf")]) as never);
    expect(res.status).toBe(403);
  });

  it("Content-Length が上限超過なら 413(formDataを読む前)", async () => {
    // 実Requestは undici が content-length を管理するため、route が使う
    // インターフェース(headers.get / formData)だけ持つ stub を渡す
    const formDataSpy = vi.fn();
    const req = {
      headers: new Headers({ "content-length": String(200 * 1024 * 1024) }),
      formData: formDataSpy,
    };
    const res = await POST(req as never);
    expect(res.status).toBe(413);
    expect(formDataSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run src/app/api/import/registry-pdf-bulk/__tests__/route.test.ts`
Expected: FAIL(route が存在しない)

- [ ] **Step 3: 実装を書く**

`src/app/api/import/registry-pdf-bulk/route.ts` を新規作成:

```ts
import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { isPdfBuffer } from "@/lib/pdf-extract";
import { getStorage } from "@/lib/storage";
import { parseRegistryPdfBulkFilename } from "@/lib/registry-pdf-bulk/filename";
import { registryPdfBulkStagingKey } from "@/lib/registry-pdf-bulk/staging";
import { enqueueRegistryPdfBulkJob } from "@/lib/registry-pdf-bulk/worker";

// multipart を Buffer 化するため Node ランタイム必須(既存 ocr-draft と同じ)
export const runtime = "nodejs";

// 承認済み仕様: 最大100ファイル/合計100MB/1ファイル5MB
const MAX_BULK_FILES = 100;
const MAX_BULK_FILE_BYTES = 5 * 1024 * 1024;
const MAX_BULK_TOTAL_BYTES = 100 * 1024 * 1024;
// multipart envelope(boundary/ヘッダ)の許容オーバーヘッド(100ファイル分)
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

interface RowSeed {
  rowNumber: number;
  status: "pending" | "error";
  rawData: Record<string, string>;
  errorMessage: string | null;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "取込の権限がありません", "FORBIDDEN");
    }

    // formData() で body 全体をバッファする前に Content-Length で過大 body を弾く
    const contentLength = Number(request.headers.get("content-length") ?? "");
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_BULK_TOTAL_BYTES + MULTIPART_OVERHEAD_BYTES
    ) {
      throw new ApiError(
        413,
        "アップロード合計サイズが上限(100MB)を超えています。分割して投入してください",
        "PAYLOAD_TOO_LARGE",
      );
    }

    const formData = await request.formData();
    const files = formData
      .getAll("files")
      .filter((f): f is File => f instanceof File);
    if (files.length === 0) {
      throw new ApiError(400, "ファイルが指定されていません", "NO_FILE");
    }
    if (files.length > MAX_BULK_FILES) {
      throw new ApiError(
        422,
        `一度に投入できるのは${MAX_BULK_FILES}ファイルまでです。分割して投入してください`,
        "TOO_MANY_FILES",
      );
    }
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > MAX_BULK_TOTAL_BYTES) {
      throw new ApiError(
        413,
        "アップロード合計サイズが上限(100MB)を超えています。分割して投入してください",
        "PAYLOAD_TOO_LARGE",
      );
    }

    const job = await prisma.importJob.create({
      data: {
        jobType: "registry_pdf_bulk",
        fileName: `所有者事項PDF一括 (${files.length}件)`,
        status: "pending",
        totalRows: files.length,
        executedBy: session.id,
        startedAt: new Date(),
      },
      select: { id: true },
    });

    const storage = getStorage();
    const rows: RowSeed[] = [];
    let acceptedCount = 0;
    let rejectedCount = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const rowNumber = i + 1;
      const fileName = file.name || `file-${rowNumber}.pdf`;

      if (file.size > MAX_BULK_FILE_BYTES) {
        rows.push({
          rowNumber,
          status: "error",
          rawData: { fileName, reason: "file_too_large" },
          errorMessage: "1ファイルの上限(5MB)を超えています",
        });
        rejectedCount++;
        continue;
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      if (!isPdfBuffer(buffer)) {
        rows.push({
          rowNumber,
          status: "error",
          rawData: { fileName, reason: "not_pdf" },
          errorMessage: "PDFファイルではありません",
        });
        rejectedCount++;
        continue;
      }

      const parsed = parseRegistryPdfBulkFilename(fileName);
      const stagedKey = registryPdfBulkStagingKey(job.id, rowNumber);
      try {
        await storage.upload(buffer, {
          key: stagedKey,
          mimeType: "application/pdf",
          fileName,
        });
      } catch (err) {
        console.error("registry-pdf-bulk: staging upload failed:", err);
        rows.push({
          rowNumber,
          status: "error",
          rawData: { fileName, reason: "staging_failed" },
          errorMessage: "サーバへの一時保存に失敗しました",
        });
        rejectedCount++;
        continue;
      }
      rows.push({
        rowNumber,
        status: "pending",
        rawData: {
          fileName,
          stagedKey,
          ...(parsed
            ? {
                requestNumber: parsed.requestNumber,
                location: parsed.location,
                ...(parsed.kind ? { kind: parsed.kind } : {}),
              }
            : {}),
        },
        errorMessage: null,
      });
      acceptedCount++;
    }

    await prisma.importJobRow.createMany({
      data: rows.map((r) => ({
        jobId: job.id,
        rowNumber: r.rowNumber,
        status: r.status,
        rawData: r.rawData,
        errorMessage: r.errorMessage,
      })),
    });

    enqueueRegistryPdfBulkJob(job.id);

    try {
      await writeAuditLog({
        userId: session.id,
        action: "registry_pdf_bulk_upload",
        targetTable: "import_jobs",
        targetId: job.id,
        detail: { fileCount: files.length, acceptedCount, rejectedCount },
      });
    } catch (e) {
      console.error("registry-pdf-bulk: audit failed (non-fatal):", e);
    }

    return apiResponse(
      {
        jobId: job.id,
        totalRows: files.length,
        acceptedCount,
        rejectedCount,
      },
      202,
    );
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/app/api/import/registry-pdf-bulk/__tests__/route.test.ts`
Expected: PASS(6 tests)

- [ ] **Step 5: コミット**

```bash
git add src/app/api/import/registry-pdf-bulk/route.ts src/app/api/import/registry-pdf-bulk/__tests__/route.test.ts
git commit -m "feat(import): 所有者事項PDF一括アップロードroute(202+非同期ジョブ投入)"
```

---

### Task 8: 再開 route `POST /api/import/jobs/[jobId]/resume-registry-pdf`

**Files:**
- Create: `src/app/api/import/jobs/[jobId]/resume-registry-pdf/route.ts`
- Test: `src/app/api/import/jobs/[jobId]/resume-registry-pdf/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `enqueueRegistryPdfBulkJob`(Task 6)。
- Produces: Response 200: `{ ok: true; pendingCount: number }`(pendingCount=0 でも 200・enqueueしない)。404 NOT_FOUND / 422 VALIDATION_ERROR(種別違い) / 403 FORBIDDEN。Task 10 の「再開」ボタンが呼ぶ。

- [ ] **Step 1: 失敗するテストを書く**

`src/app/api/import/jobs/[jobId]/resume-registry-pdf/__tests__/route.test.ts` を新規作成:

```ts
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/api-helpers", () => ({
  ApiError: class extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  getApiSession: vi.fn(),
  getUserPermissions: vi.fn(),
  apiResponse: vi.fn((body: unknown, status = 200) =>
    Response.json(body as object, { status }),
  ),
  handleApiError: vi.fn(
    (e: { status?: number; message?: string; code?: string }) =>
      Response.json(
        { error: { message: e?.message, code: e?.code } },
        { status: e?.status ?? 500 },
      ),
  ),
}));
vi.mock("@/lib/permissions", () => ({ hasPermission: vi.fn(() => true) }));
vi.mock("@/lib/prisma", () => ({
  default: {
    importJob: { findUnique: vi.fn() },
    importJobRow: { count: vi.fn() },
  },
}));
vi.mock("@/lib/registry-pdf-bulk/worker", () => ({
  enqueueRegistryPdfBulkJob: vi.fn(),
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { enqueueRegistryPdfBulkJob } from "@/lib/registry-pdf-bulk/worker";
import { POST } from "../route";

type PM = {
  importJob: { findUnique: Mock };
  importJobRow: { count: Mock };
};
const pm = prisma as unknown as PM;

function call(jobId = "j1") {
  return POST({} as never, { params: Promise.resolve({ jobId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  pm.importJob.findUnique.mockResolvedValue({
    id: "j1",
    jobType: "registry_pdf_bulk",
  });
  pm.importJobRow.count.mockResolvedValue(3);
});

describe("POST /api/import/jobs/[jobId]/resume-registry-pdf", () => {
  it("pending行があればenqueueして件数を返す", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pendingCount: 3 });
    expect(enqueueRegistryPdfBulkJob).toHaveBeenCalledWith("j1");
  });

  it("pending行が0ならenqueueしない", async () => {
    pm.importJobRow.count.mockResolvedValue(0);
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pendingCount: 0 });
    expect(enqueueRegistryPdfBulkJob).not.toHaveBeenCalled();
  });

  it("ジョブが無ければ404", async () => {
    pm.importJob.findUnique.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(404);
  });

  it("registry_pdf_bulk 以外は422", async () => {
    pm.importJob.findUnique.mockResolvedValue({
      id: "j1",
      jobType: "property_csv",
    });
    const res = await call();
    expect(res.status).toBe(422);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run "src/app/api/import/jobs/[jobId]/resume-registry-pdf/__tests__/route.test.ts"`
Expected: FAIL(route が存在しない)

- [ ] **Step 3: 実装を書く**

`src/app/api/import/jobs/[jobId]/resume-registry-pdf/route.ts` を新規作成:

```ts
import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { enqueueRegistryPdfBulkJob } from "@/lib/registry-pdf-bulk/worker";

// ============================================================
// POST /api/import/jobs/[jobId]/resume-registry-pdf
// ------------------------------------------------------------
// 所有者事項PDF一括ジョブの未処理(pending)行を再開する。
// サーバ再起動でインプロセスワーカーの待機列が消えた場合の復旧口。
// 行状態はDBに永続化されているため、enqueueし直すだけでよい
// (処理済み行は process-row 側の pending 条件で自然にスキップされる)。
// ============================================================

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "取込の権限がありません", "FORBIDDEN");
    }

    const job = await prisma.importJob.findUnique({
      where: { id: jobId },
      select: { id: true, jobType: true },
    });
    if (!job) {
      throw new ApiError(404, "取込ジョブが見つかりません", "NOT_FOUND");
    }
    if (job.jobType !== "registry_pdf_bulk") {
      throw new ApiError(
        422,
        "このAPIは所有者事項PDF一括ジョブのみ対象です",
        "VALIDATION_ERROR",
      );
    }

    const pendingCount = await prisma.importJobRow.count({
      where: { jobId, status: "pending" },
    });
    if (pendingCount > 0) {
      enqueueRegistryPdfBulkJob(jobId);
    }
    return apiResponse({ ok: true, pendingCount });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run "src/app/api/import/jobs/[jobId]/resume-registry-pdf/__tests__/route.test.ts"`
Expected: PASS(4 tests)

- [ ] **Step 5: コミット**

```bash
git add "src/app/api/import/jobs/[jobId]/resume-registry-pdf"
git commit -m "feat(import): 所有者事項PDF一括の再開route(再起動後の未処理行復旧)"
```

---

### Task 9: 手動添付 route `POST /api/import/jobs/[jobId]/rows/[rowId]/manual-attach-registry-pdf`

**Files:**
- Create: `src/app/api/import/jobs/[jobId]/rows/[rowId]/manual-attach-registry-pdf/route.ts`
- Test: `src/app/api/import/jobs/[jobId]/rows/[rowId]/manual-attach-registry-pdf/__tests__/route.test.ts`

**Interfaces:**
- Consumes: 既存 manual-link-reception-owner のパターン(atomic claim→処理→カウンタ再計算)、`getStorage`、`canAccessPropertyRecord`、`validateFile`/`ALLOWED_ATTACHMENT_MIMES`、`writeAuditLog`。
- Produces: HTTP契約(Task 10 のUIが依存):
  - Request: JSON `{ propertyId: string }`
  - Response 200: `{ ok: true; rowId: string; propertyId: string; attachmentId: string }`
  - 403 / 404 / 409 CONFLICT(claim競合) / 422 VALIDATION_ERROR(種別違い・行状態違い・staged消失)。
  - 成功時: 行= success・createdId=propertyId・errorMessage="手動添付"、staging削除、ジョブカウンタ再計算(pending含めて未解決判定)。

- [ ] **Step 1: 失敗するテストを書く**

`src/app/api/import/jobs/[jobId]/rows/[rowId]/manual-attach-registry-pdf/__tests__/route.test.ts` を新規作成:

```ts
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/api-helpers", () => ({
  ApiError: class extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  getApiSession: vi.fn(),
  getUserPermissions: vi.fn(),
  apiResponse: vi.fn((body: unknown, status = 200) =>
    Response.json(body as object, { status }),
  ),
  handleApiError: vi.fn(
    (e: { status?: number; message?: string; code?: string }) =>
      Response.json(
        { error: { message: e?.message, code: e?.code } },
        { status: e?.status ?? 500 },
      ),
  ),
}));
vi.mock("@/lib/permissions", () => ({ hasPermission: vi.fn(() => true) }));
vi.mock("@/lib/property-access", () => ({
  canAccessPropertyRecord: vi.fn(() => true),
}));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    importJobRow: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    importJob: { update: vi.fn() },
    property: { findUnique: vi.fn() },
    attachment: { create: vi.fn() },
  },
}));
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: vi.fn() };
});

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { POST } from "../route";

type PM = {
  importJobRow: {
    findUnique: Mock;
    updateMany: Mock;
    update: Mock;
    findMany: Mock;
  };
  importJob: { update: Mock };
  property: { findUnique: Mock };
  attachment: { create: Mock };
};
const pm = prisma as unknown as PM;

const PDF_BUF = Buffer.from("%PDF-1.4 test");
const storageMock = { read: vi.fn(), upload: vi.fn(), delete: vi.fn() };

function call(body: unknown, jobId = "j1", rowId = "r1") {
  const req = new Request("http://localhost/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req as never, { params: Promise.resolve({ jobId, rowId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  (canAccessPropertyRecord as Mock).mockReturnValue(true);
  (getStorage as Mock).mockReturnValue(storageMock);
  pm.importJobRow.findUnique.mockResolvedValue({
    id: "r1",
    jobId: "j1",
    rowNumber: 1,
    status: "needs_review",
    createdId: null,
    rawData: {
      fileName: "世田谷区上馬２丁目７５２－３不動産登記（建物所有者事項）2024121200118150.PDF",
      stagedKey: "import-staging/registry-pdf/j1/1.pdf",
      requestNumber: "2024121200118150",
      location: "世田谷区上馬２丁目７５２－３",
    },
    job: { id: "j1", jobType: "registry_pdf_bulk" },
  });
  pm.importJobRow.updateMany.mockResolvedValue({ count: 1 });
  pm.importJobRow.update.mockResolvedValue({});
  pm.importJobRow.findMany.mockResolvedValue([
    { status: "success" },
    { status: "needs_review" },
  ]);
  pm.importJob.update.mockResolvedValue({});
  pm.property.findUnique.mockResolvedValue({ createdBy: "u1", assignedTo: null });
  pm.attachment.create.mockResolvedValue({ id: "att1" });
  storageMock.read.mockResolvedValue({
    body: PDF_BUF,
    contentType: "application/pdf",
    size: PDF_BUF.length,
  });
  storageMock.upload.mockResolvedValue({
    url: "/uploads/properties/p9/registry/x.pdf",
    key: "properties/p9/registry/x.pdf",
  });
  storageMock.delete.mockResolvedValue(undefined);
});

describe("POST .../manual-attach-registry-pdf", () => {
  it("指定物件に添付し、行をsuccessに確定・staging削除・カウンタ再計算", async () => {
    const res = await call({ propertyId: "p9" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; attachmentId: string };
    expect(body.ok).toBe(true);
    expect(body.attachmentId).toBe("att1");
    // atomic claim
    expect(pm.importJobRow.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "r1",
          status: "needs_review",
          createdId: null,
        }),
      }),
    );
    expect(pm.attachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          propertyId: "p9",
          type: "registry",
          uploadedBy: "u1",
        }),
        select: { id: true },
      }),
    );
    expect(storageMock.delete).toHaveBeenCalledWith(
      "import-staging/registry-pdf/j1/1.pdf",
    );
    expect(pm.importJob.update).toHaveBeenCalled();
  });

  it("propertyId 未指定は 422", async () => {
    const res = await call({});
    expect(res.status).toBe(422);
  });

  it("claim競合(count=0)は 409", async () => {
    pm.importJobRow.updateMany.mockResolvedValue({ count: 0 });
    const res = await call({ propertyId: "p9" });
    expect(res.status).toBe(409);
  });

  it("種別違いのジョブは 422", async () => {
    pm.importJobRow.findUnique.mockResolvedValue({
      id: "r1",
      jobId: "j1",
      rowNumber: 1,
      status: "needs_review",
      createdId: null,
      rawData: {},
      job: { id: "j1", jobType: "owner_csv" },
    });
    const res = await call({ propertyId: "p9" });
    expect(res.status).toBe(422);
  });

  it("stagedファイル消失は 422 でclaimを戻す", async () => {
    storageMock.read.mockResolvedValue(null);
    const res = await call({ propertyId: "p9" });
    expect(res.status).toBe(422);
    // claim復帰(createdId を null に戻す)
    const revert = pm.importJobRow.updateMany.mock.calls.at(-1)![0];
    expect(revert.data.createdId).toBeNull();
  });

  it("アクセス権なしの物件は 403", async () => {
    (canAccessPropertyRecord as Mock).mockReturnValue(false);
    const res = await call({ propertyId: "p9" });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run "src/app/api/import/jobs/[jobId]/rows/[rowId]/manual-attach-registry-pdf/__tests__/route.test.ts"`
Expected: FAIL(route が存在しない)

- [ ] **Step 3: 実装を書く**

`src/app/api/import/jobs/[jobId]/rows/[rowId]/manual-attach-registry-pdf/route.ts` を新規作成:

```ts
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { writeAuditLog } from "@/lib/audit";
import {
  getStorage,
  validateFile,
  ALLOWED_ATTACHMENT_MIMES,
} from "@/lib/storage";

// ============================================================
// POST /api/import/jobs/[jobId]/rows/[rowId]/manual-attach-registry-pdf
// ------------------------------------------------------------
// 所有者事項PDF一括ジョブの needs_review 行(未突合PDF)を、
// ユーザが指定した Property に手動で添付する。
//
// manual-link-reception-owner と同じ規約:
//   - atomic claim(updateMany where status/createdId 条件)で並行実行を排除
//   - 完了後にジョブのカウンタと status を再計算
//   - 監査ログは commit 後 best-effort
// storage 操作はトランザクションに入れられないため、
// claim → storage/attachment → 失敗時は claim を戻す、の順で行う。
// ============================================================

interface RequestBody {
  propertyId?: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string; rowId: string }> },
) {
  try {
    const { jobId, rowId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const body = (await request.json().catch(() => ({}))) as RequestBody;
    const propertyId = body.propertyId?.trim();
    if (!propertyId) {
      throw new ApiError(422, "propertyId は必須です", "VALIDATION_ERROR");
    }

    const row = await prisma.importJobRow.findUnique({
      where: { id: rowId },
      include: { job: { select: { id: true, jobType: true } } },
    });
    if (!row || row.jobId !== jobId) {
      throw new ApiError(404, "行が見つかりません", "NOT_FOUND");
    }
    if (row.job.jobType !== "registry_pdf_bulk") {
      throw new ApiError(
        422,
        "このAPIは所有者事項PDF一括ジョブの行のみ対象です",
        "VALIDATION_ERROR",
      );
    }
    if (row.status !== "needs_review" || row.createdId) {
      throw new ApiError(
        422,
        `この行は手動添付の対象ではありません(ステータス: ${row.status})`,
        "VALIDATION_ERROR",
      );
    }
    const raw = ((row.rawData ?? {}) as Record<string, unknown>) ?? {};
    const stagedKey = typeof raw.stagedKey === "string" ? raw.stagedKey : "";
    const fileName =
      typeof raw.fileName === "string" && raw.fileName !== ""
        ? raw.fileName
        : "registry.pdf";
    if (!stagedKey) {
      throw new ApiError(
        422,
        "保管中のPDFが見つかりません(取込データが不完全です)",
        "VALIDATION_ERROR",
      );
    }

    const target = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { createdBy: true, assignedTo: true },
    });
    if (!target) {
      throw new ApiError(404, "指定された物件が見つかりません", "NOT_FOUND");
    }
    if (!canAccessPropertyRecord(session, target)) {
      throw new ApiError(403, "この物件を編集する権限がありません", "FORBIDDEN");
    }

    // ATOMIC CLAIM: 並行リクエストは最初の1本だけが通過する
    const claim = await prisma.importJobRow.updateMany({
      where: { id: rowId, jobId, status: "needs_review", createdId: null },
      data: { createdId: propertyId },
    });
    if (claim.count !== 1) {
      throw new ApiError(
        409,
        "別の操作で既に処理済みか、対象行が変更されました",
        "CONFLICT",
      );
    }

    const revertClaim = async () => {
      try {
        await prisma.importJobRow.updateMany({
          where: { id: rowId, status: "needs_review", createdId: propertyId },
          data: { createdId: null },
        });
      } catch (e) {
        console.error("manual-attach-registry-pdf: claim revert failed:", e);
      }
    };

    const storage = getStorage();
    let attachmentId: string;
    let uploadedKey: string | null = null;
    try {
      const staged = await storage.read(stagedKey);
      if (!staged) {
        await revertClaim();
        throw new ApiError(
          422,
          "保管中のPDFを読み取れませんでした(整理済みの可能性があります)",
          "VALIDATION_ERROR",
        );
      }
      const buf = staged.body;
      const validationError = validateFile(
        buf.length,
        "application/pdf",
        ALLOWED_ATTACHMENT_MIMES,
      );
      if (validationError) {
        await revertClaim();
        throw new ApiError(422, validationError, "VALIDATION_ERROR");
      }
      const key = `properties/${propertyId}/registry/${Date.now()}-${randomUUID()}.pdf`;
      const uploaded = await storage.upload(buf, {
        key,
        mimeType: "application/pdf",
        fileName,
      });
      uploadedKey = uploaded.key;
      const attachment = await prisma.attachment.create({
        data: {
          targetType: "property",
          targetId: propertyId,
          propertyId,
          type: "registry",
          fileName,
          fileUrl: uploaded.url,
          fileSize: buf.length,
          mimeType: "application/pdf",
          uploadedBy: session.id,
        },
        select: { id: true },
      });
      attachmentId = attachment.id;
    } catch (err) {
      if (uploadedKey) {
        try {
          await storage.delete(uploadedKey);
        } catch (delErr) {
          console.error(
            "manual-attach-registry-pdf: orphan cleanup failed:",
            delErr,
          );
        }
      }
      if (!(err instanceof ApiError)) {
        await revertClaim();
      }
      throw err;
    }

    // 行確定 + ジョブカウンタ再計算(manual-link と同じ規約 + pending も未解決扱い)
    await prisma.importJobRow.update({
      where: { id: rowId },
      data: { status: "success", errorMessage: "手動添付" },
    });
    const allRows = await prisma.importJobRow.findMany({
      where: { jobId },
      select: { status: true },
    });
    const successCount = allRows.filter((r) => r.status === "success").length;
    const errorRows = allRows.filter((r) => r.status === "error").length;
    const reviewRows = allRows.filter(
      (r) => r.status === "needs_review",
    ).length;
    const pendingRows = allRows.filter((r) => r.status === "pending").length;
    const hasUnresolved = errorRows > 0 || reviewRows > 0 || pendingRows > 0;
    await prisma.importJob.update({
      where: { id: jobId },
      data: {
        successCount,
        errorCount: errorRows + reviewRows,
        ...(hasUnresolved
          ? {}
          : { status: "completed", completedAt: new Date() }),
      },
    });

    try {
      await storage.delete(stagedKey);
    } catch (e) {
      console.error("manual-attach-registry-pdf: staging delete failed:", e);
    }
    try {
      await writeAuditLog({
        userId: session.id,
        action: "registry_pdf_manual_attach",
        targetTable: "import_job_rows",
        targetId: rowId,
        detail: { jobId, rowNumber: row.rowNumber, propertyId, attachmentId },
      });
    } catch (e) {
      console.error("manual-attach-registry-pdf: audit failed (non-fatal):", e);
    }

    return apiResponse({ ok: true, rowId, propertyId, attachmentId });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run "src/app/api/import/jobs/[jobId]/rows/[rowId]/manual-attach-registry-pdf/__tests__/route.test.ts"`
Expected: PASS(6 tests)

- [ ] **Step 5: コミット**

```bash
git add "src/app/api/import/jobs/[jobId]/rows/[rowId]/manual-attach-registry-pdf"
git commit -m "feat(import): 未突合PDFの手動添付route(atomic claim+カウンタ再計算)"
```

---

### Task 10: ジョブ詳細APIとUIの pending / registry_pdf_bulk 対応

**Files:**
- Modify: `src/app/api/import/jobs/[jobId]/route.ts`(GET: pendingCount 追加・status フィルタに pending 許可・isRegistryPdfBulkJob フラグ)
- Modify: `src/app/(dashboard)/import/jobs/[jobId]/page.tsx`(行status型 + ROW_STATUS_CONFIG + 再開ボタン + 手動添付分岐)
- Modify: `src/lib/api-client.ts`(fetch系はTask 11でまとめて追加するため、このタスクでは触らない — UI側は Task 11 の関数を先行参照せず、`fetch` 直書きもしない。**このタスクではAPI側とUI表示のみ**、ボタンの結線はTask 11で行う)
- Test: `src/app/api/import/jobs/[jobId]/__tests__/pending-support.test.ts`

**Interfaces:**
- Consumes: Task 1 の enum 値。
- Produces: GET `/api/import/jobs/[jobId]` レスポンスに `pendingCount: number` と `isRegistryPdfBulkJob: boolean` が追加される(Task 11 のウィザード進捗ポーリングと再開ボタンが依存)。`?status=pending` フィルタが有効になる。

- [ ] **Step 1: GET route の現状を読む**

Run: `Read src/app/api/import/jobs/[jobId]/route.ts 全体`
確認事項: (a) status クエリの許可値リスト(`success|error|skipped|needs_review` を列挙している箇所) (b) レスポンス構築部(`return apiResponse({ ...job, rows, summary, isReceptionOwnerJob, duplicateCount, duplicateActionableCount, pagination })`) (c) 使っている prisma 呼び出しの一覧(次Stepのテストmockをこれに合わせる)。

- [ ] **Step 2: 失敗するテストを書く**

`src/app/api/import/jobs/[jobId]/__tests__/pending-support.test.ts` を新規作成。mock は photos route test と同じ定型(api-helpers / permissions / prisma)。**prisma mock のメソッド一覧は Step 1 で確認した実際の呼び出しに合わせること**(以下は最小形。route が groupBy 等を使っていればそれも `vi.fn()` で追加する)。assertion は変えない:

```ts
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/api-helpers", () => ({
  ApiError: class extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  getApiSession: vi.fn(),
  getUserPermissions: vi.fn(),
  apiResponse: vi.fn((body: unknown, status = 200) =>
    Response.json(body as object, { status }),
  ),
  handleApiError: vi.fn(
    (e: { status?: number; message?: string; code?: string }) =>
      Response.json(
        { error: { message: e?.message, code: e?.code } },
        { status: e?.status ?? 500 },
      ),
  ),
}));
vi.mock("@/lib/permissions", () => ({ hasPermission: () => true }));
// prisma mock: Step 1 で確認した実呼び出しに合わせて調整する
vi.mock("@/lib/prisma", () => ({
  default: {
    importJob: { findUnique: vi.fn() },
    importJobRow: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { GET } from "../route";

type PM = {
  importJob: { findUnique: Mock };
  importJobRow: { findMany: Mock; count: Mock; groupBy: Mock };
};
const pm = prisma as unknown as PM;

function call(query = "") {
  const req = new Request(`http://localhost/api/import/jobs/j1${query}`);
  return GET(req as never, { params: Promise.resolve({ jobId: "j1" }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  pm.importJob.findUnique.mockResolvedValue({
    id: "j1",
    jobType: "registry_pdf_bulk",
    fileName: "所有者事項PDF一括 (3件)",
    status: "processing",
    totalRows: 3,
    successCount: 1,
    errorCount: 0,
    executedBy: "u1",
    startedAt: new Date(),
    completedAt: null,
    createdAt: new Date(),
    executor: { id: "u1", name: "user" },
    rows: [],
  });
  pm.importJobRow.findMany.mockResolvedValue([]);
  pm.importJobRow.count.mockResolvedValue(2);
  pm.importJobRow.groupBy.mockResolvedValue([]);
});

describe("GET /api/import/jobs/[jobId] pending対応", () => {
  it("registry_pdf_bulk ジョブで pendingCount と isRegistryPdfBulkJob を返す", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pendingCount: number;
      isRegistryPdfBulkJob: boolean;
    };
    expect(body.pendingCount).toBe(2);
    expect(body.isRegistryPdfBulkJob).toBe(true);
  });

  it("?status=pending が拒否されない(200)", async () => {
    const res = await call("?status=pending&page=1&limit=10");
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `npx vitest run "src/app/api/import/jobs/[jobId]/__tests__/pending-support.test.ts"`
Expected: FAIL(pendingCount が undefined)

- [ ] **Step 4: GET route を修正**

`src/app/api/import/jobs/[jobId]/route.ts` に3点の追加:

1. status クエリの許可値リスト(Step 1 (a) の箇所)に `"pending"` を追加する。
2. レスポンス構築の直前に pendingCount を算出(フィルタ非依存・ジョブ全体):

```ts
    const pendingCount = await prisma.importJobRow.count({
      where: { jobId, status: "pending" },
    });
    const isRegistryPdfBulkJob = job.jobType === "registry_pdf_bulk";
```

3. `return apiResponse({ ... })` のオブジェクトに `pendingCount,` と `isRegistryPdfBulkJob,` を追加する。

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run "src/app/api/import/jobs/[jobId]/__tests__/pending-support.test.ts"`
Expected: PASS(2 tests)。既存テストの回帰確認: `npx vitest run "src/app/api/import/jobs"`

- [ ] **Step 6: ジョブ詳細UIに pending 表示を追加**

`src/app/(dashboard)/import/jobs/[jobId]/page.tsx` を修正:

1. クライアント側 `interface ImportJobRow`(L61付近)の status union に `"pending"` を追加:

```ts
  status: "success" | "error" | "skipped" | "needs_review" | "pending";
```

2. `interface ImportJob` に2フィールド追加:

```ts
  pendingCount?: number;
  isRegistryPdfBulkJob?: boolean;
```

3. `ROW_STATUS_CONFIG`(L137-165付近)に `pending` エントリを追加する。**既存の `skipped` エントリをコピーして** key を `pending`、label を `"未処理"`、色クラスを blue 系(`text-blue-600 dark:text-blue-400` 等、既存エントリの命名規則に合わせる)に変える。アイコンは lucide の `Clock` を使う(既存 import 行に追加)。

4. status フィルタのタブ/セレクト(`filter` の選択肢を列挙している箇所)に `pending`(表示名「未処理」)を追加する。

- [ ] **Step 7: tsc で型の通りを確認**

Run: `npx tsc --noEmit`
Expected: エラー0

- [ ] **Step 8: コミット**

```bash
git add "src/app/api/import/jobs/[jobId]/route.ts" "src/app/api/import/jobs/[jobId]/__tests__/pending-support.test.ts" "src/app/(dashboard)/import/jobs/[jobId]/page.tsx"
git commit -m "feat(import): ジョブ詳細のpending行対応(件数/フィルタ/表示)"
```

---

### Task 11: api-client関数 + ジョブ詳細の結線 + ウィザード画面 + ImportSwitcher

**Files:**
- Modify: `src/lib/api-client.ts`(3関数+型を追加)
- Modify: `src/app/(dashboard)/import/jobs/[jobId]/page.tsx`(再開ボタン+手動添付の結線)
- Modify: `src/components/import/import-switcher.tsx`(ITEMS に1行)
- Create: `src/lib/registry-pdf-bulk/wizard-progress.ts`(純関数)
- Create: `src/app/(dashboard)/import/registry-dm/page.tsx`(ウィザード)
- Test: `src/lib/registry-pdf-bulk/__tests__/wizard-progress.test.ts`

**Interfaces:**
- Consumes: Task 7/8/9 のHTTP契約、Task 10 の `pendingCount`/`isRegistryPdfBulkJob`、既存 `readFileForImport`/`previewReceptionPropertyCsv`/`importReceptionPropertyCsv`/`previewReceptionOwnerCsv`/`importReceptionOwnerCsv`/`fetchImportJobDetail`/`searchProperties`。
- Produces:
  ```ts
  // api-client.ts
  export interface RegistryPdfBulkUploadResponse {
    jobId: string; totalRows: number; acceptedCount: number; rejectedCount: number;
  }
  export async function uploadRegistryPdfBulk(files: File[]): Promise<RegistryPdfBulkUploadResponse>;
  export async function resumeRegistryPdfBulk(jobId: string): Promise<{ ok: boolean; pendingCount: number }>;
  export async function manualAttachRegistryPdfRow(
    jobId: string, rowId: string, propertyId: string,
  ): Promise<{ ok: boolean; rowId: string; propertyId: string; attachmentId: string }>;
  // wizard-progress.ts
  export interface BulkJobProgress {
    total: number; done: number; finished: boolean; label: string;
  }
  export function summarizeBulkJobProgress(job: {
    totalRows: number | null; pendingCount?: number;
    successCount: number | null; errorCount: number | null; status: string;
  }): BulkJobProgress;
  ```

- [ ] **Step 1: wizard-progress の失敗するテストを書く**

`src/lib/registry-pdf-bulk/__tests__/wizard-progress.test.ts` を新規作成:

```ts
import { describe, it, expect } from "vitest";
import { summarizeBulkJobProgress } from "../wizard-progress";

describe("summarizeBulkJobProgress", () => {
  it("処理中: done = total - pending", () => {
    const p = summarizeBulkJobProgress({
      totalRows: 10,
      pendingCount: 4,
      successCount: 5,
      errorCount: 1,
      status: "processing",
    });
    expect(p).toEqual({
      total: 10,
      done: 6,
      finished: false,
      label: "処理中 6/10件",
    });
  });

  it("完了: finished=true・statusで文言が変わる", () => {
    expect(
      summarizeBulkJobProgress({
        totalRows: 3,
        pendingCount: 0,
        successCount: 3,
        errorCount: 0,
        status: "completed",
      }),
    ).toEqual({ total: 3, done: 3, finished: true, label: "完了 3/3件" });
    expect(
      summarizeBulkJobProgress({
        totalRows: 3,
        pendingCount: 0,
        successCount: 1,
        errorCount: 2,
        status: "failed",
      }).label,
    ).toBe("完了(一部失敗) 3/3件");
  });

  it("null耐性: totalRows null は 0 扱い", () => {
    const p = summarizeBulkJobProgress({
      totalRows: null,
      successCount: null,
      errorCount: null,
      status: "pending",
    });
    expect(p.total).toBe(0);
    expect(p.finished).toBe(false);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run src/lib/registry-pdf-bulk/__tests__/wizard-progress.test.ts`
Expected: FAIL(モジュールが存在しない)

- [ ] **Step 3: wizard-progress を実装**

`src/lib/registry-pdf-bulk/wizard-progress.ts` を新規作成:

```ts
/**
 * 所有者事項PDF一括ジョブの進捗表示用の純関数。
 * ウィザード(ポーリング)とジョブ詳細の両方から使う。
 */

export interface BulkJobProgress {
  total: number;
  done: number;
  finished: boolean;
  label: string;
}

export function summarizeBulkJobProgress(job: {
  totalRows: number | null;
  pendingCount?: number;
  successCount: number | null;
  errorCount: number | null;
  status: string;
}): BulkJobProgress {
  const total = job.totalRows ?? 0;
  const pending = job.pendingCount ?? 0;
  const done = Math.max(0, total - pending);
  const finished = job.status === "completed" || job.status === "failed";
  const label = finished
    ? `${job.status === "failed" ? "完了(一部失敗)" : "完了"} ${done}/${total}件`
    : `処理中 ${done}/${total}件`;
  return { total, done, finished, label };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/registry-pdf-bulk/__tests__/wizard-progress.test.ts`
Expected: PASS(3 tests)

- [ ] **Step 5: api-client に3関数を追加**

`src/lib/api-client.ts` の import 系関数群(`importReceptionPropertyCsv` の近く)に追加。`apiFetch` はファイル内既存のヘルパをそのまま使う。multipart は `uploadFile` と同じく素の fetch:

```ts
// ============================================================
// 所有者事項PDF一括取込(registry_pdf_bulk)
// ============================================================

export interface RegistryPdfBulkUploadResponse {
  jobId: string;
  totalRows: number;
  acceptedCount: number;
  rejectedCount: number;
}

export async function uploadRegistryPdfBulk(
  files: File[],
): Promise<RegistryPdfBulkUploadResponse> {
  const formData = new FormData();
  for (const f of files) formData.append("files", f);
  const res = await fetch("/api/import/registry-pdf-bulk", {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message ?? `Error: ${res.status}`);
  }
  return res.json();
}

export async function resumeRegistryPdfBulk(
  jobId: string,
): Promise<{ ok: boolean; pendingCount: number }> {
  return apiFetch(`/api/import/jobs/${jobId}/resume-registry-pdf`, {
    method: "POST",
  });
}

export async function manualAttachRegistryPdfRow(
  jobId: string,
  rowId: string,
  propertyId: string,
): Promise<{
  ok: boolean;
  rowId: string;
  propertyId: string;
  attachmentId: string;
}> {
  return apiFetch(
    `/api/import/jobs/${jobId}/rows/${rowId}/manual-attach-registry-pdf`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ propertyId }),
    },
  );
}
```

※ `fetchImportJobDetail` の戻りは型注釈が緩い(呼び出し側 interface で受ける)ため変更不要。

- [ ] **Step 6: ジョブ詳細ページに再開ボタンと手動添付を結線**

`src/app/(dashboard)/import/jobs/[jobId]/page.tsx` を修正:

1. import に追加: `resumeRegistryPdfBulk, manualAttachRegistryPdfRow`(`@/lib/api-client`)。
2. `const isReceptionOwnerJob = ...`(L372付近)の直後に:

```tsx
  const isRegistryPdfBulkJob = job?.jobType === "registry_pdf_bulk";
```

3. `handleResolve`(L434付近)の `link_existing` 分岐を拡張(既存の isReceptionOwnerJob 分岐と並べる):

```tsx
      if (action === "link_existing" && isRegistryPdfBulkJob && targetId) {
        await manualAttachRegistryPdfRow(jobId, rowId, targetId);
      } else if (action === "link_existing" && isReceptionOwnerJob && targetId) {
        await manualLinkReceptionOwnerRow(jobId, rowId, targetId);
      } else {
        await resolveImportRow(jobId, rowId, action, targetId, edited);
      }
```

4. ヘッダ(rollbackボタンの近く、L606-622付近)に再開ボタンを追加:

```tsx
      {isRegistryPdfBulkJob && (job?.pendingCount ?? 0) > 0 && (
        <button
          type="button"
          onClick={async () => {
            setResuming(true);
            try {
              await resumeRegistryPdfBulk(jobId);
              await fetchJob();
            } catch (e) {
              setError(e instanceof Error ? e.message : "再開に失敗しました");
            } finally {
              setResuming(false);
            }
          }}
          disabled={resuming}
          className="rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-sm text-blue-700 hover:bg-blue-100 disabled:opacity-50 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300 dark:hover:bg-blue-900"
        >
          {resuming ? "再開中..." : `未処理 ${job?.pendingCount}件を再開`}
        </button>
      )}
```

state を追加: `const [resuming, setResuming] = useState(false);`(既存 state 群の近く)。`setError` は既存のエラーstateを使う(名前が違う場合はそれに合わせる)。

5. 行アクションの表示条件: `needs_review` 行のボタン群(L1517付近)で、`isRegistryPdfBulkJob` のときは `create_new` と `retry` ボタンを出さない(検索&紐付け=添付、スキップ、エラー確定のみ)。紐付け確定ボタンのラベルを `isRegistryPdfBulkJob ? "この物件に添付" : "紐付け確定"` にする。

- [ ] **Step 7: tsc 確認**

Run: `npx tsc --noEmit`
Expected: エラー0

- [ ] **Step 8: ImportSwitcher に登記DM取込を追加**

`src/components/import/import-switcher.tsx` の `ITEMS`(L19-22)に1行追加(iconは lucide-react の `Files` をimportに追加):

```tsx
const ITEMS: { href: string; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { href: "/import", label: IMPORT_TYPE_LABELS.property_csv, icon: Upload },
  { href: "/import/registry-pdf", label: IMPORT_TYPE_LABELS.registry_pdf, icon: FileText },
  { href: "/import/registry-dm", label: "登記DM取込", icon: Files },
];
```

- [ ] **Step 9: ウィザードページを作成**

`src/app/(dashboard)/import/registry-dm/page.tsx` を新規作成(全文):

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import ImportSwitcher from "@/components/import/import-switcher";
import {
  readFileForImport,
  previewReceptionPropertyCsv,
  importReceptionPropertyCsv,
  previewReceptionOwnerCsv,
  importReceptionOwnerCsv,
  uploadRegistryPdfBulk,
  fetchImportJobDetail,
  type ReceptionPropertyPreviewResponse,
  type ReceptionPropertyImportResponse,
  type ReceptionOwnerPreviewResponse,
  type ReceptionOwnerImportResponse,
  type ReceptionDlFilter,
  type ReceptionShinkiFilter,
  type RegistryPdfBulkUploadResponse,
} from "@/lib/api-client";
import { summarizeBulkJobProgress } from "@/lib/registry-pdf-bulk/wizard-progress";

// ============================================================
// 登記DM取込ウィザード
// ------------------------------------------------------------
// 外部ツール(不動産登記情報自動化システム)の成果物を順に取り込む:
//   ①受付帳Excel → 物件作成(既存API)
//   ②受付帳×所有者Excel → 所有者登録+紐付け(既存API)
//   ③取得済み所有者事項PDF → 一括アップロード(非同期ジョブ・閉じてもOK)
//   ④結果サマリ → 売却DMへの導線
// 各ステップは独立(途中から/一部だけでも使える)。
// ============================================================

type SheetFile = { name: string; csvText?: string; xlsxBase64?: string };

interface BulkJobView {
  totalRows: number | null;
  pendingCount?: number;
  successCount: number | null;
  errorCount: number | null;
  status: string;
}

const STEPS = [
  { n: 1, title: "受付帳Excel(物件作成)" },
  { n: 2, title: "所有者Excel(所有者登録)" },
  { n: 3, title: "取得済みPDF(謄本添付)" },
  { n: 4, title: "結果" },
] as const;

export default function RegistryDmImportPage() {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  // --- step1: 受付帳→物件 ---
  const [rpFile, setRpFile] = useState<SheetFile | null>(null);
  const [rpDl, setRpDl] = useState<ReceptionDlFilter>("marked");
  const [rpShinki, setRpShinki] = useState<ReceptionShinkiFilter>("all");
  const [rpPreview, setRpPreview] =
    useState<ReceptionPropertyPreviewResponse | null>(null);
  const [rpResult, setRpResult] =
    useState<ReceptionPropertyImportResponse | null>(null);

  // --- step2: 受付帳×所有者 ---
  const [ownerFile, setOwnerFile] = useState<SheetFile | null>(null);
  const [roDl, setRoDl] = useState<ReceptionDlFilter>("marked");
  const [roShinki, setRoShinki] = useState<ReceptionShinkiFilter>("existing");
  const [roPreview, setRoPreview] =
    useState<ReceptionOwnerPreviewResponse | null>(null);
  const [roResult, setRoResult] =
    useState<ReceptionOwnerImportResponse | null>(null);

  // --- step3: PDF一括 ---
  const [pdfFiles, setPdfFiles] = useState<File[]>([]);
  const [bulkUpload, setBulkUpload] =
    useState<RegistryPdfBulkUploadResponse | null>(null);
  const [bulkJob, setBulkJob] = useState<BulkJobView | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // step3 のジョブ進捗ポーリング(2秒間隔・完了で停止・unmountで停止)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!bulkUpload) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const job = (await fetchImportJobDetail(bulkUpload.jobId, {
          page: 1,
          limit: 1,
        })) as unknown as BulkJobView;
        if (cancelled) return;
        setBulkJob(job);
        const progress = summarizeBulkJobProgress(job);
        if (progress.finished && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch {
        // ポーリング失敗は無視(次のtickで再試行)
      }
    };
    void tick();
    pollRef.current = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [bulkUpload]);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setLoading(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  const progress = bulkJob ? summarizeBulkJobProgress(bulkJob) : null;

  return (
    <div data-pii-protected data-pii-surface="import" className="space-y-6">
      <ImportSwitcher />
      <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
        登記DM取込
      </h1>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        登記情報自動化ツールの成果物(受付帳Excel・所有者Excel・取得済みPDF)を順に取り込みます。各ステップは独立しているので、必要なものだけ実行しても構いません。
      </p>

      {/* ステップナビ */}
      <ol className="flex flex-wrap gap-2 text-sm">
        {STEPS.map((s) => (
          <li key={s.n}>
            <button
              type="button"
              onClick={() => setStep(s.n as typeof step)}
              aria-current={step === s.n ? "step" : undefined}
              className={`rounded-full border px-3 py-1 ${
                step === s.n
                  ? "border-indigo-600 bg-indigo-600 text-white"
                  : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              }`}
            >
              {s.n}. {s.title}
            </button>
          </li>
        ))}
      </ol>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {/* ---------- Step 1 ---------- */}
      {step === 1 && (
        <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <h2 className="font-medium text-gray-900 dark:text-gray-100">
            ① 受付帳Excelから物件を作成
          </h2>
          <input
            type="file"
            accept=".xlsx,.csv"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              await run(async () => {
                setRpFile(await readFileForImport(f));
                setRpPreview(null);
                setRpResult(null);
              });
            }}
            className="block text-sm"
          />
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              DL列:
              <select
                value={rpDl}
                onChange={(e) => setRpDl(e.target.value as ReceptionDlFilter)}
                className="rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700"
              >
                <option value="marked">〇のみ</option>
                <option value="unmarked">〇なしのみ</option>
                <option value="all">すべて</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              新既:
              <select
                value={rpShinki}
                onChange={(e) =>
                  setRpShinki(e.target.value as ReceptionShinkiFilter)
                }
                className="rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700"
              >
                <option value="all">すべて</option>
                <option value="new">新規のみ</option>
                <option value="existing">既存のみ</option>
              </select>
            </label>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!rpFile || loading}
              onClick={() =>
                run(async () => {
                  setRpPreview(
                    await previewReceptionPropertyCsv({
                      receptionFileName: rpFile!.name,
                      receptionCsv: rpFile!.csvText,
                      receptionXlsxBase64: rpFile!.xlsxBase64,
                      dlFilter: rpDl,
                      shinkiFilter: rpShinki,
                    }),
                  );
                })
              }
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              プレビュー
            </button>
            <button
              type="button"
              disabled={!rpPreview || loading}
              onClick={() =>
                run(async () => {
                  setRpResult(
                    await importReceptionPropertyCsv({
                      receptionFileName: rpFile!.name,
                      receptionCsv: rpFile!.csvText,
                      receptionXlsxBase64: rpFile!.xlsxBase64,
                      dlFilter: rpDl,
                      shinkiFilter: rpShinki,
                    }),
                  );
                })
              }
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              取込実行
            </button>
          </div>
          {rpPreview && (
            <p className="text-sm text-gray-700 dark:text-gray-300">
              対象 {rpPreview.summary.filteredCount}件 / 新規作成{" "}
              {rpPreview.summary.toCreateCount}件 / 既存重複{" "}
              {rpPreview.summary.duplicateCount}件 / 住所なし{" "}
              {rpPreview.summary.noAddressCount}件
            </p>
          )}
          {rpResult && (
            <p className="text-sm text-emerald-700 dark:text-emerald-400">
              取込完了: 作成 {rpResult.successCount}件 / 要確認{" "}
              {rpResult.needsReviewCount}件 / エラー {rpResult.errorCount}件(
              <Link
                href={`/import/jobs/${rpResult.jobId}`}
                className="underline"
              >
                詳細
              </Link>
              )
            </p>
          )}
          <div className="text-right">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600"
            >
              次へ(所有者Excel) →
            </button>
          </div>
        </section>
      )}

      {/* ---------- Step 2 ---------- */}
      {step === 2 && (
        <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <h2 className="font-medium text-gray-900 dark:text-gray-100">
            ② 所有者Excelで所有者を登録・物件に紐付け
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            受付帳Excel(①と同じファイル)と所有者Excelの2つを指定します。
          </p>
          <div className="space-y-2 text-sm">
            <div>
              受付帳: {rpFile ? rpFile.name : "未選択"}{" "}
              <input
                type="file"
                accept=".xlsx,.csv"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  await run(async () => {
                    setRpFile(await readFileForImport(f));
                    setRoPreview(null);
                    setRoResult(null);
                  });
                }}
              />
            </div>
            <div>
              所有者: {ownerFile ? ownerFile.name : "未選択"}{" "}
              <input
                type="file"
                accept=".xlsx,.csv"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  await run(async () => {
                    setOwnerFile(await readFileForImport(f));
                    setRoPreview(null);
                    setRoResult(null);
                  });
                }}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              DL列:
              <select
                value={roDl}
                onChange={(e) => setRoDl(e.target.value as ReceptionDlFilter)}
                className="rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700"
              >
                <option value="marked">〇のみ</option>
                <option value="unmarked">〇なしのみ</option>
                <option value="all">すべて</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              新既:
              <select
                value={roShinki}
                onChange={(e) =>
                  setRoShinki(e.target.value as ReceptionShinkiFilter)
                }
                className="rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700"
              >
                <option value="existing">既存のみ</option>
                <option value="new">新規のみ</option>
                <option value="all">すべて</option>
              </select>
            </label>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!rpFile || !ownerFile || loading}
              onClick={() =>
                run(async () => {
                  setRoPreview(
                    await previewReceptionOwnerCsv({
                      receptionFileName: rpFile!.name,
                      ownerFileName: ownerFile!.name,
                      receptionCsv: rpFile!.csvText,
                      receptionXlsxBase64: rpFile!.xlsxBase64,
                      ownerCsv: ownerFile!.csvText,
                      ownerXlsxBase64: ownerFile!.xlsxBase64,
                      dlFilter: roDl,
                      shinkiFilter: roShinki,
                    }),
                  );
                })
              }
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              プレビュー
            </button>
            <button
              type="button"
              disabled={!roPreview || loading}
              onClick={() =>
                run(async () => {
                  setRoResult(
                    await importReceptionOwnerCsv({
                      receptionFileName: rpFile!.name,
                      ownerFileName: ownerFile!.name,
                      receptionCsv: rpFile!.csvText,
                      receptionXlsxBase64: rpFile!.xlsxBase64,
                      ownerCsv: ownerFile!.csvText,
                      ownerXlsxBase64: ownerFile!.xlsxBase64,
                      dlFilter: roDl,
                      shinkiFilter: roShinki,
                    }),
                  );
                })
              }
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              取込実行
            </button>
          </div>
          {roPreview && (
            <p className="text-sm text-gray-700 dark:text-gray-300">
              物件一致 {roPreview.summary.propertyMatchedCount}件 / 物件未発見{" "}
              {roPreview.summary.propertyNotFoundCount}件 / 所有者一致{" "}
              {roPreview.summary.ownerMatchedCount}件
            </p>
          )}
          {roResult && (
            <p className="text-sm text-emerald-700 dark:text-emerald-400">
              取込完了: 成功 {roResult.successCount}件 / 所有者作成{" "}
              {roResult.ownerCreatedCount}件 / 紐付け {roResult.ownerLinkedCount}
              件 / 要確認 {roResult.needsReviewCount}件(
              <Link
                href={`/import/jobs/${roResult.jobId}`}
                className="underline"
              >
                詳細
              </Link>
              )
            </p>
          )}
          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600"
            >
              ← 戻る
            </button>
            <button
              type="button"
              onClick={() => setStep(3)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600"
            >
              次へ(PDF一括) →
            </button>
          </div>
        </section>
      )}

      {/* ---------- Step 3 ---------- */}
      {step === 3 && (
        <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <h2 className="font-medium text-gray-900 dark:text-gray-100">
            ③ 取得済みPDFを一括で物件に添付
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            「取得済みPDF」フォルダの所有者事項PDFをまとめて選択してください(最大100件・合計100MB)。アップロード後の処理はサーバ側で進むため、この画面を閉じても構いません。
          </p>
          <input
            type="file"
            accept=".pdf,application/pdf"
            multiple
            onChange={(e) => setPdfFiles(Array.from(e.target.files ?? []))}
            className="block text-sm"
          />
          {pdfFiles.length > 0 && !bulkUpload && (
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {pdfFiles.length}件選択中(合計{" "}
              {(pdfFiles.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(1)}
              MB)
            </p>
          )}
          <button
            type="button"
            disabled={pdfFiles.length === 0 || loading || !!bulkUpload}
            onClick={() =>
              run(async () => {
                setBulkUpload(await uploadRegistryPdfBulk(pdfFiles));
              })
            }
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            アップロードして処理開始
          </button>
          {bulkUpload && (
            <div className="space-y-1 text-sm text-gray-700 dark:text-gray-300">
              <p>
                受付: {bulkUpload.acceptedCount}件
                {bulkUpload.rejectedCount > 0 &&
                  ` / 受付不可 ${bulkUpload.rejectedCount}件`}
              </p>
              <p>{progress ? progress.label : "処理待ち..."}</p>
              <p>
                <Link
                  href={`/import/jobs/${bulkUpload.jobId}`}
                  className="underline"
                >
                  ジョブ詳細(要確認の手動添付はこちら)
                </Link>
              </p>
            </div>
          )}
          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600"
            >
              ← 戻る
            </button>
            <button
              type="button"
              onClick={() => setStep(4)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600"
            >
              次へ(結果) →
            </button>
          </div>
        </section>
      )}

      {/* ---------- Step 4 ---------- */}
      {step === 4 && (
        <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <h2 className="font-medium text-gray-900 dark:text-gray-100">
            ④ 結果サマリ
          </h2>
          <ul className="space-y-1 text-sm text-gray-700 dark:text-gray-300">
            <li>
              物件作成:{" "}
              {rpResult
                ? `${rpResult.successCount}件(要確認 ${rpResult.needsReviewCount}件)`
                : "未実行"}
            </li>
            <li>
              所有者登録:{" "}
              {roResult
                ? `作成 ${roResult.ownerCreatedCount}件 / 紐付け ${roResult.ownerLinkedCount}件`
                : "未実行"}
            </li>
            <li>
              PDF添付:{" "}
              {bulkJob && progress
                ? `${progress.label}(成功 ${bulkJob.successCount ?? 0}件 / 要対応 ${bulkJob.errorCount ?? 0}件)`
                : bulkUpload
                  ? "処理中"
                  : "未実行"}
            </li>
          </ul>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/properties"
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-700"
            >
              物件一覧へ(売却DMの作成はこちらから)
            </Link>
            <Link
              href="/import"
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600"
            >
              取込履歴を見る
            </Link>
          </div>
          <div>
            <button
              type="button"
              onClick={() => setStep(3)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600"
            >
              ← 戻る
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 10: tsc + 対象テスト確認**

Run: `npx tsc --noEmit && npx vitest run src/lib/registry-pdf-bulk`
Expected: tsc エラー0・テスト全PASS

- [ ] **Step 11: コミット**

```bash
git add src/lib/api-client.ts src/lib/registry-pdf-bulk/wizard-progress.ts src/lib/registry-pdf-bulk/__tests__/wizard-progress.test.ts "src/app/(dashboard)/import/registry-dm/page.tsx" src/components/import/import-switcher.tsx "src/app/(dashboard)/import/jobs/[jobId]/page.tsx"
git commit -m "feat(import): 登記DM取込ウィザード(4ステップ+進捗ポーリング)と手動添付/再開の結線"
```

---

### Task 12: 全ゲート + 実サンプル検証 + PR提出

**Files:**
- 変更なし(検証と提出のみ)。必要ならゲートで見つかった不具合の修正コミット。

**Interfaces:**
- Consumes: Task 1〜11 の全成果物。
- Produces: push済み branch `feat/registry-dm-import` + open PR(@codex レビュー待ち状態)。

- [ ] **Step 1: フルゲートを回す(対象限定でなくフル)**

Run(worktree直下で順に):
```bash
npx tsc --noEmit
npx vitest run
npm run build
npx eslint . 2>&1 | tail -3
```
Expected: tsc エラー0 / vitest 全緑(既存 約8000 + 新規 約35) / build 成功(新route `/import/registry-dm`・`/api/import/registry-pdf-bulk` が manifest に出る) / eslint はベースラインから増加0。

- [ ] **Step 2: 実サンプルでファイル名解析と突合正規化を検証(コミットしない)**

scratchpad に一時スクリプトを作り、実在の6ファイル名(`DM.zip` 展開済みサンプル)で新パーサを検証する。**出力に所有者名を含めない**:

```bash
cd <worktree>
./node_modules/.bin/tsx -e "
(async () => {
  const { parseRegistryPdfBulkFilename } = await import('./src/lib/registry-pdf-bulk/filename.ts');
  const { normalizeAddress } = await import('./src/lib/normalize.ts');
  const { readdirSync } = require('node:fs');
  const DIR = 'C:/Users/issin/AppData/Local/Temp/claude/C--windows-system32/46ae49db-a5a8-4c21-a091-9128c12204f4/scratchpad/dmzip/資料/所有者ダウンロードPDF';
  for (const f of readdirSync(DIR)) {
    const p = parseRegistryPdfBulkFilename(f);
    console.log(p ? 'OK ' + p.kind + ' ' + p.requestNumber + ' ' + normalizeAddress(p.location) : 'PARSE_FAIL ' + f.slice(0, 20));
  }
})();
"
```
Expected: 6件すべて `OK`(PARSE_FAIL が出たらパターンを修正して Task 2 のテストに実例を追加)。

- [ ] **Step 3: push して PR を作成**

```bash
git push -u origin feat/registry-dm-import
gh pr create --title "feat(import): 登記DM取込(所有者事項PDF一括+一気通貫ウィザード)" --body "$(cat <<'EOF'
## 概要
外部製「不動産登記情報自動化システム」の成果物を取り込む連携の第1弾。

- 新画面「登記DM取込」ウィザード: ①受付帳Excel(既存API)→②所有者Excel(既存API)→③取得済み所有者事項PDFの一括アップロード(新規)→④結果サマリ+売却DM導線
- PDF一括はサーバ側非同期ジョブ(インプロセス直列ワーカー・202即応・画面を閉じても継続・再開ボタンで再起動後復旧)
- 1件ごとに: 請求番号で重複スキップ → ファイル名の所在の正規化完全一致で物件突合(だめならPDF内容でフォールバック) → Attachment(type=registry)として添付
- 未突合はジョブ詳細から手動で物件を指定して添付
- migration 1本(enum値の追加のみ・additive): ImportJobType.registry_pdf_bulk / ImportRowStatus.pending

## セキュリティ/設計上の要点
- 添付書込前に対象物件のアクセス権を確認(既存A-2bと同じ)
- rawData/監査detailに所有者の氏名・住所を入れない(既存PII規律)
- stagingキーはuuid+整数のみで構成(traversal不可)・storage adapterの既存検証も通過
- 受付制限: 100ファイル/合計100MB/1ファイル5MB・Content-Length事前413・直列処理で負荷平準
- 行確定はstatus=pending条件のatomic updateMany(再enqueue/再起動に冪等)

## テスト
- 新規 約35テスト(ファイル名解析/突合/1行処理/ワーカー/route×4/進捗表示)
- フルゲート緑: tsc 0 / vitest 全緑 / build / eslint差分0

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01GJ3Y8iGK1LSs9zJcSY6Uas
EOF
)"
```

- [ ] **Step 4: 提出前プレレビュー(Codex前ゲート・プロジェクト運用ルール)**

feature-dev:code-reviewer サブエージェントでホットスポットを狙い撃ちレビューする(観点: ①認可=manual-attach/bulk routeの権限とアクセス権チェック ②PII=rawData/audit/エラーメッセージ ③atomic claim/冪等性 ④大容量アップロードのDoS面 ⑤staging keyの安全性 ⑥ワーカーのglobalThis singletonとHMR ⑦既存ジョブ詳細UIへの回帰)。指摘があれば修正コミット→再ゲート。

- [ ] **Step 5: @codex レビューを起動**

PR に `@codex review` コメントを投稿(修正push後の再レビューも自分で起動する=プロジェクト運用ルール)。以後は指摘対応→修正→再レビューのループ。**マージはユーザーが行う**。

---

## 実装後の残タスク(このPRの外・参考)

- VPS反映時は `prisma migrate deploy` 1本(enum追加・additive)を含む通常手順。
- ウィザードの実機確認(要認証): 実ファイル(受付帳Excel/所有者Excel/取得済みPDF)での一気通貫はユーザー確認推奨。
- 第2弾(システム内蔵の自動取得+所有者事項/全部事項の種別選択)は別設計(既存 `RegistryFetchProvider` seam を利用)。
