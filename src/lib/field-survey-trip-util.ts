/**
 * 現地調査マップ Phase 1-F-1 (active session UI) 用の純粋 helper。
 *
 * - エラー応答の振り分け (retry / refetch / fatal)
 * - elapsed 時間フォーマッタ
 * - active session list から 1 件選定する safe pick
 *
 * geolocation / localStorage / fetch 等の副作用は本ファイルで一切持たない。
 * lat/lng/PII を console / 戻り値に含めないこと。
 */

export type TripApiOutcome =
  | { kind: "ok" }
  | { kind: "auth_required" } // 401
  | { kind: "forbidden" } // 403
  | { kind: "conflict_active" } // 409 ACTIVE_SESSION_EXISTS (POST sessions)
  | { kind: "conflict_state" } // 409 INVALID_STATE (PATCH sessions/[id])
  | { kind: "validation" } // 422 INVALID_JSON / VALIDATION_ERROR
  | { kind: "server_error" } // 5xx
  | { kind: "unknown" }; // その他

/**
 * fetch response の status と body.error.code から、UI の次アクションを決める。
 * 詳細 message を UI / console に流出させない設計（呼び出し側で汎用文言に変換）。
 */
export function classifyTripApiResponse(
  status: number,
  errorCode?: string | null,
): TripApiOutcome {
  if (status >= 200 && status < 300) return { kind: "ok" };
  if (status === 401) return { kind: "auth_required" };
  if (status === 403) return { kind: "forbidden" };
  if (status === 409) {
    if (errorCode === "ACTIVE_SESSION_EXISTS") {
      return { kind: "conflict_active" };
    }
    if (errorCode === "INVALID_STATE") {
      return { kind: "conflict_state" };
    }
    return { kind: "conflict_state" };
  }
  if (status === 400 || status === 422) return { kind: "validation" };
  if (status >= 500 && status < 600) return { kind: "server_error" };
  return { kind: "unknown" };
}

/**
 * outcome → UI 表示用の汎用日本語文言に変換 (PII / API 内部 message を含めない)。
 */
export function tripOutcomeMessage(outcome: TripApiOutcome): string {
  switch (outcome.kind) {
    case "auth_required":
      return "ログインが必要です。再ログインしてください。";
    case "forbidden":
      return "巡回操作の権限がありません。管理者に確認してください。";
    case "conflict_active":
      return "すでに巡回中です。最新の状態を取得します。";
    case "conflict_state":
      return "巡回の状態が変わりました。最新の状態を取得します。";
    case "validation":
      return "リクエストが不正です。";
    case "server_error":
      return "サーバーエラーが発生しました。時間をおいて再試行してください。";
    case "ok":
      return "";
    case "unknown":
    default:
      return "操作に失敗しました。時間をおいて再試行してください。";
  }
}

/**
 * fetch response body から `body.error.code` を安全に抽出する。
 * 想定 shape: `{ error: { message: string, code: string } }`。
 * 失敗時は null (UI 表示には汎用文言を使う)。
 */
export function extractApiErrorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const err = (body as { error?: unknown }).error;
  if (typeof err !== "object" || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * 経過時間を `HH:MM:SS` (24h+) フォーマットに整形。
 * 1 桁分・秒は 0 詰め。負値や非有限は "00:00:00"。
 */
export function formatElapsed(startedAt: Date, now: Date): string {
  const ms = now.getTime() - startedAt.getTime();
  if (!Number.isFinite(ms) || ms < 0) return "00:00:00";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export interface ActiveSessionLike {
  id: string;
  staffUserId: string;
  startedAt: string | Date;
  endedAt: string | Date | null;
  status: string;
  memo: string | null;
  pointCount: number;
  /** 最終活動時刻 (放置判定に使用)。古い API 応答に無い場合は startedAt で代用。 */
  updatedAt?: string | Date;
}

/**
 * `GET /sessions?status=active` の list から「自分の active session」を 1 件
 * 選定する。
 *  - status が active のもののみ対象
 *  - currentUserId と staffUserId が一致するもののみ
 *  - 複数あれば startedAt が最新のものを採用 (理論上 partial unique index で
 *    1 件のはずだが、history がある場合の安全側)
 *  - 何もなければ null
 */
export function pickOwnActiveSession<T extends ActiveSessionLike>(
  list: T[] | undefined | null,
  currentUserId: string,
): T | null {
  if (!Array.isArray(list)) return null;
  const owned = list.filter(
    (s) => s.status === "active" && s.staffUserId === currentUserId,
  );
  if (owned.length === 0) return null;
  owned.sort((a, b) => {
    const aT = new Date(a.startedAt).getTime();
    const bT = new Date(b.startedAt).getTime();
    return bT - aT;
  });
  return owned[0];
}

// ---------------------------------------------------------------------------
// B-7 (UI総点検): 巡回セッションの終了し忘れ対策
// ---------------------------------------------------------------------------

/**
 * 画面表示時に「巡回を終了しますか?」の確認を出す放置閾値 (12 時間)。
 * 実巡回がこの長さを超えることは想定していない。
 */
export const STALE_CONFIRM_THRESHOLD_MS = 12 * 60 * 60 * 1000;

/**
 * 新規巡回開始時に、残っている古い active session を自動終了する放置閾値
 * (24 時間)。表示時確認 (12h) より保守的に長く取り、実巡回中の誤終了を避ける。
 */
export const STALE_AUTO_END_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * 巡回 session が「放置されている」と見なせるか (startedAt から thresholdMs 以上経過)。
 * startedAt が不正な日付の場合は false (安全側 = 勝手に終了扱いしない)。
 */
export function isSessionStale(
  startedAt: string | Date,
  now: Date,
  thresholdMs: number,
): boolean {
  const t = new Date(startedAt).getTime();
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t >= thresholdMs;
}

// ---------------------------------------------------------------------------
// #317: 巡回終了の確実化 (終了 commit の活動フェンス)
// ---------------------------------------------------------------------------

/**
 * 「位置記録開始」フェンス (活動 touch PATCH) の応答分類。
 *
 * - 409 = 巡回は既に終了済み (遅延した終了 commit が先に着地した等)。
 *   watch を開始すると以降の点が 409 で失われるため開始をブロックする。
 * - 404 = session 消失。同様にブロック。
 * - null (network / timeout / abort) やその他のエラーは fail-open で開始を許可
 *   する。フェンスの目的は「終了済みへの記録開始」の防止であり、オフライン等の
 *   一時障害で記録自体を妨げない (この後の既存ルート取得 GET が失敗すれば
 *   従来どおり開始は中止される)。
 */
export function classifyStartFence(
  status: number | null,
): "proceed" | "blocked" {
  if (status === 409 || status === 404) return "blocked";
  return "proceed";
}

/**
 * 放置時間の概算表示 (「約13時間」/ 48 時間以上は「約2日」)。
 * 不正・負値は「しばらく」に fallback (通常発生しない)。
 */
export function formatStaleDuration(
  startedAt: string | Date,
  now: Date,
): string {
  const t = new Date(startedAt).getTime();
  const ms = now.getTime() - t;
  if (!Number.isFinite(ms) || ms < 0) return "しばらく";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 48) return `約${hours}時間`;
  return `約${Math.floor(hours / 24)}日`;
}
