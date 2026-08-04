/**
 * 巡回の自動終了（無操作が続いた巡回を、時間で自動的に終わらせる）。
 *
 * 発注者要望と決定 (2026-08-03):
 * 「巡回終了ボタンを押さなくてもブラウザから一定時間離れたら巡回終了することは
 *   できますか？」→ **無操作1時間で終了する**。
 *
 * ⚠**ブラウザ側では実現できない**。タブを閉じる・画面が消えると JS が止まるため
 * (iOS Safari は `beforeunload` すら落とす)。**サーバー側の定期実行**でしか
 * 「離れたら終わる」は作れない。前例=添付お掃除 (`/api/attachments/cleanup-run`)。
 *
 * ⚠既にある2つの「放置対策」とは別物なので混同しない:
 *   - 12時間: 放置 session を**画面で開いたとき**に確認 modal を出す
 *   - 24時間: **次に新しい巡回を開始したとき**に古い session を自動終了
 *   どちらも「時間が来たら勝手に終わる」ものではない。本モジュールがその穴を埋める。
 *
 * このモジュールは純ロジックのみ (prisma / fetch / console を使わない)。
 */

/** 無操作がこの時間を超えた巡回を自動終了する（発注者決定=1時間）。 */
export const TRIP_AUTO_END_IDLE_MS = 60 * 60 * 1000;

/**
 * 自動終了したことを示す印 (session.endReason / 監査の reason)。
 * ⚠**"人が終了ボタンを押した" と区別するために要る**(@codex #356 P1)。
 * 圏外で貯めた位置記録は、自動終了した巡回にだけ後から受け取る。
 * 意図して終えた巡回に後から足すのは誤りなので、そちらは従来どおり弾く。
 */
export const TRIP_AUTO_END_REASON = "idle_timeout";

/** 1回の実行で終了させる上限。取りこぼしは次の実行で拾う。 */
export const TRIP_AUTO_END_BATCH_LIMIT = 100;

/**
 * 「最終活動」の基準時刻。
 *
 * ⚠`updatedAt` を使う。位置記録の送信 (`pointCount` の加算) でも、ピンの作成でも
 * この列が動くため、**位置記録を使わない巡回 (撮って登録だけ) でも活動として数えられる**。
 * ここを `startedAt` にすると、写真を撮り続けていても開始1時間で切れてしまう。
 */
export function lastActivityAt(session: {
  updatedAt: Date;
  startedAt: Date;
}): Date {
  return session.updatedAt > session.startedAt
    ? session.updatedAt
    : session.startedAt;
}

/** その巡回を自動終了すべきか（純関数）。 */
export function shouldAutoEndTrip(
  session: { status: string; updatedAt: Date; startedAt: Date },
  now: Date,
  idleMs: number = TRIP_AUTO_END_IDLE_MS,
): boolean {
  // ⚠`active` 以外 (ended / cancelled) は触らない。
  if (session.status !== "active") return false;
  const idle = now.getTime() - lastActivityAt(session).getTime();
  return idle >= idleMs;
}

/**
 * 自動終了した巡回の「終了時刻」。
 *
 * ⚠**気づいた時刻ではなく、最後に活動した時刻**を入れる。実際に歩き終えたのは
 * そのときで、見回りが走ったのは単に後からだから。踏破ヒートは「終了した巡回」を
 * 日付で数えるので、ここを now にすると**日付をまたいだときに歩いた日がずれる**
 * (例: 23:50 に活動が止まり、翌 0:05 の見回りで終了 → 翌日の踏破として数えられる)。
 * 既存の24時間自動終了も同じ判断 (`endedAt: existingActive.updatedAt`)。
 */
export function autoEndedAt(session: {
  updatedAt: Date;
  startedAt: Date;
}): Date {
  return lastActivityAt(session);
}

/**
 * 巡回の「まだ作業中です」を伝える心拍（@codex #356 P2）。
 *
 * ⚠**位置記録の送信とピン作成しか `updatedAt` を動かしていなかった**。
 * 写真の追加はピン行だけを、ピンの編集は「巡回の紐付けを変えたとき」だけを
 * 更新していたため、**写真を撮り続けている巡回が1時間で切られる**。
 * 自動終了を入れる以上、現場で起きる更新はすべて活動として数える必要がある。
 *
 * ⚠**best-effort**。0 行更新（すでに終了した巡回のピンを後から編集した等）でも
 * throw しない。終わった巡回のピンを事務所で直すのは正常な操作であり、
 * それを 409 で拒む理由は無い。
 */
export async function touchTripActivity(
  tx: {
    fieldSurveySession: {
      updateMany: (args: {
        where: { id: string; status: "active" };
        data: { updatedAt: Date };
      }) => Promise<{ count: number }>;
    };
  },
  sessionId: string | null | undefined,
): Promise<void> {
  if (!sessionId) return;
  try {
    await tx.fieldSurveySession.updateMany({
      where: { id: sessionId, status: "active" },
      data: { updatedAt: new Date() },
    });
  } catch {
    // 心拍の失敗で本来の操作（写真追加・編集）を壊さない。
  }
}

/** 実行結果の要約（件数のみ・PII を持たない）。 */
export interface TripAutoEndResult {
  /** 判定対象として読んだ件数。 */
  scanned: number;
  /** 実際に終了させた件数。 */
  ended: number;
  /** 直前に活動があり見送った件数（競合）。 */
  skipped: number;
  /**
   * 踏破マップへ復帰させた件数 (@codex #356 P1)。
   * 自動終了した後に位置記録が届いて踏破マップから外していた巡回のうち、
   * 再び無操作1時間を超えて「今度こそ歩き終えた」と判断できたもの。
   */
  settled: number;
}
