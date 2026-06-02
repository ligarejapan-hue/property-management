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
 * 表示するのは「閲覧者自身の身元」であり、所有者等の第三者 PII ではない。
 * email / role が欠損している場合は該当部分を省く。name 欠損時は "ユーザー"。
 */
export function buildWatermarkText({
  name,
  email,
  role,
  now,
}: WatermarkParts): string {
  const parts: string[] = [];
  parts.push((name ?? "").trim() || "ユーザー");

  const safeEmail = (email ?? "").trim();
  if (safeEmail) parts.push(`<${safeEmail}>`);

  const safeRole = (role ?? "").trim();
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
