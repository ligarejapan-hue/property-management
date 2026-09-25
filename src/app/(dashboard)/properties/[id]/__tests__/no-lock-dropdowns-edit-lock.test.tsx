/**
 * 鍵を持たない入口(案件ステータス・導入ルートのプルダウン)の保存(Task 7・仕様 6.5)。
 *
 * ⚠このリポジトリは jsdom を使わない方針(vitest.config.ts が environment: "node" を
 *   固定)。プルダウンをクリックするテストは書けないので、実体
 *   (`runNoLockPropertyPatch`)を node から直接呼んで検査する
 *   (`owner-card-edit-lock.test.tsx` と同じやり方)。
 *
 * ⚠この入口は鍵を**取らない**。`editLockHeaders()` は世代(lockId)を渡さず、
 *   タブの合言葉(X-Edit-Screen)だけを載せる。`EDIT_LOCKED` は
 *   `composeEditLockedMessage` で氏名+時刻の文を組み立てて表示する
 *   (仕様6.5・fix round1)。窓口の423自体は氏名・時刻を返さない。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runNoLockPropertyPatch } from "../page";
import { EDIT_SCREEN_HEADER, EDIT_LOCK_HEADER } from "@/lib/edit-lock/header-names";
import {
  setScreenTokenEnvForTest,
  resetScreenTokenForTest,
  type ScreenTokenEnv,
} from "@/lib/edit-lock/screen-token-client";

function fakeScreenTokenEnv(token: string): ScreenTokenEnv {
  return {
    getItem: () => token,
    setItem: () => {},
    openChannel: () => null,
    newId: () => token,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(handler);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** URLで分岐するスタブ(状態窓口 `/api/edit-locks/status` を呼ぶテスト用)。 */
function stubFetchByUrl(handlers: Record<string, (init?: RequestInit) => Promise<Response>>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const handler = handlers[url];
    if (!handler) throw new Error(`unexpected fetch: ${url}`);
    return handler(init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("runNoLockPropertyPatch(鍵を持たない入口の保存)", () => {
  beforeEach(() => {
    resetScreenTokenForTest();
    setScreenTokenEnvForTest(fakeScreenTokenEnv("screen-1"));
  });
  afterEach(() => {
    setScreenTokenEnvForTest(null);
    resetScreenTokenForTest();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("X-Edit-Screenだけを載せ、X-Edit-Lockは載せない(世代=鍵を持たない)", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ id: "p1", version: 2 }));
    await runNoLockPropertyPatch(
      "p1",
      1,
      { caseStatus: "active" },
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/properties/p1");
    expect(init?.method).toBe("PATCH");
    const headers = init?.headers as Record<string, string>;
    expect(headers[EDIT_SCREEN_HEADER]).toBe("screen-1");
    expect(EDIT_LOCK_HEADER in headers).toBe(false);
  });

  it("bodyはpatchとversionを合わせて送る", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ id: "p1", version: 2 }));
    await runNoLockPropertyPatch(
      "p1",
      7,
      { introductionRoute: "referral" },
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );
    const [, init] = fetchMock.mock.calls[0];
    // ⚠キー順ではなく構造を見る(走査は引数を見る・書式ではない)。
    expect(JSON.parse(init?.body as string)).toEqual({ introductionRoute: "referral", version: 7 });
  });

  it("成功したらonRefreshを呼ぶ", async () => {
    stubFetch(async () => jsonResponse({ id: "p1", version: 2 }));
    const onRefresh = vi.fn();
    await runNoLockPropertyPatch("p1", 1, { caseStatus: "active" }, vi.fn(), vi.fn(), onRefresh);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("EDIT_LOCKED + 状態窓口が保持者行を返せば、氏名+時刻の文を組み立てて表示する(仕様6.5・fix round1)", async () => {
    const since = new Date(2026, 8, 22, 14, 0).toISOString();
    stubFetchByUrl({
      "/api/properties/p1": async () =>
        jsonResponse({ error: { code: "EDIT_LOCKED", message: "他の画面で編集中です" } }, 423),
      "/api/edit-locks/status": async () =>
        jsonResponse({
          locks: [
            {
              resourceType: "property",
              resourceId: "p1",
              state: "held_by_other",
              since,
              holderName: "太郎",
            },
          ],
        }),
    });
    const setError = vi.fn();
    await runNoLockPropertyPatch("p1", 1, { caseStatus: "active" }, vi.fn(), setError, vi.fn());
    expect(setError).toHaveBeenCalledWith("太郎さんが編集中です(14:00〜)");
  });

  it("EDIT_LOCKED + 状態窓口への問い合わせが失敗すれば、封筒のmessageへフォールバックする(仕様6.5・fix round1)", async () => {
    stubFetchByUrl({
      "/api/properties/p1": async () =>
        jsonResponse({ error: { code: "EDIT_LOCKED", message: "他の画面で編集中です" } }, 423),
      "/api/edit-locks/status": async () => jsonResponse({ error: { message: "エラー" } }, 500),
    });
    const setError = vi.fn();
    await runNoLockPropertyPatch("p1", 1, { caseStatus: "active" }, vi.fn(), setError, vi.fn());
    expect(setError).toHaveBeenCalledWith("他の画面で編集中です");
  });

  it("EDIT_LOCKED以外のエラーも従来どおり封筒のmessageを表示する(既存挙動を変えない)", async () => {
    stubFetch(async () =>
      jsonResponse({ error: { code: "VALIDATION_ERROR", message: "入力に誤りがあります" } }, 422),
    );
    const setError = vi.fn();
    await runNoLockPropertyPatch("p1", 1, { caseStatus: "active" }, vi.fn(), setError, vi.fn());
    expect(setError).toHaveBeenCalledWith("入力に誤りがあります");
  });
});
