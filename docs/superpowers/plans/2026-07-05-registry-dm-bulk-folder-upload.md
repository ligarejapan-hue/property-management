# 登記DM取込 Step3 フォルダ一括アップロード Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 登記DM取込ウィザードの Step3 を、フォルダ丸ごと選択→クライアント側で100件ずつ自動分割→直列アップロードする方式に作り直し、6000件規模の滞留PDFを放置で取り込めるようにする。

**Architecture:** 変更はクライアント側のみ。サーバの一括取込エンドポイント(`/api/import/registry-pdf-bulk`・上限100件/100MB/5MB・冪等)は無改修で流用し、ブラウザが複数バッチを直列に送る。純ロジック(仕分け・分割・再開)を部品化してTDDし、UIコンポーネントはオーケストレーションに徹する。中断・再開は送信済み請求番号を localStorage に記録して実現し、サーバ側の請求番号 dedup が二重添付を防ぐ二重の安全とする。

**Tech Stack:** Next.js(App Router)/ React(client component)/ TypeScript / vitest(env=node)/ Tailwind CSS。

## Global Constraints

- **サーバ無改修**: `/api/import/registry-pdf-bulk`・ワーカー・staging・突合・上限値(`MAX_BULK_FILES=100`/`MAX_BULK_FILE_BYTES=5MB`/`MAX_BULK_TOTAL_BYTES=100MB`)を一切変更しない。
- **直列アップロード厳守**: バッチを同時送信しない(サーバの同時実行ガード最大2・メモリ保護に整合)。
- **新規依存なし・migrationなし・schema変更なし**。
- **クライアント側バッチ目標**: 100件 または 90MB(`BATCH_TARGET_BYTES`)のどちらか先に達したら区切る。
- **テスト**: env=node(jsdom無)。純関数は RED→GREEN、UIは `renderToStaticMarkup` で初期構造のみ検証。
- **全ゲート**: `npx tsc --noEmit`=0 / full `npx vitest run` 緑 / `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build` 成功 / `npx eslint <変更ファイル>` 差分0。
- **commit末尾**: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` と `Claude-Session: https://claude.ai/code/session_01PCtd5pRJdLHnBF9QrciQZc` を付す。
- worktree: `property-management-worktrees/registry-dm-file-ui` / branch: `feat/registry-dm-bulk-upload`。

---

### Task 1: 純ロジック `bulk-upload-plan.ts`(仕分け・分割・再開キー)

**Files:**
- Create: `src/lib/registry-pdf-bulk/bulk-upload-plan.ts`
- Test: `src/lib/registry-pdf-bulk/__tests__/bulk-upload-plan.test.ts`

**Interfaces:**
- Consumes: `parseRegistryPdfBulkFilename(name)` from `./filename`(戻り値 `{ location, kind, requestNumber } | null`)。
- Produces:
  - `interface BulkFileMeta { name: string; size: number }`
  - `type ExcludeReason = "too_large" | "not_pdf"`
  - `interface ExcludedFile { index: number; name: string; reason: ExcludeReason }`
  - `interface UploadPlan { excluded: ExcludedFile[]; alreadySentCount: number; batches: number[][]; sendableTotal: number }`
  - `const MAX_BULK_FILES = 100`, `const MAX_BULK_FILE_BYTES = 5*1024*1024`, `const BATCH_TARGET_BYTES = 90*1024*1024`
  - `classifyBulkFiles(files: BulkFileMeta[]): { sendable: number[]; excluded: ExcludedFile[] }`
  - `planBatches(sendable: number[], files: BulkFileMeta[]): number[][]`
  - `bulkFileKey(name: string): string`
  - `filterUnsent(sendable: number[], files: BulkFileMeta[], sentKeys: ReadonlySet<string>): number[]`
  - `buildUploadPlan(files: BulkFileMeta[], sentKeys: ReadonlySet<string>): UploadPlan`

- [ ] **Step 1: Write the failing test**

`src/lib/registry-pdf-bulk/__tests__/bulk-upload-plan.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  classifyBulkFiles,
  planBatches,
  bulkFileKey,
  filterUnsent,
  buildUploadPlan,
  MAX_BULK_FILE_BYTES,
  type BulkFileMeta,
} from "../bulk-upload-plan";

const meta = (name: string, size = 1024): BulkFileMeta => ({ name, size });
const pdfs = (n: number, size = 1024): BulkFileMeta[] =>
  Array.from({ length: n }, (_, i) => meta(`f${i}.pdf`, size));

describe("classifyBulkFiles", () => {
  it(".pdf は大文字小文字問わず送信可、非PDFは not_pdf 除外", () => {
    const files = [meta("a.pdf"), meta("b.PDF"), meta("c.xlsx"), meta("d.txt")];
    const { sendable, excluded } = classifyBulkFiles(files);
    expect(sendable).toEqual([0, 1]);
    expect(excluded).toEqual([
      { index: 2, name: "c.xlsx", reason: "not_pdf" },
      { index: 3, name: "d.txt", reason: "not_pdf" },
    ]);
  });

  it("ちょうど5MBは送信可、5MB+1は too_large", () => {
    const files = [
      meta("ok.pdf", MAX_BULK_FILE_BYTES),
      meta("big.pdf", MAX_BULK_FILE_BYTES + 1),
    ];
    const { sendable, excluded } = classifyBulkFiles(files);
    expect(sendable).toEqual([0]);
    expect(excluded).toEqual([
      { index: 1, name: "big.pdf", reason: "too_large" },
    ]);
  });
});

describe("planBatches", () => {
  it("空入力は空配列", () => {
    expect(planBatches([], [])).toEqual([]);
  });

  it("100件は1バッチ、101件は2バッチ(100+1)", () => {
    const files = pdfs(101);
    const idx = files.map((_, i) => i);
    const b100 = planBatches(idx.slice(0, 100), files);
    expect(b100).toHaveLength(1);
    expect(b100[0]).toHaveLength(100);
    const b101 = planBatches(idx, files);
    expect(b101).toHaveLength(2);
    expect(b101[0]).toHaveLength(100);
    expect(b101[1]).toEqual([100]);
  });

  it("合計が90MB目標を跨ぐ位置で分割", () => {
    const mb = 1024 * 1024;
    const files = [
      meta("a.pdf", 40 * mb),
      meta("b.pdf", 40 * mb),
      meta("c.pdf", 40 * mb),
    ];
    expect(planBatches([0, 1, 2], files)).toEqual([[0, 1], [2]]);
  });
});

describe("bulkFileKey", () => {
  it("規約ファイル名は請求番号、非規約はファイル名", () => {
    expect(
      bulkFileKey("渋谷区A不動産登記（建物所有者事項）2024121200118150.PDF"),
    ).toBe("2024121200118150");
    expect(bulkFileKey("random.pdf")).toBe("random.pdf");
  });
});

describe("filterUnsent / buildUploadPlan", () => {
  it("送信済みキーを除外する", () => {
    const files = [
      meta("渋谷区A不動産登記（土地所有者事項）1111111111111111.pdf"),
      meta("渋谷区B不動産登記（建物所有者事項）2222222222222222.pdf"),
    ];
    expect(filterUnsent([0, 1], files, new Set(["1111111111111111"]))).toEqual([
      1,
    ]);
  });

  it("buildUploadPlan は除外・送信済み・バッチを集計", () => {
    const files = [
      meta("渋谷区A不動産登記（土地所有者事項）1111111111111111.pdf"),
      meta("big.pdf", MAX_BULK_FILE_BYTES + 1),
      meta("note.txt"),
      meta("渋谷区B不動産登記（建物所有者事項）2222222222222222.pdf"),
    ];
    const plan = buildUploadPlan(files, new Set(["1111111111111111"]));
    expect(plan.excluded.map((x) => x.reason)).toEqual(["too_large", "not_pdf"]);
    expect(plan.alreadySentCount).toBe(1);
    expect(plan.sendableTotal).toBe(1);
    expect(plan.batches).toEqual([[3]]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/registry-pdf-bulk/__tests__/bulk-upload-plan.test.ts`
Expected: FAIL(`Cannot find module '../bulk-upload-plan'`)

- [ ] **Step 3: Write minimal implementation**

`src/lib/registry-pdf-bulk/bulk-upload-plan.ts`:

```ts
/**
 * 所有者事項PDF一括アップロードのクライアント側「割り振り」純関数。
 * DOM/File 非依存({ name, size } の軽量メタと元 index で扱う)。
 * サーバ(registry-pdf-bulk/route.ts)は無改修で、ここが複数バッチへの分割・
 * 再開スキップを担う。上限の正本はサーバ側。
 */
import { parseRegistryPdfBulkFilename } from "./filename";

export interface BulkFileMeta {
  name: string;
  size: number;
}

export type ExcludeReason = "too_large" | "not_pdf";

export interface ExcludedFile {
  index: number;
  name: string;
  reason: ExcludeReason;
}

export interface UploadPlan {
  excluded: ExcludedFile[];
  alreadySentCount: number;
  batches: number[][];
  sendableTotal: number;
}

// サーバ route.ts / wizard-progress.ts と同じ上限(正本はサーバ側)。
export const MAX_BULK_FILES = 100;
export const MAX_BULK_FILE_BYTES = 5 * 1024 * 1024;
// 1バッチのバイト目標。サーバ上限100MBに余裕を持たせる。
export const BATCH_TARGET_BYTES = 90 * 1024 * 1024;

/** 拡張子 .pdf 以外 / 5MB超 を除外し、残りを送信可 index 配列に。 */
export function classifyBulkFiles(files: BulkFileMeta[]): {
  sendable: number[];
  excluded: ExcludedFile[];
} {
  const sendable: number[] = [];
  const excluded: ExcludedFile[] = [];
  files.forEach((f, index) => {
    if (!f.name.toLowerCase().endsWith(".pdf")) {
      excluded.push({ index, name: f.name, reason: "not_pdf" });
    } else if (f.size > MAX_BULK_FILE_BYTES) {
      excluded.push({ index, name: f.name, reason: "too_large" });
    } else {
      sendable.push(index);
    }
  });
  return { sendable, excluded };
}

/** 送信可 index を「100件 or 90MB を超えたら区切る」で複数バッチに分割。 */
export function planBatches(
  sendable: number[],
  files: BulkFileMeta[],
): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let currentBytes = 0;
  for (const index of sendable) {
    const size = files[index]?.size ?? 0;
    const exceedsCount = current.length >= MAX_BULK_FILES;
    const exceedsBytes =
      current.length > 0 && currentBytes + size > BATCH_TARGET_BYTES;
    if (exceedsCount || exceedsBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(index);
    currentBytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** 再開キー: 請求番号が取れればそれ、無ければ正規化したファイル名。 */
export function bulkFileKey(name: string): string {
  const parsed = parseRegistryPdfBulkFilename(name);
  return parsed ? parsed.requestNumber : name.normalize("NFC").trim();
}

/** 送信済みキー集合に含まれる index を除外。 */
export function filterUnsent(
  sendable: number[],
  files: BulkFileMeta[],
  sentKeys: ReadonlySet<string>,
): number[] {
  return sendable.filter((i) => !sentKeys.has(bulkFileKey(files[i].name)));
}

/** UI 用のまとめ計画: 除外・送信済みスキップ・未送信バッチ列を一括算出。 */
export function buildUploadPlan(
  files: BulkFileMeta[],
  sentKeys: ReadonlySet<string>,
): UploadPlan {
  const { sendable, excluded } = classifyBulkFiles(files);
  const unsent = filterUnsent(sendable, files, sentKeys);
  return {
    excluded,
    alreadySentCount: sendable.length - unsent.length,
    batches: planBatches(unsent, files),
    sendableTotal: unsent.length,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/registry-pdf-bulk/__tests__/bulk-upload-plan.test.ts`
Expected: PASS(全ケース緑)

- [ ] **Step 5: Commit**

```bash
git add src/lib/registry-pdf-bulk/bulk-upload-plan.ts src/lib/registry-pdf-bulk/__tests__/bulk-upload-plan.test.ts
git commit -m "$(cat <<'EOF'
feat(registry-dm): 一括アップロードの割り振り純ロジック

仕分け(5MB超/非PDF除外)・100件/90MB分割・請求番号キー・送信済み
スキップ・buildUploadPlan をTDDで実装(env=nodeで完結)。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PCtd5pRJdLHnBF9QrciQZc
EOF
)"
```

---

### Task 2: 再開ストレージ `bulk-upload-resume.ts`(localStorage)

**Files:**
- Create: `src/lib/registry-pdf-bulk/bulk-upload-resume.ts`
- Test: `src/lib/registry-pdf-bulk/__tests__/bulk-upload-resume.test.ts`

**Interfaces:**
- Produces:
  - `loadSentKeys(): Set<string>`(window無/壊れJSONは空集合)
  - `recordSentKeys(keys: string[]): void`(既存に追記)
  - `clearSentKeys(): void`

- [ ] **Step 1: Write the failing test**

`src/lib/registry-pdf-bulk/__tests__/bulk-upload-resume.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  loadSentKeys,
  recordSentKeys,
  clearSentKeys,
} from "../bulk-upload-resume";

function makeLocalStorageStub(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

describe("bulk-upload-resume", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("window が無ければ no-op(空集合・throwしない)", () => {
    expect(loadSentKeys().size).toBe(0);
    recordSentKeys(["a"]);
    clearSentKeys();
    expect(loadSentKeys().size).toBe(0);
  });

  it("record→load でキーが往復し、重複は集合で吸収", () => {
    vi.stubGlobal("window", { localStorage: makeLocalStorageStub() });
    recordSentKeys(["k1", "k2"]);
    recordSentKeys(["k2", "k3"]);
    expect([...loadSentKeys()].sort()).toEqual(["k1", "k2", "k3"]);
  });

  it("clear で消える", () => {
    vi.stubGlobal("window", { localStorage: makeLocalStorageStub() });
    recordSentKeys(["k1"]);
    clearSentKeys();
    expect(loadSentKeys().size).toBe(0);
  });

  it("壊れた JSON は空集合にフォールバック", () => {
    const stub = makeLocalStorageStub();
    stub.setItem("registry-pdf-bulk:sent-keys", "{not json");
    vi.stubGlobal("window", { localStorage: stub });
    expect(loadSentKeys().size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/registry-pdf-bulk/__tests__/bulk-upload-resume.test.ts`
Expected: FAIL(`Cannot find module '../bulk-upload-resume'`)

- [ ] **Step 3: Write minimal implementation**

`src/lib/registry-pdf-bulk/bulk-upload-resume.ts`:

```ts
/**
 * 一括アップロードの中断・再開用の送信済み請求番号ストア(ブラウザ localStorage)。
 * 請求番号はグローバルに一意なため単一キー集合で運用する。
 * SSR/テスト(window無)では no-op。正しさの最終担保はサーバ側の請求番号 dedup。
 */
const STORAGE_KEY = "registry-pdf-bulk:sent-keys";

function safeStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadSentKeys(): Set<string> {
  const s = safeStorage();
  if (!s) return new Set();
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? new Set(arr.filter((x): x is string => typeof x === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

export function recordSentKeys(keys: string[]): void {
  const s = safeStorage();
  if (!s) return;
  const cur = loadSentKeys();
  for (const k of keys) cur.add(k);
  try {
    s.setItem(STORAGE_KEY, JSON.stringify([...cur]));
  } catch {
    // quota 超過等は無視(再開効率が落ちるだけで、サーバ dedup が二重添付を防ぐ)
  }
}

export function clearSentKeys(): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/registry-pdf-bulk/__tests__/bulk-upload-resume.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/registry-pdf-bulk/bulk-upload-resume.ts src/lib/registry-pdf-bulk/__tests__/bulk-upload-resume.test.ts
git commit -m "$(cat <<'EOF'
feat(registry-dm): 一括アップロードの再開ストレージ

送信済み請求番号を localStorage に蓄積(window無/壊れJSONは空集合)。
中断後に同フォルダ再選択で続きから送るための土台。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PCtd5pRJdLHnBF9QrciQZc
EOF
)"
```

---

### Task 3: UIコンポーネント `bulk-folder-upload.tsx`

**Files:**
- Create: `src/components/import/bulk-folder-upload.tsx`
- Test: `src/components/import/__tests__/bulk-folder-upload.test.tsx`

**Interfaces:**
- Consumes: `buildUploadPlan`, `bulkFileKey`, `type BulkFileMeta`, `type UploadPlan`(Task 1); `loadSentKeys`, `recordSentKeys`, `clearSentKeys`(Task 2); `uploadRegistryPdfBulk`, `type RegistryPdfBulkUploadResponse`(`@/lib/api-client`)。
- Produces:
  - default export `BulkFolderUpload`(props: `{ onUploaded?: (summary: BulkUploadSummary) => void }`)
  - `interface BulkUploadSummary { acceptedTotal: number; rejectedTotal: number; excludedTotal: number; batchCount: number; jobIds: string[] }`

- [ ] **Step 1: Write the failing test**

`src/components/import/__tests__/bulk-folder-upload.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import BulkFolderUpload from "../bulk-folder-upload";

describe("BulkFolderUpload — SSR構造", () => {
  it("フォルダ/ファイル選択ボタン・対応形式・PDF入力を描画する", () => {
    const html = renderToStaticMarkup(<BulkFolderUpload />);
    expect(html).toContain("data-bulk-folder-upload");
    expect(html).toContain("フォルダを選択");
    expect(html).toContain("ファイルを選択");
    expect(html).toContain("対応形式");
    expect(html).toContain('type="file"');
    expect(html).toContain('accept=".pdf,application/pdf"');
  });

  it("未選択の初期状態では開始/完了/進捗を描画しない", () => {
    const html = renderToStaticMarkup(<BulkFolderUpload />);
    expect(html).not.toContain("アップロード開始");
    expect(html).not.toContain("アップロード完了");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/import/__tests__/bulk-folder-upload.test.tsx`
Expected: FAIL(`Cannot find module '../bulk-folder-upload'`)

- [ ] **Step 3: Write the implementation**

`src/components/import/bulk-folder-upload.tsx`:

```tsx
"use client";

import { useCallback, useState, type ChangeEvent } from "react";
import Link from "next/link";
import {
  uploadRegistryPdfBulk,
  type RegistryPdfBulkUploadResponse,
} from "@/lib/api-client";
import {
  buildUploadPlan,
  bulkFileKey,
  type BulkFileMeta,
  type UploadPlan,
} from "@/lib/registry-pdf-bulk/bulk-upload-plan";
import {
  loadSentKeys,
  recordSentKeys,
  clearSentKeys,
} from "@/lib/registry-pdf-bulk/bulk-upload-resume";

export interface BulkUploadSummary {
  acceptedTotal: number;
  rejectedTotal: number;
  excludedTotal: number;
  batchCount: number;
  jobIds: string[];
}

const REASON_LABEL: Record<string, string> = {
  too_large: "5MB超過",
  not_pdf: "PDF以外",
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toMetas(files: File[]): BulkFileMeta[] {
  return files.map((f) => ({ name: f.name, size: f.size }));
}

export default function BulkFolderUpload({
  onUploaded,
}: {
  onUploaded?: (summary: BulkUploadSummary) => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [plan, setPlan] = useState<UploadPlan | null>(null);
  const [uploading, setUploading] = useState(false);
  const [sentCount, setSentCount] = useState(0);
  const [batchDone, setBatchDone] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<BulkUploadSummary | null>(null);
  const [showExcluded, setShowExcluded] = useState(false);

  // webkitdirectory は React の型に無いため callback ref で付与する。
  const folderRefCb = useCallback((el: HTMLInputElement | null) => {
    if (el) el.setAttribute("webkitdirectory", "");
  }, []);

  const onPick = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const picked = Array.from(input.files ?? []).filter((f) =>
      f.name.toLowerCase().endsWith(".pdf"),
    );
    // 同じフォルダ/ファイルを選び直しても onChange が再発火するよう value をクリア。
    input.value = "";
    if (picked.length === 0) return;
    setFiles(picked);
    setPlan(buildUploadPlan(toMetas(picked), loadSentKeys()));
    setSentCount(0);
    setBatchDone(0);
    setError(null);
    setSummary(null);
    setShowExcluded(false);
  }, []);

  const start = useCallback(async () => {
    if (files.length === 0) return;
    // クリック時点の送信済み記録で再計算(中断後は続きから送る)。
    const fresh = buildUploadPlan(toMetas(files), loadSentKeys());
    setPlan(fresh);
    setSentCount(0);
    setBatchDone(0);
    setError(null);
    if (fresh.batches.length === 0) {
      const s: BulkUploadSummary = {
        acceptedTotal: 0,
        rejectedTotal: 0,
        excludedTotal: fresh.excluded.length,
        batchCount: 0,
        jobIds: [],
      };
      setSummary(s);
      onUploaded?.(s);
      return;
    }
    setUploading(true);
    let accepted = 0;
    let rejected = 0;
    let sent = 0;
    const jobIds: string[] = [];
    try {
      for (let b = 0; b < fresh.batches.length; b++) {
        const batch = fresh.batches[b];
        const batchFiles = batch.map((i) => files[i]);
        // 直列送信。503(混雑)や一時失敗に備えた軽いリトライ(最大3回)。
        let res: RegistryPdfBulkUploadResponse | undefined;
        let lastErr: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            res = await uploadRegistryPdfBulk(batchFiles);
            break;
          } catch (err) {
            lastErr = err;
            if (attempt < 2) await delay(2000);
          }
        }
        if (!res) throw lastErr;
        accepted += res.acceptedCount;
        rejected += res.rejectedCount;
        jobIds.push(res.jobId);
        recordSentKeys(batch.map((i) => bulkFileKey(files[i].name)));
        sent += batch.length;
        setSentCount(sent);
        setBatchDone(b + 1);
      }
      const s: BulkUploadSummary = {
        acceptedTotal: accepted,
        rejectedTotal: rejected,
        excludedTotal: fresh.excluded.length,
        batchCount: fresh.batches.length,
        jobIds,
      };
      setSummary(s);
      onUploaded?.(s);
    } catch (err) {
      setError(
        err instanceof Error
          ? `アップロードを中断しました: ${err.message}（「再開する」で続きから送れます）`
          : "アップロードを中断しました（「再開する」で続きから送れます）",
      );
    } finally {
      setUploading(false);
    }
  }, [files, onUploaded]);

  const reset = useCallback(() => {
    setFiles([]);
    setPlan(null);
    setSentCount(0);
    setBatchDone(0);
    setError(null);
    setSummary(null);
    setShowExcluded(false);
  }, []);

  const clearRecord = useCallback(() => {
    clearSentKeys();
    reset();
  }, [reset]);

  const total = plan?.sendableTotal ?? 0;
  const batchTotal = plan?.batches.length ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((sentCount / total) * 100)) : 0;

  return (
    <div data-bulk-folder-upload className="space-y-4">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        「取得済みPDF」フォルダを丸ごと選んでください。100件ずつ自動で分割して順番にアップロードします。件数が多くても放置で完了し、途中で閉じても同じフォルダを選び直せば続きから送れます（送信済みは自動でスキップ）。
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
          フォルダを選択
          <input
            ref={folderRefCb}
            type="file"
            accept=".pdf,application/pdf"
            multiple
            onChange={onPick}
            className="hidden"
          />
        </label>
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">
          ファイルを選択（複数可）
          <input
            type="file"
            accept=".pdf,application/pdf"
            multiple
            onChange={onPick}
            className="hidden"
          />
        </label>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          対応形式: PDF（1ファイル5MBまで）
        </span>
      </div>

      {plan && !summary && (
        <div className="space-y-2 rounded-md border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-900/40">
          <p className="text-gray-800 dark:text-gray-200">
            選択 {files.length}件 / これから送信{" "}
            <span className="font-semibold">{plan.sendableTotal}件</span>
            {plan.alreadySentCount > 0 &&
              ` / 送信済みスキップ ${plan.alreadySentCount}件`}
            {plan.excluded.length > 0 && ` / 除外 ${plan.excluded.length}件`}
            {plan.batches.length > 0 && `（${plan.batches.length}バッチ）`}
          </p>
          {plan.excluded.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setShowExcluded((v) => !v)}
                className="text-xs text-indigo-600 underline dark:text-indigo-400"
              >
                除外 {plan.excluded.length}件の内訳を
                {showExcluded ? "隠す" : "見る"}
              </button>
              {showExcluded && (
                <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-xs text-gray-600 dark:text-gray-400">
                  {plan.excluded.map((x) => (
                    <li key={x.index} className="break-all">
                      {REASON_LABEL[x.reason] ?? x.reason}: {x.name}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {(uploading || (sentCount > 0 && !summary)) && (
        <div className="space-y-1">
          <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
            <div
              className="h-full bg-emerald-500 transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-sm text-gray-700 dark:text-gray-300">
            送信 {sentCount} / {total}件（バッチ {batchDone} / {batchTotal}）
          </p>
        </div>
      )}

      {plan && plan.batches.length > 0 && !summary && (
        <button
          type="button"
          disabled={uploading}
          onClick={start}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {uploading
            ? "アップロード中..."
            : error
              ? "再開する"
              : "アップロード開始"}
        </button>
      )}

      {plan && plan.batches.length === 0 && !summary && files.length > 0 && (
        <p className="text-sm text-emerald-700 dark:text-emerald-400">
          選択したPDFはすべて送信済みです。
        </p>
      )}

      {error && <p className="text-sm text-red-700 dark:text-red-400">{error}</p>}

      {summary && (
        <div className="space-y-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-800 dark:bg-emerald-950/40">
          <p className="text-emerald-800 dark:text-emerald-300">
            アップロード完了: {summary.acceptedTotal}件を受付
            {summary.batchCount > 0 && `（${summary.batchCount}バッチ）`}
            {summary.excludedTotal > 0 && ` / 除外 ${summary.excludedTotal}件`}
          </p>
          <p className="text-gray-700 dark:text-gray-300">
            添付結果（添付済 / 既取得スキップ / 要確認）は取込履歴で確認できます。
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/import"
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs dark:border-gray-600"
            >
              取込履歴を見る
            </Link>
            <button
              type="button"
              onClick={reset}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-700 dark:border-gray-600 dark:text-gray-300"
            >
              別のフォルダを送る
            </button>
            <button
              type="button"
              onClick={clearRecord}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-500 dark:border-gray-600 dark:text-gray-400"
            >
              送信記録をリセット
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/import/__tests__/bulk-folder-upload.test.tsx`
Expected: PASS

- [ ] **Step 5: Typecheck & lint this file**

Run: `npx tsc --noEmit` → 0、`npx eslint src/components/import/bulk-folder-upload.tsx` → 差分0
Expected: エラーなし(疑わしい eslint 指摘は `git stash` 前後のベースライン比較で自差分か判別)

- [ ] **Step 6: Commit**

```bash
git add src/components/import/bulk-folder-upload.tsx src/components/import/__tests__/bulk-folder-upload.test.tsx
git commit -m "$(cat <<'EOF'
feat(registry-dm): フォルダ一括アップロードUI(直列送信・進捗・再開)

フォルダ/複数ファイル選択→100件ずつ直列送信、全体進捗、除外一覧、
中断→再開(送信済みスキップ)、完了サマリ。ファイル選択UIも刷新。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PCtd5pRJdLHnBF9QrciQZc
EOF
)"
```

---

### Task 4: ウィザード Step3/Step4 への配線(`page.tsx` 差し替え)

**Files:**
- Modify: `src/app/(dashboard)/import/registry-dm/page.tsx`

**Interfaces:**
- Consumes: `BulkFolderUpload`(default), `type BulkUploadSummary`(Task 3)。
- Produces: なし(ページ内配線)。

- [ ] **Step 1: import を整理する**

`import { useCallback, useEffect, useRef, useState } from "react";` を次に変更:

```tsx
import { useCallback, useState } from "react";
```

api-client の import ブロックから `uploadRegistryPdfBulk,`・`fetchImportJobDetail,`・`type RegistryPdfBulkUploadResponse,` の3行を削除(他は残す)。

次の wizard-progress import 行を削除:

```tsx
import {
  summarizeBulkJobProgress,
  validateBulkSelection,
} from "@/lib/registry-pdf-bulk/wizard-progress";
```

コンポーネント import を追加(既存 `import ImportSwitcher ...` の下あたり):

```tsx
import BulkFolderUpload, {
  type BulkUploadSummary,
} from "@/components/import/bulk-folder-upload";
```

- [ ] **Step 2: 不要な型・state・effect を削除する**

`interface BulkJobView { ... }` の宣言ブロックを削除。

Step3 用 state ブロック(`pdfFiles`/`pdfSelectionError`/`pdfInputKey`/`bulkUpload`/`bulkJob` の5つの `useState`)を削除し、代わりに1行を追加:

```tsx
const [bulkSummary, setBulkSummary] = useState<BulkUploadSummary | null>(null);
```

ポーリングの `const pollRef = useRef<...>(null);` と、それに続く `useEffect(() => { ... }, [bulkUpload]);` ブロック全体を削除。

`const progress = bulkJob ? summarizeBulkJobProgress(bulkJob) : null;` を削除。

- [ ] **Step 3: Step3 セクションを差し替える**

`{/* ---------- Step 3 ---------- */}` の `{step === 3 && ( ... )}` 全体を次に置換:

```tsx
{/* ---------- Step 3 ---------- */}
{step === 3 && (
  <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
    <h2 className="font-medium text-gray-900 dark:text-gray-100">
      ③ 取得済みPDFを一括で物件に添付
    </h2>
    <BulkFolderUpload onUploaded={setBulkSummary} />
    <div className="flex justify-between">
      <button
        type="button"
        onClick={() => setStep(2)}
        className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-300"
      >
        ← 戻る
      </button>
      <button
        type="button"
        onClick={() => setStep(4)}
        className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-300"
      >
        次へ(結果) →
      </button>
    </div>
  </section>
)}
```

- [ ] **Step 4: Step4 の「PDF添付」行を差し替える**

Step4 の `<li> PDF添付: ... </li>`(`bulkJob`/`progress`/`bulkUpload` を参照している行)を次に置換:

```tsx
<li>
  PDF添付:{" "}
  {bulkSummary
    ? `${bulkSummary.acceptedTotal}件を受付（${bulkSummary.batchCount}バッチ${
        bulkSummary.excludedTotal > 0
          ? ` / 除外 ${bulkSummary.excludedTotal}件`
          : ""
      }）`
    : "未実行"}
</li>
```

- [ ] **Step 5: 型・ビルド・lint を確認する**

Run: `npx tsc --noEmit` → 0
Run: `npx eslint "src/app/(dashboard)/import/registry-dm/page.tsx"` → 差分0(未使用 import/変数が残っていれば削除)
Expected: エラーなし。`useEffect`/`useRef`/削除した各シンボルの未使用参照が残っていないこと。

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/import/registry-dm/page.tsx"
git commit -m "$(cat <<'EOF'
feat(registry-dm): Step3をフォルダ一括アップロードUIに差し替え

生の<input>とポーリングを撤去し BulkFolderUpload を配線。Step4サマリは
受付件数(概況)を表示。詳細は従来どおり取込履歴で確認。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PCtd5pRJdLHnBF9QrciQZc
EOF
)"
```

---

### Task 5: 全ゲート + 提出前レビュー + PR

**Files:** なし(検証・提出)

- [ ] **Step 1: フルゲート**

```bash
npx tsc --noEmit
npx vitest run
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build
```
Expected: tsc 0 / 全テスト緑(新規テスト含む) / build 成功。full vitest は対象限定でなく必ず全件。

- [ ] **Step 2: 提出前レビュー(feature-dev:code-reviewer)**

`git add -A` 後、staged diff を `feature-dev:code-reviewer`(sonnet)へ。ホットスポット指定:
- **直列送信の担保**(バッチ並列化していないか・503リトライが無限化しないか)
- **再開の冪等性**(送信済みキーの記録タイミング=202受領後か・中断後 start 再計算で二重送信にならないか)
- **境界**(planBatchesの100件/90MB境界・classifyの5MB境界・空入力)
- **サーバ無改修の順守**(route/worker/上限に手が入っていないこと)
- 一般観点: 認可(本UIは既存 import:write エンドポイント経由=新規認可コードなし)/PII(ファイル名・請求番号をログ/監査に出さない)/デスクトップ回帰/テスト妥当性。

指摘は新commitで対応(amend禁止)。

- [ ] **Step 3: push & PR**

```bash
git push -u origin feat/registry-dm-bulk-upload
gh pr create --title "feat(registry-dm): 登記DM取込のフォルダ一括アップロード" --body "<本文>"
```
本文は平易な日本語で Summary(6000件の滞留を放置で取込)/実装(クライアント側のみ・サーバ無改修・直列100件分割・中断再開)/テスト(純ロジックTDD・SSR構造)/セキュリティ(新規認可なし・既存エンドポイント流用)。末尾に `🤖 Generated with [Claude Code](https://claude.com/claude-code)`。

- [ ] **Step 4: @codex 起動**

```bash
gh pr comment <PR番号> --body "@codex review"
```
以降の対応は codex-triage スキルに従う。マージはユーザー。

---

## Self-Review(計画作成者による点検)

- **Spec coverage**: フォルダ選択(Task3)/自動分割(Task1 planBatches)/直列送信(Task3 start)/進捗(Task3)/中断再開(Task2+Task3)/除外表示(Task1 classify+Task3)/UI刷新(Task3 ボタン)/Step4サマリ(Task4)/サーバ無改修(全タスク)= 各仕様にタスク対応あり。
- **Placeholder scan**: TBD/TODO なし。全コードブロックは実体。
- **Type consistency**: `BulkFileMeta`/`UploadPlan`/`ExcludedFile`/`BulkUploadSummary`/`bulkFileKey`/`buildUploadPlan`/`loadSentKeys`/`recordSentKeys`/`clearSentKeys`/`uploadRegistryPdfBulk`/`RegistryPdfBulkUploadResponse` を Task 間で同名・同型で参照。
- **既知の割り切り**: (1) 6000件で約60ジョブが履歴に並ぶ(v1許容)。(2) 全ジョブ横断の添付結果ライブ集計はしない(履歴で確認)。(3) 拡張子が .pdf でも実体が非PDFのファイルはクライアントを通過しサーバ側 rejectedCount に計上され得るが、再送してもサーバで弾かれるため送信済み扱いで問題なし。
