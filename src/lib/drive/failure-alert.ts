/**
 * 見回りが続けて失敗しているときの知らせ(第2段b の続き・設計 §6.3)。**純関数だけ**。
 *
 * - 何回続いたら知らせるか(管理画面の「(N回続いています)」と同じ数)。
 * - 「同じ続きの失敗」を見分ける材料: 接続した時刻と最後に成功した時刻。どちらかが変われば
 *   (つなぎ直した・いったん成功した)別の続きとして、また知らせる。
 */
export const DRIVE_ALERT_AFTER_FAILURES = 3;

export interface DriveAlertRow {
  refreshTokenEnc: string | null;
  consecutiveFailures: number;
  connectedAt: Date | null;
  lastSyncAt: Date | null;
}

/** 知らせるなら印の材料(時刻の文字列だけ)、知らせないなら null。 */
export function driveAlertParts(row: DriveAlertRow | null): string[] | null {
  if (!row || row.refreshTokenEnc === null) return null;
  if (row.consecutiveFailures < DRIVE_ALERT_AFTER_FAILURES) return null;
  return [row.connectedAt?.toISOString() ?? "unknown", row.lastSyncAt?.toISOString() ?? "never"];
}
