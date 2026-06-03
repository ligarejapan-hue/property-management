import type { PermissionEntry } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";

/**
 * S1b-2: 画面保護（透かし）の純ロジック。UI から切り離し node 環境で単体テストする。
 *
 * 注意: これは「抑止＋事後追跡」であって「防止」ではない。
 * DevTools で透かし要素は削除可能であり、OS スクリーンショット / 画面録画 / 外部カメラ撮影は
 * Web からは検知も禁止もできない（後続 PR でも同様）。
 */

/**
 * screen_protection:bypass を持つユーザーは画面保護（透かし）を免除される。
 * 未付与時は default-deny（= 保護対象 = 透かし表示）。hasPermission がそのまま使える。
 */
export function isScreenProtectionBypassed(
  permissions: PermissionEntry[],
): boolean {
  return hasPermission(permissions, "screen_protection", "bypass");
}

export interface WatermarkParts {
  name?: string | null;
  email?: string | null;
  role?: string | null;
  /** ページ表示時刻（フォレンジック用に mount 時刻を一度だけ確定して渡す） */
  now: Date;
}

/**
 * 透かし表示文字列を組み立てる。
 * 例: "山田太郎 <yamada@example.com> [admin] 2026-06-03 14:30"
 *
 * Codex P2-2: traceability の無い汎用透かしを出さない。
 * - name / email / role の識別情報が 1 つも無い場合は **null** を返す
 *   （= 呼び出し側は透かしを描画しない。汎用の代替文言にフォールバックしない）。
 * - 取得できた識別情報のみを連結する（name 欠損でも email / role があれば生成する）。
 * 表示するのは「閲覧者自身の身元」であり、所有者等の第三者 PII ではない。
 */
export function buildWatermarkText({
  name,
  email,
  role,
  now,
}: WatermarkParts): string | null {
  const safeName = (name ?? "").trim();
  const safeEmail = (email ?? "").trim();
  const safeRole = (role ?? "").trim();

  // 識別情報が一切無ければ汎用透かしを出さない（fail-safe より traceability を優先）。
  if (!safeName && !safeEmail && !safeRole) return null;

  const parts: string[] = [];
  if (safeName) parts.push(safeName);
  if (safeEmail) parts.push(`<${safeEmail}>`);
  if (safeRole) parts.push(`[${safeRole}]`);
  parts.push(formatTimestamp(now));
  return parts.join(" ");
}

function formatTimestamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`
  );
}

/**
 * Codex P2-1: viewport 全体を覆う透かし背景を生成する。
 *
 * 固定個数のタイル要素ではなく、回転した透かしテキストを 1 タイルに描いた SVG を
 * `background-repeat: repeat` で敷き詰める。これにより wide / tall / 4K でも
 * 下端・右端に無透かし領域を残さず全面を覆える（DOM ノード数も一定）。
 *
 * テキストは XML エスケープしてから encodeURIComponent するため、
 * "<email>" の山括弧が SVG タグとして解釈される（インジェクション）ことはない。
 *
 * 戻り値は CSS `background-image` にそのまま渡せる `url("data:image/svg+xml,...")`。
 */
export function watermarkSvgDataUri(text: string): string {
  const safe = xmlEscape(text);
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='340' height='180'>` +
    `<text x='12' y='96' fill='#111827' font-family='sans-serif' font-size='13' ` +
    `font-weight='600' transform='rotate(-30 170 96)'>${safe}</text>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ============================================================
// S1b-3: copy / cut / contextmenu / print 抑止＋client 監査の純ロジック。
// detail は非PII enum のみ。URL / path / 選択テキスト / 所有者名は一切扱わない。
// ============================================================

/** client が送る操作イベント種別（厳格 enum）。 */
export const SCREEN_PROTECTION_EVENT_TYPES = [
  "copy",
  "cut",
  "contextmenu",
  "print",
  "print_shortcut",
] as const;
export type ScreenProtectionEventType =
  (typeof SCREEN_PROTECTION_EVENT_TYPES)[number];

/** PII 画面の粗いラベル（ID を含まない非PII enum）。 */
export const SCREEN_PROTECTION_SURFACES = [
  "owner",
  "property",
  "history",
  "import",
  "registry",
  "dashboard",
] as const;
export type ScreenProtectionSurface =
  (typeof SCREEN_PROTECTION_SURFACES)[number];

export type ScreenProtectionAuditAction =
  | "pii_copy_attempt"
  | "pii_cut_attempt"
  | "pii_contextmenu_attempt"
  | "pii_print_attempt";

/** detail.trigger（操作の発生源。非PII enum）。 */
export type ScreenProtectionTrigger =
  | "clipboard"
  | "menu"
  | "print_dialog"
  | "keyboard";

export function isScreenProtectionEventType(
  v: unknown,
): v is ScreenProtectionEventType {
  return (
    typeof v === "string" &&
    (SCREEN_PROTECTION_EVENT_TYPES as readonly string[]).includes(v)
  );
}

export function isScreenProtectionSurface(
  v: unknown,
): v is ScreenProtectionSurface {
  return (
    typeof v === "string" &&
    (SCREEN_PROTECTION_SURFACES as readonly string[]).includes(v)
  );
}

/**
 * eventType → AuditLog action。
 * print と print_shortcut は同一 action(pii_print_attempt) に統合し、trigger で区別する。
 */
export function eventTypeToAuditAction(
  eventType: ScreenProtectionEventType,
): ScreenProtectionAuditAction {
  switch (eventType) {
    case "copy":
      return "pii_copy_attempt";
    case "cut":
      return "pii_cut_attempt";
    case "contextmenu":
      return "pii_contextmenu_attempt";
    case "print":
    case "print_shortcut":
      return "pii_print_attempt";
  }
}

/** eventType → detail.trigger（非PII enum、サーバ側で決定し client を信用しない）。 */
export function eventTypeToTrigger(
  eventType: ScreenProtectionEventType,
): ScreenProtectionTrigger {
  switch (eventType) {
    case "copy":
    case "cut":
      return "clipboard";
    case "contextmenu":
      return "menu";
    case "print":
      return "print_dialog";
    case "print_shortcut":
      return "keyboard";
  }
}

export interface ScreenProtectionAuditDetail {
  surface: ScreenProtectionSurface;
  trigger: ScreenProtectionTrigger;
}

/** 監査 detail を非PII enum のみで構築する（PII は構造的に混入できない）。 */
export function buildScreenProtectionAuditDetail(
  eventType: ScreenProtectionEventType,
  surface: ScreenProtectionSurface,
): ScreenProtectionAuditDetail {
  return { surface, trigger: eventTypeToTrigger(eventType) };
}
