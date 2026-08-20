/**
 * 物件詳細ページの「取り直し」の交通整理（純関数）。
 *
 * 2 種類の取り直しが同時に走り得る:
 *   - full : 利用者の操作による取り直し。画面を「読み込み中」にする。
 *   - quiet: 謄本の取得/取り込みが成功した直後の静かな更新。画面を作り直さない
 *            （作り直すと実況パネルごと消えるため。@codex #380 R3 P2）。
 *
 * ⚠この判定を画面のコードに直書きしていたところ、@codex に **6 巡連続で別々の穴**を
 *   指摘された（後着勝ち / 「読み込み中」の取り残し / 失敗が成功を無効化 /
 *   追い越された失敗でページ全体がエラー画面 / 両方失敗したときに黙る /
 *   古い成功が新しい失敗の預かりを消す）。
 *   文字列の走査では**順番の交差を確かめられない**のが根本原因だったため、判定だけを
 *   純関数に出し、**全ての交差を総当たりで**検証する（__tests__ を参照）。
 *
 * 守るべき約束は2つだけ:
 *   1. 画面には**いちばん新しく取れた内容**だけを出す（古い結果で上書きしない）。
 *   2. 利用者の操作による取り直しが失敗したのに、**黙って古い内容を見せ続けない**。
 *      （静かな更新**自身**の失敗は best-effort なので黙ってよい）
 */

export type RefreshKind = "full" | "quiet";

export interface DeferredFailure {
  /** どの世代の失敗か。⚠古い成功で新しい失敗を消さないために要る。 */
  seq: number;
  message: string;
}

export interface RefreshState {
  /** 発行した順番。 */
  issued: number;
  /** 中身を反映できた世代。これより古い結果は捨てる。 */
  applied: number;
  /** 「読み込み中」の持ち主。⚠full だけが進める。 */
  loadingOwner: number;
  /** まだ決着していない取り直しの数。0 になったら預かりを出す（誰も決着させないため）。 */
  pending: number;
  /** 追い越された失敗の預かり。 */
  deferredError: DeferredFailure | null;
}

export interface RefreshTicket {
  kind: RefreshKind;
  seq: number;
  /** 「読み込み中」の持ち主判定用（quiet では使わない）。 */
  loadingSeq: number;
}

export interface RefreshOutcome {
  /** 取得した内容を画面へ反映してよいか。 */
  applyData: boolean;
  /** 居座っているエラー表示を畳むか。 */
  clearError: boolean;
  /** 画面に出すエラー。null は「出さない」。⚠clearError と同時に立つことはない。 */
  showError: string | null;
}

export const createRefreshState = (): RefreshState => ({
  issued: 0,
  applied: 0,
  loadingOwner: 0,
  pending: 0,
  deferredError: null,
});

/** 取り直しを発行する。戻り値のチケットを結果の判定に使う。 */
export function beginRefresh(state: RefreshState, kind: RefreshKind): RefreshTicket {
  state.issued += 1;
  state.pending += 1;
  if (kind === "full") state.loadingOwner += 1;
  return { kind, seq: state.issued, loadingSeq: state.loadingOwner };
}

/**
 * 走っているものが無くなった時点で、預かっている失敗を出す。
 * ⚠出さないと「誰も決着させないまま黙る」（＝古い内容を見せ続ける）。
 * ⚠預かりより新しい中身が反映済みなら、もう出す必要はない。
 */
function settleDeferred(state: RefreshState, outcome: RefreshOutcome): RefreshOutcome {
  if (state.pending > 0) return outcome;
  const deferred = state.deferredError;
  if (deferred === null) return outcome;
  state.deferredError = null;
  if (state.applied > deferred.seq) return outcome;
  return { ...outcome, clearError: false, showError: deferred.message };
}

/** 取得に成功したとき、画面に何をしてよいか。 */
export function resolveSuccess(state: RefreshState, ticket: RefreshTicket): RefreshOutcome {
  state.pending = Math.max(0, state.pending - 1);
  // より新しい結果が既に反映済みなら、古い内容で上書きしない。
  if (ticket.seq < state.applied) {
    return settleDeferred(state, { applyData: false, clearError: false, showError: null });
  }
  state.applied = ticket.seq;
  // ⚠預かりを消してよいのは**その失敗より新しい**中身が届いたときだけ。
  //   古い成功で新しい失敗を消すと、後続も失敗したときに何も知らせないまま古い内容が残る。
  if (state.deferredError !== null && ticket.seq > state.deferredError.seq) {
    state.deferredError = null;
  }
  return settleDeferred(state, { applyData: true, clearError: true, showError: null });
}

/** 取得に失敗したとき、画面に何をしてよいか。 */
export function resolveFailure(
  state: RefreshState,
  ticket: RefreshTicket,
  message: string,
): RefreshOutcome {
  state.pending = Math.max(0, state.pending - 1);
  // 最新の full の失敗は、そのまま画面に出す（利用者が待っている操作の結果）。
  if (ticket.kind === "full" && ticket.seq === state.issued) {
    state.applied = ticket.seq;
    state.deferredError = null;
    return { applyData: false, clearError: false, showError: message };
  }
  if (ticket.kind === "full") {
    // 追い越された失敗は**すぐには出さない**（ページ全体がエラー画面に差し替わり、
    // 実況パネルごと消えるため）。かといって**捨てない**（両方失敗したときに黙る）。
    // ⇒ いちばん新しい失敗を預かり、決着したときに出す。
    if (state.deferredError === null || state.deferredError.seq < ticket.seq) {
      state.deferredError = { seq: ticket.seq, message };
    }
  }
  // 静かな更新**自身**の失敗は表に出さない（best-effort）。ここでエラー画面にすると、
  // 謄本の取得に成功した直後なのに実況パネルごと消える。
  return settleDeferred(state, { applyData: false, clearError: false, showError: null });
}

/** 「読み込み中」を解除してよいか。⚠解除できるのは**最新の full** だけ。 */
export function shouldClearLoading(state: RefreshState, ticket: RefreshTicket): boolean {
  return ticket.kind === "full" && ticket.loadingSeq === state.loadingOwner;
}
