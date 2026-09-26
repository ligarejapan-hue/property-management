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

describe("鍵の表示状態(純関数)", () => {
  it("取得できたら mine(保存できる・帯なし)", () => {
    const s = uiStateFromAcquire({ state: "mine", lockId: "l1", since: "2026-09-22T01:00:00.000Z" });
    expect(s).toEqual({ kind: "mine", lockId: "l1", since: "2026-09-22T01:00:00.000Z" });
    expect(s.kind).toBe("mine");
  });

  it("他の人が持っていたら taken(氏名と開始時刻を持つ・自分の別画面ではない)", () => {
    const s = uiStateFromAcquire({
      code: "EDIT_LOCKED", state: "held_by_other", holderName: "佐藤", since: "2026-09-22T01:00:00.000Z",
    });
    expect(s).toEqual({
      kind: "taken",
      holderName: "佐藤",
      since: "2026-09-22T01:00:00.000Z",
      bySelfOtherScreen: false,
    });
  });

  /**
   * 横断レビュー I2。どちらも「待つ」(D6)のは変わらないが、**誰が持っているかは違う**。
   * 畳んでしまうと、編集ウィンドウの帯が自分自身の氏名を「◯◯さんが編集を始めました」と
   * 出す(ページを開いた直後の競合の窓で現実に踏める。§11に3回「自分の別画面を他人扱い
   * するな」と書かれているのに4回目)。
   */
  it("自分の別画面が持っていたら taken だが「自分の別画面」の印を付ける(氏名を他人として出さない・I2)", () => {
    const s = uiStateFromAcquire({
      code: "EDIT_LOCKED", state: "held_by_self_other_screen", holderName: "自分", since: "2026-09-22T01:00:00.000Z",
    });
    expect(s).toEqual({
      kind: "taken",
      holderName: "自分",
      since: "2026-09-22T01:00:00.000Z",
      bySelfOtherScreen: true,
    });
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
    expect(uiStateFromSaveError("EDIT_LOCK_STALE", null)!.kind).toBe("expired");
    expect(uiStateFromSaveError("EDIT_LOCK_FORCE_RELEASED", null)!.kind).toBe("force_released");
    expect(uiStateFromSaveError("EDIT_LOCKED", "山田")!.kind).toBe("taken");
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
    for (const kind of Object.keys(expected) as EditLockUiState["kind"][]) {
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
