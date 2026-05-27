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
      return "active な巡回 session が既に存在します。状態を再取得します。";
    case "conflict_state":
      return "巡回 session の状態が変わりました。状態を再取得します。";
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
