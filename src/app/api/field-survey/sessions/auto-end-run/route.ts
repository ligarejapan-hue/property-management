import { timingSafeEqual } from "crypto";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, apiResponse } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import {
  TRIP_AUTO_END_BATCH_LIMIT,
  TRIP_AUTO_END_IDLE_MS,
  TRIP_AUTO_END_REASON,
  autoEndedAt,
  type TripAutoEndResult,
} from "@/lib/field-survey-auto-end";

/**
 * POST /api/field-survey/sessions/auto-end-run — 巡回の自動終了の実行口（cron 用）。
 *
 * 発注者決定 (2026-08-03): **無操作1時間で巡回を自動終了する**。
 * 「巡回終了ボタンを押さずにブラウザから離れても終わる」を実現する唯一の方法が
 * サーバー側の定期実行（ブラウザは閉じた時点で JS が止まる）。
 *
 * 作りは添付お掃除 (`/api/attachments/cleanup-run`) と同型:
 * - `FIELD_SURVEY_AUTO_END_SECRET` 未設定なら **503（dormant＝設定するまで何も終了しない）**
 * - header `x-auto-end-secret` 不一致は 403。人間 auth は不要（cron 駆動）
 * - `?dryRun=1` で件数のみ（終了させない）
 * - ⚠`src/proxy.ts` の `PUBLIC_EXACT_PATHS` に本パスの追加が必要（無いと 307）
 */
export async function POST(request: Request) {
  try {
    const secret = process.env.FIELD_SURVEY_AUTO_END_SECRET;
    if (!secret) {
      throw new ApiError(503, "巡回の自動終了は未設定です", "NOT_CONFIGURED");
    }
    const headerSecret = request.headers.get("x-auto-end-secret") ?? "";
    const secretBuf = Buffer.from(secret);
    const headerBuf = Buffer.from(headerSecret);
    if (
      secretBuf.length !== headerBuf.length ||
      !timingSafeEqual(secretBuf, headerBuf)
    ) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
    const now = new Date();
    const threshold = new Date(now.getTime() - TRIP_AUTO_END_IDLE_MS);

    // 無操作が閾値を超えた active な巡回。⚠`updatedAt` は位置記録の送信でも
    // ピン作成でも動くので、位置記録を使わない巡回も正しく「活動中」と見なせる。
    const stale = await prisma.fieldSurveySession.findMany({
      where: { status: "active", updatedAt: { lt: threshold } },
      select: {
        id: true,
        staffUserId: true,
        startedAt: true,
        updatedAt: true,
        pointCount: true,
      },
      orderBy: { updatedAt: "asc" },
      take: TRIP_AUTO_END_BATCH_LIMIT,
    });

    const result: TripAutoEndResult = {
      scanned: stale.length,
      ended: 0,
      skipped: 0,
      settled: 0,
    };
    if (dryRun) return apiResponse({ ...result, dryRun });

    for (const s of stale) {
      // ⚠**読み取った時点の updatedAt を条件に含める**。読んでから書くまでの間に
      // 位置記録が届いていたら（＝まだ歩いている）終了させない。既存の24時間
      // 自動終了と同じ守り方。
      const upd = await prisma.fieldSurveySession.updateMany({
        where: { id: s.id, status: "active", updatedAt: s.updatedAt },
        // ⚠**理由を残す**(@codex #356 P1)。圏外で貯めた位置記録を復帰後に
        // 受け取れるようにするため、"人が押した終了" と区別する必要がある。
        data: {
          status: "ended",
          endedAt: autoEndedAt(s),
          endReason: TRIP_AUTO_END_REASON,
        },
      });
      if (upd.count === 0) {
        result.skipped++;
        continue;
      }
      result.ended++;
      // 監査は既存の action を使う（人が押した終了と区別できるよう reason を変える）。
      // ⚠識別子だけ。座標・メモ・氏名は載せない。
      await writeAuditLog({
        // ⚠**担当者を実行者にしない**(@codex #356 P2)。押したのは誰でもなく
        // 定期実行なので、`userId` に担当者を入れると監査画面の「ユーザー」欄に
        // その社員が並び、**本人がやっていない操作が本人の記録として残る**
        // (名前で検索しても引っかかる)。誰の巡回だったかは detail に残す。
        userId: null,
        action: "field_survey_session_auto_end",
        targetTable: "field_survey_sessions",
        targetId: s.id,
        detail: {
          sessionId: s.id,
          // 誰の巡回だったかは detail に残す(識別子のみ・氏名は入れない)。
          // 実行者(userId)とは意味が違うので別のキーにする。
          ownerStaffUserId: s.staffUserId,
          reason: TRIP_AUTO_END_REASON,
          idleMinutes: Math.floor(TRIP_AUTO_END_IDLE_MS / 60000),
          pointCount: s.pointCount,
        },
      });
    }

    // ⚠**踏破マップへの復帰**(@codex #356 P1)。自動終了した後に位置記録が届いた
    // 巡回は「まだ歩いているかもしれない」ので踏破マップから外してある。その巡回が
    // 再び無操作1時間を超えたら、今度こそ歩き終えたと判断して印を外し、
    // 終了時刻も最後の活動時刻に直す(記録が届いた分だけ後ろに伸びている)。
    // ⚠ここを作らないと、圏外から復帰した巡回が**二度と踏破マップに出ない**
    // = 二度歩きを避けるという機能の目的そのものを損なう。
    const pending = await prisma.fieldSurveySession.findMany({
      where: {
        status: "ended",
        endReason: TRIP_AUTO_END_REASON,
        reconcilePending: true,
        updatedAt: { lt: threshold },
      },
      select: { id: true, startedAt: true, updatedAt: true },
      orderBy: { updatedAt: "asc" },
      take: TRIP_AUTO_END_BATCH_LIMIT,
    });
    for (const s of pending) {
      // 読み取ってから書くまでの間に記録が届いていたら見送る(次の見回りで拾う)。
      const settled = await prisma.fieldSurveySession.updateMany({
        where: { id: s.id, reconcilePending: true, updatedAt: s.updatedAt },
        data: { reconcilePending: false, endedAt: autoEndedAt(s) },
      });
      if (settled.count > 0) result.settled++;
    }

    // 非PII の運用ログ（件数のみ）。
    console.log(
      `[trip-auto-end] scanned=${result.scanned} ended=${result.ended} skipped=${result.skipped} settled=${result.settled}`,
    );
    return apiResponse({ ...result, dryRun });
  } catch (error) {
    return handleApiError(error);
  }
}
