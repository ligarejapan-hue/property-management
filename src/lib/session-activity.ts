/**
 * 無操作アイドルタイムアウト用の「最終操作時刻」をタブ間で共有する localStorage ヘルパ。
 *
 * - IdleSessionGuard が操作検知のたびに書き込み、判定時に読み出す(全タブの最大値で idle 判定)。
 * - ログインページが認証成功時に「今」を seed する。これにより新規ログイン直後の初回マウントで
 *   前セッションの古い値を誤って読み、即ログアウトしてしまうのを防ぐ(@codex #290 R7 P2)。
 *
 * localStorage が使えない環境(private mode 等)では自タブのみの判定に degrade する。
 */
export const LAST_ACTIVITY_KEY = "pm:session:last-activity";

export function readSharedLastActivity(): number {
  try {
    const v = window.localStorage.getItem(LAST_ACTIVITY_KEY);
    const n = v ? Number(v) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0; // localStorage 不可時は自タブのみで判定
  }
}

export function writeSharedLastActivity(now: number): void {
  try {
    window.localStorage.setItem(LAST_ACTIVITY_KEY, String(now));
  } catch {
    /* private mode 等で不可なら自タブのみで判定 */
  }
}
