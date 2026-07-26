/**
 * 実況パネル (謄本所在検索のライブ中継) のメモリ内ストアのテスト。
 *
 * 規約 (candidate-cache.ts と同型):
 *  - 単一プロセス前提の in-memory Map。DB / ディスクへ永続しない。
 *  - スクショは「その場限り」: 完了後 + TTL で必ず消える。追加時に期限切れ
 *    prune + 同一 user×property の旧エントリ破棄 (無限増大防止)。
 *  - shot は枚数 / 総バイト数の cap を超えたら保存しない (steps の文字情報は残す)。
 *  - 取得は実行者本人 (userId 一致) のみ = key に userId を含める。
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  beginLiveView,
  reportLiveStep,
  completeLiveView,
  getLiveView,
  getLiveShot,
  LIVE_VIEW_TTL_MS,
  LIVE_VIEW_MAX_SHOTS,
  LIVE_VIEW_MAX_TOTAL_SHOT_BYTES,
  __clearLiveViewStoreForTests,
  __liveViewStoreSizeForTests,
} from "@/lib/registry-fetch/live-view-store";

const U = "user-1";
const P = "prop-1";
const R = "ref-abc12345";

beforeEach(() => {
  __clearLiveViewStoreForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function shot(bytes: number): Uint8Array {
  return new Uint8Array(bytes).fill(1);
}

describe("live-view-store", () => {
  it("begin → step → complete の基本フロー (steps は文字情報 + hasShot)", () => {
    beginLiveView(U, P, R);
    reportLiveStep(U, P, R, "ログイン中 (画面は省略)", null);
    reportLiveStep(U, P, R, "所在の入力", shot(100));
    completeLiveView(U, P, R);
    const v = getLiveView(U, P, R);
    expect(v).not.toBeNull();
    expect(v!.done).toBe(true);
    expect(v!.steps.map((s) => s.label)).toEqual([
      "ログイン中 (画面は省略)",
      "所在の入力",
    ]);
    expect(v!.steps[0].hasShot).toBe(false);
    expect(v!.steps[1].hasShot).toBe(true);
    expect(getLiveShot(U, P, R, v!.steps[1].seq)).not.toBeNull();
    expect(getLiveShot(U, P, R, v!.steps[0].seq)).toBeNull();
  });

  it("begin していない ref への step は無視される (誤配線で落ちない)", () => {
    reportLiveStep(U, P, R, "x", null);
    expect(getLiveView(U, P, R)).toBeNull();
  });

  it("userId が違えば見えない (実行者本人のみ)", () => {
    beginLiveView(U, P, R);
    reportLiveStep(U, P, R, "所在の入力", shot(10));
    expect(getLiveView("other-user", P, R)).toBeNull();
    expect(getLiveShot("other-user", P, R, 0)).toBeNull();
  });

  it("TTL 経過で消える (完了後も未完了でも)", () => {
    beginLiveView(U, P, R);
    reportLiveStep(U, P, R, "a", shot(10));
    completeLiveView(U, P, R);
    vi.advanceTimersByTime(LIVE_VIEW_TTL_MS + 1000);
    expect(getLiveView(U, P, R)).toBeNull();
    expect(getLiveShot(U, P, R, 0)).toBeNull();
  });

  it("アクセスが一切来なくても TTL で自動削除される (scheduled expiry・@codex P2)", () => {
    // パネルは done でポーリングを止めるため、以後の get は来ないのが通常経路。
    // アクセス起点の prune に頼らず、タイマー発火でプロセス内から必ず消える。
    beginLiveView(U, P, R);
    reportLiveStep(U, P, R, "a", shot(100));
    completeLiveView(U, P, R);
    expect(__liveViewStoreSizeForTests()).toBe(1);
    vi.advanceTimersByTime(LIVE_VIEW_TTL_MS + 1000);
    // get を呼ばずにサイズだけ確認
    expect(__liveViewStoreSizeForTests()).toBe(0);
  });

  it("旧エントリの残タイマーが同一 key の新エントリを誤削除しない", () => {
    beginLiveView(U, P, R);
    vi.advanceTimersByTime(LIVE_VIEW_TTL_MS - 1000);
    // 同一 user×property×ref で新しい実行を開始 (旧タイマーは clear される)
    beginLiveView(U, P, R);
    reportLiveStep(U, P, R, "fresh", shot(10));
    // 旧タイマーの発火予定時刻を跨いでも、新エントリは生きている
    vi.advanceTimersByTime(2000);
    expect(getLiveView(U, P, R)).not.toBeNull();
    // 新エントリ自身の TTL では消える
    vi.advanceTimersByTime(LIVE_VIEW_TTL_MS + 1000);
    expect(__liveViewStoreSizeForTests()).toBe(0);
  });

  it("同一 user×property の新規 begin は旧エントリを破棄する (滞留防止)", () => {
    beginLiveView(U, P, "ref-old0001");
    reportLiveStep(U, P, "ref-old0001", "a", shot(10));
    beginLiveView(U, P, "ref-new0001");
    expect(getLiveView(U, P, "ref-old0001")).toBeNull();
    expect(getLiveView(U, P, "ref-new0001")).not.toBeNull();
    expect(__liveViewStoreSizeForTests()).toBe(1);
  });

  it("shot 枚数 cap 超過は画像を保存しない (steps は残る)", () => {
    beginLiveView(U, P, R);
    for (let i = 0; i < LIVE_VIEW_MAX_SHOTS + 5; i++) {
      reportLiveStep(U, P, R, `step-${i}`, shot(10));
    }
    const v = getLiveView(U, P, R)!;
    expect(v.steps.length).toBe(LIVE_VIEW_MAX_SHOTS + 5);
    const withShot = v.steps.filter((s) => s.hasShot);
    expect(withShot.length).toBe(LIVE_VIEW_MAX_SHOTS);
  });

  it("shot 総バイト cap 超過は画像を保存しない", () => {
    beginLiveView(U, P, R);
    reportLiveStep(U, P, R, "big-1", shot(LIVE_VIEW_MAX_TOTAL_SHOT_BYTES - 10));
    reportLiveStep(U, P, R, "big-2", shot(1024));
    const v = getLiveView(U, P, R)!;
    expect(v.steps[0].hasShot).toBe(true);
    expect(v.steps[1].hasShot).toBe(false);
  });
});
