import { describe, it, expect } from "vitest";
import {
  beginRefresh,
  createRefreshState,
  resolveFailure,
  resolveSuccess,
  shouldClearLoading,
} from "@/lib/property-refresh/refresh-coordinator";

/**
 * 取り直しの交通整理を、**交差する順番を実際に並べて**確かめる。
 * ここに挙げた場面は、すべて @codex #395 の R1〜R5 で実際に指摘された穴。
 */
describe("refresh-coordinator: 単独で走る場合", () => {
  it("通常の取り直しは反映して「読み込み中」も解除する", () => {
    const s = createRefreshState();
    const t = beginRefresh(s, "full");
    expect(resolveSuccess(s, t)).toEqual({ applyData: true, clearError: true });
    expect(shouldClearLoading(s, t)).toBe(true);
  });

  it("静かな取り直しは反映するが「読み込み中」には触らない", () => {
    const s = createRefreshState();
    const t = beginRefresh(s, "quiet");
    expect(resolveSuccess(s, t).applyData).toBe(true);
    expect(shouldClearLoading(s, t)).toBe(false);
  });

  it("最新の通常の取り直しの失敗は、そのまま画面に出す", () => {
    const s = createRefreshState();
    const t = beginRefresh(s, "full");
    expect(resolveFailure(s, t, "落ちました").showError).toBe("落ちました");
  });

  it("静かな取り直しが単独で失敗しても黙っている(best-effort)", () => {
    const s = createRefreshState();
    const t = beginRefresh(s, "quiet");
    expect(resolveFailure(s, t, "落ちました").showError).toBeNull();
  });
});

describe("refresh-coordinator: 通常と静かが交差する場合", () => {
  it("古い結果は新しい結果を上書きしない(後着勝ち)", () => {
    const s = createRefreshState();
    const full = beginRefresh(s, "full");
    const quiet = beginRefresh(s, "quiet");
    expect(resolveSuccess(s, quiet).applyData).toBe(true);
    // 先に始まっていた通常の取り直しが後から返ってきても、古い内容は反映しない。
    expect(resolveSuccess(s, full).applyData).toBe(false);
  });

  it("届いた順が発行順どおりなら両方とも反映する", () => {
    const s = createRefreshState();
    const full = beginRefresh(s, "full");
    const quiet = beginRefresh(s, "quiet");
    expect(resolveSuccess(s, full).applyData).toBe(true);
    expect(resolveSuccess(s, quiet).applyData).toBe(true);
  });

  it("静かな取り直しが割り込んでも「読み込み中」は取り残されない", () => {
    // ⚠実装中に踏んだ罠: 中身の世代で縛ると、ここが false になって
    //   誰も「読み込み中」を解除できず画面が固まる。
    const s = createRefreshState();
    const full = beginRefresh(s, "full");
    beginRefresh(s, "quiet");
    expect(shouldClearLoading(s, full)).toBe(true);
  });

  it("古い通常の取り直しは、新しい通常の取り直しの「読み込み中」を解除しない", () => {
    // @codex R1 P2: 古い方が先に返っただけで解除されると、最新の取得を待たずに
    //   古い内容や「物件が見つかりません」を見せてしまう。
    const s = createRefreshState();
    const first = beginRefresh(s, "full");
    const second = beginRefresh(s, "full");
    expect(shouldClearLoading(s, first)).toBe(false);
    expect(shouldClearLoading(s, second)).toBe(true);
  });

  it("静かな取り直しが失敗しても、成功した通常の取り直しを無効にしない", () => {
    // @codex R3 P2: best-effort の失敗で世代を進めると、ちゃんと返ってきた結果まで捨てられる。
    const s = createRefreshState();
    const full = beginRefresh(s, "full");
    const quiet = beginRefresh(s, "quiet");
    expect(resolveFailure(s, quiet, "一時的な失敗").showError).toBeNull();
    expect(resolveSuccess(s, full).applyData).toBe(true);
  });

  it("追い越された失敗は即座には出さない(ページ全体をエラー画面にしない)", () => {
    // @codex R4 P2: 出すと `error || !property` の分岐でページが差し替わり、
    //   実況パネルごと消える。
    const s = createRefreshState();
    const full = beginRefresh(s, "full");
    const quiet = beginRefresh(s, "quiet");
    expect(resolveFailure(s, full, "落ちました").showError).toBeNull();
    const outcome = resolveSuccess(s, quiet);
    expect(outcome.applyData).toBe(true);
    expect(outcome.clearError).toBe(true);
  });

  it("中身が届いたら、預かっていた失敗は二度と出てこない", () => {
    const s = createRefreshState();
    const full = beginRefresh(s, "full");
    const quiet = beginRefresh(s, "quiet");
    resolveFailure(s, full, "落ちました");
    resolveSuccess(s, quiet);
    // その後の静かな取り直しが失敗しても、古い失敗を蒸し返さない。
    const later = beginRefresh(s, "quiet");
    expect(resolveFailure(s, later, "また失敗").showError).toBeNull();
  });

  it("両方の取り直しが失敗したら黙らない(元の失敗を出す)", () => {
    // @codex R5 P2: 通信障害で両方落ちたとき、何も知らせず古い内容を見せ続けない。
    const s = createRefreshState();
    const full = beginRefresh(s, "full");
    const quiet = beginRefresh(s, "quiet");
    expect(resolveFailure(s, full, "落ちました").showError).toBeNull();
    expect(resolveFailure(s, quiet, "静かな方も失敗").showError).toBe("落ちました");
  });

  it("さらに新しい取り直しが控えているなら、静かな失敗はまだ出さない", () => {
    const s = createRefreshState();
    const first = beginRefresh(s, "full");
    const quiet = beginRefresh(s, "quiet");
    const second = beginRefresh(s, "full");
    expect(resolveFailure(s, first, "1回目の失敗").showError).toBeNull();
    // quiet はもう最新ではない＝決着はまだ先。
    expect(resolveFailure(s, quiet, "静かな方も失敗").showError).toBeNull();
    // 最新の通常の取り直しが失敗したら、その失敗を出す（預かりは破棄）。
    expect(resolveFailure(s, second, "2回目の失敗").showError).toBe("2回目の失敗");
  });

  it("最新が失敗した後は、古い成功で画面を書き戻さない", () => {
    const s = createRefreshState();
    const older = beginRefresh(s, "quiet");
    const newer = beginRefresh(s, "full");
    expect(resolveFailure(s, newer, "落ちました").showError).toBe("落ちました");
    expect(resolveSuccess(s, older).applyData).toBe(false);
  });
});
