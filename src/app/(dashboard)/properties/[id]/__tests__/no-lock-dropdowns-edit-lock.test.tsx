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
 * ⚠(fix round2 Important A) 組み立ての問い合わせは `await` しない=封筒の
 *   messageを即座に表示し、控え(disabled/spinner)も即座に解放する。組み立てが
 *   届いたら `setError` を後から呼び直して差し替える。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runNoLockPropertyPatch } from "../page";
import { EDIT_SCREEN_HEADER, EDIT_LOCK_HEADER } from "@/lib/edit-lock/header-names";
import { setScreenTokenEnvForTest, resetScreenTokenForTest } from "@/lib/edit-lock/screen-token-client";
// review round2 Minor F: 重複していたテストヘルパー(fakeScreenTokenEnv・
// jsonResponse・stubFetch・stubFetchByUrl)を共有モジュールへまとめた。
import { fakeScreenTokenEnv, jsonResponse, stubFetch, stubFetchByUrl, flushAsync } from "@/lib/edit-lock/__tests__/test-helpers";

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
    // ⚠(review round2 Important A) 封筒のmessageを即座に表示する
    //   (状態窓口の応答を待たない・1回目は関数冒頭の setError(null))。
    expect(setError).toHaveBeenNthCalledWith(2, "他の画面で編集中です");
    await flushAsync();
    // 状態窓口が届いたら組み立てた文へ差し替える。
    expect(setError).toHaveBeenLastCalledWith("太郎さんが編集中です(14:00〜)");
  });

  it("EDIT_LOCKED + 状態窓口への問い合わせが失敗すれば、封筒のmessageへフォールバックする(仕様6.5・fix round1)", async () => {
    stubFetchByUrl({
      "/api/properties/p1": async () =>
        jsonResponse({ error: { code: "EDIT_LOCKED", message: "他の画面で編集中です" } }, 423),
      "/api/edit-locks/status": async () => jsonResponse({ error: { message: "エラー" } }, 500),
    });
    const setError = vi.fn();
    await runNoLockPropertyPatch("p1", 1, { caseStatus: "active" }, vi.fn(), setError, vi.fn());
    await flushAsync();
    expect(setError).toHaveBeenLastCalledWith("他の画面で編集中です");
  });

  it("状態窓口が固まっても、封筒のmessageを即座に表示し控えを即座に解放する(review round2 Important A)", async () => {
    vi.useFakeTimers();
    try {
      stubFetchByUrl({
        "/api/properties/p1": async () =>
          jsonResponse({ error: { code: "EDIT_LOCKED", message: "他の画面で編集中です" } }, 423),
        // ⚠固まる(解決しない)。fetchEditLockStatus は AbortSignal を持たないため、
        //   これが本番で「状態窓口が遅い/固まる」ときの再現。
        "/api/edit-locks/status": () => new Promise<Response>(() => {}),
      });
      const setError = vi.fn();
      const setSaving = vi.fn();
      await runNoLockPropertyPatch("p1", 1, { caseStatus: "active" }, setSaving, setError, vi.fn());
      // 状態窓口の応答を待たずに、封筒のmessageが即座に見える。
      expect(setError).toHaveBeenCalledWith("他の画面で編集中です");
      // 状態窓口の応答を待たずに、控え(disabled/spinner)が即座に解放される。
      expect(setSaving).toHaveBeenLastCalledWith(false);
      // 内部の上限時間タイマーを進めて後始末する(タイマーを残したままにしない)。
      await vi.advanceTimersByTimeAsync(3000);
    } finally {
      vi.useRealTimers();
    }
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
