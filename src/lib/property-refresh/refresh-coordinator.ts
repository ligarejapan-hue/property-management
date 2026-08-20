/**
 * 物件詳細ページの「取り直し」の交通整理（純関数）。
 *
 * 2 種類の取り直しが同時に走り得る:
 *   - full : 利用者の操作による取り直し。画面を「読み込み中」にする。
 *   - quiet: 謄本の取得/取り込みが成功した直後の静かな更新。画面を作り直さない
 *            （作り直すと実況パネルごと消えるため。@codex #380 R3 P2）。
 *
 * ⚠この判定を画面のコードに直書きしていたところ、@codex に **5 巡連続で別々の穴**を
 *   指摘された（後着勝ち / 「読み込み中」の取り残し / 失敗が成功を無効化 /
 *   追い越された失敗でページ全体がエラー画面 / 両方失敗したときに黙る）。
 *   文字列の走査では**振る舞いを確かめられない**のが根本原因だったため、判定だけを
 *   純関数に出し、**交差する順番を実際に並べたテスト**で固定する。
 */

export type RefreshKind = "full" | "quiet";

export interface RefreshState {
  /** 発行した順番。 */
  issued: number;
  /** 中身を反映できた世代。これより古い結果は捨てる。 */
  applied: number;
  /** 「読み込み中」の持ち主。⚠full だけが進める。 */
  loadingOwner: number;
  /** 追い越された失敗の預かり。決着したときに出す。 */
  deferredError: string | null;
}

export interface RefreshTicket {
  kind: RefreshKind;
  seq: number;
  /** 「読み込み中」の持ち主判定用（quiet では使わない）。 */
  loadingSeq: number;
}

export interface SuccessOutcome {
  /** 取得した内容を画面へ反映してよいか。 */
  applyData: boolean;
  /** 居座っているエラー表示を畳むか。 */
  clearError: boolean;
}

export interface FailureOutcome {
  /** 画面に出すエラー。null は「出さない」。 */
  showError: string | null;
}

export const createRefreshState = (): RefreshState => ({
  issued: 0,
  applied: 0,
  loadingOwner: 0,
  deferredError: null,
});

/** 取り直しを発行する。戻り値のチケットを結果の判定に使う。 */
export function beginRefresh(state: RefreshState, kind: RefreshKind): RefreshTicket {
  state.issued += 1;
  if (kind === "full") state.loadingOwner += 1;
  return { kind, seq: state.issued, loadingSeq: state.loadingOwner };
}

/** 取得に成功したとき、画面に何をしてよいか。 */
export function resolveSuccess(state: RefreshState, ticket: RefreshTicket): SuccessOutcome {
  // より新しい結果が既に反映済みなら、古い内容で上書きしない。
  if (ticket.seq < state.applied) return { applyData: false, clearError: false };
  state.applied = ticket.seq;
  // 中身が届いたのだから、預かっている失敗は不要になる。
  state.deferredError = null;
  return { applyData: true, clearError: true };
}

/** 取得に失敗したとき、画面に何をしてよいか。 */
export function resolveFailure(
  state: RefreshState,
  ticket: RefreshTicket,
  message: string,
): FailureOutcome {
  if (ticket.kind === "quiet") {
    // 静かな更新**自身**の失敗は表に出さない（best-effort）。ここでエラー画面にすると、
    // 謄本の取得に成功した直後なのに実況パネルごと消える。
    // ⚠ただし、これが最新の発行で、かつ**預かっている失敗**があるなら出す。
    //   「新しい方に賭けたが実らなかった」＝黙って古い内容を見せ続けない。
    if (ticket.seq !== state.issued) return { showError: null };
    const deferred = state.deferredError;
    if (deferred === null) return { showError: null };
    state.deferredError = null;
    return { showError: deferred };
  }
  // full: 追い越されているなら**すぐには出さない**（ページ全体がエラー画面に
  // 差し替わり、実況パネルごと消えるため）。かといって**捨てない**（両方失敗したときに
  // 何も知らせなくなる）。⇒ 預かって、決着したときに出す。
  if (ticket.seq !== state.issued) {
    state.deferredError = message;
    return { showError: null };
  }
  state.applied = ticket.seq;
  state.deferredError = null;
  return { showError: message };
}

/** 「読み込み中」を解除してよいか。⚠解除できるのは**最新の full** だけ。 */
export function shouldClearLoading(state: RefreshState, ticket: RefreshTicket): boolean {
  return ticket.kind === "full" && ticket.loadingSeq === state.loadingOwner;
}
