// 自分のパスワード変更で「今のパスワード」を当てずっぽうに試させない(@codex #517 P2)。
//
// 2026-10-15 から全員が /api/me/change-password を使える。乗っ取ったセッションから今の
// パスワードを何度でも試せないよう、**本人ごとに30分で5回まで**に絞る。
//
// ⚠ログインのロック(login_failed_count / locked_until)とは**別の数え**にする(@codex #517 2巡目)。
//   共有すると、セッションを持った側が5回わざと間違えるだけで本人がログインできなくなり、
//   しかも JWT はロックを見ないので乗っ取った側は居座れる(30分ごとに延長できる)。
//   ここで止まるのはパスワード変更の画面だけで、ログインには一切影響しない。
// ⚠数えは照合(bcrypt)の**前**に、await を挟まずに行う=同時に投げた要求でも5回を超えない。
// ⚠保持はプロセス内(本番は systemd 単一プロセス・public-rate-limit.ts と同じ前提)。
//   再起動で数えは消える(その場合も新しい30分で5回まで)。

import { createRateLimiter } from "@/lib/public-rate-limit";

export const SELF_PASSWORD_MAX_ATTEMPTS = 5;
export const SELF_PASSWORD_WINDOW_MS = 30 * 60 * 1000;

/** 利用者ごとの数え。鍵が溢れたら止める側(fail-closed)。 */
export function createSelfPasswordLimiter() {
  return createRateLimiter(
    { limit: SELF_PASSWORD_MAX_ATTEMPTS, windowMs: SELF_PASSWORD_WINDOW_MS },
    { onOverflow: "deny" },
  );
}

const limiter = createSelfPasswordLimiter();

/** 1回分の試行を数える。30分で5回を超えていれば false(数えない)。 */
export function takeSelfPasswordAttempt(userId: string, now?: number): boolean {
  return limiter.hit(userId.toLowerCase(), now);
}
