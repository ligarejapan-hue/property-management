# 作業中の入力を消さない — 第1段(土台+新規物件登録+物件の編集) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新規物件登録の小窓と物件の編集の小窓で、入力途中に別のメニューへ移っても、戻ると続きが開き直るようにする(その土台の仕組みも作る)。

**Architecture:** sessionStorage に `pm-draft:v1:<画面>[:<物件ID>]` の鍵で控えを置く小さな保存層(`src/lib/drafts/draft-store.ts`)と、約1秒の間引き+離れる瞬間の即時書き込みを受け持つ純粋な書き手(`draft-writer.ts`)を作り、React からは薄い hook 3つで使う。画面ごとの控えの形は zod で検査する純関数に置く。ログアウト・ログイン成功で全消し。

**Tech Stack:** Next.js App Router(client components)・React 19・zod v4(`zod/v4`)・vitest(node 環境・jsdom なし)

**Spec:** `docs/superpowers/specs/2026-10-13-keep-draft-on-navigate-design.md`(§2 S5・S6、§3、§4、§5.1、§6、§7)。第2段(S1〜S4)は本計画の対象外=第1段マージ後に別計画を書く。

## Global Constraints

- 置き場は **sessionStorage のみ**。localStorage・IndexedDB は使わない。
- 鍵: `pm-draft:v1:<画面名>[:<物件ID>]`。利用者IDは鍵に入れない(ログアウト/ログイン成功時に全消し)。
- 失効 **12時間**(`DRAFT_MAX_AGE_MS = 12 * 60 * 60 * 1000`)。上限 **1,500,000文字**(`DRAFT_MAX_CHARS`)。
- 書き込みは**約1秒の間引き**(`DRAFT_WRITE_DELAY_MS = 1000`)+ unmount と `pagehide` で即時。
- sessionStorage の読み書きはすべて try/catch。使えなければ何もしない(画面は従来どおり動く)。
- 控えの中身をログ・エラー表示・監査に出さない。サーバー側(API・DB・migration)は変えない。
- 文言(そのまま使う):
  - 帯: `前回の続きを表示しています（{H}時{MM}分の入力）` + ボタン `最初からやり直す`
  - 送信途中: `前回、登録の途中で画面を離れました。登録されたかどうかを物件一覧で確かめてください。` + ボタン `確かめたので続ける`
  - 版違い: `ほかの方が保存したため、入力途中の内容は使えませんでした。` + ボタン `閉じる`
  - 大きすぎ(第2段で使う・部品だけ作る): `このファイルは大きいため、別の画面へ移ると消えます。`
- テストは vitest node 環境。UI は `renderToStaticMarkup` と、ソースを読んで CRLF→LF 正規化してから正規表現で確かめる走査型。
- 新規依存なし。commit 末尾:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01LYGLoZ3RCTWGGudbns69rp
  ```

## Review Focus

1. 入力して1秒たたないうちにメニューで移動 → unmount の即時書き込みで控えが残り、戻ると続きが出る(Task 2 のテスト「flush は間引き中の最新を書く」)。
2. sessionStorage が例外を投げる端末(プライベートモード・容量超過) → 画面は壊れず、控えが無いだけ(Task 1「storage が投げても例外にしない」)。
3. 保存・登録・キャンセルの直後に unmount の即時書き込みが走っても、控えが**書き戻されない**(幽霊の再オープンを起こさない)(Task 2「close 後の flush は書かない」)。
4. ほかの人が保存して版が上がった後に戻る → 古い入力をかぶせず、版違いの知らせを1回だけ出す(Task 5「decideEditDraftOnLoad」・Task 6 配線)。
5. 登録ボタンを押して返事が来る前に移動 → 戻ると送信途中の知らせが出て、確かめるまで入力も登録も押せない(Task 2「markSubmitting は即時に書く」・Task 4 配線)。

## File Structure

| ファイル | 役割 |
|---|---|
| Create `src/lib/drafts/draft-store.ts` | 鍵・封筒の形・読み書き・全消し・変更の通知(純関数+薄い保存層) |
| Create `src/lib/drafts/draft-writer.ts` | 間引き・即時書き込み・送信中の印・閉じたら書かない(純粋・タイマーだけ) |
| Create `src/hooks/use-draft.ts` | `useRestoredDraft` / `useDraftAutosave` / `useDraftExists` |
| Create `src/components/drafts/draft-notices.tsx` | 帯4種(見た目だけ)+`formatDraftTime` |
| Create `src/lib/drafts/screens/new-property.ts` | 新規物件登録の控えの形・検査・空判定 |
| Create `src/lib/drafts/screens/property-edit.ts` | 物件の編集の控えの形・検査・差分・合成・読み込み時の判定 |
| Modify `src/lib/notifications/logout.ts` | ログアウトで全消し |
| Modify `src/app/(auth)/login/page.tsx` | ログイン成功で全消し |
| Modify `src/components/properties/new-property-modal.tsx` | 控えの復元・自動保存・帯・送信途中 |
| Modify `src/app/(dashboard)/properties/page.tsx` | 控えがあれば新規登録の小窓を開き直す |
| Modify `src/app/(dashboard)/sales-sheets/new/page.tsx` | 同上(販売図面の新規作成) |
| Modify `src/components/properties/property-edit-form.tsx` | 控えの復元・自動保存・帯 |
| Modify `src/app/(dashboard)/properties/[id]/page.tsx` | 読み込み完了時に編集の小窓を開き直す/版違いの知らせ |
| Tests `src/lib/drafts/__tests__/*.test.ts`・`src/components/drafts/__tests__/*.test.tsx`・`src/components/properties/__tests__/keep-draft-wiring.test.ts` | |

---

### Task 0: 作業場所の準備

- [ ] **Step 1:** worktree `C:\Users\issin\Desktop\Claude\property-management-worktrees\keep-draft`(branch `feat/keep-draft`)で:

```bash
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
npx prisma generate
npx vitest run src/components/properties src/lib/notifications > /tmp/base.txt 2>&1; echo exit=$?
```
Expected: `exit=0`(赤なら既存の問題=手を止めて報告)。

---

### Task 1: 控えの保存層 `draft-store.ts`

**Files:**
- Create: `src/lib/drafts/draft-store.ts`
- Test: `src/lib/drafts/__tests__/draft-store.test.ts`
- Create (テスト用の偽物): `src/lib/drafts/__tests__/memory-storage.ts`

**Interfaces:**
- Produces: `DRAFT_PREFIX`, `DRAFT_MAX_AGE_MS`, `DRAFT_MAX_CHARS`, `DraftScreen`, `StoredDraft<T>`, `WriteResult`, `draftKey(screen, resourceId?)`, `readDraft(key, parseData, now?)`, `hasDraft(key, now?)`, `writeDraft(key, draft)`, `clearDraft(key)`, `clearAllDrafts()`, `subscribeDrafts(listener)`

- [ ] **Step 1: テスト用の偽物を書く**

```ts
// src/lib/drafts/__tests__/memory-storage.ts
/** vitest(node)で sessionStorage の代わりに差す偽物。throwOn を立てると setItem で投げる。 */
export class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  throwOnSet: Error | null = null;
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    if (this.throwOnSet) throw this.throwOnSet;
    this.m.set(k, String(v));
  }
}

export function installMemoryStorage(): MemoryStorage {
  const s = new MemoryStorage();
  Object.defineProperty(globalThis, "sessionStorage", { value: s, configurable: true, writable: true });
  return s;
}

export function uninstallStorage(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).sessionStorage;
}
```

- [ ] **Step 2: 失敗するテストを書く**

```ts
// src/lib/drafts/__tests__/draft-store.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DRAFT_MAX_AGE_MS,
  DRAFT_MAX_CHARS,
  clearAllDrafts,
  clearDraft,
  draftKey,
  hasDraft,
  readDraft,
  subscribeDrafts,
  writeDraft,
} from "../draft-store";
import { installMemoryStorage, uninstallStorage, type MemoryStorage } from "./memory-storage";

const parseName = (d: unknown) =>
  d && typeof d === "object" && typeof (d as { name?: unknown }).name === "string"
    ? (d as { name: string })
    : null;

let s: MemoryStorage;
beforeEach(() => {
  s = installMemoryStorage();
});
afterEach(() => uninstallStorage());

describe("draftKey", () => {
  it("画面名だけ/物件IDつき", () => {
    expect(draftKey("new-property:properties")).toBe("pm-draft:v1:new-property:properties");
    expect(draftKey("property-edit", "abc")).toBe("pm-draft:v1:property-edit:abc");
  });
});

describe("writeDraft / readDraft", () => {
  it("往復で同じ中身が返る", () => {
    const k = draftKey("property-edit", "p1");
    expect(writeDraft(k, { v: 1, savedAt: 1000, data: { name: "A" } })).toBe("ok");
    expect(readDraft(k, parseName, 2000)).toEqual({ v: 1, savedAt: 1000, data: { name: "A" } });
  });
  it("送信中の印も往復する", () => {
    const k = draftKey("property-edit", "p1");
    writeDraft(k, { v: 1, savedAt: 1000, data: { name: "A" }, pendingSubmit: { at: 1500 } });
    expect(readDraft(k, parseName, 2000)?.pendingSubmit).toEqual({ at: 1500 });
  });
  it("12時間を過ぎた控えは無かったことにして消す", () => {
    const k = draftKey("property-edit", "p1");
    writeDraft(k, { v: 1, savedAt: 0, data: { name: "A" } });
    expect(readDraft(k, parseName, DRAFT_MAX_AGE_MS + 1)).toBeNull();
    expect(s.getItem(k)).toBeNull();
  });
  it("12時間ちょうどまでは読める", () => {
    const k = draftKey("property-edit", "p1");
    writeDraft(k, { v: 1, savedAt: 0, data: { name: "A" } });
    expect(readDraft(k, parseName, DRAFT_MAX_AGE_MS)).not.toBeNull();
  });
  it("壊れたJSON・封筒の形違い・中身の形違いは消す", () => {
    const k = draftKey("property-edit", "p1");
    for (const raw of ["{", "null", '{"v":2,"savedAt":1,"data":{"name":"A"}}', '{"v":1,"savedAt":"x","data":{}}', '{"v":1,"savedAt":1,"data":{"name":3}}']) {
      s.setItem(k, raw);
      expect(readDraft(k, parseName, 2)).toBeNull();
      expect(s.getItem(k)).toBeNull();
    }
  });
  it("上限を超える控えは書かずに too_large", () => {
    const k = draftKey("csv-import");
    const big = "x".repeat(DRAFT_MAX_CHARS);
    expect(writeDraft(k, { v: 1, savedAt: 1, data: { name: big } })).toBe("too_large");
    expect(s.getItem(k)).toBeNull();
  });
  it("storage が投げても例外にしない(failed)", () => {
    s.throwOnSet = new Error("QuotaExceededError");
    expect(writeDraft(draftKey("paste"), { v: 1, savedAt: 1, data: { name: "A" } })).toBe("failed");
  });
  it("sessionStorage が無い環境でも例外にしない", () => {
    uninstallStorage();
    const k = draftKey("paste");
    expect(writeDraft(k, { v: 1, savedAt: 1, data: { name: "A" } })).toBe("failed");
    expect(readDraft(k, parseName, 2)).toBeNull();
    expect(hasDraft(k, 2)).toBe(false);
    expect(() => clearDraft(k)).not.toThrow();
    expect(() => clearAllDrafts()).not.toThrow();
  });
});

describe("hasDraft", () => {
  it("封筒が正しく期限内なら true・期限切れや壊れは false", () => {
    const k = draftKey("new-property:properties");
    expect(hasDraft(k, 5)).toBe(false);
    writeDraft(k, { v: 1, savedAt: 1, data: { name: "A" } });
    expect(hasDraft(k, 5)).toBe(true);
    expect(hasDraft(k, DRAFT_MAX_AGE_MS + 2)).toBe(false);
    s.setItem(k, "{");
    expect(hasDraft(k, 5)).toBe(false);
  });
});

describe("clearAllDrafts", () => {
  it("pm-draft: で始まる鍵だけを消す", () => {
    s.setItem("edit-screen-token", "t");
    writeDraft(draftKey("paste"), { v: 1, savedAt: 1, data: { name: "A" } });
    writeDraft(draftKey("property-edit", "p1"), { v: 1, savedAt: 1, data: { name: "B" } });
    clearAllDrafts();
    expect(s.length).toBe(1);
    expect(s.getItem("edit-screen-token")).toBe("t");
  });
});

describe("subscribeDrafts", () => {
  it("書く・消す・全消しで知らせる。解除後は知らせない", () => {
    const fn = vi.fn();
    const off = subscribeDrafts(fn);
    const k = draftKey("paste");
    writeDraft(k, { v: 1, savedAt: 1, data: { name: "A" } });
    clearDraft(k);
    clearAllDrafts();
    expect(fn).toHaveBeenCalledTimes(3);
    off();
    writeDraft(k, { v: 1, savedAt: 1, data: { name: "A" } });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 3: 失敗を確かめる**

Run: `npx vitest run src/lib/drafts/__tests__/draft-store.test.ts`
Expected: FAIL(`Cannot find module '../draft-store'`)

- [ ] **Step 4: 実装する**

```ts
// src/lib/drafts/draft-store.ts
/**
 * 作業中の入力の控え(設計書 docs/superpowers/specs/2026-10-13-keep-draft-on-navigate-design.md §4.1)。
 *
 * - 置き場は sessionStorage だけ(タブを閉じると消える)。localStorage・IndexedDB は使わない。
 * - 鍵に利用者IDは入れない。ログアウト・ログイン成功のたびに全消しするので、タブの控えは
 *   常に今ログインしている人のもの(§4.2)。
 * - 読み書きはすべて try/catch。使えない端末では何もしない(これまでどおり消えるだけ)。
 * - ⚠控えの中身をログ・エラー表示に出さない(所有者の名前・住所が入りうる)。
 */

export const DRAFT_PREFIX = "pm-draft:v1:";
export const DRAFT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const DRAFT_MAX_CHARS = 1_500_000;

export const DRAFT_SCREENS = [
  "new-property:properties",
  "new-property:sales-sheet",
  "property-edit",
  "paste",
  "paste-excel",
  "registry-pdf",
  "csv-import",
] as const;
export type DraftScreen = (typeof DRAFT_SCREENS)[number];

export interface StoredDraft<T> {
  v: 1;
  savedAt: number;
  data: T;
  /** 登録・取り込みを送った時刻。返事を受け取る前に画面を離れると残る(§5.1)。 */
  pendingSubmit?: { at: number };
}

export type WriteResult = "ok" | "too_large" | "failed";

export function draftKey(screen: DraftScreen, resourceId?: string): string {
  return DRAFT_PREFIX + screen + (resourceId ? `:${resourceId}` : "");
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of [...listeners]) fn();
}

/** 控えが書かれた・消えたときに呼ばれる(小窓の自動再オープン用)。戻り値で解除。 */
export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function store(): Storage | null {
  try {
    const s = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

function getRaw(key: string): string | null {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function removeRaw(key: string): void {
  try {
    store()?.removeItem(key);
  } catch {
    /* 使えない端末では何もしない */
  }
}

/** 封筒の形と期限だけを見る(中身の検査は呼び出し側の parseData)。 */
function parseEnvelope(raw: string | null, now: number): StoredDraft<unknown> | null {
  if (raw == null) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.v !== 1 || typeof o.savedAt !== "number" || !Number.isFinite(o.savedAt)) return null;
  if (!("data" in o)) return null;
  if (now - o.savedAt > DRAFT_MAX_AGE_MS) return null;
  let pendingSubmit: { at: number } | undefined;
  if (o.pendingSubmit !== undefined) {
    const p = o.pendingSubmit as { at?: unknown } | null;
    if (!p || typeof p.at !== "number") return null;
    pendingSubmit = { at: p.at };
  }
  return { v: 1, savedAt: o.savedAt, data: o.data, ...(pendingSubmit ? { pendingSubmit } : {}) };
}

/** 控えを読む。壊れ・形違い・期限切れは消して null。 */
export function readDraft<T>(
  key: string,
  parseData: (data: unknown) => T | null,
  now: number = Date.now(),
): StoredDraft<T> | null {
  const raw = getRaw(key);
  if (raw == null) return null;
  const env = parseEnvelope(raw, now);
  const data = env ? parseData(env.data) : null;
  if (!env || data == null) {
    removeRaw(key);
    return null;
  }
  return { ...env, data };
}

/** 控えがあるか(封筒と期限だけ見る・消さない)。 */
export function hasDraft(key: string, now: number = Date.now()): boolean {
  return parseEnvelope(getRaw(key), now) != null;
}

export function writeDraft<T>(key: string, draft: StoredDraft<T>): WriteResult {
  const s = store();
  if (!s) return "failed";
  let text: string;
  try {
    text = JSON.stringify(draft);
  } catch {
    return "failed";
  }
  if (text.length > DRAFT_MAX_CHARS) return "too_large";
  try {
    s.setItem(key, text);
  } catch {
    return "failed";
  }
  notify();
  return "ok";
}

export function clearDraft(key: string): void {
  removeRaw(key);
  notify();
}

/** pm-draft: で始まる鍵をすべて消す(ログアウト・ログイン成功時)。 */
export function clearAllDrafts(): void {
  const s = store();
  if (s) {
    try {
      const keys: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k && k.startsWith(DRAFT_PREFIX)) keys.push(k);
      }
      for (const k of keys) s.removeItem(k);
    } catch {
      /* 使えない端末では何もしない */
    }
  }
  notify();
}
```

- [ ] **Step 5: 通ることを確かめる**

Run: `npx vitest run src/lib/drafts/__tests__/draft-store.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/drafts
git commit -m "feat(drafts): 作業中の入力の控え(sessionStorage)の保存層"
```

---

### Task 2: 書き手 `draft-writer.ts`(間引き・即時・送信中・閉じたら書かない)

**Files:**
- Create: `src/lib/drafts/draft-writer.ts`
- Test: `src/lib/drafts/__tests__/draft-writer.test.ts`

**Interfaces:**
- Consumes: Task 1 の `writeDraft`, `clearDraft`, `WriteResult`
- Produces:
  ```ts
  export const DRAFT_WRITE_DELAY_MS = 1000;
  export interface DraftWriter<T> {
    update(data: T): void;          // 間引いて書く
    flush(): void;                  // 待っている分をすぐ書く(unmount・pagehide)
    discard(): void;                // 控えを消す。作業は続く(以後の update でまた書く)
    close(): void;                  // 控えを消し、以後は一切書かない(完了・キャンセル)
    markSubmitting(): void;         // 送信中の印を付けてすぐ書く
    unmarkSubmitting(): void;       // 印を外してすぐ書く(送信失敗・確かめた)
  }
  export function createDraftWriter<T>(opts: {
    key: string;
    isEmpty: (data: T) => boolean;
    initialPendingAt?: number | null;
    delayMs?: number;
    now?: () => number;
    onResult?: (r: WriteResult) => void;
  }): DraftWriter<T>;
  ```

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/drafts/__tests__/draft-writer.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDraftWriter, DRAFT_WRITE_DELAY_MS } from "../draft-writer";
import { DRAFT_MAX_CHARS, draftKey } from "../draft-store";
import { installMemoryStorage, uninstallStorage, type MemoryStorage } from "./memory-storage";

type D = { name: string };
const isEmpty = (d: D) => d.name === "";
const K = draftKey("new-property:properties");
let s: MemoryStorage;
const stored = () => {
  const raw = s.getItem(K);
  return raw ? JSON.parse(raw) : null;
};

beforeEach(() => {
  vi.useFakeTimers();
  s = installMemoryStorage();
});
afterEach(() => {
  vi.useRealTimers();
  uninstallStorage();
});

describe("createDraftWriter", () => {
  it("update は約1秒待ってから最後の値だけを書く", () => {
    const w = createDraftWriter<D>({ key: K, isEmpty, now: () => 42 });
    w.update({ name: "a" });
    w.update({ name: "ab" });
    expect(stored()).toBeNull();
    vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);
    expect(stored()).toEqual({ v: 1, savedAt: 42, data: { name: "ab" } });
  });
  it("flush は間引き中の最新をすぐ書く(移動の瞬間)", () => {
    const w = createDraftWriter<D>({ key: K, isEmpty });
    w.update({ name: "a" });
    w.flush();
    expect(stored()?.data).toEqual({ name: "a" });
  });
  it("空の値は書かずに控えを消す", () => {
    const w = createDraftWriter<D>({ key: K, isEmpty });
    w.update({ name: "a" });
    w.flush();
    w.update({ name: "" });
    w.flush();
    expect(stored()).toBeNull();
  });
  it("close 後の update・flush は書かない(保存直後の unmount で書き戻さない)", () => {
    const w = createDraftWriter<D>({ key: K, isEmpty });
    w.update({ name: "a" });
    w.close();
    expect(stored()).toBeNull();
    w.update({ name: "b" });
    w.flush();
    vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS * 2);
    expect(stored()).toBeNull();
  });
  it("discard は控えを消すが、その後の update はまた書く", () => {
    const w = createDraftWriter<D>({ key: K, isEmpty });
    w.update({ name: "a" });
    w.flush();
    w.discard();
    expect(stored()).toBeNull();
    w.flush();
    expect(stored()).toBeNull();
    w.update({ name: "c" });
    w.flush();
    expect(stored()?.data).toEqual({ name: "c" });
  });
  it("markSubmitting は印つきで即時に書く・unmarkSubmitting で外れる", () => {
    const w = createDraftWriter<D>({ key: K, isEmpty, now: () => 7 });
    w.update({ name: "a" });
    w.markSubmitting();
    expect(stored()).toEqual({ v: 1, savedAt: 7, data: { name: "a" }, pendingSubmit: { at: 7 } });
    w.unmarkSubmitting();
    expect(stored()).toEqual({ v: 1, savedAt: 7, data: { name: "a" } });
  });
  it("初めから送信中の印を持って始められる(復元した控えの印を保つ)", () => {
    const w = createDraftWriter<D>({ key: K, isEmpty, initialPendingAt: 3, now: () => 9 });
    w.update({ name: "a" });
    w.flush();
    expect(stored()?.pendingSubmit).toEqual({ at: 3 });
  });
  it("大きすぎたら too_large を知らせ、以後は書かない", () => {
    const onResult = vi.fn();
    const w = createDraftWriter<D>({ key: K, isEmpty, onResult });
    w.update({ name: "x".repeat(DRAFT_MAX_CHARS) });
    w.flush();
    expect(onResult).toHaveBeenLastCalledWith("too_large");
    w.update({ name: "small" });
    w.flush();
    expect(stored()).toBeNull();
  });
  it("一度も update していなければ flush は何もしない", () => {
    s.setItem(K, JSON.stringify({ v: 1, savedAt: 1, data: { name: "restored" } }));
    const w = createDraftWriter<D>({ key: K, isEmpty });
    w.flush();
    expect(stored()?.data).toEqual({ name: "restored" });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/drafts/__tests__/draft-writer.test.ts`
Expected: FAIL(`Cannot find module '../draft-writer'`)

- [ ] **Step 3: 実装する**

```ts
// src/lib/drafts/draft-writer.ts
/**
 * 控えの書き手(設計書 §4.1・§5.1)。React に依存しない(タイマーだけ)=単体で試せる。
 * - update は約1秒間引く。flush は待っている分をすぐ書く(メニューで移る=unmount の瞬間)。
 * - close の後は一切書かない(保存・キャンセル直後の unmount で控えを書き戻さないため)。
 */
import { clearDraft, writeDraft, type WriteResult } from "./draft-store";

export const DRAFT_WRITE_DELAY_MS = 1000;

export interface DraftWriter<T> {
  update(data: T): void;
  flush(): void;
  discard(): void;
  close(): void;
  markSubmitting(): void;
  unmarkSubmitting(): void;
}

export function createDraftWriter<T>(opts: {
  key: string;
  isEmpty: (data: T) => boolean;
  initialPendingAt?: number | null;
  delayMs?: number;
  now?: () => number;
  onResult?: (r: WriteResult) => void;
}): DraftWriter<T> {
  const delay = opts.delayMs ?? DRAFT_WRITE_DELAY_MS;
  const now = opts.now ?? Date.now;
  let latest: { data: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let tooLarge = false;
  let pendingAt: number | null = opts.initialPendingAt ?? null;

  const cancelTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const write = () => {
    cancelTimer();
    if (closed || tooLarge || latest == null) return;
    if (pendingAt == null && opts.isEmpty(latest.data)) {
      clearDraft(opts.key);
      return;
    }
    const r = writeDraft(opts.key, {
      v: 1,
      savedAt: now(),
      data: latest.data,
      ...(pendingAt != null ? { pendingSubmit: { at: pendingAt } } : {}),
    });
    if (r === "too_large") {
      tooLarge = true;
      clearDraft(opts.key);
    }
    opts.onResult?.(r);
  };

  return {
    update(data) {
      if (closed) return;
      latest = { data };
      cancelTimer();
      timer = setTimeout(write, delay);
    },
    flush() {
      write();
    },
    discard() {
      cancelTimer();
      latest = null;
      pendingAt = null;
      clearDraft(opts.key);
    },
    close() {
      cancelTimer();
      closed = true;
      latest = null;
      clearDraft(opts.key);
    },
    markSubmitting() {
      if (closed) return;
      pendingAt = now();
      write();
    },
    unmarkSubmitting() {
      if (closed) return;
      pendingAt = null;
      write();
    },
  };
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/lib/drafts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/drafts
git commit -m "feat(drafts): 控えの書き手(間引き・即時・送信中の印・閉じたら書かない)"
```

---

### Task 3: hook と帯の部品

**Files:**
- Create: `src/hooks/use-draft.ts`
- Create: `src/components/drafts/draft-notices.tsx`
- Test: `src/components/drafts/__tests__/draft-notices.test.tsx`
- Test: `src/lib/drafts/__tests__/use-draft-source.test.ts`

**Interfaces:**
- Consumes: Task 1・2
- Produces:
  ```ts
  // src/hooks/use-draft.ts
  export function useRestoredDraft<T>(key: string | null, parse: (d: unknown) => T | null): StoredDraft<T> | null;
  export function useDraftAutosave<T>(key: string | null, data: T, isEmpty: (d: T) => boolean, restored: StoredDraft<T> | null): {
    tooLarge: boolean; discard(): void; close(): void; markSubmitting(): void; unmarkSubmitting(): void;
  };
  export function useDraftExists(key: string | null): boolean;
  // src/components/drafts/draft-notices.tsx
  export function formatDraftTime(ms: number): string; // 例 "10時05分"(日本時間)
  export function DraftRestoredNotice(props: { savedAt: number; onDiscard: () => void }): JSX.Element;
  export function DraftPendingNotice(props: { onConfirm: () => void }): JSX.Element;
  export function DraftStaleNotice(props: { onDismiss: () => void }): JSX.Element;
  export function DraftTooLargeNotice(): JSX.Element;
  ```
- ⚠`useRestoredDraft` は `useState` の初期化で sessionStorage を読む。**サーバー描画の最初の出力に含まれない部品(開いたときだけ描く小窓)でだけ使う**。第2段のページ本体で使うときは別の形にする(第2段の計画で扱う)。

- [ ] **Step 1: 失敗するテストを書く(帯)**

```tsx
// src/components/drafts/__tests__/draft-notices.test.tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DraftPendingNotice,
  DraftRestoredNotice,
  DraftStaleNotice,
  DraftTooLargeNotice,
  formatDraftTime,
} from "../draft-notices";

describe("formatDraftTime", () => {
  it("日本時間の H時MM分", () => {
    expect(formatDraftTime(Date.UTC(2026, 9, 13, 1, 5))).toBe("10時05分");
    expect(formatDraftTime(Date.UTC(2026, 9, 13, 15, 30))).toBe("0時30分");
  });
});

describe("帯", () => {
  it("続きの帯: 時刻と「最初からやり直す」", () => {
    const html = renderToStaticMarkup(<DraftRestoredNotice savedAt={Date.UTC(2026, 9, 13, 1, 5)} onDiscard={() => {}} />);
    expect(html).toContain("前回の続きを表示しています（10時05分の入力）");
    expect(html).toContain("最初からやり直す");
    expect(html).toContain('data-testid="draft-restored-notice"');
  });
  it("送信途中の帯", () => {
    const html = renderToStaticMarkup(<DraftPendingNotice onConfirm={() => {}} />);
    expect(html).toContain("前回、登録の途中で画面を離れました。登録されたかどうかを物件一覧で確かめてください。");
    expect(html).toContain("確かめたので続ける");
  });
  it("版違いの帯", () => {
    const html = renderToStaticMarkup(<DraftStaleNotice onDismiss={() => {}} />);
    expect(html).toContain("ほかの方が保存したため、入力途中の内容は使えませんでした。");
    expect(html).toContain("閉じる");
  });
  it("大きすぎの帯", () => {
    expect(renderToStaticMarkup(<DraftTooLargeNotice />)).toContain("このファイルは大きいため、別の画面へ移ると消えます。");
  });
});
```

- [ ] **Step 2: 失敗するテストを書く(hook の配線)**

```ts
// src/lib/drafts/__tests__/use-draft-source.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(process.cwd(), "src/hooks/use-draft.ts"), "utf8").replace(/\r\n/g, "\n");

describe("use-draft の配線", () => {
  it("離れるとき(unmount)と pagehide で flush する", () => {
    expect(src).toMatch(/addEventListener\("pagehide"/);
    expect(src).toMatch(/return \(\) => \{[\s\S]*?removeEventListener\("pagehide"[\s\S]*?writer\.flush\(\)/);
  });
  it("useDraftExists はサーバー描画では false(useSyncExternalStore の第3引数)", () => {
    expect(src).toMatch(/useSyncExternalStore\(\s*subscribeDrafts,[\s\S]*?,\s*\(\) => false\s*\)/);
  });
  it("localStorage・indexedDB を使わない", () => {
    expect(src).not.toMatch(/localStorage|indexedDB/);
  });
});
```

- [ ] **Step 3: 失敗を確かめる**

Run: `npx vitest run src/components/drafts src/lib/drafts`
Expected: FAIL(モジュールが無い)

- [ ] **Step 4: 実装する(帯)**

```tsx
// src/components/drafts/draft-notices.tsx
/** 作業中の入力の控えに関する帯(設計書 §3・§5)。見た目だけ=SSRで試せる。 */
import { AlertTriangle, History } from "lucide-react";

const fmt = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  hour: "numeric",
  minute: "2-digit",
  hourCycle: "h23",
});

/** 控えた時刻を日本時間の「H時MM分」で。 */
export function formatDraftTime(ms: number): string {
  const parts = fmt.formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${h}時${m.padStart(2, "0")}分`;
}

const BOX = "flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm";
const INFO = `${BOX} border-indigo-200 bg-indigo-50 text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-200`;
const WARN = `${BOX} border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200`;
const BTN =
  "ml-auto rounded-md border border-current px-2 py-0.5 text-xs font-medium hover:bg-white/60 dark:hover:bg-black/20";

export function DraftRestoredNotice({ savedAt, onDiscard }: { savedAt: number; onDiscard: () => void }) {
  return (
    <div role="status" data-testid="draft-restored-notice" className={INFO}>
      <History className="h-4 w-4 shrink-0" />
      <span>前回の続きを表示しています（{formatDraftTime(savedAt)}の入力）</span>
      <button type="button" onClick={onDiscard} className={BTN}>
        最初からやり直す
      </button>
    </div>
  );
}

export function DraftPendingNotice({ onConfirm }: { onConfirm: () => void }) {
  return (
    <div role="alert" data-testid="draft-pending-notice" className={WARN}>
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>前回、登録の途中で画面を離れました。登録されたかどうかを物件一覧で確かめてください。</span>
      <button type="button" onClick={onConfirm} className={BTN}>
        確かめたので続ける
      </button>
    </div>
  );
}

export function DraftStaleNotice({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div role="status" data-testid="draft-stale-notice" className={WARN}>
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>ほかの方が保存したため、入力途中の内容は使えませんでした。</span>
      <button type="button" onClick={onDismiss} className={BTN}>
        閉じる
      </button>
    </div>
  );
}

export function DraftTooLargeNotice() {
  return (
    <div role="status" data-testid="draft-too-large-notice" className={WARN}>
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>このファイルは大きいため、別の画面へ移ると消えます。</span>
    </div>
  );
}
```

- [ ] **Step 5: 実装する(hook)**

```ts
// src/hooks/use-draft.ts
"use client";
/**
 * 作業中の入力の控え(設計書 §4.1)。
 * ⚠useRestoredDraft は useState の初期化で sessionStorage を読む=サーバー描画の最初の出力に
 *   含まれない部品(開いたときだけ描く小窓)でだけ使う。
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { hasDraft, readDraft, subscribeDrafts, type StoredDraft } from "@/lib/drafts/draft-store";
import { createDraftWriter } from "@/lib/drafts/draft-writer";

/** 開いた時点の控えを1回だけ読む(key が null なら控えを使わない)。 */
export function useRestoredDraft<T>(key: string | null, parse: (d: unknown) => T | null): StoredDraft<T> | null {
  const [restored] = useState(() => (key ? readDraft(key, parse) : null));
  return restored;
}

/** 入力が変わるたびに控えを書く(約1秒間引き・離れるときは即時)。 */
export function useDraftAutosave<T>(
  key: string | null,
  data: T,
  isEmpty: (d: T) => boolean,
  restored: StoredDraft<T> | null,
) {
  const [tooLarge, setTooLarge] = useState(false);
  const [writer] = useState(() =>
    key
      ? createDraftWriter<T>({
          key,
          isEmpty,
          initialPendingAt: restored?.pendingSubmit?.at ?? null,
          onResult: (r) => {
            if (r === "too_large") setTooLarge(true);
          },
        })
      : null,
  );

  useEffect(() => {
    writer?.update(data);
  }, [writer, data]);

  useEffect(() => {
    if (!writer) return;
    const onHide = () => writer.flush();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      writer.flush();
    };
  }, [writer]);

  return {
    tooLarge,
    discard: () => writer?.discard(),
    close: () => writer?.close(),
    markSubmitting: () => writer?.markSubmitting(),
    unmarkSubmitting: () => writer?.unmarkSubmitting(),
  };
}

/** 控えがあるか(小窓の自動再オープン用)。サーバー描画では常に false。 */
export function useDraftExists(key: string | null): boolean {
  return useSyncExternalStore(
    subscribeDrafts,
    () => (key ? hasDraft(key) : false),
    () => false,
  );
}
```

- [ ] **Step 6: 通ることを確かめる**

Run: `npx vitest run src/components/drafts src/lib/drafts && npx tsc --noEmit`
Expected: PASS・tsc 0

- [ ] **Step 7: Commit**

```bash
git add src/hooks/use-draft.ts src/components/drafts src/lib/drafts
git commit -m "feat(drafts): 控えの hook と帯の部品"
```

---

### Task 4: ログアウト・ログイン成功で全消し

**Files:**
- Modify: `src/lib/notifications/logout.ts`
- Modify: `src/app/(auth)/login/page.tsx`(成功時の `writeSharedLastActivity(Date.now());` の直後)
- Test: `src/lib/drafts/__tests__/clear-on-auth-source.test.ts`

- [ ] **Step 1: 失敗するテスト**

```ts
// src/lib/drafts/__tests__/clear-on-auth-source.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

describe("ログアウト・ログインで控えを全消しする", () => {
  it("logout.ts: clearNoticeStorage の隣で clearAllDrafts を呼ぶ(signOut より前)", () => {
    const src = read("src/lib/notifications/logout.ts");
    expect(src).toMatch(/import \{ clearAllDrafts \} from "@\/lib\/drafts\/draft-store";/);
    expect(src).toMatch(/clearNoticeStorage\(\);\n\s*clearAllDrafts\(\);[\s\S]*await signOut\(/);
  });
  it("login: 成功したら移動の前に clearAllDrafts を呼ぶ", () => {
    const src = read("src/app/(auth)/login/page.tsx");
    expect(src).toMatch(/import \{ clearAllDrafts \} from "@\/lib\/drafts\/draft-store";/);
    expect(src).toMatch(/writeSharedLastActivity\(Date\.now\(\)\);\n(?:\s*\/\/.*\n)*\s*clearAllDrafts\(\);[\s\S]*router\.push\(safeInternalDest\(cb\)\)/);
  });
});
```

- [ ] **Step 2: 失敗を確かめる** — Run: `npx vitest run src/lib/drafts/__tests__/clear-on-auth-source.test.ts` / Expected: FAIL

- [ ] **Step 3: 実装** — `logout.ts`:

```ts
import { clearAllDrafts } from "@/lib/drafts/draft-store";
// ...
export async function signOutWithNotificationCleanup(callbackUrl = "/login"): Promise<void> {
  clearNoticeStorage();
  clearAllDrafts(); // 作業中の入力の控え(所有者名などが入りうる)も共用PC対策で消す。
```

`login/page.tsx`(import を足し、成功の枝で):

```ts
        writeSharedLastActivity(Date.now());
        // 作業中の入力の控えは、前にこのタブを使っていた人のものかもしれないので消す
        // (ログアウトを通らずにセッションが切れた場合の備え・設計書 §4.2)。
        clearAllDrafts();
```

ファイル冒頭のコメント(logout.ts)の1行目を「ログアウトの前に、その端末の通知と作業中の入力の控えを片付ける」に直す。

- [ ] **Step 4: 通ることを確かめる** — Run: `npx vitest run src/lib/drafts src/components/notifications src/lib/notifications` / Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/notifications/logout.ts "src/app/(auth)/login/page.tsx" src/lib/drafts
git commit -m "feat(drafts): ログアウト・ログイン成功で控えを全消し"
```

---

### Task 5: 画面ごとの控えの形(新規物件登録・物件の編集)

**Files:**
- Create: `src/lib/drafts/screens/new-property.ts`
- Create: `src/lib/drafts/screens/property-edit.ts`
- Test: `src/lib/drafts/__tests__/screens.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // new-property.ts
  export interface NewPropertyDraft { propertyType: string; postalCode: string; address: string; addressEdited: boolean; lotNumber: string; buildingName: string; roomNo: string; introductionRoute: string; note: string; buildingChoice: BuildingChoice }
  export const EMPTY_NEW_PROPERTY_DRAFT: NewPropertyDraft;
  export function parseNewPropertyDraft(d: unknown): NewPropertyDraft | null;
  export function isNewPropertyDraftEmpty(d: NewPropertyDraft): boolean;
  // property-edit.ts
  export interface PropertyEditDraft { propertyId: string; baseVersion: number; changed: Record<string, string>; buildingChoice: BuildingChoice }
  export function parsePropertyEditDraft(d: unknown): PropertyEditDraft | null;
  export function isPropertyEditDraftEmpty(d: PropertyEditDraft): boolean;
  export function changedValues(values: Record<string, string>, property: Record<string, unknown>): Record<string, string>;
  export function mergeDraftIntoInitial(initial: Record<string, string>, draft: PropertyEditDraft | null, propertyId: string, version: number): { values: Record<string, string>; applied: boolean };
  export function decideEditDraftOnLoad(draft: PropertyEditDraft | null, propertyId: string, version: number): "none" | "reopen" | "stale";
  ```

- [ ] **Step 1: 失敗するテスト**

```ts
// src/lib/drafts/__tests__/screens.test.ts
import { describe, it, expect } from "vitest";
import {
  EMPTY_NEW_PROPERTY_DRAFT,
  isNewPropertyDraftEmpty,
  parseNewPropertyDraft,
} from "../screens/new-property";
import {
  changedValues,
  decideEditDraftOnLoad,
  isPropertyEditDraftEmpty,
  mergeDraftIntoInitial,
  parsePropertyEditDraft,
} from "../screens/property-edit";

describe("新規物件登録の控え", () => {
  it("空の控えは空と判定・1文字でも入れば空でない", () => {
    expect(isNewPropertyDraftEmpty(EMPTY_NEW_PROPERTY_DRAFT)).toBe(true);
    expect(isNewPropertyDraftEmpty({ ...EMPTY_NEW_PROPERTY_DRAFT, note: "x" })).toBe(false);
    expect(isNewPropertyDraftEmpty({ ...EMPTY_NEW_PROPERTY_DRAFT, buildingChoice: { kind: "new" } })).toBe(false);
  });
  it("往復して同じ・形違いは null", () => {
    const d = { ...EMPTY_NEW_PROPERTY_DRAFT, propertyType: "apartment_unit", address: "東京都", buildingChoice: { kind: "existing" as const, buildingId: "b1" } };
    expect(parseNewPropertyDraft(JSON.parse(JSON.stringify(d)))).toEqual(d);
    expect(parseNewPropertyDraft({ ...d, address: 1 })).toBeNull();
    expect(parseNewPropertyDraft({ ...d, buildingChoice: { kind: "existing" } })).toBeNull();
    expect(parseNewPropertyDraft(null)).toBeNull();
  });
});

describe("物件の編集の控え", () => {
  const property = { id: "p1", version: 3, address: "東京都A", note: null, floorArea: 12.5 };
  it("changedValues: 開いた時点の値と違う欄だけ(null は空文字として比べる)", () => {
    expect(changedValues({ address: "東京都A", note: "", floorArea: "12.5" }, property)).toEqual({});
    expect(changedValues({ address: "東京都B", note: "メモ", floorArea: "12.5" }, property)).toEqual({ address: "東京都B", note: "メモ" });
  });
  it("空判定", () => {
    expect(isPropertyEditDraftEmpty({ propertyId: "p1", baseVersion: 3, changed: {}, buildingChoice: { kind: "auto" } })).toBe(true);
    expect(isPropertyEditDraftEmpty({ propertyId: "p1", baseVersion: 3, changed: { note: "x" }, buildingChoice: { kind: "auto" } })).toBe(false);
  });
  it("parse: 往復・形違い", () => {
    const d = { propertyId: "p1", baseVersion: 3, changed: { note: "x" }, buildingChoice: { kind: "auto" as const } };
    expect(parsePropertyEditDraft(JSON.parse(JSON.stringify(d)))).toEqual(d);
    expect(parsePropertyEditDraft({ ...d, baseVersion: "3" })).toBeNull();
    expect(parsePropertyEditDraft({ ...d, changed: { note: 1 } })).toBeNull();
  });
  it("mergeDraftIntoInitial: 物件と版が同じなら重ねる・違えば重ねない", () => {
    const initial = { address: "東京都A", note: "" };
    const d = { propertyId: "p1", baseVersion: 3, changed: { note: "x" }, buildingChoice: { kind: "auto" as const } };
    expect(mergeDraftIntoInitial(initial, d, "p1", 3)).toEqual({ values: { address: "東京都A", note: "x" }, applied: true });
    expect(mergeDraftIntoInitial(initial, d, "p1", 4)).toEqual({ values: initial, applied: false });
    expect(mergeDraftIntoInitial(initial, d, "p2", 3)).toEqual({ values: initial, applied: false });
    expect(mergeDraftIntoInitial(initial, null, "p1", 3)).toEqual({ values: initial, applied: false });
  });
  it("decideEditDraftOnLoad: 無し/開き直す/版違い", () => {
    const d = { propertyId: "p1", baseVersion: 3, changed: { note: "x" }, buildingChoice: { kind: "auto" as const } };
    expect(decideEditDraftOnLoad(null, "p1", 3)).toBe("none");
    expect(decideEditDraftOnLoad(d, "p1", 3)).toBe("reopen");
    expect(decideEditDraftOnLoad(d, "p1", 4)).toBe("stale");
    expect(decideEditDraftOnLoad(d, "p2", 3)).toBe("none");
  });
});
```

- [ ] **Step 2: 失敗を確かめる** — Run: `npx vitest run src/lib/drafts/__tests__/screens.test.ts` / Expected: FAIL

- [ ] **Step 3: 実装**

```ts
// src/lib/drafts/screens/building-choice.ts
import { z } from "zod/v4";

/** BuildingChoice(src/lib/building-link/resolve.ts)と同じ形の検査。 */
export const buildingChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("auto") }),
  z.object({ kind: z.literal("existing"), buildingId: z.string().min(1) }),
  z.object({ kind: z.literal("new") }),
]);
```

```ts
// src/lib/drafts/screens/new-property.ts
/** 新規物件登録の小窓の控え(設計書 §2 S6)。 */
import { z } from "zod/v4";
import type { BuildingChoice } from "@/lib/building-link/resolve";
import { buildingChoiceSchema } from "./building-choice";

export interface NewPropertyDraft {
  propertyType: string;
  postalCode: string;
  address: string;
  addressEdited: boolean;
  lotNumber: string;
  buildingName: string;
  roomNo: string;
  introductionRoute: string;
  note: string;
  buildingChoice: BuildingChoice;
}

export const EMPTY_NEW_PROPERTY_DRAFT: NewPropertyDraft = {
  propertyType: "",
  postalCode: "",
  address: "",
  addressEdited: false,
  lotNumber: "",
  buildingName: "",
  roomNo: "",
  introductionRoute: "",
  note: "",
  buildingChoice: { kind: "auto" },
};

const schema = z.object({
  propertyType: z.string(),
  postalCode: z.string(),
  address: z.string(),
  addressEdited: z.boolean(),
  lotNumber: z.string(),
  buildingName: z.string(),
  roomNo: z.string(),
  introductionRoute: z.string(),
  note: z.string(),
  buildingChoice: buildingChoiceSchema,
});

export function parseNewPropertyDraft(d: unknown): NewPropertyDraft | null {
  const r = schema.safeParse(d);
  return r.success ? r.data : null;
}

export function isNewPropertyDraftEmpty(d: NewPropertyDraft): boolean {
  return (
    d.propertyType === "" &&
    d.postalCode === "" &&
    d.address === "" &&
    d.lotNumber === "" &&
    d.buildingName === "" &&
    d.roomNo === "" &&
    d.introductionRoute === "" &&
    d.note === "" &&
    d.buildingChoice.kind === "auto"
  );
}
```

```ts
// src/lib/drafts/screens/property-edit.ts
/**
 * 物件の編集の小窓の控え(設計書 §2 S5・§4.3)。変えた欄だけ+基にした版番号を持つ。
 * ⚠版が違えば重ねない(ほかの人の保存を古い入力で上書きしない)。
 */
import { z } from "zod/v4";
import type { BuildingChoice } from "@/lib/building-link/resolve";
import { buildingChoiceSchema } from "./building-choice";

export interface PropertyEditDraft {
  propertyId: string;
  baseVersion: number;
  changed: Record<string, string>;
  buildingChoice: BuildingChoice;
}

const schema = z.object({
  propertyId: z.string().min(1),
  baseVersion: z.number().int(),
  changed: z.record(z.string(), z.string()),
  buildingChoice: buildingChoiceSchema,
});

export function parsePropertyEditDraft(d: unknown): PropertyEditDraft | null {
  const r = schema.safeParse(d);
  return r.success ? r.data : null;
}

export function isPropertyEditDraftEmpty(d: PropertyEditDraft): boolean {
  return Object.keys(d.changed).length === 0 && d.buildingChoice.kind === "auto";
}

/** 開いた時点の値と違う欄だけ(編集の小窓の hasUnsavedInput と同じ比べ方)。 */
export function changedValues(
  values: Record<string, string>,
  property: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(values)) {
    const raw = property[key];
    if (v !== (raw != null ? String(raw) : "")) out[key] = v;
  }
  return out;
}

export function mergeDraftIntoInitial(
  initial: Record<string, string>,
  draft: PropertyEditDraft | null,
  propertyId: string,
  version: number,
): { values: Record<string, string>; applied: boolean } {
  if (!draft || draft.propertyId !== propertyId || draft.baseVersion !== version) {
    return { values: initial, applied: false };
  }
  return { values: { ...initial, ...draft.changed }, applied: true };
}

export function decideEditDraftOnLoad(
  draft: PropertyEditDraft | null,
  propertyId: string,
  version: number,
): "none" | "reopen" | "stale" {
  if (!draft || draft.propertyId !== propertyId) return "none";
  return draft.baseVersion === version ? "reopen" : "stale";
}
```

- [ ] **Step 4: 通ることを確かめる** — Run: `npx vitest run src/lib/drafts` / Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/drafts
git commit -m "feat(drafts): 新規物件登録・物件の編集の控えの形"
```

---

### Task 6: 新規物件登録の小窓に組み込む+開き直す

**Files:**
- Modify: `src/components/properties/new-property-modal.tsx`
- Modify: `src/app/(dashboard)/properties/page.tsx`(`showNewModal` の描画 ~:1167)
- Modify: `src/app/(dashboard)/sales-sheets/new/page.tsx`(`showRegister` の描画 ~:188)
- Test: `src/components/properties/__tests__/keep-draft-wiring.test.ts`(Task 7 でも追記)

**Interfaces:**
- Consumes: Task 3 の hook・帯、Task 5 の `NewPropertyDraft` 関係、Task 1 の `draftKey`
- Produces: `NewPropertyModal` の新しい任意 prop `draftScreen?: "new-property:properties" | "new-property:sales-sheet"`(未指定=控えを使わない=従来どおり)

- [ ] **Step 1: 失敗するテスト**

```ts
// src/components/properties/__tests__/keep-draft-wiring.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

describe("新規物件登録の小窓: 作業中の入力を消さない", () => {
  const src = read("src/components/properties/new-property-modal.tsx");
  it("控えから初期値を作る(useRestoredDraft)", () => {
    expect(src).toMatch(/useRestoredDraft\(draftKeyValue, parseNewPropertyDraft\)/);
    expect(src).toMatch(/useState\(start\.propertyType\)/);
    expect(src).toMatch(/useState<BuildingChoice>\(start\.buildingChoice\)/);
  });
  it("自動で控える(useDraftAutosave)", () => {
    expect(src).toMatch(/useDraftAutosave\(draftKeyValue, draftData, isNewPropertyDraftEmpty, restored\)/);
  });
  it("送る直前に送信中の印・成功で close・失敗で印を外す", () => {
    expect(src).toMatch(/draft\.markSubmitting\(\);[\s\S]*?await createProperty\(/);
    expect(src).toMatch(/draft\.close\(\);\n\s*resolvePostCreate\(/);
    expect(src).toMatch(/catch \(err\) \{\n\s*draft\.unmarkSubmitting\(\);/);
  });
  it("キャンセル・×は控えを消して閉じる", () => {
    expect(src).toMatch(/const handleCancel = \(\) => \{\n\s*draft\.close\(\);\n\s*onClose\(\);/);
    expect((src.match(/onClick=\{handleCancel\}/g) ?? []).length).toBe(2);
    expect(src).not.toMatch(/onClick=\{onClose\}/);
  });
  it("帯: 続き・送信途中", () => {
    expect(src).toMatch(/<DraftRestoredNotice/);
    expect(src).toMatch(/<DraftPendingNotice/);
    expect(src).toMatch(/<fieldset disabled=\{pendingBlocked\}/);
  });
});

describe("新規物件登録の小窓を開き直す", () => {
  it("物件一覧: 控えがあれば開く", () => {
    const src = read("src/app/(dashboard)/properties/page.tsx");
    expect(src).toMatch(/useDraftExists\(draftKey\("new-property:properties"\)\)/);
    expect(src).toMatch(/\(showNewModal \|\| newPropertyDraftExists\) && \(\n\s*<NewPropertyModal draftScreen="new-property:properties"/);
  });
  it("販売図面の新規作成: 控えがあれば開く", () => {
    const src = read("src/app/(dashboard)/sales-sheets/new/page.tsx");
    expect(src).toMatch(/useDraftExists\(draftKey\("new-property:sales-sheet"\)\)/);
    expect(src).toMatch(/\(showRegister \|\| registerDraftExists\) && \(\n\s*<NewPropertyModal\n\s*draftScreen="new-property:sales-sheet"/);
  });
});
```

- [ ] **Step 2: 失敗を確かめる** — Run: `npx vitest run src/components/properties/__tests__/keep-draft-wiring.test.ts` / Expected: FAIL

- [ ] **Step 3: 小窓を直す** — `new-property-modal.tsx`:

import に足す:

```ts
import { useMemo, useState } from "react";
import { draftKey } from "@/lib/drafts/draft-store";
import {
  EMPTY_NEW_PROPERTY_DRAFT,
  isNewPropertyDraftEmpty,
  parseNewPropertyDraft,
  type NewPropertyDraft,
} from "@/lib/drafts/screens/new-property";
import { useDraftAutosave, useRestoredDraft } from "@/hooks/use-draft";
import { DraftPendingNotice, DraftRestoredNotice } from "@/components/drafts/draft-notices";
```

(既存の `import { useState } from "react";` は上の行に置き換える。`import { AUTO_CHOICE, type BuildingChoice }` の `AUTO_CHOICE` が使われなくなったら外す。)

Props に足す:

```ts
  /**
   * 作業中の入力の控えの置き場(設計書 2026-10-13 §2 S6)。開いた画面ごとに分ける。
   * 未指定なら控えを使わない(従来どおり)。
   */
  draftScreen?: "new-property:properties" | "new-property:sales-sheet";
```

関数の頭(`const router = useRouter();` の直後)で、state の初期値を控えから作る:

```ts
export default function NewPropertyModal({ onClose, typeFilter, onCreated, draftScreen }: Props) {
  const router = useRouter();

  // 作業中の入力の控え。別のメニューへ移って戻っても続きから(設計書 2026-10-13)。
  const draftKeyValue = draftScreen ? draftKey(draftScreen) : null;
  const restored = useRestoredDraft(draftKeyValue, parseNewPropertyDraft);
  const start: NewPropertyDraft = restored?.data ?? EMPTY_NEW_PROPERTY_DRAFT;

  const [propertyType, setPropertyType] = useState(start.propertyType);
  const [postalCode, setPostalCode] = useState(start.postalCode);
  const [address, setAddress] = useState(start.address);
  const [addressEdited, setAddressEdited] = useState(start.addressEdited);
  const [lotNumber, setLotNumber] = useState(start.lotNumber);
  const [buildingName, setBuildingName] = useState(start.buildingName);
  const [buildingChoice, setBuildingChoice] = useState<BuildingChoice>(start.buildingChoice);
  const [roomNo, setRoomNo] = useState(start.roomNo);
  const [introductionRoute, setIntroductionRoute] = useState(start.introductionRoute);
  const [note, setNote] = useState(start.note);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 前回、登録の返事が来る前に離れた=登録されたか分からない。確かめるまで入力も登録も止める(§5.1)。
  const [pendingBlocked, setPendingBlocked] = useState(restored?.pendingSubmit != null);
  const [restoredDismissed, setRestoredDismissed] = useState(false);

  const draftData = useMemo<NewPropertyDraft>(
    () => ({ propertyType, postalCode, address, addressEdited, lotNumber, buildingName, roomNo, introductionRoute, note, buildingChoice }),
    [propertyType, postalCode, address, addressEdited, lotNumber, buildingName, roomNo, introductionRoute, note, buildingChoice],
  );
  const draft = useDraftAutosave(draftKeyValue, draftData, isNewPropertyDraftEmpty, restored);

  const handleCancel = () => {
    draft.close();
    onClose();
  };

  /** 「最初からやり直す」: 控えを消して空に戻す(小窓は開いたまま)。 */
  const handleDiscardDraft = () => {
    draft.discard();
    const e = EMPTY_NEW_PROPERTY_DRAFT;
    setPropertyType(e.propertyType);
    setPostalCode(e.postalCode);
    setAddress(e.address);
    setAddressEdited(e.addressEdited);
    setLotNumber(e.lotNumber);
    setBuildingName(e.buildingName);
    setBuildingChoice(e.buildingChoice);
    setRoomNo(e.roomNo);
    setIntroductionRoute(e.introductionRoute);
    setNote(e.note);
    setRestoredDismissed(true);
  };
```

(既存の各 `useState("")` / `useState(false)` / `useState<BuildingChoice>(AUTO_CHOICE)` の行と、そのすぐ上の説明コメントは残しつつ、初期値だけ `start.*` に替える。上は並びの例。)

`handleSubmit` の送信部分:

```ts
    setSubmitting(true);
    draft.markSubmitting();
    try {
      const result = await createProperty({
        // ...(既存のまま)
      });
      if (!onCreated) stashBuildingLinkNotice(result.id, result.buildingLink);
      draft.close();
      resolvePostCreate(onCreated, router)(result.id, propertyType, { buildingLink: result.buildingLink ?? null });
    } catch (err) {
      draft.unmarkSubmitting();
      setError(err instanceof Error ? err.message : "登録に失敗しました");
      setSubmitting(false);
    }
```

見出しの × ボタンと「キャンセル」ボタンの `onClick={onClose}` を `onClick={handleCancel}` に替える(2か所)。

`<form ...>` の直後(既存の `{error && (` の前)に帯を置き、入力欄〜ボタンを `fieldset` で包む:

```tsx
        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-5">
          {pendingBlocked ? (
            <DraftPendingNotice
              onConfirm={() => {
                draft.unmarkSubmitting();
                setPendingBlocked(false);
              }}
            />
          ) : (
            restored &&
            !restoredDismissed && <DraftRestoredNotice savedAt={restored.savedAt} onDiscard={handleDiscardDraft} />
          )}
          <fieldset disabled={pendingBlocked} className="contents">
            {/* ↓既存の {error && ...} から「Buttons」の div までをそのままここへ */}
          </fieldset>
        </form>
```

⚠ `fieldset` の中の「キャンセル」も止まるが、見出しの × は外なので閉じられる(×=控えを消して閉じる)。

- [ ] **Step 4: 開き直しの配線** — `properties/page.tsx`:

```ts
import { useDraftExists } from "@/hooks/use-draft";
import { draftKey } from "@/lib/drafts/draft-store";
// コンポーネント内、const [showNewModal, setShowNewModal] = useState(false); の直後:
  // 新規登録の途中で別のメニューへ移って戻ったら、小窓を開き直す(設計書 2026-10-13 §3-3)。
  const newPropertyDraftExists = useDraftExists(draftKey("new-property:properties"));
```

描画(~:1167):

```tsx
      {(showNewModal || newPropertyDraftExists) && (
        <NewPropertyModal draftScreen="new-property:properties" onClose={() => setShowNewModal(false)} />
      )}
```

`sales-sheets/new/page.tsx`(同じ import、`showRegister` の useState の直後に `const registerDraftExists = useDraftExists(draftKey("new-property:sales-sheet"));`):

```tsx
      {(showRegister || registerDraftExists) && (
        <NewPropertyModal
          draftScreen="new-property:sales-sheet"
          onClose={() => setShowRegister(false)}
          typeFilter={[...SALES_SHEET_REGISTRABLE_PROPERTY_TYPES]}
          onCreated={handleCreated}
        />
      )}
```

- [ ] **Step 5: 通ることを確かめる**

Run: `npx vitest run src/components/properties "src/app/(dashboard)/properties" "src/app/(dashboard)/sales-sheets" && npx tsc --noEmit && npx eslint src/components/properties/new-property-modal.tsx "src/app/(dashboard)/properties/page.tsx" "src/app/(dashboard)/sales-sheets/new/page.tsx" src/hooks/use-draft.ts src/lib/drafts src/components/drafts`
Expected: PASS・tsc 0・eslint 0(既存テストが `<NewPropertyModal onClose=...` の並びを正規表現で見ていて落ちたら、新しい並びに合わせて直す)

- [ ] **Step 6: Commit**

```bash
git add -A src
git commit -m "feat(drafts): 新規物件登録の小窓で作業中の入力を消さない"
```

---

### Task 7: 物件の編集の小窓に組み込む+読み込み時に開き直す

**Files:**
- Modify: `src/components/properties/property-edit-form.tsx`(state ~:412-424、`[property]` の effect ~:465-488、保存成功 ~:626、`handleClose` ~:653、本体の先頭)
- Modify: `src/app/(dashboard)/properties/[id]/page.tsx`(`fetchProperty` の成功枝 ~:433-441、state 宣言 ~:344、描画)
- Test: `src/components/properties/__tests__/keep-draft-wiring.test.ts`(追記)

**Interfaces:**
- Consumes: Task 3・5(`parsePropertyEditDraft`, `isPropertyEditDraftEmpty`, `changedValues`, `mergeDraftIntoInitial`, `decideEditDraftOnLoad`)、Task 1(`draftKey`, `readDraft`, `clearDraft`)

- [ ] **Step 1: 失敗するテスト(追記)**

```ts
describe("物件の編集の小窓: 作業中の入力を消さない", () => {
  const src = read("src/components/properties/property-edit-form.tsx");
  it("開いた時点の控えを読み、[property] の初期化のあとに重ねる", () => {
    expect(src).toMatch(/useRestoredDraft\(editDraftKey, parsePropertyEditDraft\)/);
    expect(src).toMatch(/const merged = mergeDraftIntoInitial\(\s*initial,\s*draftDiscarded \? null : restored\?\.data \?\? null,\s*property\.id,\s*property\.version,?\s*\);\n\s*setValues\(merged\.values\);/);
    expect(src).toMatch(/\}, \[property, restored, draftDiscarded\]\);/);
  });
  it("変えた欄だけを控える(版つき)", () => {
    expect(src).toMatch(/changed: changedValues\(values, property as unknown as Record<string, unknown>\)/);
    expect(src).toMatch(/baseVersion: property\.version/);
    expect(src).toMatch(/useDraftAutosave\(editDraftKey, editDraftData, isPropertyEditDraftEmpty, restored\)/);
  });
  it("保存できたら控えを消してから onSaved", () => {
    expect(src).toMatch(/editDraft\.close\(\);\n\s*void lock\.release\(\);\n\s*onSaved\(/);
  });
  it("閉じる・キャンセルで控えを消す", () => {
    expect(src).toMatch(/const handleClose = \(\) => \{\n\s*editDraft\.close\(\);\n\s*void lock\.release\(\);\n\s*onClose\(\);/);
  });
  it("帯", () => {
    expect(src).toMatch(/<DraftRestoredNotice/);
  });
});

describe("物件詳細: 読み込み完了時に編集の小窓を開き直す", () => {
  const src = read("src/app/(dashboard)/properties/[id]/page.tsx");
  it("物件ごとに最初の読み込みで1回だけ判定する", () => {
    expect(src).toMatch(/if \(applied && editDraftCheckedRef\.current !== id\) \{/);
    expect(src).toMatch(/decideEditDraftOnLoad\(/);
    expect(src).toMatch(/if \(decision === "reopen"\) setShowEditForm\(true\);/);
    expect(src).toMatch(/clearDraft\(editKey\);\n\s*setEditDraftStale\(true\);/);
  });
  it("版違いの帯を出す", () => {
    expect(src).toMatch(/\{editDraftStale && <DraftStaleNotice onDismiss=\{\(\) => setEditDraftStale\(false\)\} \/>\}/);
  });
});
```

- [ ] **Step 2: 失敗を確かめる** — Run: `npx vitest run src/components/properties/__tests__/keep-draft-wiring.test.ts` / Expected: FAIL(新しい describe が落ちる)

- [ ] **Step 3: 編集の小窓を直す** — `property-edit-form.tsx`:

import に足す(`useState, useEffect` に `useMemo` を足す):

```ts
import { useState, useEffect, useMemo } from "react";
import { draftKey } from "@/lib/drafts/draft-store";
import {
  changedValues,
  isPropertyEditDraftEmpty,
  mergeDraftIntoInitial,
  parsePropertyEditDraft,
  type PropertyEditDraft,
} from "@/lib/drafts/screens/property-edit";
import { useDraftAutosave, useRestoredDraft } from "@/hooks/use-draft";
import { DraftRestoredNotice } from "@/components/drafts/draft-notices";
```

`const [values, setValues] = ...` の直前:

```ts
  // 作業中の入力の控え(設計書 2026-10-13 §2 S5)。変えた欄だけ+基にした版番号。
  // ⚠版が違えば重ねない(mergeDraftIntoInitial)=ほかの人の保存を古い入力で上書きしない。
  const editDraftKey = draftKey("property-edit", property.id);
  const restored = useRestoredDraft(editDraftKey, parsePropertyEditDraft);
  const [draftDiscarded, setDraftDiscarded] = useState(false);
```

`buildingChoice` の初期値:

```ts
  const [buildingChoice, setBuildingChoice] = useState<BuildingChoice>(() =>
    restored && restored.data.propertyId === property.id && restored.data.baseVersion === property.version
      ? restored.data.buildingChoice
      : AUTO_CHOICE,
  );
```

`[property]` の effect の `setValues(initial);` を次に替え、依存を `[property, restored, draftDiscarded]` にする:

```ts
    // 控えがあれば、開いた時点の値の上に重ねる(版が同じときだけ)。
    const merged = mergeDraftIntoInitial(
      initial,
      draftDiscarded ? null : restored?.data ?? null,
      property.id,
      property.version,
    );
    setValues(merged.values);
```

(`setClearableKeys` は `initial` のまま=「開いた時点の値で決める」既存の約束を守る。)

`isMansion` の行の後あたりに、控えの組み立てと自動保存:

```ts
  const editDraftData = useMemo<PropertyEditDraft>(
    () => ({
      propertyId: property.id,
      baseVersion: property.version,
      changed: changedValues(values, property as unknown as Record<string, unknown>),
      buildingChoice,
    }),
    [property, values, buildingChoice],
  );
  const editDraft = useDraftAutosave(editDraftKey, editDraftData, isPropertyEditDraftEmpty, restored);
  const showRestoredNotice =
    !draftDiscarded &&
    restored != null &&
    restored.data.propertyId === property.id &&
    restored.data.baseVersion === property.version;

  /** 「最初からやり直す」: 控えを消して開いた時点の値に戻す(小窓は開いたまま)。 */
  const handleDiscardDraft = () => {
    editDraft.discard();
    setBuildingChoice(AUTO_CHOICE);
    setDraftDiscarded(true);
  };
```

保存成功の枝:

```ts
      editDraft.close();
      void lock.release();
      onSaved({ buildingLink: saved?.buildingLink ?? null });
```

`handleClose`(コメントも直す):

```ts
  /** 閉じる・キャンセルの共通後始末。作業中の入力の控えを消し、鍵を返す。 */
  const handleClose = () => {
    editDraft.close();
    void lock.release();
    onClose();
  };
```

帯は、小窓の本体の先頭(既存の `EditLockBanner` を描いている所のすぐ下)に:

```tsx
          {showRestoredNotice && restored && (
            <DraftRestoredNotice savedAt={restored.savedAt} onDiscard={handleDiscardDraft} />
          )}
```

⚠`handleClose` が鍵を奪われたときなど**利用者の操作以外**から呼ばれていないか `grep -n "handleClose" src/components/properties/property-edit-form.tsx` で確かめる。利用者の「閉じる/キャンセル/×」以外から呼ばれていたら、その経路では `editDraft.close()` を呼ばない別の関数(`releaseAndClose`)に分ける(入力を消さないため)。

- [ ] **Step 4: 物件詳細を直す** — `properties/[id]/page.tsx`:

import:

```ts
import { clearDraft, draftKey, readDraft } from "@/lib/drafts/draft-store";
import { decideEditDraftOnLoad, parsePropertyEditDraft } from "@/lib/drafts/screens/property-edit";
import { DraftStaleNotice } from "@/components/drafts/draft-notices";
```

state(`const [showEditForm, setShowEditForm] = useState(false);` の直後。`useRef` が import 済みか確かめる):

```ts
  // 編集の途中で別のメニューへ移って戻ったら、編集の小窓を開き直す(設計書 2026-10-13 §3-3)。
  // ⚠物件ごとに最初の読み込みで1回だけ判定する(編集中の取り直しで控えを消さない)。
  const editDraftCheckedRef = useRef<string | null>(null);
  const [editDraftStale, setEditDraftStale] = useState(false);
```

`fetchProperty` の成功枝、既存の `if (applied) { const stashed = ... }` の直後:

```ts
      if (applied && editDraftCheckedRef.current !== id) {
        editDraftCheckedRef.current = id;
        const editKey = draftKey("property-edit", id);
        const decision = decideEditDraftOnLoad(
          readDraft(editKey, parsePropertyEditDraft)?.data ?? null,
          id,
          (data as unknown as ApiProperty).version,
        );
        if (decision === "reopen") setShowEditForm(true);
        else if (decision === "stale") {
          clearDraft(editKey);
          setEditDraftStale(true);
        }
      }
```

(`ApiProperty` に `version` が無ければ、`fetchPropertyDetail` の戻り値の型から版番号を取る形に合わせる。)

描画: 既存の `{buildingNotice && (` の帯の直前に:

```tsx
      {editDraftStale && <DraftStaleNotice onDismiss={() => setEditDraftStale(false)} />}
```

- [ ] **Step 5: 通ることを確かめる**

Run: `npx vitest run src/components/properties "src/app/(dashboard)/properties" src/lib/drafts && npx tsc --noEmit && npx eslint src/components/properties/property-edit-form.tsx "src/app/(dashboard)/properties/[id]/page.tsx"`
Expected: PASS・tsc 0・eslint 0

- [ ] **Step 6: Commit**

```bash
git add -A src
git commit -m "feat(drafts): 物件の編集の小窓で作業中の入力を消さない(版違いは使わない)"
```

---

### Task 8: 全ゲート・提出前レビュー・PR

- [ ] **Step 1: 全ゲート**(どれか1つでも赤なら直してから次へ)

```bash
npx tsc --noEmit > /tmp/tsc.txt 2>&1; echo tsc=$?
npx vitest run > /tmp/vitest.txt 2>&1; echo vitest=$?; tail -5 /tmp/vitest.txt
npx eslint src/lib/drafts src/hooks/use-draft.ts src/components/drafts src/components/properties/new-property-modal.tsx src/components/properties/property-edit-form.tsx "src/app/(dashboard)/properties/page.tsx" "src/app/(dashboard)/properties/[id]/page.tsx" "src/app/(dashboard)/sales-sheets/new/page.tsx" "src/app/(auth)/login/page.tsx" src/lib/notifications/logout.ts; echo eslint=$?
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build > /tmp/build.txt 2>&1; echo build=$?
```
Expected: すべて 0。

- [ ] **Step 2: 提出前レビュー** — `git add -A` の差分を `feature-dev:code-reviewer`(sonnet)に見せる。観点: PII(控えの中身をログ/エラーに出していない・sessionStorage 以外を使っていない)/close 後の書き戻し/StrictMode の二重 effect で控えが消えないか/版違いで古い入力をかぶせないか/送信途中の扱い/既存の編集の鍵(edit-lock)を素通りしていないか/デスクトップ・スマホの表示崩れ。

- [ ] **Step 3: PR** — `gh pr create --title "feat(drafts): 作業中の入力を、別のメニューへ移っても消さない(第1段)" --body-file <本文>`。本文は平易な日本語で、何ができるようになったか/守り(タブの中だけ・ログアウトとログインで消す・12時間)/テスト/第2段の予定。末尾:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01LYGLoZ3RCTWGGudbns69rp
```

- [ ] **Step 4:** `gh pr comment <PR> --body "@codex review"` → codex-triage スキルに従って監視・対応。マージは発注者。
