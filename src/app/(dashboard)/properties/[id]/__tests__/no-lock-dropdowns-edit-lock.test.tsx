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
 * ⚠(fix round3 Important G) 控えが即座に解放される副作用として、組み立てが
 *   届く前に利用者が再保存を成功させ得る。`setError` は世代の見張り
 *   (`prev === envelopeMessage` の一致)を条件に更新関数の形でも呼ばれるため、
 *   「最終的にどの値になるか」を検査するテストは `createStateSpy`(useState相当の
 *   フェイク)を使う。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runNoLockPropertyPatch } from "../page";
import { EDIT_SCREEN_HEADER, EDIT_LOCK_HEADER } from "@/lib/edit-lock/header-names";
import { setScreenTokenEnvForTest, resetScreenTokenForTest } from "@/lib/edit-lock/screen-token-client";
// review round2 Minor F: 重複していたテストヘルパー(fakeScreenTokenEnv・
// jsonResponse・stubFetch・stubFetchByUrl)を共有モジュールへまとめた。
import { fakeScreenTokenEnv, jsonResponse, stubFetch, stubFetchByUrl, flushAsync, createStateSpy } from "@/lib/edit-lock/__tests__/test-helpers";

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

  it("EDIT_LOCKED + 状態窓口が保持者行を返せば、氏名+時刻の文を組み立てて表示する(仕様6.5・fix round1・round3 Important Gの「まだ封筒のまま」の分岐)", async () => {
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
    const error = createStateSpy<string | null>(null);
    await runNoLockPropertyPatch("p1", 1, { caseStatus: "active" }, vi.fn(), error.setState, vi.fn());
    // ⚠(carried item 2) setError(null) が保存開始時に必ず呼ばれることのピン。
    //   `calls` はこれまで型として公開されているだけで、どのテストからも
    //   読まれていなかった(=保存開始時のリセットを外しても検査は落ちなかった)。
    expect(error.calls[0]).toBeNull();
    // ⚠(review round2 Important A) 封筒のmessageを即座に表示する
    //   (状態窓口の応答を待たない)。
    expect(error.value).toBe("他の画面で編集中です");
    await flushAsync();
    // 状態窓口が届き、かつエラーがまだこの試行の封筒のままなら組み立てた文へ差し替える。
    expect(error.value).toBe("太郎さんが編集中です(14:00〜)");
  });

  it("後着の同文言のrefusalは、先着の古い組み立てに上書きされない(caller-owned sequence number・review round3 K)", async () => {
    const since = new Date(2026, 8, 22, 14, 0).toISOString();
    const holderRow = (name: string) => ({
      locks: [
        {
          resourceType: "property" as const,
          resourceId: "p1",
          state: "held_by_other" as const,
          since,
          holderName: name,
        },
      ],
    });
    const resolvers: Array<(res: Response) => void> = [];
    let statusCall = 0;
    stubFetchByUrl({
      "/api/properties/p1": async () =>
        jsonResponse({ error: { code: "EDIT_LOCKED", message: "他の画面で編集中です" } }, 423),
      "/api/edit-locks/status": () =>
        new Promise<Response>((resolve) => {
          resolvers[statusCall++] = resolve;
        }),
    });
    const error = createStateSpy<string | null>(null);
    const seqRef = { current: 0 };
    await runNoLockPropertyPatch("p1", 1, { caseStatus: "active" }, vi.fn(), error.setState, vi.fn(), seqRef);
    await runNoLockPropertyPatch("p1", 1, { caseStatus: "active" }, vi.fn(), error.setState, vi.fn(), seqRef);
    expect(error.value).toBe("他の画面で編集中です");
    // 1回目(太郎)の組み立てが先に届く＝世代が古いので、封筒のままでも上書きしない。
    resolvers[0]?.(jsonResponse(holderRow("太郎")));
    await flushAsync();
    expect(error.value).toBe("他の画面で編集中です");
    // 2回目(次郎)の組み立てが後から届く＝これが最新なので反映する。
    resolvers[1]?.(jsonResponse(holderRow("次郎")));
    await flushAsync();
    expect(error.value).toBe("次郎さんが編集中です(14:00〜)");
  });

  it("EDIT_LOCKED + 状態窓口への問い合わせが失敗すれば、封筒のmessageへフォールバックする(仕様6.5・fix round1)", async () => {
    stubFetchByUrl({
      "/api/properties/p1": async () =>
        jsonResponse({ error: { code: "EDIT_LOCKED", message: "他の画面で編集中です" } }, 423),
      "/api/edit-locks/status": async () => jsonResponse({ error: { message: "エラー" } }, 500),
    });
    const error = createStateSpy<string | null>(null);
    await runNoLockPropertyPatch("p1", 1, { caseStatus: "active" }, vi.fn(), error.setState, vi.fn());
    await flushAsync();
    expect(error.value).toBe("他の画面で編集中です");
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
      const error = createStateSpy<string | null>(null);
      const setSaving = vi.fn();
      await runNoLockPropertyPatch("p1", 1, { caseStatus: "active" }, setSaving, error.setState, vi.fn());
      // 状態窓口の応答を待たずに、封筒のmessageが即座に見える。
      expect(error.value).toBe("他の画面で編集中です");
      // 状態窓口の応答を待たずに、控え(disabled/spinner)が即座に解放される。
      expect(setSaving).toHaveBeenLastCalledWith(false);
      // 内部の上限時間タイマー(10秒・review round3 Minor H)を進めて後始末する
      //   (タイマーを残したままにしない)。
      await vi.advanceTimersByTimeAsync(11_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("成功で消えたエラーへ、遅れて届いた組み立てが後から生えない(review round3 Important G)", async () => {
    // ⚠`let x: T | null = null` を Promise executor(ネストした関数)の中だけで
    //   再代入すると、TypeScriptの制御フロー解析がこの後の読み取り位置で
    //   `never` に絞り込んでしまう(TSの既知の挙動)。ミュータブルなオブジェクトの
    //   プロパティに逃がして回避する。
    const statusResolver: { resolve: ((res: Response) => void) | null } = { resolve: null };
    stubFetchByUrl({
      "/api/properties/p1": async () =>
        jsonResponse({ error: { code: "EDIT_LOCKED", message: "他の画面で編集中です" } }, 423),
      "/api/edit-locks/status": () =>
        new Promise<Response>((resolve) => {
          statusResolver.resolve = resolve;
        }),
    });
    const error = createStateSpy<string | null>(null);
    await runNoLockPropertyPatch("p1", 1, { caseStatus: "active" }, vi.fn(), error.setState, vi.fn());
    expect(error.value).toBe("他の画面で編集中です");
    // ⚠控えは既に解放されているため、利用者は状態窓口の応答を待たずに選び直して
    //   保存を成功させ得る(round2 Important Aの副作用)。ここではその結果として
    //   起きる「エラーが消える」ことだけを模す(実際の再保存の詳細は無関係)。
    error.setState(null);
    expect(error.value).toBeNull();
    // この試行(1回目)の組み立てが、ようやく(遅れて)届く。
    statusResolver.resolve?.(
      jsonResponse({
        locks: [
          {
            resourceType: "property",
            resourceId: "p1",
            state: "held_by_other",
            since: new Date(2026, 8, 22, 14, 0).toISOString(),
            holderName: "太郎",
          },
        ],
      }),
    );
    await flushAsync();
    // 消えたエラーへ後から生えない(世代の見張りが弾く=既に envelopeMessage
    //   ではないため、上書きしない)。
    expect(error.value).toBeNull();
  });

  it("上限時間より遅い組み立ては捨て、速い組み立ては使う(review round3 Minor H)", async () => {
    vi.useFakeTimers();
    try {
      const holderRow = (since: string) => ({
        locks: [
          {
            resourceType: "property" as const,
            resourceId: "p1",
            state: "held_by_other" as const,
            since,
            holderName: "太郎",
          },
        ],
      });
      const since = new Date(2026, 8, 22, 14, 0).toISOString();

      // 遅い方: 上限(10秒)ちょうどで既に諦めているので、後から届いても捨てる。
      // ⚠`let` ではなくミュータブルなオブジェクトに逃がす(上のテストと同じ理由=
      //   TSの制御フロー解析がこの後の読み取りを `never` に絞り込むのを避ける)。
      const slowResolver: { resolve: ((res: Response) => void) | null } = { resolve: null };
      stubFetchByUrl({
        "/api/properties/p1": async () =>
          jsonResponse({ error: { code: "EDIT_LOCKED", message: "他の画面で編集中です" } }, 423),
        "/api/edit-locks/status": () =>
          new Promise<Response>((resolve) => {
            slowResolver.resolve = resolve;
          }),
      });
      const slow = createStateSpy<string | null>(null);
      await runNoLockPropertyPatch("p1", 1, { caseStatus: "active" }, vi.fn(), slow.setState, vi.fn());
      await vi.advanceTimersByTimeAsync(10_000);
      expect(slow.value).toBe("他の画面で編集中です");
      slowResolver.resolve?.(jsonResponse(holderRow(since)));
      await vi.advanceTimersByTimeAsync(0);
      expect(slow.value).toBe("他の画面で編集中です");

      // 速い方: 上限より前(9秒後)に届けば、組み立てた文を使う。
      const fastResolver: { resolve: ((res: Response) => void) | null } = { resolve: null };
      stubFetchByUrl({
        "/api/properties/p1": async () =>
          jsonResponse({ error: { code: "EDIT_LOCKED", message: "他の画面で編集中です" } }, 423),
        "/api/edit-locks/status": () =>
          new Promise<Response>((resolve) => {
            fastResolver.resolve = resolve;
          }),
      });
      const fast = createStateSpy<string | null>(null);
      await runNoLockPropertyPatch("p1", 1, { caseStatus: "active" }, vi.fn(), fast.setState, vi.fn());
      await vi.advanceTimersByTimeAsync(9_000);
      fastResolver.resolve?.(jsonResponse(holderRow(since)));
      await vi.advanceTimersByTimeAsync(0);
      expect(fast.value).toBe("太郎さんが編集中です(14:00〜)");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Task 9: preFetchedRowsを渡すと状態窓口(/api/edit-locks/status)を呼ばずに組み立てる", async () => {
    const since = new Date(2026, 8, 22, 14, 0).toISOString();
    const fetchMock = stubFetchByUrl({
      "/api/properties/p1": async () =>
        jsonResponse({ error: { code: "EDIT_LOCKED", message: "他の画面で編集中です" } }, 423),
    });
    const error = createStateSpy<string | null>(null);
    await runNoLockPropertyPatch(
      "p1",
      1,
      { caseStatus: "active" },
      vi.fn(),
      error.setState,
      vi.fn(),
      undefined,
      [{ resourceType: "property", resourceId: "p1", state: "held_by_other", since, holderName: "太郎" }],
    );
    await flushAsync();
    expect(error.value).toBe("太郎さんが編集中です(14:00〜)");
    // ⚠状態窓口への呼び出しが1本も無いこと(呼ばれた実際のURLで確認する=
    //   「回数が2回のまま」のような無意味な検査にしない)。
    const calledUrls = fetchMock.mock.calls.map(([url]) => url);
    expect(calledUrls).not.toContain("/api/edit-locks/status");
  });

  it("Task 9: preFetchedRowsを省略すると従来どおり状態窓口へ1回問い合わせる(呼び出し元がまだ行を持っていない経路の後方互換)", async () => {
    const since = new Date(2026, 8, 22, 14, 0).toISOString();
    const fetchMock = stubFetchByUrl({
      "/api/properties/p1": async () =>
        jsonResponse({ error: { code: "EDIT_LOCKED", message: "他の画面で編集中です" } }, 423),
      "/api/edit-locks/status": async () =>
        jsonResponse({
          locks: [{ resourceType: "property", resourceId: "p1", state: "held_by_other", since, holderName: "次郎" }],
        }),
    });
    const error = createStateSpy<string | null>(null);
    await runNoLockPropertyPatch("p1", 1, { caseStatus: "active" }, vi.fn(), error.setState, vi.fn());
    await flushAsync();
    expect(error.value).toBe("次郎さんが編集中です(14:00〜)");
    const calledUrls = fetchMock.mock.calls.map(([url]) => url);
    expect(calledUrls).toContain("/api/edit-locks/status");
  });

  it("Task 9 review round1 Important 2: preFetchedRowsの行が氏名を名乗っていなければ(free/mine等)、状態窓口へ問い合わせて氏名を取りに行く(封筒文言へ後退させない)", async () => {
    const since = new Date(2026, 8, 22, 14, 0).toISOString();
    const fetchMock = stubFetchByUrl({
      "/api/properties/p1": async () =>
        jsonResponse({ error: { code: "EDIT_LOCKED", message: "他の画面で編集中です" } }, 423),
      "/api/edit-locks/status": async () =>
        jsonResponse({
          locks: [{ resourceType: "property", resourceId: "p1", state: "held_by_other", since, holderName: "花子" }],
        }),
    });
    const error = createStateSpy<string | null>(null);
    // ⚠この画面の実際の配線では、渡す行は保存ボタン自体を無効化した行と同じなので、
    //   保存が実行できる(=このcatchに入る)時点では常にfree/mineになる
    //   (レビュー指摘の再現)。ここではfreeを直接渡して固定する。
    await runNoLockPropertyPatch(
      "p1",
      1,
      { caseStatus: "active" },
      vi.fn(),
      error.setState,
      vi.fn(),
      undefined,
      [{ resourceType: "property", resourceId: "p1", state: "free" }],
    );
    await flushAsync();
    // ⚠修理前は`row.state === "held_by_other"`を満たさず`:57`が失敗し、封筒文言
    //   (「他の画面で編集中です」)のまま止まっていた。氏名まで組み立てられている。
    expect(error.value).toBe("花子さんが編集中です(14:00〜)");
    const calledUrls = fetchMock.mock.calls.map(([url]) => url);
    expect(calledUrls).toContain("/api/edit-locks/status");
  });

  it("Task 9 review round1 Important 2: preFetchedRowsに該当資源の行が無いときも、状態窓口へ問い合わせる(:56のフォールバック漏れの修理)", async () => {
    const since = new Date(2026, 8, 22, 14, 0).toISOString();
    const fetchMock = stubFetchByUrl({
      "/api/properties/p1": async () =>
        jsonResponse({ error: { code: "EDIT_LOCKED", message: "他の画面で編集中です" } }, 423),
      "/api/edit-locks/status": async () =>
        jsonResponse({
          locks: [{ resourceType: "property", resourceId: "p1", state: "held_by_other", since, holderName: "三郎" }],
        }),
    });
    const error = createStateSpy<string | null>(null);
    await runNoLockPropertyPatch(
      "p1",
      1,
      { caseStatus: "active" },
      vi.fn(),
      error.setState,
      vi.fn(),
      undefined,
      // ⚠p1についての行が1件も無い配列(空配列)を渡す。
      [],
    );
    await flushAsync();
    expect(error.value).toBe("三郎さんが編集中です(14:00〜)");
    const calledUrls = fetchMock.mock.calls.map(([url]) => url);
    expect(calledUrls).toContain("/api/edit-locks/status");
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
