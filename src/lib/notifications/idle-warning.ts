/**
 * 自動ログオフの予告(N3・設計書 §4.3)の判定。**純関数だけ**。
 * 60分でログアウトする規則・延長の仕組み(`idle-session-guard.tsx`)は変えない。
 */
import { IDLE_TIMEOUT_MS } from "@/lib/idle-timeout";

/** 予告を出す無操作の長さ(60分の5分前=55分)。 */
export const IDLE_LOGOUT_WARN_MS = IDLE_TIMEOUT_MS - 5 * 60 * 1000;

export type IdlePhase = "active" | "warn" | "logout";

export function idlePhase(idleFor: number): IdlePhase {
  if (idleFor >= IDLE_TIMEOUT_MS) return "logout";
  if (idleFor >= IDLE_LOGOUT_WARN_MS) return "warn";
  return "active";
}

/** 「残り 4分59秒」の表示用。0未満は0。 */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

export const IDLE_WARN_TITLE = "まもなく自動ログオフします";
export const IDLE_WARN_OS_BODY = "5分後に自動ログオフします";
export const IDLE_WARN_DIALOG_BODY = "操作がないため、あと5分で自動ログオフします。続ける場合は「続ける」を押してください。";
/** ログイン画面の理由表示(`/login?reason=idle`)。 */
export const IDLE_LOGGED_OUT_MESSAGE = "無操作が60分続いたため、自動ログオフしました。もう一度ログインしてください。";
export const IDLE_LOGOUT_CALLBACK_URL = "/login?reason=idle";
