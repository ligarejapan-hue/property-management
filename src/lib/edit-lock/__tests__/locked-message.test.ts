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
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { showComposedEditLockedMessage } from "../locked-message";
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

    showComposedEditLockedMessage("property", "p1", "他の画面で編集中です", spy.setState);
    // まだ問い合わせの応答を待っていない時点で、封筒の message が出ている。
    expect(spy.value).toBe("他の画面で編集中です");

    await flushAsync();
    expect(spy.value).toBe("山田さんが編集中です(14:02〜)");
  });

  it("状態窓口を1回だけ引く(先読み・ポーリングをしない)", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(heldRow(new Date().toISOString(), "owner", "o1")),
    );
    const spy = createStateSpy<string | null>(null);

    showComposedEditLockedMessage("owner", "o1", "他の画面で編集中です", spy.setState);
    await flushAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(STATUS_URL);
  });

  it("問い合わせが失敗したら封筒の message のまま(画面を無言にしない)", async () => {
    stubFetch(async () => jsonResponse({ error: { message: "boom" } }, 500));
    const spy = createStateSpy<string | null>(null);

    showComposedEditLockedMessage("property", "p1", "他の画面で編集中です", spy.setState);
    await flushAsync();

    expect(spy.value).toBe("他の画面で編集中です");
  });

  it("届くまでに表示が別の値へ変わっていたら上書きしない(round3 Important G の世代の見張り)", async () => {
    stubFetch(async () => jsonResponse(heldRow(new Date().toISOString())));
    const spy = createStateSpy<string | null>(null);

    showComposedEditLockedMessage("property", "p1", "他の画面で編集中です", spy.setState);
    // 組み立てが届く前に保存が成功した(=エラー表示が消えた)。
    spy.setState(null);
    await flushAsync();

    expect(spy.value).toBeNull();
  });
});
