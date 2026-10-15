// 自分のパスワード変更で「今のパスワード」を当てずっぽうに試させない(@codex #517 P2)。
//
// 2026-10-15 から全員が /api/me/change-password を使える。ログインの「5回失敗で30分ロック」
// (src/lib/auth.ts)は login 経路でしか数えていなかったため、乗っ取ったセッションから
// 今のパスワードを何度でも試せてしまう。ここではログインと**同じ数え(login_failed_count /
// locked_until)**を使う=どちらで間違えても合計5回で30分止まる。
//
// ⚠照合(bcrypt)の**前に**1回分を予約する。照合のあとで数えると、同時に投げた要求が
//   全部照合まで進み、5回を超えて試せてしまう。予約は1文の UPDATE で、
//   「ロック中でない」の確認・+1・5回目ならロック、を同時に行う(行ロックで直列化)。
//   当たったら呼び出し側で 0 に戻しロックを解く(ログイン成功時と同じ)。
// ⚠時刻は JS で1回だけ作って渡す(SQL の now() と混ぜない)。
// ⚠locked_until は時差なしの timestamp 列(Prisma が UTC の時刻で入れる)。引数は
//   ISO 文字列→timestamptz→AT TIME ZONE 'UTC' で同じ形に揃える=DB の TimeZone 設定に左右されない
//   (edit-lock/service.ts と同じ書き方)。

export const SELF_PASSWORD_MAX_FAILURES = 5; // auth.ts の MAX_LOGIN_FAILURES と同じ
export const SELF_PASSWORD_LOCK_MS = 30 * 60 * 1000; // auth.ts の LOCK_DURATION_MS と同じ

export interface AttemptDb {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

/**
 * 1回分の試行を予約する。ロック中(または無効・存在しない利用者)なら false。
 * 予約できたら true(この時点で回数は+1済み・5回目ならロックも掛かっている)。
 */
export async function reserveSelfPasswordAttempt(db: AttemptDb, userId: string, now: Date): Promise<boolean> {
  const lockUntil = new Date(now.getTime() + SELF_PASSWORD_LOCK_MS);
  const updated = await db.$executeRaw`
    UPDATE users
       SET login_failed_count = login_failed_count + 1,
           locked_until = CASE
             WHEN login_failed_count + 1 >= ${SELF_PASSWORD_MAX_FAILURES}
               THEN (${lockUntil.toISOString()}::timestamptz AT TIME ZONE 'UTC')
             ELSE locked_until
           END
     WHERE id = ${userId}::uuid
       AND is_active = true
       AND (locked_until IS NULL OR locked_until <= (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC'))`;
  return updated === 1;
}
