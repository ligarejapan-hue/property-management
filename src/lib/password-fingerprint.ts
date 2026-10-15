// パスワードを変えたら、ほかのブラウザのログインも切る(@codex #517 P1)。
//
// ログインはJWT(最長65分)で、これまで回転時に見ていたのは isActive と role だけだった。
// 乗っ取りに気づいて本人がパスワードを変えても、写し取られたトークンは期限まで生きていた。
// ログイン時に**保存済みハッシュの指紋**をトークンへ入れ、回転のたびに今のハッシュと比べる。
// 違えば(本人の変更・管理者の再設定・再設定メールのどれでも)そのトークンは失効させる。
//
// ⚠トークンにハッシュそのものは入れない(sha256 の先頭16桁だけ)。bcrypt は塩が毎回違うので、
//   同じパスワードを入れ直しても指紋は変わる=変更のたびに必ず切れる。
// ⚠migration は要らない(既存の password_hash 列だけで決まる)。

import { createHash } from "node:crypto";

export function passwordFingerprint(passwordHash: string): string {
  return createHash("sha256").update(passwordHash).digest("hex").slice(0, 16);
}

/**
 * トークンの指紋が今のハッシュと合うか。指紋の無いトークン(この仕組みより前に発行)も
 * 合わない扱い=反映直後に一度だけログインし直してもらう(最長65分の古いトークンを残さない)。
 */
export function tokenMatchesPassword(tokenFingerprint: unknown, passwordHash: string): boolean {
  return typeof tokenFingerprint === "string" && tokenFingerprint === passwordFingerprint(passwordHash);
}
