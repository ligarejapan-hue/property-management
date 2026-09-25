/**
 * 法人番号の反映パネル(corporate-lookup-panel.tsx)に配線した編集中の鍵
 * (仕様 6.1・6.5・Task 8・6入口目)を node で検証する。
 *
 * このパネルは**物件詳細の所有者カード内**と **`admin/owners/[id]`** の2画面に
 * 置かれ、鍵の有無が画面ごとに変わる:
 * - 所有者カード内: カードが持つ鍵の世代(`lock.lockId`)を props で受け取り、
 *   反映の保存(`applyOwnerCorporate`)に `X-Edit-Lock` として載せる。反映が
 *   鍵の失効(`EDIT_LOCK_STALE`/`EDIT_LOCK_FORCE_RELEASED`)で断られたら、
 *   `onLockRefused` 経由でカードの鍵コントローラ(`lock.noteSaveError`)へも
 *   伝える(review round1 Important #3)。
 * - `admin/owners/[id]`: 鍵を持たない入口。合言葉(`X-Edit-Screen`)だけを送り、
 *   423 のときはこのパネル自身が氏名+時刻の文言を組み立てて表示する(仕様6.5)。
 *   `onLockRefused` は渡らない(=何も起きない)。
 *
 * ⚠このリポジトリは jsdom を使わない方針(vitest.config.ts が environment: "node" を
 *   固定)。パネルを描画してクリックするテストは書けないので、
 *   - `applyOwnerCorporate` のヘッダ組み立て(第3引数 opts.lockId)
 *   - 423 の文言組み立て(`handleCorporateApplyEditLockedError`・node から直接呼ぶ)
 *   - 反映失敗のカードへの報告(`reportCorporateApplyLockRefusal`・node から直接呼ぶ)
 *   の3つは実際に関数を呼んで node で検証し、
 *   - 配線そのもの(2画面での lockId/onLockRefused の受け渡し・handleApply の
 *     catch節がこれらを呼んでいること)
 *   は `save-entrypoints-scan.test.ts` 側の走査(source assertion)で固定する。
 *   ⚠(review round1 Important #4) この3つの source assertion をこのファイルにも
 *     複製しない。1箇所(scan test=ratchet)だけに置き、正当なリファクタで
 *     どちらかだけが赤くなる/どちらかを消して唯一の網を失う、を避ける。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { applyOwnerCorporate, apiErrorCode } from "@/lib/api-client";
import {
  handleCorporateApplyEditLockedError,
  reportCorporateApplyLockRefusal,
} from "../corporate-lookup-panel";
import { EDIT_SCREEN_HEADER, EDIT_LOCK_HEADER } from "@/lib/edit-lock/header-names";
import { setScreenTokenEnvForTest, resetScreenTokenForTest } from "@/lib/edit-lock/screen-token-client";
import {
  fakeScreenTokenEnv,
  jsonResponse,
  stubFetch,
  stubFetchByUrl,
  flushAsync,
  createStateSpy,
} from "@/lib/edit-lock/__tests__/test-helpers";

const BASE_PAYLOAD = {
  corporateNumber: "1234567890123",
  version: 1,
  apply: { name: true, address: false, zip: false, corporateNumber: false },
  expectedRecord: {
    corporateNumber: "1234567890123",
    name: "モック株式会社",
    address: "東京都千代田区丸の内1-1-1",
    postCode: null,
    updateDate: null,
  },
};

describe("applyOwnerCorporate(法人番号の反映)のヘッダ", () => {
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

  it("1) opts.lockIdを渡すとX-Edit-Lockにその値を載せる(合言葉も同時に載る)", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ ok: true, owner: { id: "o1", version: 2 } }),
    );
    await applyOwnerCorporate("o1", BASE_PAYLOAD, { lockId: "l1" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/owners/o1/corporate-apply");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers[EDIT_LOCK_HEADER]).toBe("l1");
    expect(headers[EDIT_SCREEN_HEADER]).toBe("screen-1");
  });

  it("2) 第3引数(opts)を省略するとX-Edit-Screenだけを載せ、X-Edit-Lockは載せない(鍵を持たない既存の呼び出し元と同じ形)", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ ok: true, owner: { id: "o1", version: 2 } }),
    );
    await applyOwnerCorporate("o1", BASE_PAYLOAD);

    const [, init] = fetchMock.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers[EDIT_SCREEN_HEADER]).toBe("screen-1");
    expect(EDIT_LOCK_HEADER in headers).toBe(false);
  });

  it("3) lockIdがnullのときもX-Edit-Lockは載せない(取得できていない状態と同じ扱い)", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ ok: true, owner: { id: "o1", version: 2 } }),
    );
    await applyOwnerCorporate("o1", BASE_PAYLOAD, { lockId: null });

    const [, init] = fetchMock.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(EDIT_LOCK_HEADER in headers).toBe(false);
  });

  it("bodyは従来どおりpayloadそのまま(ヘッダの追加以外は挙動を変えない)", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ ok: true, owner: { id: "o1", version: 2 } }),
    );
    await applyOwnerCorporate("o1", BASE_PAYLOAD, { lockId: "l1" });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual(BASE_PAYLOAD);
  });

  it("実際の423レスポンス(toApiError経由)がhandleCorporateApplyEditLockedErrorへ正しく渡り、氏名+時刻の文が組み立てられる(review round1 Minor #8)", async () => {
    // ⚠他のテストは Object.assign(new Error(...), { code }) で手組みした err を
    //   直接渡している。「423の封筒 → toApiError → code/message → 組み立て」の
    //   実配線は登記ポップアップ側のテストにしか無かった(このパネルには無かった)。
    //   ここで実際に fetch → apiFetch(toApiError) → 例外 という経路を1本通す。
    const since = new Date(2026, 8, 22, 14, 0).toISOString();
    stubFetchByUrl({
      "/api/owners/o1/corporate-apply": async () =>
        jsonResponse({ error: { code: "EDIT_LOCKED", message: "他の画面で編集中です" } }, 423),
      "/api/edit-locks/status": async () =>
        jsonResponse({
          locks: [
            {
              resourceType: "owner",
              resourceId: "o1",
              state: "held_by_other",
              since,
              holderName: "太郎",
            },
          ],
        }),
    });
    let caught: unknown;
    try {
      await applyOwnerCorporate("o1", BASE_PAYLOAD);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(apiErrorCode(caught)).toBe("EDIT_LOCKED");
    const error = createStateSpy<string | null>(null);
    const seqRef = { current: 1 };
    const handled = handleCorporateApplyEditLockedError(caught, "o1", error.setState, seqRef, 1);
    expect(handled).toBe(true);
    expect(error.value).toBe("他の画面で編集中です");
    await flushAsync();
    expect(error.value).toBe("太郎さんが編集中です(14:00〜)");
  });
});

/**
 * handleCorporateApplyEditLockedError(423のとき既存のエラー位置に文言が出る・仕様6.5)。
 * ⚠registry-chiban-popup.tsx / page.tsx の同種テストと同じ構造(review round1〜3の
 *   教訓をそのまま踏襲)。
 * ⚠(review round1 Minor #10) `seqRef`/`mySeq` に default は無い。呼び出し元
 *   (`handleApply`)は必ず自分の採番を渡す契約なので、テストも常に明示的な
 *   `{ current: n }` と数値を渡す。
 */
describe("handleCorporateApplyEditLockedError(鍵を持たない入口としての反映エラー・node で直接呼ぶ)", () => {
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

  it("EDIT_LOCKED以外はfalseを返し、applyErrorに一切触らない(既存の msg.includes 分岐を壊さない)", () => {
    const error = createStateSpy<string | null>(null);
    const err = Object.assign(new Error("他のユーザーが先に更新しました"), { code: "CONFLICT" });
    expect(apiErrorCode(err)).toBe("CONFLICT");
    const handled = handleCorporateApplyEditLockedError(err, "o1", error.setState, { current: 0 }, 1);
    expect(handled).toBe(false);
    expect(error.calls.length).toBe(0);
  });

  it("Errorインスタンスでない値が来てもfalseを返す(型ガード)", () => {
    const error = createStateSpy<string | null>(null);
    const handled = handleCorporateApplyEditLockedError("boom", "o1", error.setState, { current: 0 }, 1);
    expect(handled).toBe(false);
    expect(error.calls.length).toBe(0);
  });

  it("EDIT_LOCKED + 状態窓口が保持者行を返せば、氏名+時刻の文を組み立てて表示する(仕様6.5)", async () => {
    const since = new Date(2026, 8, 22, 14, 0).toISOString();
    stubFetchByUrl({
      "/api/edit-locks/status": async () =>
        jsonResponse({
          locks: [
            {
              resourceType: "owner",
              resourceId: "o1",
              state: "held_by_other",
              since,
              holderName: "太郎",
            },
          ],
        }),
    });
    const error = createStateSpy<string | null>(null);
    const err = Object.assign(new Error("他の画面で編集中です"), { code: "EDIT_LOCKED" });
    const handled = handleCorporateApplyEditLockedError(err, "o1", error.setState, { current: 1 }, 1);
    expect(handled).toBe(true);
    // ⚠(carried item 2) setApplyError(null)-at-save-startはhandleApply側が既に
    //   持つ責務であってこの関数の責務ではないため、ここでは封筒のmessageが
    //   最初の呼び出しであることだけを見る(この関数自体はリセットしない)。
    expect(error.calls[0]).toBe("他の画面で編集中です");
    expect(error.value).toBe("他の画面で編集中です");
    await flushAsync();
    expect(error.value).toBe("太郎さんが編集中です(14:00〜)");
  });

  it("状態窓口への問い合わせが失敗すれば、封筒のmessageへフォールバックする", async () => {
    stubFetchByUrl({
      "/api/edit-locks/status": async () => jsonResponse({ error: { message: "エラー" } }, 500),
    });
    const error = createStateSpy<string | null>(null);
    const err = Object.assign(new Error("他の画面で編集中です"), { code: "EDIT_LOCKED" });
    handleCorporateApplyEditLockedError(err, "o1", error.setState, { current: 1 }, 1);
    await flushAsync();
    expect(error.value).toBe("他の画面で編集中です");
  });

  it("成功で消えたエラーへ、遅れて届いた組み立てが後から生えない(review round3 Important G)", async () => {
    const statusResolver: { resolve: ((res: Response) => void) | null } = { resolve: null };
    stubFetchByUrl({
      "/api/edit-locks/status": () =>
        new Promise<Response>((resolve) => {
          statusResolver.resolve = resolve;
        }),
    });
    const error = createStateSpy<string | null>(null);
    const err = Object.assign(new Error("他の画面で編集中です"), { code: "EDIT_LOCKED" });
    handleCorporateApplyEditLockedError(err, "o1", error.setState, { current: 1 }, 1);
    expect(error.value).toBe("他の画面で編集中です");
    // 控えは既に解放されているため、利用者が再反映を成功させ得る(round2 Important Aの副作用)。
    error.setState(null);
    expect(error.value).toBeNull();
    statusResolver.resolve?.(
      jsonResponse({
        locks: [
          {
            resourceType: "owner",
            resourceId: "o1",
            state: "held_by_other",
            since: new Date(2026, 8, 22, 14, 0).toISOString(),
            holderName: "太郎",
          },
        ],
      }),
    );
    await flushAsync();
    expect(error.value).toBeNull();
  });

  it("後着の同文言のrefusalは、先着の古い組み立てに上書きされない(caller-owned sequence number・review round3 K)", async () => {
    const since = new Date(2026, 8, 22, 14, 0).toISOString();
    const holderRow = (name: string) => ({
      locks: [
        {
          resourceType: "owner" as const,
          resourceId: "o1",
          state: "held_by_other" as const,
          since,
          holderName: name,
        },
      ],
    });
    const resolvers: Array<(res: Response) => void> = [];
    let call = 0;
    stubFetchByUrl({
      "/api/edit-locks/status": () =>
        new Promise<Response>((resolve) => {
          resolvers[call++] = resolve;
        }),
    });
    const error = createStateSpy<string | null>(null);
    // ⚠この2回は同じ試行(=呼び出し元が同じhandleApply呼び出し内で2回起きた
    //   ケースを模す)。呼び出し元がhandleApplyの頭で1回だけ採番するのと同じく、
    //   ここでも同じseqRefを共有しつつ、1回目はmySeq=1(古い)、2回目は
    //   seqRef.currentを2へ進めてmySeq=2(新しい)を渡す。
    const seqRef = { current: 1 };
    const err = Object.assign(new Error("他の画面で編集中です"), { code: "EDIT_LOCKED" });
    handleCorporateApplyEditLockedError(err, "o1", error.setState, seqRef, 1);
    seqRef.current = 2;
    handleCorporateApplyEditLockedError(err, "o1", error.setState, seqRef, 2);
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

  it("異なるseqRef(=別のパネルインスタンス)は互いに干渉しない(review round1 Important #2の書き直し)", async () => {
    // ⚠旧テストは「seqRefを省略した2回の呼び出しはそれぞれ独立」と名乗りながら
    //   関数を1回しか呼んでおらず、seqRefをモジュール共有の{current:0}へ差し替える
    //   mutationでも green のままだった(review round1 Important #2で指摘・
    //   mutationで確認済み)。ここでは実際に2つの独立したパネルインスタンス
    //   (別々のownerId・別々のseqRef)を模して2回呼び、片方の世代が進んでも
    //   もう片方に影響しないことを検証する。
    const since = new Date(2026, 8, 22, 14, 0).toISOString();
    const resolversA: Array<(res: Response) => void> = [];
    const resolversB: Array<(res: Response) => void> = [];
    let callA = 0;
    let callB = 0;
    stubFetchByUrl({
      "/api/edit-locks/status": (init) => {
        const body = JSON.parse((init?.body as string) ?? "{}") as {
          resources?: Array<{ resourceId: string }>;
        };
        const resourceId = body.resources?.[0]?.resourceId;
        return new Promise<Response>((resolve) => {
          if (resourceId === "o-a") resolversA[callA++] = resolve;
          else resolversB[callB++] = resolve;
        });
      },
    });
    const errorA = createStateSpy<string | null>(null);
    const errorB = createStateSpy<string | null>(null);
    // 2つの独立したパネル。たまたま同じ番号(mySeq=1)から始まる。
    const seqRefA = { current: 1 };
    const seqRefB = { current: 1 };
    const errA = Object.assign(new Error("他の画面で編集中です"), { code: "EDIT_LOCKED" });
    const errB = Object.assign(new Error("他の画面で編集中です"), { code: "EDIT_LOCKED" });
    handleCorporateApplyEditLockedError(errA, "o-a", errorA.setState, seqRefA, 1);
    handleCorporateApplyEditLockedError(errB, "o-b", errorB.setState, seqRefB, 1);
    // Aだけ後発の試行が始まった(=seqRefA.currentが進んだ)としても、
    // Bのseq比較はBのseqRefBしか見ないため無関係。
    seqRefA.current = 2;
    resolversA[0]?.(
      jsonResponse({
        locks: [
          { resourceType: "owner", resourceId: "o-a", state: "held_by_other", since, holderName: "太郎" },
        ],
      }),
    );
    await flushAsync();
    // Aは自分のseqRefが進んだので、mySeq=1の組み立ては古いとみなされ捨てられる。
    expect(errorA.value).toBe("他の画面で編集中です");
    resolversB[0]?.(
      jsonResponse({
        locks: [
          { resourceType: "owner", resourceId: "o-b", state: "held_by_other", since, holderName: "次郎" },
        ],
      }),
    );
    await flushAsync();
    // Bのseqrefは進んでいないので、mySeq=1の組み立てはそのまま反映される
    // (=Aの世代の変化に一切引きずられない)。
    expect(errorB.value).toBe("次郎さんが編集中です(14:00〜)");
  });
});

/**
 * reportCorporateApplyLockRefusal(反映の失敗をカードの鍵コントローラへ伝える・
 * review round1 Important #3)。
 */
describe("reportCorporateApplyLockRefusal(反映の失敗をカードへ報告・node で直接呼ぶ)", () => {
  it("onLockRefusedがあれば、apiErrorCode(err)をそのまま渡す(鍵の失効=カード側)", () => {
    const onLockRefused = vi.fn();
    const err = Object.assign(
      new Error("編集の鍵が外れています。画面を開き直してください"),
      { code: "EDIT_LOCK_STALE" },
    );
    reportCorporateApplyLockRefusal(err, onLockRefused);
    expect(onLockRefused).toHaveBeenCalledTimes(1);
    expect(onLockRefused).toHaveBeenCalledWith("EDIT_LOCK_STALE");
  });

  it("管理者に強制解除されたときのコードもそのまま渡す", () => {
    const onLockRefused = vi.fn();
    const err = Object.assign(
      new Error("管理者が編集を終了しました。この内容は保存できません"),
      { code: "EDIT_LOCK_FORCE_RELEASED" },
    );
    reportCorporateApplyLockRefusal(err, onLockRefused);
    expect(onLockRefused).toHaveBeenCalledWith("EDIT_LOCK_FORCE_RELEASED");
  });

  it("鍵に無関係なコードもそのまま渡す(分岐しない・写像はuiStateFromSaveErrorへ任せる)", () => {
    const onLockRefused = vi.fn();
    const err = Object.assign(new Error("他のユーザーが先に更新しました"), { code: "CONFLICT" });
    reportCorporateApplyLockRefusal(err, onLockRefused);
    expect(onLockRefused).toHaveBeenCalledWith("CONFLICT");
  });

  it("onLockRefusedが無ければ何もしない(admin/owners/[id]・例外を投げない)", () => {
    const err = Object.assign(new Error("他の画面で編集中です"), { code: "EDIT_LOCKED" });
    expect(() => reportCorporateApplyLockRefusal(err, undefined)).not.toThrow();
  });
});
