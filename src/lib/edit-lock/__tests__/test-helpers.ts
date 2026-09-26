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

/**
 * `openTag` から始まる JSX 要素を、その要素自身の閉じ(自己終了 `/>`)までで
 * 切り出す(Task 9 review round1 Important 3・round2 Minor N4で共有化)。
 * ⚠`[\s\S]*?prop=...` のように右側が無制限な正規表現は、同じ prop 名を持つ
 *   **次の別要素**まで読み飛ばしてマッチしてしまい、対象要素からその prop を
 *   消しても検査が green のままになる(round1で`<RegistryLocationSearchButton`
 *   から4147文字先の`<BasicTab`へ誤マッチすることを実測で確認済み)。
 * ⚠(review round2 Minor N5) この関数は対象要素が**自己終了**であることを
 *   前提にしている。将来 `<X ...>...</X>`(非自己終了)の形に変わると、
 *   最初の `/>` は X の外(ネストした子・後続の別要素の自己終了タグ)まで
 *   窓が黙って広がってしまう——round1で塞いだのと同じ形の穴が別の入口から
 *   戻ってくる。切り出した範囲の中に(対象自身の開始タグ以外の)**もう1つの
 *   大文字コンポーネントタグ**が現れたら、自己終了の前提が崩れているサインと
 *   みなし、黙って広い窓を返さず例外を投げて検査自体を落とす。
 */
export function extractJsxElement(source: string, openTag: string): string {
  const start = source.indexOf(openTag);
  if (start === -1) return "";
  const closeIdx = source.indexOf("/>", start);
  if (closeIdx === -1) return source.slice(start);
  const block = source.slice(start, closeIdx + 2);
  const secondUppercaseTag = block.slice(openTag.length).match(/<[A-Z]\w*/);
  if (secondUppercaseTag) {
    throw new Error(
      `extractJsxElement: ${openTag} は自己終了(/>)ではなくなった可能性がある` +
        `(切り出した範囲の中に別の大文字タグ ${secondUppercaseTag[0]} を検出)。` +
        `走査の前提(この要素は自己終了である)が崩れていないか確認してください。`,
    );
  }
  return block;
}
