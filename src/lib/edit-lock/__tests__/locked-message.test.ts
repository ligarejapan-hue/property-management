/**
 * `showComposedEditLockedMessage`(横断レビュー I2・3つめ)。
 *
 * 鍵を**持つ**2入口(編集ウィンドウ・所有者カード)が保存で 423 `EDIT_LOCKED` を
 * 受けたとき、これまでは封筒の `message`(段階1のサーバは「他の画面で編集中です」
 * しか返さない)をそのまま出すだけで、**氏名も時刻も出なかった**。鍵を持たない
 * 3入口は `composeEditLockedMessage` で状態窓口を1回引いて実名+時刻を出しており、
 * 「最も名前が要る2画面が、最も要らない3入口より情報が少ない」状態だった。
 * 同じ helper をこちらでも通す。
 *
 * ⚠`await` しない(封筒の message を即座に出し、組み立ては届いてから差し替える)・
 *   差し替えは世代の見張り(`prev === envelopeMessage`)つき、という round2 Important A /
 *   round3 Important G の作りをそのまま共有する。
 * ⚠**仕上げround2の裁定**: 引いた保持者は呼び出し側にも渡す(`onHolderIdentified`)。
 *   エラー表示だけが実名を名乗り、すぐ上の帯が「他の利用者さん」と言う食い違いを
 *   出さないため。問い合わせは**1回だけ**(エラー表示と帯の両方がその1回の結果を使う)。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { showComposedEditLockedMessage, type EditLockHolder } from "../locked-message";
import { jsonResponse, stubFetch, flushAsync, createStateSpy } from "./test-helpers";

const STATUS_URL = "/api/edit-locks/status";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const heldRow = (
  since: string,
  resourceType: "property" | "owner" = "property",
  resourceId = "p1",
) => ({
  locks: [{ resourceType, resourceId, state: "held_by_other", holderName: "山田", since }],
});

describe("showComposedEditLockedMessage(鍵を持つ入口の423の文言)", () => {
  it("封筒の message を同期的に出し、届いた組み立て(氏名+時刻)へ差し替える", async () => {
    const since = new Date(2026, 8, 22, 14, 2).toISOString();
    stubFetch(async () => jsonResponse(heldRow(since)));
    const spy = createStateSpy<string | null>(null);

    showComposedEditLockedMessage("property", "p1", "他の画面で編集中です", spy.setState, vi.fn());
    // まだ問い合わせの応答を待っていない時点で、封筒の message が出ている。
    expect(spy.value).toBe("他の画面で編集中です");

    await flushAsync();
    expect(spy.value).toBe("山田さんが編集中です(14:02〜)");
  });

  it("状態窓口を1回だけ引く(先読み・ポーリングをしない。帯とエラー表示が同じ1回の結果を使う)", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(heldRow(new Date().toISOString(), "owner", "o1")),
    );
    const spy = createStateSpy<string | null>(null);
    const onHolder = vi.fn();

    showComposedEditLockedMessage("owner", "o1", "他の画面で編集中です", spy.setState, onHolder);
    await flushAsync();

    // ⚠帯のために2回目を引いていないこと(仕上げround2の要件)。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(STATUS_URL);
    expect(onHolder).toHaveBeenCalledTimes(1);
  });

  it("問い合わせが失敗したら封筒の message のまま(画面を無言にしない)", async () => {
    stubFetch(async () => jsonResponse({ error: { message: "boom" } }, 500));
    const spy = createStateSpy<string | null>(null);

    showComposedEditLockedMessage("property", "p1", "他の画面で編集中です", spy.setState, vi.fn());
    await flushAsync();

    expect(spy.value).toBe("他の画面で編集中です");
  });

  it("届くまでに表示が別の値へ変わっていたら上書きしない(round3 Important G の世代の見張り)", async () => {
    stubFetch(async () => jsonResponse(heldRow(new Date().toISOString())));
    const spy = createStateSpy<string | null>(null);

    showComposedEditLockedMessage("property", "p1", "他の画面で編集中です", spy.setState, vi.fn());
    // 組み立てが届く前に保存が成功した(=エラー表示が消えた)。
    spy.setState(null);
    await flushAsync();

    expect(spy.value).toBeNull();
  });

  describe("引いた保持者を呼び出し側へ渡す(仕上げround2の裁定=帯にも実名を出すため)", () => {
    it("氏名と開始時刻をそのまま渡す(帯が『他の利用者さん』のままにならない)", async () => {
      const since = new Date(2026, 8, 22, 14, 2).toISOString();
      stubFetch(async () => jsonResponse(heldRow(since)));
      const spy = createStateSpy<string | null>(null);
      const holders: EditLockHolder[] = [];

      showComposedEditLockedMessage("property", "p1", "他の画面で編集中です", spy.setState, (h) =>
        holders.push(h),
      );
      // 応答を待っている間は呼ばれない(帯は既定の文言で即座に出ている)。
      expect(holders).toEqual([]);

      await flushAsync();
      expect(holders).toEqual([{ holderName: "山田", since }]);
      // ⚠エラー表示側は氏名+**時刻**を保ち続ける(帯の一文には時刻が入らないため、
      //   時刻を名乗るのはこちらだけ)。
      expect(spy.value).toBe("山田さんが編集中です(14:02〜)");
    });

    it("誰も名乗れないとき(問い合わせ失敗)は渡さない=帯は既定の文言のまま", async () => {
      stubFetch(async () => jsonResponse({ error: { message: "boom" } }, 500));
      const spy = createStateSpy<string | null>(null);
      const onHolder = vi.fn();

      showComposedEditLockedMessage("property", "p1", "他の画面で編集中です", spy.setState, onHolder);
      await flushAsync();

      expect(onHolder).not.toHaveBeenCalled();
      expect(spy.value).toBe("他の画面で編集中です");
    });

    it("該当行が無い/「他の人が持っている」以外(空いた・自分の別画面)なら渡さない", async () => {
      stubFetch(async () =>
        jsonResponse({
          locks: [{ resourceType: "property", resourceId: "p1", state: "free" }],
        }),
      );
      const spy = createStateSpy<string | null>(null);
      const onHolder = vi.fn();

      showComposedEditLockedMessage("property", "p1", "他の画面で編集中です", spy.setState, onHolder);
      await flushAsync();

      expect(onHolder).not.toHaveBeenCalled();
      expect(spy.value).toBe("他の画面で編集中です");
    });
  });
});
