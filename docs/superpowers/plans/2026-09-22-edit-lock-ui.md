# 編集中の鍵 第2段(画面) 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 物件・所有者の編集を始めた人が鍵を取り、他の人には「○○さんが編集中です」を見せて編集を止める画面側を作る(第1段で本番稼働している5つの窓口に画面を繋ぐ)。

**Architecture:** 難しい判断(応答→表示状態の写像・合図の間隔・失効の扱い)は**純関数の状態機械**に出し、React の hook は結線だけを持つ(既存の `src/hooks/use-address-lookup.ts` と同じ作り)。画面は「鍵を持つ側」(`useEditLock`)と「見ている側」(`useEditLockStatus`)の2本の hook に分け、6つの保存入口には共通のヘッダ関数を通す。

**Tech Stack:** Next.js 16 App Router / React 19 / TypeScript / vitest(**node 環境のみ・jsdom は使わない**) / `renderToStaticMarkup`(react-dom/server) / Tailwind(既存クラスのみ)

**Spec:** `docs/superpowers/specs/2026-09-17-edit-lock-design.md`(6章=画面。2.2/4章=窓口の契約。第1段で**本番稼働済**)

## Global Constraints

- **第1段のサーバ側は変更しない**。窓口5本・SQL・保存の確認は本番で動いている。画面側だけを足す(やむを得ず窓口を変える必要が出たら、実装を止めて報告する)。
- 定数は `src/lib/edit-lock/rules.ts` から読む: `EDIT_LOCK_HEARTBEAT_INTERVAL_MS`(30秒) / `EDIT_LOCK_HEARTBEAT_GRACE_MS`(5分) / `EDIT_LOCK_IDLE_LIMIT_MS`(60分) / `EDIT_LOCK_IDLE_WARN_MS`(55分) / `EDIT_LOCK_STATUS_POLL_MS`(30秒)。**値を画面側に書き写さない**。
- ⚠**client 部品から `src/lib/edit-lock/screen-token.ts` を import しない**(`@/lib/api-helpers` 経由で auth と prisma を引き込む=client bundle が壊れる)。ヘッダ名は Task 1 で作る素のモジュールから取る。
- ⚠**無操作の時間をクライアントの時計で数え直さない**。55分の予告は合図の応答 `idleSince`(DBの時計)を起点にする(仕様 2.2-3)。
- ⚠**管理者に外された画面は自動で取り直さない**(仕様 6.2)。ただし墓標は5分で期限切れになるので、その後は合図が `lost: expired` に変わり自動の取り直しが働く。
- 保存の拒否(423)は**エラー封筒** `{ error: { message, code } }` から読む。取得(acquire)の423は**裸** `{ code, state, holderName, since }`(仕様 4.7)。`apiErrorCode(e)` が封筒側のコードを取り出す。
- 新しい色・形を作らない。帯は既存の amber クラス(`src/app/(dashboard)/properties/[id]/page.tsx:1414` と同じ組み)、確認は `src/components/ui/confirm-dialog.tsx` を使う。スマホ幅で1〜2行に収める。
- テストは mock ベース(CIに実DBは無い)。**同一性の検査(`toBe`)を `expect.anything()` より優先**、順序は記録した配列で固定、走査テストはラチェットとして「守るものを外したら落ちる」ことを実演してから完了とする。
- 🔴**テストの作り方はこのrepoの方針に従う(2026-09-22 実測で確定・計画の初版は誤っていた)**:
  - **`jsdom` と `@testing-library/react` は使わない**。vitest の環境は `node` 固定で、既存の `.test.tsx` 43本のうち**39本が `renderToStaticMarkup`(react-dom/server)** で見た目を固定している(`@testing-library/react` は0本・`@vitest-environment jsdom` も0本・`renderHook` も0本)。方針は `src/app/(dashboard)/admin/attachments/__tests__/name-cell.test.tsx` の冒頭に明文で書かれている。
  - **DOM・タイマー・イベントに触る部分は「差し替えられる形」に切り出して node で検査する**(例: 合言葉なら storage と channel を引数で受ける)。
  - **部品の見た目・文言は `renderToStaticMarkup` の文字列で固定する**。クリック等の操作は、部品から切り出した**ハンドラ関数**を直接呼んで検査する(DOMイベントを起こさない)。
  - **hook そのものは検査しない**。判断は純関数か controller に出し、そちらを総当たりで固定する(`src/hooks/use-address-lookup.ts` が既にこの形=判断は `createAddressLookupController` 側にあり、hook は結線だけ)。
  - 配線(どの画面がどの関数を呼ぶか)は**走査テストのラチェット**と、計画末尾の**ローカル実機確認**で担保する。
- 日本語のコミットメッセージ。`--amend` 禁止。commit の末尾に:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` と
  `Claude-Session: https://claude.ai/code/session_01LXJhM1iYknUdWRffjNpMFU`

## 第1段の窓口の実物(画面が前提にしてよい契約)

| 窓口 | 送るもの | 返るもの |
|---|---|---|
| `POST /api/edit-locks/acquire` | `{resourceType, resourceId}` + ヘッダ `X-Edit-Screen` | 200 `{state:"mine", lockId, since}` / **423裸** `{code:"EDIT_LOCKED", state:"held_by_other"|"held_by_self_other_screen", holderName, since}` / 400封筒 `EDIT_SCREEN_REQUIRED` / 404封筒 / 403封筒 |
| `POST /api/edit-locks/heartbeat` | `{resourceType, resourceId, active}` + ヘッダ | 200 `{state:"mine", idleSince}` / 200 `{state:"lost", reason:"force_released"|"expired"}` / 200 `{state:"taken", holderName, since}` / **404封筒**(資源が消えた) |
| `POST /api/edit-locks/release` | `{resourceType, resourceId, lockId, screenToken?}` | 常に 200 `{ok:true}`(beacon 用。`screenToken` は本文に生値で入れてよい=ヘッダを付けられない beacon のため) |
| `POST /api/edit-locks/force-release` | `{resourceType, resourceId, lockId}` | 200 / 409封筒 `EDIT_LOCK_CHANGED` / 403封筒(管理者以外) |
| `POST /api/edit-locks/status` | `{resources:[{resourceType, resourceId}]}` + ヘッダ | 200 `{locks:[{resourceType, resourceId, state:"mine"|"held_by_self_other_screen"|"held_by_other"|"free", since?, holderName?, lockId?(管理者のみ)}]}` |

保存側(第1段で稼働中)が返す拒否コード: `423 EDIT_LOCKED` / `423 EDIT_LOCK_FORCE_RELEASED` / `423 EDIT_LOCK_STALE` / `400 EDIT_LOCK_ID_INVALID`(すべて封筒)。

## ファイル構成

**新規**
- `src/lib/edit-lock/header-names.ts` — ヘッダ名だけの素のモジュール(server/client 両方が import する)
- `src/lib/edit-lock/screen-token-client.ts` — 合言葉の採番・保存・**タブ複製の検知**(client専用)
- `src/lib/edit-lock/ui-state.ts` — 窓口の応答 → 帯/ボタンの状態への**純関数**の写像
- `src/hooks/use-edit-lock.ts` — 鍵を持つ側の hook(React結線のみ)
- `src/hooks/use-edit-lock-status.ts` — 見ている側の hook(30秒ポーリング)
- `src/components/edit-lock/edit-lock-banner.tsx` — 帯(文言6種)+管理者の「鍵を外す」
- 各テスト: `src/lib/edit-lock/__tests__/screen-token-client.test.ts` / `ui-state.test.ts` / `src/hooks/__tests__/use-edit-lock.test.ts` / `use-edit-lock-status.test.ts` / `src/components/edit-lock/__tests__/edit-lock-banner.test.tsx` / `src/lib/edit-lock/__tests__/save-entrypoints-scan.test.ts`

**変更(6つの保存入口)**
- `src/components/properties/property-edit-form.tsx:414` — 編集ウィンドウ(鍵を持つ)
- `src/app/(dashboard)/properties/[id]/page.tsx:1141` `OwnerCard` — 所有者カード(鍵を持つ)
- `src/app/(dashboard)/properties/[id]/page.tsx:1891` `CaseStatusField` / `:1972` `IntroductionRouteField` — 鍵を持たない
- `src/components/properties/registry-chiban-popup.tsx:105` — 鍵を持たない
- `src/components/owners/corporate-lookup-panel.tsx` — 法人番号の反映(物件詳細と `admin/owners/[id]` の2画面に置かれている)
- `src/lib/api-client.ts` — 5窓口の関数と、`updateOwner`/`corporate-apply` にヘッダを渡す口

---

### Task 1: ヘッダ名の素モジュールと、合言葉(タブ複製の検知つき)

**Files:**
- Create: `src/lib/edit-lock/header-names.ts`
- Create: `src/lib/edit-lock/screen-token-client.ts`
- Modify: `src/lib/edit-lock/screen-token.ts`(定数を header-names から再輸出に変える。**関数と挙動は変えない**)
- Test: `src/lib/edit-lock/__tests__/screen-token-client.test.ts`

**Interfaces:**
- Produces: `EDIT_SCREEN_HEADER` / `EDIT_LOCK_HEADER`(header-names)、`getScreenToken(): string`・`ensureUniqueScreenToken(): Promise<string>`・`resetScreenTokenForTest(): void`(screen-token-client)

**🔴テストの作り方(確定・下のテストコードはこの形に読み替える)**: `jsdom` は使わない(Global Constraints)。`screen-token-client.ts` は **差し替えられる環境**を受け取る形にする:

```ts
/** 差し替え可能な環境。既定はブラウザの実物。 */
export interface ScreenTokenEnv {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** 無い環境(BroadcastChannel 非対応)では null を返す。 */
  openChannel(name: string): {
    postMessage(data: unknown): void;
    onMessage(handler: (data: unknown) => void): void;
    close(): void;
  } | null;
  newId(): string;
}
export function setScreenTokenEnvForTest(env: ScreenTokenEnv | null): void;
```

ブラウザ既定の実装は `sessionStorage` と `BroadcastChannel` を try/catch で包んで上の形に合わせる(例外は「使えない」として扱う)。テストは **node 環境**で、記憶を Map で持つ偽の storage と、`postMessage` を相手に配る偽の channel を注入して、下のテストの**検査内容をそのまま**確かめる(`sessionStorage.getItem(...)` の代わりに偽 storage の中身を見る)。時間は `vi.useFakeTimers()` で進める。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/edit-lock/__tests__/screen-token-client.test.ts
// ⚠この1行目(`@vitest-environment jsdom`)は**書かない**。上の「テストの作り方(確定)」の
//   とおり、偽の storage / channel を注入して node で検査する。検査内容は下のまま。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getScreenToken, ensureUniqueScreenToken, resetScreenTokenForTest } from "../screen-token-client";

describe("画面の合言葉(client)", () => {
  beforeEach(() => {
    resetScreenTokenForTest();
    try { sessionStorage.clear(); } catch { /* 使えない環境は無視 */ }
  });

  it("初回は採番して sessionStorage に保存し、2回目は同じ値を返す", () => {
    const a = getScreenToken();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(sessionStorage.getItem("edit-screen-token")).toBe(a);
    expect(getScreenToken()).toBe(a);
  });

  it("sessionStorage が使えなくてもその画面の間は同じ値を返す(例外にしない)", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const a = getScreenToken();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(getScreenToken()).toBe(a);
    spy.mockRestore();
  });

  it("同じ合言葉を名乗る生きたタブが居たら、複製と判断して作り直す", async () => {
    sessionStorage.setItem("edit-screen-token", "11111111-1111-4111-8111-111111111111");
    // 生きたタブの代役: 問い合わせに同じ合言葉で即答する BroadcastChannel
    const other = new BroadcastChannel("edit-screen");
    other.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type: string; token: string };
      if (msg.type === "who-has") other.postMessage({ type: "i-have", token: msg.token });
    };
    const token = await ensureUniqueScreenToken();
    other.close();
    expect(token).not.toBe("11111111-1111-4111-8111-111111111111");
    expect(sessionStorage.getItem("edit-screen-token")).toBe(token);
  });

  it("返事が無ければ同じ合言葉を使い続ける(同タブの再読み込み=D6)", async () => {
    sessionStorage.setItem("edit-screen-token", "22222222-2222-4222-8222-222222222222");
    const token = await ensureUniqueScreenToken();
    expect(token).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("BroadcastChannel が無い環境でも例外にせず、そのまま使う", async () => {
    sessionStorage.setItem("edit-screen-token", "33333333-3333-4333-8333-333333333333");
    const saved = globalThis.BroadcastChannel;
    // @ts-expect-error 環境の再現
    delete globalThis.BroadcastChannel;
    const token = await ensureUniqueScreenToken();
    globalThis.BroadcastChannel = saved;
    expect(token).toBe("33333333-3333-4333-8333-333333333333");
  });
});
```

- [ ] **Step 2: 落ちることを確認**

Run: `npx vitest run src/lib/edit-lock/__tests__/screen-token-client.test.ts`
Expected: FAIL(`Cannot find module '../screen-token-client'`)

- [ ] **Step 3: 実装する**

```ts
// src/lib/edit-lock/header-names.ts
/**
 * 編集中の鍵のヘッダ名だけを置く**素のモジュール**。
 *
 * ⚠ここに依存を足さない。`screen-token.ts`(server)は `@/lib/api-helpers` を
 *   経由して auth と prisma を引くため、client 部品から import できない。
 *   ヘッダ名は両側で必要なので、名前だけをこのファイルに分ける。
 */
/** ブラウザのタブごとの合言葉を送るヘッダ名。 */
export const EDIT_SCREEN_HEADER = "X-Edit-Screen";
/** 鍵の世代(取得の応答の lockId)を送るヘッダ名。鍵を持つ画面の保存だけが付ける。 */
export const EDIT_LOCK_HEADER = "X-Edit-Lock";
```

```ts
// src/lib/edit-lock/screen-token-client.ts
"use client";

/**
 * 画面の合言葉(仕様 6.1)。**タブ1枚 = 合言葉1つ**。
 *
 * - `sessionStorage["edit-screen-token"]` に置く。読み書きは try/catch(プライベート
 *   モード等で例外になる)。使えない場合はこのページの間だけメモリに持つ
 *   (再読み込みで別の画面扱い=自分の鍵に最大5分締め出される。まれなので許容)。
 * - ⚠**タブの複製で合言葉まで複製される**(@codex R1 P2)。「タブを複製」や
 *   `target=_blank` は元のタブの sessionStorage を写して始まるため、読むだけだと
 *   2枚が同じ保持者になり D6(自分の別タブも待つ)が破れる。開いたときに
 *   `BroadcastChannel("edit-screen")` で「この合言葉を使っているタブは居ますか」と
 *   問い合わせ、**300ms以内に同じ合言葉を名乗る返事があれば作り直す**。
 *   再読み込みは元のタブが消えてから読み込むので返事は来ない=同じ合言葉を保つ。
 */
import { EDIT_SCREEN_HEADER } from "./header-names";

const KEY = "edit-screen-token";
const CHANNEL = "edit-screen";
/** 複製の問い合わせの待ち時間(仕様 6.1)。 */
export const SCREEN_TOKEN_PROBE_MS = 300;

let memoryToken: string | null = null;

function newToken(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // 古い環境向けの退避。uuid の形は保つ(窓口が uuid を要求するのは lockId だけだが揃える)。
    const h = () => Math.floor(Math.random() * 16).toString(16);
    return `${Array.from({ length: 8 }, h).join("")}-${Array.from({ length: 4 }, h).join("")}-4${Array.from({ length: 3 }, h).join("")}-8${Array.from({ length: 3 }, h).join("")}-${Array.from({ length: 12 }, h).join("")}`;
  }
}

function read(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function write(token: string): void {
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    /* 使えない環境ではメモリのみ */
  }
}

/** 今の合言葉を返す(無ければ採番して保存する)。同期。 */
export function getScreenToken(): string {
  const stored = read();
  if (stored) {
    memoryToken = stored;
    return stored;
  }
  if (memoryToken) return memoryToken;
  const token = newToken();
  memoryToken = token;
  write(token);
  return token;
}

/**
 * 複製のタブでないことを確かめた合言葉を返す。**編集を押せるようにする前に1回呼ぶ**。
 * `BroadcastChannel` が無い環境では問い合わせを省略する(複製の判別はできない=
 * まれなので許容し、版番号の守りに任せる)。
 */
export async function ensureUniqueScreenToken(): Promise<string> {
  const token = getScreenToken();
  const Ctor = globalThis.BroadcastChannel;
  if (typeof Ctor !== "function") return token;

  const channel = new Ctor(CHANNEL);
  const duplicated = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), SCREEN_TOKEN_PROBE_MS);
    channel.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type?: string; token?: string } | null;
      if (msg?.type === "i-have" && msg.token === token) {
        clearTimeout(timer);
        resolve(true);
      }
    };
    channel.postMessage({ type: "who-has", token });
  });
  channel.close();

  if (!duplicated) return token;
  const fresh = newToken();
  memoryToken = fresh;
  write(fresh);
  return fresh;
}

/** 他のタブからの問い合わせに答え続ける。hook の mount 中だけ張る。 */
export function answerScreenTokenProbes(): () => void {
  const Ctor = globalThis.BroadcastChannel;
  if (typeof Ctor !== "function") return () => {};
  const channel = new Ctor(CHANNEL);
  channel.onmessage = (e: MessageEvent) => {
    const msg = e.data as { type?: string; token?: string } | null;
    if (msg?.type === "who-has" && msg.token === getScreenToken()) {
      channel.postMessage({ type: "i-have", token: msg.token });
    }
  };
  return () => channel.close();
}

/** テスト用。モジュールが抱えているメモリ上の合言葉を捨てる。 */
export function resetScreenTokenForTest(): void {
  memoryToken = null;
}

/** 保存の入口が付けるヘッダ。⚠**6つの入口すべてがこれを通す**(走査テストで固定)。 */
export function editLockHeaders(lockId?: string | null): Record<string, string> {
  const headers: Record<string, string> = { [EDIT_SCREEN_HEADER]: getScreenToken() };
  if (lockId) headers[EDIT_LOCK_HEADER] = lockId;
  return headers;
}
```

`src/lib/edit-lock/screen-token.ts` の定数定義2行を、`header-names.ts` からの再輸出に置き換える(**値と輸出名は変えない**ので server 側の呼び出し元は無変更):

```ts
// src/lib/edit-lock/screen-token.ts の冒頭付近
// ⚠ヘッダ名は client からも使うため素のモジュールに分けた(Task 1)。ここは再輸出だけ。
export { EDIT_SCREEN_HEADER, EDIT_LOCK_HEADER } from "./header-names";
```

- [ ] **Step 4: 通ることを確認**

Run: `npx vitest run src/lib/edit-lock/__tests__/screen-token-client.test.ts src/lib/edit-lock/__tests__/screen-token.test.ts`
Expected: PASS(既存の `screen-token.test.ts` も無変更で緑=server 側の契約を壊していない)

- [ ] **Step 5: client bundle を汚していないことを確認**

Run: `npx tsc --noEmit` と `npx eslint src/lib/edit-lock/header-names.ts src/lib/edit-lock/screen-token-client.ts src/lib/edit-lock/screen-token.ts`
そのうえで **`header-names.ts` と `screen-token-client.ts` が `@/lib/api-helpers`・`@/lib/prisma`・`@/lib/auth` を import していないこと**を目で確認する(Task 7 の走査テストで機械的にも固定する)。

- [ ] **Step 6: commit**

```bash
git add src/lib/edit-lock/header-names.ts src/lib/edit-lock/screen-token-client.ts src/lib/edit-lock/screen-token.ts src/lib/edit-lock/__tests__/screen-token-client.test.ts
git commit -m "feat(edit-lock): 画面の合言葉(タブ複製の検知つき)とヘッダ名の素モジュール"
```

---

### Task 2: 応答 → 表示状態の純関数(状態機械)

**Files:**
- Create: `src/lib/edit-lock/ui-state.ts`
- Test: `src/lib/edit-lock/__tests__/ui-state.test.ts`

**Interfaces:**
- Consumes: `EDIT_LOCK_IDLE_WARN_MS`(`./rules`)
- Produces: 型 `EditLockUiState`・`AcquireResponse`・`HeartbeatResponse`、関数 `uiStateFromAcquire`・`uiStateFromHeartbeat`・`uiStateFromSaveError`・`shouldReacquireOnInput`・`shouldWarnIdle`

**なぜ純関数に出すか:** 帯の文言・保存ボタンの可否・自動取り直しの可否は「どの応答が来たか」だけで決まる。React の中に書くと組み合わせを試せない(この repo で8巡連続で指摘された型=[[concurrent-order-exhaustive-test]])。写像を純関数にして**全組み合わせを総当たり**で固定する。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/edit-lock/__tests__/ui-state.test.ts
import { describe, it, expect } from "vitest";
import {
  uiStateFromAcquire,
  uiStateFromHeartbeat,
  uiStateFromSaveError,
  shouldReacquireOnInput,
  shouldWarnIdle,
  type EditLockUiState,
} from "../ui-state";
import { EDIT_LOCK_IDLE_WARN_MS } from "../rules";

const ALL: EditLockUiState["kind"][] = ["idle", "mine", "expired", "force_released", "taken", "deleted"];

describe("鍵の表示状態(純関数)", () => {
  it("取得できたら mine(保存できる・帯なし)", () => {
    const s = uiStateFromAcquire({ state: "mine", lockId: "l1", since: "2026-09-22T01:00:00.000Z" });
    expect(s).toEqual({ kind: "mine", lockId: "l1", since: "2026-09-22T01:00:00.000Z" });
    expect(s.kind).toBe("mine");
  });

  it("他の人が持っていたら taken(氏名と開始時刻を持つ)", () => {
    const s = uiStateFromAcquire({
      code: "EDIT_LOCKED", state: "held_by_other", holderName: "佐藤", since: "2026-09-22T01:00:00.000Z",
    });
    expect(s).toMatchObject({ kind: "taken", holderName: "佐藤" });
  });

  it("自分の別画面が持っていても taken として扱う(D6)", () => {
    const s = uiStateFromAcquire({
      code: "EDIT_LOCKED", state: "held_by_self_other_screen", holderName: "自分", since: "2026-09-22T01:00:00.000Z",
    });
    expect(s.kind).toBe("taken");
  });

  it("合図の lost は理由で分かれる", () => {
    expect(uiStateFromHeartbeat({ state: "lost", reason: "expired" }, "l1").kind).toBe("expired");
    expect(uiStateFromHeartbeat({ state: "lost", reason: "force_released" }, "l1").kind).toBe("force_released");
  });

  it("合図の taken は氏名を引き継ぐ", () => {
    expect(
      uiStateFromHeartbeat({ state: "taken", holderName: "山田", since: "2026-09-22T01:00:00.000Z" }, "l1"),
    ).toMatchObject({ kind: "taken", holderName: "山田" });
  });

  it("合図が mine なら lockId を保ったまま idleSince を更新する", () => {
    const s = uiStateFromHeartbeat({ state: "mine", idleSince: "2026-09-22T02:00:00.000Z" }, "l1");
    expect(s).toEqual({ kind: "mine", lockId: "l1", idleSince: "2026-09-22T02:00:00.000Z" });
  });

  it("保存の 423/400 は封筒のコードで分かれる", () => {
    expect(uiStateFromSaveError("EDIT_LOCK_STALE", null).kind).toBe("expired");
    expect(uiStateFromSaveError("EDIT_LOCK_FORCE_RELEASED", null).kind).toBe("force_released");
    expect(uiStateFromSaveError("EDIT_LOCKED", "山田").kind).toBe("taken");
    // 鍵と無関係なエラーは状態を変えない(null=呼び出し側が今の状態を保つ)
    expect(uiStateFromSaveError("CONFLICT", null)).toBeNull();
    expect(uiStateFromSaveError(null, null)).toBeNull();
  });

  it("資源が消えた(合図の404)は deleted・自動の取り直しをしない", () => {
    const s = uiStateFromHeartbeat({ notFound: true }, "l1");
    expect(s.kind).toBe("deleted");
    expect(shouldReacquireOnInput(s)).toBe(false);
  });

  it("自動の取り直しは expired のときだけ(全状態を総当たり)", () => {
    const expected: Record<EditLockUiState["kind"], boolean> = {
      idle: false, mine: false, expired: true, force_released: false, taken: false, deleted: false,
    };
    for (const kind of ALL) {
      expect(shouldReacquireOnInput({ kind } as EditLockUiState)).toBe(expected[kind]);
    }
  });

  it("55分の予告は idleSince(DBの時計)だけで決まる", () => {
    const now = new Date("2026-09-22T03:00:00.000Z").getTime();
    const warnAt = new Date(now - EDIT_LOCK_IDLE_WARN_MS).toISOString();
    const justBefore = new Date(now - EDIT_LOCK_IDLE_WARN_MS + 1000).toISOString();
    expect(shouldWarnIdle({ kind: "mine", lockId: "l1", idleSince: warnAt }, now)).toBe(true);
    expect(shouldWarnIdle({ kind: "mine", lockId: "l1", idleSince: justBefore }, now)).toBe(false);
    // mine 以外では出さない
    expect(shouldWarnIdle({ kind: "taken", holderName: "山田" } as EditLockUiState, now)).toBe(false);
    // idleSince をまだ受け取っていない間は出さない(クライアントの時計で数えない)
    expect(shouldWarnIdle({ kind: "mine", lockId: "l1" } as EditLockUiState, now)).toBe(false);
  });
});
```

- [ ] **Step 2: 落ちることを確認**

Run: `npx vitest run src/lib/edit-lock/__tests__/ui-state.test.ts`
Expected: FAIL(`Cannot find module '../ui-state'`)

- [ ] **Step 3: 実装する**

```ts
// src/lib/edit-lock/ui-state.ts
/**
 * 窓口の応答 → 画面(帯・保存ボタン)の状態への写像。**純関数だけ**。
 *
 * React の中に散らすと組み合わせを試せないので、判断はすべてここに集める
 * (hook は結線のみ)。仕様 6.2 の分岐がそのまま1つの型になっている。
 */
import { EDIT_LOCK_IDLE_WARN_MS } from "./rules";

/** 取得の応答(200=裸の mine / 423=裸の held)。 */
export type AcquireResponse =
  | { state: "mine"; lockId: string; since: string }
  | {
      code: "EDIT_LOCKED";
      state: "held_by_other" | "held_by_self_other_screen";
      holderName: string;
      since: string;
    };

/** 合図の応答。`notFound` は 404(資源が消えた)を呼び出し側が畳んだ形。 */
export type HeartbeatResponse =
  | { state: "mine"; idleSince: string }
  | { state: "lost"; reason: "expired" | "force_released" }
  | { state: "taken"; holderName: string; since: string }
  | { notFound: true };

export type EditLockUiState =
  /** まだ取得していない(閲覧中)。 */
  | { kind: "idle" }
  /** 自分が鍵を持っている。保存できる。 */
  | { kind: "mine"; lockId: string; since?: string; idleSince?: string }
  /** 期限切れ・世代違い。入力したら自動で取り直す。入力は消さない。 */
  | { kind: "expired" }
  /** 管理者が外した。保存できない。**自動の取り直しはしない**。 */
  | { kind: "force_released" }
  /** 他の人(または自分の別画面)が持っている。保存できない。 */
  | { kind: "taken"; holderName: string; since?: string }
  /** 資源そのものが消えた。保存できない・再試行もしない。 */
  | { kind: "deleted" };

export function uiStateFromAcquire(res: AcquireResponse): EditLockUiState {
  if (res.state === "mine") return { kind: "mine", lockId: res.lockId, since: res.since };
  // held_by_other / held_by_self_other_screen はどちらも「他の画面が持っている」=待つ(D6)。
  return { kind: "taken", holderName: res.holderName, since: res.since };
}

export function uiStateFromHeartbeat(res: HeartbeatResponse, lockId: string): EditLockUiState {
  if ("notFound" in res) return { kind: "deleted" };
  if (res.state === "mine") return { kind: "mine", lockId, idleSince: res.idleSince };
  if (res.state === "taken") return { kind: "taken", holderName: res.holderName, since: res.since };
  return res.reason === "force_released" ? { kind: "force_released" } : { kind: "expired" };
}

/**
 * 保存が断られたときの写像。**封筒のコード**で分かれる(仕様 4.7)。
 * 鍵と無関係なコードでは `null` を返し、呼び出し側は今の状態を保つ。
 */
export function uiStateFromSaveError(code: string | null, holderName: string | null): EditLockUiState | null {
  switch (code) {
    case "EDIT_LOCK_STALE":
      // 世代が合わない=鍵は既に外れている。意味は期限切れと同じ(仕様 6.2)。
      return { kind: "expired" };
    case "EDIT_LOCK_FORCE_RELEASED":
      return { kind: "force_released" };
    case "EDIT_LOCKED":
      return { kind: "taken", holderName: holderName ?? "他の利用者" };
    default:
      return null;
  }
}

/** 入力したときに自動で取り直してよいか。⚠管理者が外した場合と資源が消えた場合はしない。 */
export function shouldReacquireOnInput(state: EditLockUiState): boolean {
  return state.kind === "expired";
}

/** 55分の予告を出すか。**DBの時計が起点**(`idleSince`)。 */
export function shouldWarnIdle(state: EditLockUiState, nowMs: number): boolean {
  if (state.kind !== "mine" || !state.idleSince) return false;
  return nowMs - new Date(state.idleSince).getTime() >= EDIT_LOCK_IDLE_WARN_MS;
}
```

- [ ] **Step 4: 通ることを確認**

Run: `npx vitest run src/lib/edit-lock/__tests__/ui-state.test.ts`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add src/lib/edit-lock/ui-state.ts src/lib/edit-lock/__tests__/ui-state.test.ts
git commit -m "feat(edit-lock): 応答から帯・保存可否を決める純関数を足す"
```

---

### Task 3: 窓口を叩く関数(api-client)と `useEditLock`

**Files:**
- Modify: `src/lib/api-client.ts`(末尾に「編集中の鍵」節を足す。既存の関数は触らない)
- Create: `src/hooks/use-edit-lock.ts`
- Test: `src/hooks/__tests__/use-edit-lock.test.ts`

**Interfaces:**
- Consumes: `editLockHeaders`・`getScreenToken`・`answerScreenTokenProbes`(Task 1)、`ui-state` の全関数(Task 2)、`EDIT_LOCK_HEARTBEAT_INTERVAL_MS`(`rules`)
- Produces: api-client の `acquireEditLockApi`・`heartbeatEditLockApi`・`releaseEditLockApi`・`forceReleaseEditLockApi`・`fetchEditLockStatus`、**`createEditLockController(deps)`**(`src/lib/edit-lock/controller.ts`)、hook の `useEditLock({resourceType, resourceId, enabled})` → `{ state, acquire, release, noteActivity, noteSaveError, canSave, warnIdle, lockId }`

**🔴テストの作り方(確定・下の `renderHook` のテストはこの形に読み替える)**: `@testing-library/react` と `renderHook` は使わない(Global Constraints・repo全体で0件)。判断とタイマーは **`src/lib/edit-lock/controller.ts` の `createEditLockController`** に置き、**node でそれを検査する**(`use-address-lookup` が `createAddressLookupController` で既にこの形)。

```ts
export interface EditLockControllerDeps {
  acquire(): Promise<AcquireResponse>;
  heartbeat(active: boolean): Promise<HeartbeatResponse>;
  release(lockId: string): Promise<void>;
  releaseByBeacon(lockId: string): void;
  /** 状態が変わったら呼ばれる(hook は setState を渡す)。 */
  onState(state: EditLockUiState, warnIdle: boolean): void;
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}
export function createEditLockController(deps: EditLockControllerDeps): {
  acquire(): Promise<void>;
  release(): Promise<void>;
  noteActivity(): void;
  noteSaveError(code: string | null, holderName?: string | null): void;
  onHidden(): void;   // pagehide 相当
  onVisible(): void;  // visibilitychange 相当
  dispose(): void;
};
```

下に書いた**8件の検査内容はそのまま**(取得→30秒ごとの合図/active の立ち下がり/管理者解除で取り直さない/期限切れは入力で1回取り直す/資源が消えたら合図を止める/release で止まる/pagehide は beacon/裏から戻ったら即1回)。`vi.useFakeTimers()` の代わりに **`deps.setInterval` に記録用の偽物を渡して手で発火**させ、`deps.now()` も固定値を返す。hook 本体(`src/hooks/use-edit-lock.ts`)は controller を React に繋ぐだけで、**テストは書かない**。

- [ ] **Step 1: api-client に窓口の関数を足す**

```ts
// src/lib/api-client.ts の末尾に追記
// ---------- 編集中の鍵(第1段の窓口5本・仕様 4章) ----------
import { editLockHeaders, getScreenToken } from "./edit-lock/screen-token-client";
import type { AcquireResponse, HeartbeatResponse } from "./edit-lock/ui-state";

/** 取得。423(他の人が持っている)は**エラーにせず**裸の応答をそのまま返す。 */
export async function acquireEditLockApi(
  resourceType: "property" | "owner",
  resourceId: string,
): Promise<AcquireResponse> {
  const res = await fetch("/api/edit-locks/acquire", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...editLockHeaders() },
    body: JSON.stringify({ resourceType, resourceId }),
  });
  if (res.status === 423) return (await res.json()) as AcquireResponse;
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as AcquireResponse;
}

/** 合図。404(資源が消えた)は `{notFound:true}` に畳んで返す(仕様 6.2・N5)。 */
export async function heartbeatEditLockApi(
  resourceType: "property" | "owner",
  resourceId: string,
  active: boolean,
): Promise<HeartbeatResponse> {
  const res = await fetch("/api/edit-locks/heartbeat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...editLockHeaders() },
    body: JSON.stringify({ resourceType, resourceId, active }),
  });
  if (res.status === 404) return { notFound: true };
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as HeartbeatResponse;
}

/** 解除。常に 200 が返る契約なので、失敗しても画面は進める。 */
export async function releaseEditLockApi(
  resourceType: "property" | "owner",
  resourceId: string,
  lockId: string,
): Promise<void> {
  await fetch("/api/edit-locks/release", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...editLockHeaders() },
    body: JSON.stringify({ resourceType, resourceId, lockId }),
  }).catch(() => {});
}

/** 管理者の強制解除。409 `EDIT_LOCK_CHANGED` は封筒のエラーとして投げる。 */
export async function forceReleaseEditLockApi(
  resourceType: "property" | "owner",
  resourceId: string,
  lockId: string,
): Promise<void> {
  await apiFetch<{ ok: true }>("/api/edit-locks/force-release", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...editLockHeaders() },
    body: JSON.stringify({ resourceType, resourceId, lockId }),
  });
}

export interface EditLockStatusRow {
  resourceType: "property" | "owner";
  resourceId: string;
  state: "mine" | "held_by_self_other_screen" | "held_by_other" | "free";
  since?: string;
  holderName?: string;
  /** 管理者にだけ返る(強制解除に要る)。 */
  lockId?: string;
}

/** 状態の一覧。⚠窓口は1回50件まで(仕様 4.5)なので呼び出し側で分割する。 */
export async function fetchEditLockStatus(
  resources: { resourceType: "property" | "owner"; resourceId: string }[],
): Promise<EditLockStatusRow[]> {
  if (resources.length === 0) return [];
  const { locks } = await apiFetch<{ locks: EditLockStatusRow[] }>("/api/edit-locks/status", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...editLockHeaders() },
    body: JSON.stringify({ resources }),
  });
  return locks;
}

/** 画面を閉じるときの解除(beacon)。⚠ヘッダを付けられないので合言葉は本文に入れる(窓口が対応済)。 */
export function releaseEditLockByBeacon(
  resourceType: "property" | "owner",
  resourceId: string,
  lockId: string,
): void {
  try {
    const body = JSON.stringify({ resourceType, resourceId, lockId, screenToken: getScreenToken() });
    navigator.sendBeacon("/api/edit-locks/release", new Blob([body], { type: "text/plain" }));
  } catch {
    /* 閉じる処理は最善努力。失敗しても5分で期限切れになる */
  }
}
```

- [ ] **Step 2: 失敗する hook のテストを書く**

```ts
// src/hooks/__tests__/use-edit-lock.test.ts
// ⚠この形(jsdom + renderHook)では**書かない**。上の「テストの作り方(確定)」のとおり
//   `createEditLockController` を node で検査する。**8件の検査内容は下のまま**読み替える。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// import { renderHook, act, waitFor } from "@testing-library/react"; ← 使わない
import { useEditLock } from "../use-edit-lock";
import * as api from "@/lib/api-client";
import { EDIT_LOCK_HEARTBEAT_INTERVAL_MS } from "@/lib/edit-lock/rules";

vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof api>()),
  acquireEditLockApi: vi.fn(),
  heartbeatEditLockApi: vi.fn(),
  releaseEditLockApi: vi.fn(),
  releaseEditLockByBeacon: vi.fn(),
}));

const PROP = "0f48857e-b714-4d56-b98b-e3b90e1496ea";
const mineRes = { state: "mine" as const, lockId: "11111111-1111-4111-8111-111111111111", since: "2026-09-22T01:00:00.000Z" };

describe("useEditLock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("acquire で鍵を取り、30秒ごとに合図を送る(間隔は定数から)", async () => {
    vi.mocked(api.acquireEditLockApi).mockResolvedValue(mineRes);
    vi.mocked(api.heartbeatEditLockApi).mockResolvedValue({ state: "mine", idleSince: "2026-09-22T01:00:10.000Z" });
    const { result } = renderHook(() => useEditLock({ resourceType: "property", resourceId: PROP }));

    await act(async () => { await result.current.acquire(); });
    expect(result.current.state.kind).toBe("mine");
    expect(result.current.canSave).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(EDIT_LOCK_HEARTBEAT_INTERVAL_MS + 10); });
    expect(api.heartbeatEditLockApi).toHaveBeenCalledTimes(1);
    // active は「前回の合図からの操作の有無」
    expect(vi.mocked(api.heartbeatEditLockApi).mock.calls[0][2]).toBe(false);
  });

  it("操作があった回の合図は active=true、その次は false に戻る", async () => {
    vi.mocked(api.acquireEditLockApi).mockResolvedValue(mineRes);
    vi.mocked(api.heartbeatEditLockApi).mockResolvedValue({ state: "mine", idleSince: "2026-09-22T01:00:10.000Z" });
    const { result } = renderHook(() => useEditLock({ resourceType: "property", resourceId: PROP }));
    await act(async () => { await result.current.acquire(); });

    act(() => { result.current.noteActivity(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(EDIT_LOCK_HEARTBEAT_INTERVAL_MS + 10); });
    await act(async () => { await vi.advanceTimersByTimeAsync(EDIT_LOCK_HEARTBEAT_INTERVAL_MS + 10); });
    const calls = vi.mocked(api.heartbeatEditLockApi).mock.calls;
    expect(calls[0][2]).toBe(true);
    expect(calls[1][2]).toBe(false);
  });

  it("管理者に外されたら保存できなくなり、入力しても取り直さない", async () => {
    vi.mocked(api.acquireEditLockApi).mockResolvedValue(mineRes);
    vi.mocked(api.heartbeatEditLockApi).mockResolvedValue({ state: "lost", reason: "force_released" });
    const { result } = renderHook(() => useEditLock({ resourceType: "property", resourceId: PROP }));
    await act(async () => { await result.current.acquire(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(EDIT_LOCK_HEARTBEAT_INTERVAL_MS + 10); });

    expect(result.current.state.kind).toBe("force_released");
    expect(result.current.canSave).toBe(false);
    vi.mocked(api.acquireEditLockApi).mockClear();
    act(() => { result.current.noteActivity(); });
    expect(api.acquireEditLockApi).not.toHaveBeenCalled();
  });

  it("期限切れなら、入力した時に1回だけ取り直す", async () => {
    vi.mocked(api.acquireEditLockApi).mockResolvedValue(mineRes);
    vi.mocked(api.heartbeatEditLockApi).mockResolvedValue({ state: "lost", reason: "expired" });
    const { result } = renderHook(() => useEditLock({ resourceType: "property", resourceId: PROP }));
    await act(async () => { await result.current.acquire(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(EDIT_LOCK_HEARTBEAT_INTERVAL_MS + 10); });
    expect(result.current.state.kind).toBe("expired");

    vi.mocked(api.acquireEditLockApi).mockClear();
    await act(async () => { result.current.noteActivity(); await vi.advanceTimersByTimeAsync(0); });
    expect(api.acquireEditLockApi).toHaveBeenCalledTimes(1);
  });

  it("資源が消えたら合図を止める(無限ループにしない)", async () => {
    vi.mocked(api.acquireEditLockApi).mockResolvedValue(mineRes);
    vi.mocked(api.heartbeatEditLockApi).mockResolvedValue({ notFound: true });
    const { result } = renderHook(() => useEditLock({ resourceType: "property", resourceId: PROP }));
    await act(async () => { await result.current.acquire(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(EDIT_LOCK_HEARTBEAT_INTERVAL_MS + 10); });
    expect(result.current.state.kind).toBe("deleted");

    vi.mocked(api.heartbeatEditLockApi).mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(EDIT_LOCK_HEARTBEAT_INTERVAL_MS * 3); });
    expect(api.heartbeatEditLockApi).not.toHaveBeenCalled();
  });

  it("release で鍵を返し、合図も止まる", async () => {
    vi.mocked(api.acquireEditLockApi).mockResolvedValue(mineRes);
    vi.mocked(api.heartbeatEditLockApi).mockResolvedValue({ state: "mine", idleSince: "x" });
    const { result } = renderHook(() => useEditLock({ resourceType: "property", resourceId: PROP }));
    await act(async () => { await result.current.acquire(); });
    await act(async () => { await result.current.release(); });

    expect(api.releaseEditLockApi).toHaveBeenCalledWith("property", PROP, mineRes.lockId);
    vi.mocked(api.heartbeatEditLockApi).mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(EDIT_LOCK_HEARTBEAT_INTERVAL_MS * 2); });
    expect(api.heartbeatEditLockApi).not.toHaveBeenCalled();
  });

  it("画面が閉じるとき(pagehide)は beacon で返す", async () => {
    vi.mocked(api.acquireEditLockApi).mockResolvedValue(mineRes);
    const { result } = renderHook(() => useEditLock({ resourceType: "property", resourceId: PROP }));
    await act(async () => { await result.current.acquire(); });
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(api.releaseEditLockByBeacon).toHaveBeenCalledWith("property", PROP, mineRes.lockId);
  });

  it("裏から戻ったら即座に1回合図を送る(iPhoneで合図が止まるため)", async () => {
    vi.mocked(api.acquireEditLockApi).mockResolvedValue(mineRes);
    vi.mocked(api.heartbeatEditLockApi).mockResolvedValue({ state: "mine", idleSince: "x" });
    const { result } = renderHook(() => useEditLock({ resourceType: "property", resourceId: PROP }));
    await act(async () => { await result.current.acquire(); });
    vi.mocked(api.heartbeatEditLockApi).mockClear();
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(0); });
    expect(api.heartbeatEditLockApi).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: 落ちることを確認**

Run: `npx vitest run src/hooks/__tests__/use-edit-lock.test.ts`
Expected: FAIL(`Cannot find module '../use-edit-lock'`)

- [ ] **Step 4: hook を実装する(結線だけ・判断は Task 2 の純関数)**

```ts
// src/hooks/use-edit-lock.ts
"use client";

/**
 * 鍵を持つ側の hook(仕様 6.2)。**判断は `@/lib/edit-lock/ui-state` の純関数**に置き、
 * ここは React への結線(タイマー・イベント・ref)だけを持つ
 * (`use-address-lookup.ts` と同じ作り)。
 *
 * ⚠無操作の時間はクライアントで数えない。合図の応答 `idleSince`(DBの時計)を使う。
 * ⚠管理者に外された/資源が消えた場合は自動で取り直さない(仕様 6.2・N5)。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  acquireEditLockApi,
  heartbeatEditLockApi,
  releaseEditLockApi,
  releaseEditLockByBeacon,
} from "@/lib/api-client";
import { answerScreenTokenProbes } from "@/lib/edit-lock/screen-token-client";
import { EDIT_LOCK_HEARTBEAT_INTERVAL_MS } from "@/lib/edit-lock/rules";
import {
  shouldReacquireOnInput,
  shouldWarnIdle,
  uiStateFromAcquire,
  uiStateFromHeartbeat,
  uiStateFromSaveError,
  type EditLockUiState,
} from "@/lib/edit-lock/ui-state";

export interface UseEditLockOptions {
  resourceType: "property" | "owner";
  resourceId: string;
  /** false の間は何もしない(カードが閉じている等)。 */
  enabled?: boolean;
}

export function useEditLock({ resourceType, resourceId, enabled = true }: UseEditLockOptions) {
  const [state, setState] = useState<EditLockUiState>({ kind: "idle" });
  const stateRef = useRef(state);
  stateRef.current = state;
  const lockIdRef = useRef<string | null>(null);
  const activeRef = useRef(false);
  const [warnIdle, setWarnIdle] = useState(false);

  /** 他のタブからの「その合言葉を使っていますか」に答え続ける(複製の検知に要る)。 */
  useEffect(() => answerScreenTokenProbes(), []);

  const apply = useCallback((next: EditLockUiState) => {
    lockIdRef.current = next.kind === "mine" ? next.lockId : null;
    setState(next);
    setWarnIdle(shouldWarnIdle(next, Date.now()));
  }, []);

  const acquire = useCallback(async () => {
    if (!enabled) return;
    const res = await acquireEditLockApi(resourceType, resourceId);
    apply(uiStateFromAcquire(res));
  }, [apply, enabled, resourceId, resourceType]);

  const release = useCallback(async () => {
    const lockId = lockIdRef.current;
    lockIdRef.current = null;
    setState({ kind: "idle" });
    setWarnIdle(false);
    if (lockId) await releaseEditLockApi(resourceType, resourceId, lockId);
  }, [resourceId, resourceType]);

  const beat = useCallback(async () => {
    const lockId = lockIdRef.current;
    if (!lockId) return;
    const active = activeRef.current;
    activeRef.current = false;
    const res = await heartbeatEditLockApi(resourceType, resourceId, active);
    apply(uiStateFromHeartbeat(res, lockId));
  }, [apply, resourceId, resourceType]);

  /** 合図。鍵を持っている間だけ回す(lost/deleted になったら止まる)。 */
  useEffect(() => {
    if (!enabled || state.kind !== "mine") return;
    const timer = setInterval(() => { void beat(); }, EDIT_LOCK_HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [beat, enabled, state.kind]);

  /** 裏から戻ったら即1回(iPhoneでは裏に回ると合図が止まる=正常)。 */
  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => {
      if (document.visibilityState !== "hidden" && stateRef.current.kind === "mine") void beat();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [beat, enabled]);

  /** 閉じるときは beacon(ヘッダが付けられないので合言葉は本文で送る)。 */
  useEffect(() => {
    if (!enabled) return;
    const onHide = () => {
      const lockId = lockIdRef.current;
      if (lockId) releaseEditLockByBeacon(resourceType, resourceId, lockId);
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [enabled, resourceId, resourceType]);

  /** 入力・キー・ポインタのときに呼ぶ。期限切れならここで取り直す。 */
  const noteActivity = useCallback(() => {
    activeRef.current = true;
    if (shouldReacquireOnInput(stateRef.current)) void acquire();
  }, [acquire]);

  /** 保存が断られたときに呼ぶ。鍵と無関係なコードなら状態は変えない。 */
  const noteSaveError = useCallback(
    (code: string | null, holderName: string | null = null) => {
      const next = uiStateFromSaveError(code, holderName);
      if (next) apply(next);
    },
    [apply],
  );

  return {
    state,
    acquire,
    release,
    noteActivity,
    noteSaveError,
    /** 保存ボタンを押せるか。 */
    canSave: state.kind === "mine",
    /** 55分の予告を出すか(DBの時計基準)。 */
    warnIdle,
    lockId: state.kind === "mine" ? state.lockId : null,
  };
}
```

- [ ] **Step 5: 通ることを確認 → commit**

Run: `npx vitest run src/hooks/__tests__/use-edit-lock.test.ts` → PASS、`npx tsc --noEmit` clean

```bash
git add src/lib/api-client.ts src/hooks/use-edit-lock.ts src/hooks/__tests__/use-edit-lock.test.ts
git commit -m "feat(edit-lock): 窓口を叩く関数と、鍵を持つ側のhookを足す"
```

---

### Task 4: 帯の部品と、管理者の「鍵を外す」

**Files:**
- Create: `src/components/edit-lock/edit-lock-banner.tsx`
- Test: `src/components/edit-lock/__tests__/edit-lock-banner.test.tsx`

**Interfaces:**
- Consumes: `EditLockUiState`(Task 2)、`ConfirmDialog`(`@/components/ui/confirm-dialog`)、`forceReleaseEditLockApi`・`apiErrorCode`(api-client)
- Produces: `<EditLockBanner state={…} warnIdle={…} />`・`<EditLockHolderBanner row={…} isAdmin={…} onReleased={…} />`・`formatSince(since?)`・**`createForceReleaseHandler({row, onReleased, setNotice})`**(切り出したハンドラ)

**🔴テストの作り方(確定・下の `render/fireEvent` のテストはこの形に読み替える)**: `@testing-library/react` は使わない(Global Constraints)。
- **見た目・文言**は `renderToStaticMarkup(<EditLockBanner … />)` の文字列で固定する(既存の `name-cell.test.tsx` と同じ形)。「帯を出さない」は `html === ""`、文言は `toContain`、管理者だけに出るボタンは `toContain("鍵を外す")` / `not.toContain` で見る。
- **押したときの動き**は、部品から切り出した **`createForceReleaseHandler`** を node で直接呼んで検査する(確認ダイアログの文言は `renderToStaticMarkup(<ConfirmDialog …>)` の文字列で固定)。`forceReleaseEditLockApi` をモックし、成功で `onReleased` が呼ばれること・`EDIT_LOCK_CHANGED` のときに `setNotice("状況が変わりました。表示を更新します")` と `onReleased` の**両方**が呼ばれることを確かめる。
- 検査する**文言・氏名・時刻の書式・呼び出し先は下の表とテストのまま**。

**文言(仕様 6.2・6.3・N6 で確定。1文字も変えない)**

| 状態 | 文言 |
|---|---|
| `taken` | `🔒 {氏名}さんが編集中です({HH:mm}〜)` (帯・見ている側も同じ) |
| `held_by_self_other_screen` | `🔒 あなたが別の画面で編集中です({HH:mm}〜)` |
| `expired` | `しばらく画面が止まっていたため、編集の鍵が外れました。入力すると自動で取り直します` |
| `force_released` | `管理者が編集を終了しました。この内容は保存できません` |
| `deleted` | `この記録は削除されたため、編集を続けられません` |
| `warnIdle` | `操作がないため、あと5分で編集を終了します` |
| 解除の確認 | `{氏名}さんの編集を終わらせます。{氏名}さんが今入力している内容は失われ、保存されません。{氏名}さんの画面は、この先5分間は保存できません(5分経つと、この記録はまた誰でも編集を始められる状態に戻ります)。` |
| 解除が競合 | `状況が変わりました。表示を更新します` |

- [ ] **Step 1: 失敗するテストを書く**

```tsx
// src/components/edit-lock/__tests__/edit-lock-banner.test.tsx
// ⚠この形(jsdom + render/fireEvent)では**書かない**。上の「テストの作り方(確定)」のとおり
//   文言は `renderToStaticMarkup` の文字列で、押したときの動きは `createForceReleaseHandler`
//   を直接呼んで検査する。**検査する文言・呼び出し先は下のまま**読み替える。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EditLockBanner, EditLockHolderBanner } from "../edit-lock-banner";
import * as api from "@/lib/api-client";

vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof api>()),
  forceReleaseEditLockApi: vi.fn(),
}));

describe("編集中の鍵の帯", () => {
  beforeEach(() => vi.clearAllMocks());

  it("鍵を持っている間は帯を出さない", () => {
    const { container } = render(<EditLockBanner state={{ kind: "mine", lockId: "l1" }} warnIdle={false} />);
    expect(container.textContent).toBe("");
  });

  it("55分の予告を出す", () => {
    render(<EditLockBanner state={{ kind: "mine", lockId: "l1" }} warnIdle />);
    expect(screen.getByText("操作がないため、あと5分で編集を終了します")).toBeTruthy();
  });

  it("期限切れ・管理者解除・削除の文言を出す", () => {
    const { rerender } = render(<EditLockBanner state={{ kind: "expired" }} warnIdle={false} />);
    expect(screen.getByText(/入力すると自動で取り直します/)).toBeTruthy();
    rerender(<EditLockBanner state={{ kind: "force_released" }} warnIdle={false} />);
    expect(screen.getByText("管理者が編集を終了しました。この内容は保存できません")).toBeTruthy();
    rerender(<EditLockBanner state={{ kind: "deleted" }} warnIdle={false} />);
    expect(screen.getByText("この記録は削除されたため、編集を続けられません")).toBeTruthy();
  });

  it("他の人が編集中のときは氏名と開始時刻(HH:mm)を出す", () => {
    render(
      <EditLockBanner
        state={{ kind: "taken", holderName: "山田", since: "2026-09-22T05:02:00.000Z" }}
        warnIdle={false}
      />,
    );
    // 表示は現地時間。時刻の書式(HH:mm)だけを固定する。
    expect(screen.getByText(/山田さんが編集中です\(\d{2}:\d{2}〜\)/)).toBeTruthy();
  });

  it("管理者にだけ「鍵を外す」が出る", () => {
    const row = { resourceType: "property" as const, resourceId: "p1", state: "held_by_other" as const, holderName: "山田", since: "2026-09-22T05:02:00.000Z", lockId: "l1" };
    const { rerender } = render(<EditLockHolderBanner row={row} isAdmin={false} onReleased={() => {}} />);
    expect(screen.queryByRole("button", { name: "鍵を外す" })).toBeNull();
    rerender(<EditLockHolderBanner row={row} isAdmin onReleased={() => {}} />);
    expect(screen.getByRole("button", { name: "鍵を外す" })).toBeTruthy();
  });

  it("鍵を外すと確認が出て、承諾すると窓口を叩く(文言も固定)", async () => {
    const onReleased = vi.fn();
    render(
      <EditLockHolderBanner
        row={{ resourceType: "property", resourceId: "p1", state: "held_by_other", holderName: "山田", since: "2026-09-22T05:02:00.000Z", lockId: "l1" }}
        isAdmin
        onReleased={onReleased}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "鍵を外す" }));
    expect(
      screen.getByText(
        "山田さんの編集を終わらせます。山田さんが今入力している内容は失われ、保存されません。山田さんの画面は、この先5分間は保存できません(5分経つと、この記録はまた誰でも編集を始められる状態に戻ります)。",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "編集を終わらせる" }));
    await waitFor(() => expect(api.forceReleaseEditLockApi).toHaveBeenCalledWith("property", "p1", "l1"));
    await waitFor(() => expect(onReleased).toHaveBeenCalled());
  });

  it("解除が競合したら「状況が変わりました」を出して一覧を更新する", async () => {
    vi.mocked(api.forceReleaseEditLockApi).mockRejectedValue(
      Object.assign(new Error("changed"), { code: "EDIT_LOCK_CHANGED", status: 409 }),
    );
    const onReleased = vi.fn();
    render(
      <EditLockHolderBanner
        row={{ resourceType: "property", resourceId: "p1", state: "held_by_other", holderName: "山田", since: "2026-09-22T05:02:00.000Z", lockId: "l1" }}
        isAdmin
        onReleased={onReleased}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "鍵を外す" }));
    fireEvent.click(screen.getByRole("button", { name: "編集を終わらせる" }));
    await waitFor(() => expect(screen.getByText("状況が変わりました。表示を更新します")).toBeTruthy());
    expect(onReleased).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 落ちることを確認 → 実装 → 通す**

実装の要点(コードは既存の amber の組みをそのまま使う):

```tsx
// src/components/edit-lock/edit-lock-banner.tsx
"use client";

/**
 * 編集中の鍵の帯(仕様 6.2・6.3・6.4)。
 *
 * ⚠新しい色・形を作らない。`properties/[id]/page.tsx` の注意帯と同じ amber の組み。
 * ⚠文言は仕様の表のまま(N6 で「保存されません」の無期限の約束を外した版)。
 */
import { useState } from "react";
import { Lock } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { apiErrorCode, forceReleaseEditLockApi, type EditLockStatusRow } from "@/lib/api-client";
import type { EditLockUiState } from "@/lib/edit-lock/ui-state";

const BAND =
  "flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300";

/** 開始時刻は現地時間の HH:mm(仕様の見本と同じ)。 */
export function formatSince(since?: string): string {
  if (!since) return "";
  const d = new Date(since);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function EditLockBanner({ state, warnIdle }: { state: EditLockUiState; warnIdle: boolean }) {
  if (state.kind === "mine") {
    return warnIdle ? <div className={BAND}>操作がないため、あと5分で編集を終了します</div> : null;
  }
  if (state.kind === "idle") return null;
  if (state.kind === "expired") {
    return <div className={BAND}>しばらく画面が止まっていたため、編集の鍵が外れました。入力すると自動で取り直します</div>;
  }
  if (state.kind === "force_released") {
    return <div className={BAND}>管理者が編集を終了しました。この内容は保存できません</div>;
  }
  if (state.kind === "deleted") {
    return <div className={BAND}>この記録は削除されたため、編集を続けられません</div>;
  }
  return (
    <div className={BAND}>
      <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{`${state.holderName}さんが編集中です(${formatSince(state.since)}〜)`}</span>
    </div>
  );
}
```

`EditLockHolderBanner` は同じ帯に「鍵を外す」を足したもの。`state === "held_by_self_other_screen"` のときは文言を `あなたが別の画面で編集中です(HH:mm〜)` にする。`ConfirmDialog` は `confirmLabel="編集を終わらせる"` で使う。`forceReleaseEditLockApi` の失敗は `apiErrorCode(e) === "EDIT_LOCK_CHANGED"` のときだけ「状況が変わりました。表示を更新します」を出し、**どちらの場合も `onReleased()` を呼んで一覧を更新する**(競合=誰かが既に外した/取り直した、なので表示を作り直すのが正しい)。

Run: `npx vitest run src/components/edit-lock/__tests__/edit-lock-banner.test.tsx` → PASS

- [ ] **Step 3: commit**

```bash
git add src/components/edit-lock/edit-lock-banner.tsx src/components/edit-lock/__tests__/edit-lock-banner.test.tsx
git commit -m "feat(edit-lock): 帯の部品と管理者の鍵を外す操作を足す"
```

---

### Task 5: 編集ウィンドウ(物件)に配線する

**Files:**
- Modify: `src/components/properties/property-edit-form.tsx`(`:393`〜`:430` の保存と、フォーム冒頭)
- Test: `src/components/properties/__tests__/property-edit-form-edit-lock.test.tsx`(新規)

**Interfaces:**
- Consumes: `useEditLock`(Task 3)・`EditLockBanner`(Task 4)・`editLockHeaders`(Task 1)
- Produces: なし(画面)

- [ ] **Step 1: 失敗するテストを書く**

**🔴テストの作り方(確定)**: フォームを描画して操作するテストは書かない(`@testing-library/react` は使わない)。代わりに、保存の**ヘッダ組み立てとエラーの写像を関数に切り出して** node で検査し、配線は走査で固定する。

切り出す関数(`src/components/properties/property-edit-form.tsx` から輸出する):

```ts
/** 保存の fetch に渡す init を作る。⚠ヘッダは必ず editLockHeaders を通す。 */
export function buildPropertySaveInit(payload: unknown, lockId: string | null): RequestInit;
```

検査(4件):
1. `buildPropertySaveInit({}, null)` の headers に `X-Edit-Screen` があり、**`X-Edit-Lock` は無い**
2. `buildPropertySaveInit({}, "l1")` の headers に `X-Edit-Lock: "l1"` が載る
3. `Content-Type: application/json` と `method: "PATCH"` が従来どおり
4. 走査: このファイルが `useEditLock(`・`ensureUniqueScreenToken(`・`EditLockBanner`・`disabled={` を含む(配線のラチェット。Task 7 の走査に合流させてよい)

⚠**「帯が出る」「保存ボタンが押せない」の判断自体は Task 2 の純関数と Task 4 の部品で既に検査済み**。ここで重複して検査しない(YAGNI)。画面が本当に繋がっているかは計画末尾の**ローカル実機確認**で見る。

- [ ] **Step 2: 配線する**

```tsx
// property-edit-form.tsx の冒頭(フォームの中)
const lock = useEditLock({ resourceType: "property", resourceId: property.id });
// ⚠**複製のタブの判定(最大300ms)が付くまで編集させない**(仕様 6.1)。判定より先に
//   取得すると、複製されたタブが元のタブと同じ保持者として鍵を取ってしまう(D6違反)。
const [tokenReady, setTokenReady] = useState(false);
useEffect(() => {
  let alive = true;
  void ensureUniqueScreenToken().then(() => {
    if (!alive) return;
    setTokenReady(true);
    void lock.acquire();
  });
  return () => { alive = false; };
}, []); // 開いたとき1回だけ(依存を足さない)
// 保存成功・閉じる・キャンセルで lock.release() を呼ぶ
```

保存ボタンは `disabled={!tokenReady || !lock.canSave || busy}`。**判定中(最大300ms)の帯は出さない**(何も起きていないため)。

⚠この「判定が付くまで押せない」は**テストで固定する**(5件目): `ensureUniqueScreenToken` が解決する前は保存ボタンが `disabled` で `acquireEditLockApi` が呼ばれていないこと、解決後に1回呼ばれること。

保存の `fetch`(`:414`)のヘッダに `...editLockHeaders(lock.lockId)` を足し、`catch` で `lock.noteSaveError(apiErrorCode(e), null)` を呼ぶ。フォーム内の `onInput`/`onKeyDown`/`onPointerDown` の一番外側で `lock.noteActivity()` を呼ぶ。保存ボタンは `disabled={!lock.canSave || busy}`。フォームの一番上に `<EditLockBanner state={lock.state} warnIdle={lock.warnIdle} />`。

⚠**入力は消さない**(状態が変わっても値は保持する)。⚠帯が出ている間も選択・コピーはできるままにする。

- [ ] **Step 3: 通す → 全体テスト → commit**

Run: `npx vitest run src/components/properties/__tests__/` → PASS、`npx tsc --noEmit` clean

```bash
git add src/components/properties/property-edit-form.tsx src/components/properties/__tests__/property-edit-form-edit-lock.test.tsx
git commit -m "feat(edit-lock): 物件の編集ウィンドウで鍵を取り、保存に世代を載せる"
```

---

### Task 6: 所有者カードに配線する

**Files:**
- Modify: `src/app/(dashboard)/properties/[id]/page.tsx`(`OwnerCard` `:1141`〜、保存は `:1311` の `updateOwner`)
- Modify: `src/lib/api-client.ts`(`updateOwner` に `lockId` を渡せる引数を足す)
- Test: `src/app/(dashboard)/properties/[id]/__tests__/owner-card-edit-lock.test.tsx`(新規)

**Interfaces:**
- Consumes: `useEditLock`・`EditLockBanner`・`editLockHeaders`
- Produces: `updateOwner(id, data, opts?: { lockId?: string | null })`

- [ ] **Step 1: `updateOwner` にヘッダの口を足す**

```ts
export async function updateOwner(
  id: string,
  data: { note?: string | null; version: number } & Record<string, unknown>,
  opts: { lockId?: string | null } = {},
) {
  // …mock は従来どおり…
  return apiFetch<{ id: string; name: string; note: string | null; version: number }>(`/api/owners/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...editLockHeaders(opts.lockId) },
    body: JSON.stringify(data),
  });
}
```

⚠既存の呼び出し元(`opts` なし)は**合言葉だけ**が付く=鍵を持たない入口として正しく扱われる。

- [ ] **Step 2〜4: カードに配線・テスト・commit**(Task 5 と同じ形。カードは**所有者ごとに1つの hook**=`enabled` は「そのカードが編集中か」)

⚠Task 5 と同じく、**複製タブの判定(`ensureUniqueScreenToken`)が付くまで編集を始めさせない**。判定は画面で1回で足りるので、**物件詳細の親(page.tsx)で1回だけ走らせて結果を配る**(カードごとに 300ms 待たせない)。

**🔴テストの作り方(確定)**: カードを描画して操作するテストは書かない。検査は3件に絞る:
1. `updateOwner("o1", {version:1}, {lockId:"l1"})` が `X-Edit-Lock: "l1"` を載せる(`global.fetch` を差し替えて `init.headers` を直接見る)
2. `updateOwner("o1", {version:1})`(第3引数なし)は `X-Edit-Screen` だけで **`X-Edit-Lock` を載せない**
3. 走査: `page.tsx` が `useEditLock(`・`EditLockBanner`・`updateOwner(`… の第3引数に `lockId` を渡す形を含む

⚠「そのカードだけ止まる」「判定が付くまで押せない」は**資源IDごとに hook を分けた結果**であり、Task 2の純関数(状態)とTask 3の controller(資源ID単位)で既に固定されている。ここでは重複して検査せず、**ローカル実機確認**(計画末尾)で見る。

```bash
git commit -m "feat(edit-lock): 所有者カードで鍵を取り、カード単位で編集を止める"
```

---

### Task 7: 鍵を持たない3入口にヘッダを足し、6入口を走査で固定する

**Files:**
- Modify: `src/app/(dashboard)/properties/[id]/page.tsx`(`CaseStatusField` `:1907`・`IntroductionRouteField` `:1988` の `fetch`)
- Modify: `src/components/properties/registry-chiban-popup.tsx:105`
- Test: `src/lib/edit-lock/__tests__/save-entrypoints-scan.test.ts`(新規)

**Interfaces:**
- Consumes: `editLockHeaders`(Task 1)
- Produces: なし

- [ ] **Step 1: 走査テストを書く(仕様 8.3)**

```ts
// src/lib/edit-lock/__tests__/save-entrypoints-scan.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 保存窓口を呼ぶ**6つの入口すべて**が合言葉のヘッダを付ける(仕様 5.1・6.1)。
 * 1つでも付け忘れると、その入口からの保存だけが鍵をすり抜ける。
 */
const ENTRYPOINTS = [
  "src/components/properties/property-edit-form.tsx",
  "src/app/(dashboard)/properties/[id]/page.tsx",
  "src/components/properties/registry-chiban-popup.tsx",
  "src/components/owners/corporate-lookup-panel.tsx",
];

describe("保存の入口(走査)", () => {
  for (const rel of ENTRYPOINTS) {
    it(`${rel} は editLockHeaders を通している`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
      expect(src).toMatch(/editLockHeaders\(/);
    });
  }

  it("client 側の合言葉モジュールは server 専用の依存を引かない", () => {
    for (const rel of ["src/lib/edit-lock/header-names.ts", "src/lib/edit-lock/screen-token-client.ts"]) {
      const src = readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
      expect(src).not.toMatch(/@\/lib\/(api-helpers|prisma|auth)/);
    }
  });

  it("client の部品は server 用の screen-token.ts を import しない", () => {
    for (const rel of [...ENTRYPOINTS, "src/hooks/use-edit-lock.ts", "src/hooks/use-edit-lock-status.ts"]) {
      const src = readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
      expect(src).not.toMatch(/from "@\/lib\/edit-lock\/screen-token"/);
    }
  });
});
```

- [ ] **Step 2: 3入口にヘッダを足す**

3か所とも `headers: { "Content-Type": "application/json" }` を `headers: { "Content-Type": "application/json", ...editLockHeaders() }` にする(**世代は渡さない**=鍵を持たない入口)。失敗時は `apiErrorCode(e) === "EDIT_LOCKED"` のときだけ、その入口の既存のエラー表示位置に `{氏名}さんが編集中です({HH:mm}〜)` を出す(仕様 6.5)。氏名は封筒の `message` をそのまま使う(窓口が既にこの文言で返す)。

- [ ] **Step 3: 走査が効くことを実演 → commit**

一時的に1つの入口から `editLockHeaders(` を消し、この走査が落ちることを確認してから戻す。

```bash
git commit -m "feat(edit-lock): 鍵を持たない3入口にも合言葉を付け、6入口を走査で固定"
```

---

### Task 8: 法人番号の反映パネル(2画面)に配線する

**Files:**
- Modify: `src/components/owners/corporate-lookup-panel.tsx`
- Modify: `src/lib/api-client.ts`(corporate-apply を呼ぶ関数に `lockId` の口を足す)
- Test: `src/components/owners/__tests__/corporate-lookup-panel-edit-lock.test.tsx`(新規)

**Interfaces:**
- Consumes: `editLockHeaders`
- Produces: なし

このパネルは**物件詳細の所有者カード内**と **`admin/owners/[id]`** の2画面に置かれている。所有者カード内では Task 6 の hook が持つ世代を props で受け取り、`admin/owners/[id]` では鍵を持たない入口として合言葉だけを付ける(=そちらは 423 のときに文言を出す)。

- [ ] テスト3件: カード内では世代が載る / 管理画面では世代が載らない(合言葉だけ) / 423 のとき既存のエラー位置に文言が出る
- [ ] commit: `feat(edit-lock): 法人番号の反映も鍵の確認を通す`

---

### Task 9: 見ている側(物件詳細)に帯と無効化を付ける

**Files:**
- Create: `src/hooks/use-edit-lock-status.ts`
- Create: `src/hooks/__tests__/use-edit-lock-status.test.ts`
- Modify: `src/app/(dashboard)/properties/[id]/page.tsx`(上部の帯・編集ボタン等の無効化)

**Interfaces:**
- Consumes: `fetchEditLockStatus`・`EditLockStatusRow`(Task 3)、`EDIT_LOCK_STATUS_POLL_MS`(rules)、`EditLockHolderBanner`(Task 4)
- Produces: `useEditLockStatus(resources, { enabled })` → `{ rows, refresh, byKey(resourceType, resourceId) }`

- [ ] **Step 1: controller のテストを書く**(5件)

**🔴テストの作り方(確定)**: hook は検査しない。判断と周期は **`createEditLockStatusController(deps)`**(`src/lib/edit-lock/status-controller.ts`)に置き、`deps` に `fetchStatus`・`onRows`・`setInterval`/`clearInterval`・`isHidden()` を渡して node で検査する(Task 3 と同じ形)。

1. 開いたとき1回・以後 `EDIT_LOCK_STATUS_POLL_MS` ごとに1回だけ呼ぶ(偽の `setInterval` を手で発火させる)
2. **`isHidden()` が true の回は呼ばない**→false に戻った回で再開する
3. 50件を超える資源は**分割して呼ぶ**(51件 → 2回。1回目50件・2回目1件であることを引数で確かめる)
4. `refresh()` で即座に1回呼ぶ(管理者が鍵を外した直後に使う)
5. 資源の一覧が変わったら古い応答で `onRows` を呼ばない(`seq` で stale を捨てる。`use-address-lookup` の controller と同じ型)

- [ ] **Step 2: 実装 → 画面に配線**

物件詳細の上部に、その物件の行が `held_by_other` / `held_by_self_other_screen` のとき `EditLockHolderBanner`。同時に**編集ボタン・案件ステータス・紹介経路・所在検索の地番保存を無効化**する(仕様 6.3 の表)。所有者カードは**その所有者の行**だけで無効化する。`free` に戻ったら帯を消して戻す。

- [ ] **Step 3: 仕様 6.3 の表を1件ずつテストで固定 → commit**

```bash
git commit -m "feat(edit-lock): 見ている側に編集中の帯を出し、該当操作を止める"
```

---

## 実装後の確認(最終レビューの前に必ず)

- [ ] `npx vitest run`(全体)が緑・件数を報告
- [ ] `npx tsc --noEmit` clean / `npx eslint` 触ったファイルすべてで新規エラーなし
- [ ] `npm run build` 成功(**client bundle に server 専用の依存が入っていないことの実証**=Task 1 の分離が効いている)
- [ ] ローカル実機(仕様 8.4): 2つのブラウザで同じ物件を開き、①片方が編集を始めると他方に帯が出る ②**タブを複製**しても両方が同じ保持者にならない ③管理者が外すと帯が変わり保存が止まる ④5分待つと外された画面が自動で取り直せるようになる
- [ ] 実機確認の項目を [[field-check-pending]] の Artifact に追記
