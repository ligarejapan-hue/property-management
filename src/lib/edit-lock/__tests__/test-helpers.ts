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
