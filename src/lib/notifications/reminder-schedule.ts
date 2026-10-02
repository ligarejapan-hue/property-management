/**
 * 次回対応の知らせの送信予定(設計書 §7.4・D8/D16/D17)。**純関数だけ**。
 *
 * 段階2(画面を開いている間のポップアップ)と段階4(Web プッシュ)で同じ関数を使う。
 * 期限 T から数えた「回」の番号を返し、同じ (次回対応, 期限, 版, 回) は1度だけ知らせる。
 * 止まっていた間に過ぎた回はまとめず、今の1回だけ(設計書 §7.4)。
 */

const H = 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * H;

/** 期限から1週間(168時間)で知らせを止める(件数には「期限切れ」として残る)。 */
export const REMINDER_STOP_MS = 168 * H;

/**
 * 回ごとの送る時刻(期限 T からのずれ・ms)。
 * 時刻なし=T(予定日の 9:00)が最初の回。時刻あり(段階3)=T の5分前が最初の回で、
 * 期限ちょうどには送らず +2h から繰り返す。
 */
export function reminderSendOffsets(timed: boolean): number[] {
  const out: number[] = [timed ? -5 * 60 * 1000 : 0];
  for (let h = 2; h <= 24; h += 2) out.push(h * H);
  for (let h = 30; h <= 72; h += 6) out.push(h * H);
  for (let h = 84; h <= 156; h += 12) out.push(h * H);
  return out;
}

/** 今が何回目の回に当たるか(今以前で最も新しい回)。期限の前・1週間を過ぎたら null。 */
export function nextActionReminderSlot(
  deadlineMs: number,
  nowMs: number,
  opts: { timed?: boolean } = {},
): number | null {
  if (nowMs - deadlineMs >= REMINDER_STOP_MS) return null;
  const offsets = reminderSendOffsets(opts.timed === true);
  let slot: number | null = null;
  for (let i = 0; i < offsets.length; i++) {
    if (deadlineMs + offsets[i] <= nowMs) slot = i;
    else break;
  }
  return slot;
}

/** 日本時間の今日(YYYY-MM-DD)。 */
export function jstToday(now: Date): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 日本時間の YYYY-MM-DD を、DB の date 列と比べる Date(UTC 0時)にする。 */
export function jstDateToDbDate(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

/**
 * 時刻なしの次回対応の期限 T(D16: 予定日の 9:00 日本時間)。
 * `scheduledAt` は DB の date 列(UTC 0時の Date で返る)。
 */
export function nextActionDeadline(scheduledAt: Date): number {
  const ymd = scheduledAt.toISOString().slice(0, 10);
  return Date.parse(`${ymd}T09:00:00.000+09:00`);
}
