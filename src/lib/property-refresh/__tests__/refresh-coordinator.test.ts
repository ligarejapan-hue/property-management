import { describe, it, expect } from "vitest";
import {
  type RefreshKind,
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
    expect(resolveSuccess(s, t)).toEqual({
      applyData: true,
      clearError: true,
      showError: null,
    });
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

  it("古い成功は、より新しい失敗の預かりを消さない(full1/full2/quiet3)", () => {
    // @codex R6 P2: full2 が失敗して預かりになった後に**より古い** full1 が成功しても、
    //   full2 の失敗は未解決のまま。ここで預かりを消すと、quiet3 も失敗したときに
    //   何も知らせず、full1 の古い内容だけが残る。
    const s = createRefreshState();
    const full1 = beginRefresh(s, "full");
    const full2 = beginRefresh(s, "full");
    const quiet3 = beginRefresh(s, "quiet");
    expect(resolveFailure(s, full2, "2回目が失敗").showError).toBeNull();
    expect(resolveSuccess(s, full1).applyData).toBe(true);
    expect(resolveFailure(s, quiet3, "静かな方も失敗").showError).toBe("2回目が失敗");
  });

  it("預かりより新しい中身が届いたら、預かりは消える", () => {
    const s = createRefreshState();
    const full1 = beginRefresh(s, "full");
    const quiet2 = beginRefresh(s, "quiet");
    resolveFailure(s, full1, "1回目が失敗");
    expect(resolveSuccess(s, quiet2).applyData).toBe(true);
    const later = beginRefresh(s, "quiet");
    expect(resolveFailure(s, later, "また失敗").showError).toBeNull();
  });

  it("最新が失敗した後は、古い成功で画面を書き戻さない", () => {
    const s = createRefreshState();
    const older = beginRefresh(s, "quiet");
    const newer = beginRefresh(s, "full");
    expect(resolveFailure(s, newer, "落ちました").showError).toBe("落ちました");
    expect(resolveSuccess(s, older).applyData).toBe(false);
  });
});

/**
 * 総当たり: 発行する取り直しの種類・成否・**返ってくる順番**の全組み合わせで、
 * 守るべき約束が破れないことを確かめる。
 *
 * ⚠これを書いた動機: 個別の場面を1つずつ塞ぐやり方では、@codex に 6 巡連続で
 *   「その隣」を指摘された。**順番の交差は人が数え上げるには多すぎる**ので機械に任せる。
 *   実際このテストを書いた時点で、まだ塞げていない穴が1つ見つかった
 *   （静かな更新が先に失敗し、後から通常の更新が失敗すると、預かりを渡す相手がいない）。
 */
describe("refresh-coordinator: 総当たり(守るべき約束が破れない)", () => {
  interface Step {
    kind: RefreshKind;
    ok: boolean;
  }

  /**
   * 発行を全部済ませてから、指定の順番で決着させる（＝重なって走っている状態）。
   * ⚠settleOrder は**部分列でよい**＝載っていないチケットは「まだ返ってこない」
   *   （遅い・固まっている）。@codex R8 P2: この場合を試していなかった。
   */
  const simulate = (steps: Step[], settleOrder: number[]) => {
    const state = createRefreshState();
    const tickets = steps.map((s) => beginRefresh(state, s.kind));
    let shownError: string | null = null;
    let loadingCleared = false;
    let lastApplied = 0;
    for (const i of settleOrder) {
      const ticket = tickets[i];
      const outcome = steps[i].ok
        ? resolveSuccess(state, ticket)
        : resolveFailure(state, ticket, `失敗${i + 1}`);
      if (outcome.applyData) {
        // 約束1: 反映する内容が古い方へ戻らないこと。
        expect(ticket.seq).toBeGreaterThanOrEqual(lastApplied);
        lastApplied = ticket.seq;
      }
      if (outcome.showError !== null) shownError = outcome.showError;
      else if (outcome.clearError) shownError = null;
      if (shouldClearLoading(state, ticket)) loadingCleared = true;
    }
    return { state, shownError, loadingCleared, lastApplied };
  };

  /** 決着させるチケットの「部分集合 × 順番」を全部（載っていない分は返ってこない）。 */
  const settleSequences = (n: number): number[][] => {
    const result: number[][] = [];
    const walk = (used: number[], remaining: number[]) => {
      result.push([...used]);
      for (let i = 0; i < remaining.length; i += 1) {
        walk(
          [...used, remaining[i]],
          [...remaining.slice(0, i), ...remaining.slice(i + 1)],
        );
      }
    };
    walk([], [...Array(n).keys()]);
    return result;
  };

  const KINDS: RefreshKind[] = ["full", "quiet"];
  const allStepSets = (n: number): Step[][] => {
    if (n === 0) return [[]];
    return allStepSets(n - 1).flatMap((rest) =>
      KINDS.flatMap((kind) =>
        [true, false].map((ok) => [...rest, { kind, ok }] as Step[]),
      ),
    );
  };

  for (const n of [1, 2, 3, 4]) {
    it(`${n}件が重なって走っても、約束が破れない`, () => {
      let cases = 0;
      for (const steps of allStepSets(n)) {
        for (const order of settleSequences(n)) {
          cases += 1;
          const { state, shownError, loadingCleared, lastApplied } = simulate(
            steps,
            order,
          );
          const settled = new Set(order);
          const lastFullIndex = steps.reduce(
            (acc, s, i) => (s.kind === "full" ? i : acc),
            -1,
          );
          // 約束2: 最新の full が返ってきたなら、「読み込み中」は解除されている。
          if (lastFullIndex >= 0 && settled.has(lastFullIndex)) {
            expect(loadingCleared).toBe(true);
          }
          // 約束3: 利用者の操作(full)が失敗し、**それより新しい内容も届かず**、
          //        **それより新しい取り直しも走っていない**なら、黙らずにエラーを見せる。
          //        ⚠より**古い**取り直しが走っていても、それは中身を持ってこられない
          //        （@codex R8 P2: 一律に数えると、固まった古い1件で永久に黙る）。
          const unresolved = steps.some((s, i) => {
            if (s.kind !== "full" || s.ok || !settled.has(i)) return false;
            const seq = i + 1;
            if (lastApplied > seq) return false;
            const newerOutstanding = steps.some(
              (_x, j) => j + 1 > seq && !settled.has(j),
            );
            return !newerOutstanding;
          });
          if (unresolved) expect(shownError).not.toBeNull();
          // 約束4: 全部決着したら預かりを残さない。
          if (order.length === n) {
            expect(state.pending).toHaveLength(0);
            expect(state.deferredError).toBeNull();
          }
        }
      }
      expect(cases).toBeGreaterThan(0);
    });
  }
});
