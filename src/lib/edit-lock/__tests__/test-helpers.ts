/**
 * 編集中の鍵まわりのテストで繰り返し使う小さなヘルパー(review round2 Minor F)。
 *
 * ⚠`fakeScreenTokenEnv`/`jsonResponse`/`stubFetch`/`stubFetchByUrl` の4つが
 *   `no-lock-dropdowns-edit-lock.test.tsx` と `registry-chiban-popup.test.ts` に
 *   一字一句コピーされていた。1本にまとめてここから import する。
 * ⚠このファイルは `*.test.ts` で終わらないため、vitest の `include`
 *   (`src/**\/__tests__/**\/*.test.ts?(x)`)には拾われない=それ自体はテストとして
 *   実行されない、ただのヘルパーモジュール。
 */
import { vi } from "vitest";
import type { Dispatch, SetStateAction } from "react";
import type { ScreenTokenEnv } from "@/lib/edit-lock/screen-token-client";

/** `getScreenToken()` が固定の合言葉を返すだけの、最小限のフェイク env。 */
export function fakeScreenTokenEnv(token: string): ScreenTokenEnv {
  return {
    getItem: () => token,
    setItem: () => {},
    openChannel: () => null,
    newId: () => token,
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** `fetch` の型(url, init) を1箇所に固定し、mock.calls の要素型を保つ。 */
export function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(handler);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** URLで分岐するスタブ(例: 保存の窓口と状態の窓口 `/api/edit-locks/status` を呼び分ける)。 */
export function stubFetchByUrl(handlers: Record<string, (init?: RequestInit) => Promise<Response>>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const handler = handlers[url];
    if (!handler) throw new Error(`unexpected fetch: ${url}`);
    return handler(init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * pending なマイクロタスク/次のマクロタスクまでを1回流す(review round2 Important A)。
 * `composeEditLockedMessage` は呼び出し側が `await` しない(封筒のmessageを
 * 即座に表示するため)ので、組み立てた文が `setError` へ届くのを検査したい
 * テストはこれで1度待つ。
 */
export function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * React の `useState` の更新関数を模した、node で使えるフェイク(review round3
 * Important G)。`runChibanSave`/`runNoLockPropertyPatch` は世代の見張りのため
 * `setError` を値だけでなく更新関数(`(prev) => next`)の形でも呼ぶように
 * なった。素の `vi.fn()` は渡された更新関数を**実行しない**ため、「最終的に
 * 画面へ出る値」を検査するテストは更新関数を模擬的に適用するこのヘルパーを使う。
 * `calls`(生の呼び出し引数)と `value`(適用後の現在値)の両方を見られる。
 */
export function createStateSpy<T>(initial: T): {
  setState: Dispatch<SetStateAction<T>>;
  calls: (T | ((prev: T) => T))[];
  readonly value: T;
} {
  let current = initial;
  const calls: (T | ((prev: T) => T))[] = [];
  const setState = ((next: T | ((prev: T) => T)) => {
    calls.push(next);
    current = typeof next === "function" ? (next as (prev: T) => T)(current) : next;
  }) as Dispatch<SetStateAction<T>>;
  return {
    setState,
    calls,
    get value() {
      return current;
    },
  };
}
