import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  apiResponse,
  handleApiError,
  parseJsonBody,
  ApiError,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { patchFieldSurveySessionSchema } from "@/lib/validators";
import {
  isSessionStale,
  STALE_CONFIRM_THRESHOLD_MS,
} from "@/lib/field-survey-trip-util";
import {
  TRIP_AUTO_END_REASON,
  settledEndedAt,
} from "@/lib/field-survey-auto-end";

// ---------- PATCH /api/field-survey/sessions/[id] ----------
// 巡回終了 / cancel / memo 更新の最小対応。
// field_survey:write 必須。`manage` を持たない場合は own のみ操作可。
// 状態遷移 (ended / cancelled) は updateMany で `status="active"` を where 条件に
// 含めて atomic に判定する。Codex P2 (PATCH race) 対応:
//   2 つの並行 end/cancel が同じ active 行を read してから update した場合でも、
//   後発リクエストの updateMany は 0 行更新となり 409 INVALID_STATE を返す。

const SELECT_SESSION = {
  id: true,
  staffUserId: true,
  startedAt: true,
  endedAt: true,
  status: true,
  memo: true,
  pointCount: true,
  activitySeq: true,
  createdAt: true,
  updatedAt: true,
} as const;

// ---------- GET /api/field-survey/sessions/[id] ----------
// Phase 1-J: 過去ルート閲覧の session メタ取得。
// - field_survey:read 必須。own は read のみ、他人は read_all または manage 必須。
// - 他人 session の閲覧時のみ AuditLog (field_survey_session_view)。
//   detail は sessionId / viewedStaffUserId / scope のみ (座標・memo・PII は入れない)。
// - 返却は id/staffUserId/staffName/startedAt/endedAt/status/pointCount/pinCount。
//   memo / 座標 / 写真情報は返さない。pinCount は archived を除く紐付け pin 数。

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "field_survey", "read")) {
      throw new ApiError(403, "閲覧権限がありません", "FORBIDDEN");
    }

    const sess = await prisma.fieldSurveySession.findUnique({
      where: { id },
      select: {
        id: true,
        staffUserId: true,
        startedAt: true,
        endedAt: true,
        status: true,
        pointCount: true,
        staff: { select: { name: true } },
      },
    });
    if (!sess) {
      throw new ApiError(404, "session が見つかりません", "NOT_FOUND");
    }

    const isOwn = sess.staffUserId === session.id;
    const hasReadAll = hasPermission(permissions, "field_survey", "read_all");
    const hasManage = hasPermission(permissions, "field_survey", "manage");
    if (!isOwn && !hasReadAll && !hasManage) {
      throw new ApiError(403, "他スタッフの session は閲覧できません", "FORBIDDEN");
    }

    const pinCount = await prisma.fieldSurveyPin.count({
      where: { sessionId: id, status: { not: "archived" } },
    });

    if (!isOwn) {
      // 他人 session メタ閲覧のみ監査。detail に座標・memo・PII を入れない。
      await writeAuditLog({
        userId: session.id,
        action: "field_survey_session_view",
        targetTable: "field_survey_sessions",
        targetId: id,
        detail: {
          sessionId: id,
          viewedStaffUserId: sess.staffUserId,
          scope: hasManage ? "manage" : "read_all",
        },
      });
    }

    return apiResponse({
      data: {
        id: sess.id,
        staffUserId: sess.staffUserId,
        staffName: sess.staff?.name ?? null,
        startedAt: sess.startedAt,
        endedAt: sess.endedAt,
        status: sess.status,
        pointCount: sess.pointCount,
        pinCount,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "field_survey", "write")) {
      throw new ApiError(403, "更新権限がありません", "FORBIDDEN");
    }

    const body = await parseJsonBody(request);
    const patch = patchFieldSurveySessionSchema.parse(body);

    const existing = await prisma.fieldSurveySession.findUnique({
      where: { id },
      select: {
        id: true,
        staffUserId: true,
        startedAt: true,
        updatedAt: true,
        // 自動終了ぶんを確定するときの終了時刻の基準に使う。
        endedAt: true,
        status: true,
        // 自動終了した巡回か (終了ボタンを押せるようにする判定に使う)。
        endReason: true,
        pointCount: true,
      },
    });
    if (!existing) {
      throw new ApiError(404, "session が見つかりません", "NOT_FOUND");
    }

    const hasManage = hasPermission(permissions, "field_survey", "manage");
    if (!hasManage && existing.staffUserId !== session.id) {
      throw new ApiError(
        403,
        "他スタッフの session は操作できません",
        "FORBIDDEN",
      );
    }

    const now = new Date();
    // B-7 (@codex R3): 放置していた session (最終活動から 12h 超) を後から終了
    // する場合は、endedAt に now でなく最終活動時刻 (updatedAt) を使い、
    // 「数日巡回していた」ような過大な巡回時間を記録しない (自動終了と同じ規則)。
    // 通常の終了 (直前まで活動) は従来どおり now。
    const isStaleEnd =
      patch.status === "ended" &&
      isSessionStale(existing.updatedAt, now, STALE_CONFIRM_THRESHOLD_MS);
    const effectiveEndedAt = isStaleEnd ? existing.updatedAt : now;

    // ⚠**自動終了した巡回に「終了」を押せるようにする**(@codex #356 P1 の派生)。
    // 無操作1時間で自動終了した後、圏外から戻ったスタッフが終了ボタンを押すと、
    // 従来条件 (status:"active") では 0 行更新 → 409 になり、**何度押しても
    // 終われない**(24時間の自動終了では滅多に起きなかったが、1時間では日常的に
    // 起きる)。既に終わっているので望む状態には達している = 成功として扱い、
    // 同時に「本人が終わったと言った」ことを踏破マップへの復帰の合図にする
    // (見回りの1時間待ちを待たずに出せる)。
    const existingEndedAt = existing.endedAt;
    // 確定した終了時刻 (監査の巡回時間にも同じ値を使う)。
    let settledAt: Date | null = null;
    const settlingAutoEnded =
      patch.status === "ended" &&
      existing.status === "ended" &&
      existing.endReason === TRIP_AUTO_END_REASON;
    if (settlingAutoEnded) {
      // ⚠終了時刻は「押した時刻」でも「記録が届いた時刻」でもなく、
      // **位置記録が持つ最後の記録時刻**にそろえる (@codex #356 P2)。
      // 圏外で貯めた記録は電波が戻った時刻に届くため、届いた時刻を使うと
      // 深夜に歩いた巡回が翌日の昼に終わったことになる (巡回時間が伸び、
      // 踏破の日付もずれる)。見回り側の確定と同じ規則を使う。
      const last = await prisma.fieldSurveyTrackPoint.aggregate({
        where: { sessionId: id },
        _max: { recordedAt: true },
      });
      settledAt =
        settledEndedAt(existingEndedAt, last._max.recordedAt) ??
        existing.updatedAt;
      await prisma.fieldSurveySession.updateMany({
        where: { id, status: "ended", endReason: TRIP_AUTO_END_REASON },
        data: {
          reconcilePending: false,
          endedAt: settledAt,
          ...(patch.memo !== undefined && { memo: patch.memo }),
        },
      });
    } else if (patch.status === "ended" || patch.status === "cancelled") {
      // status 変更は atomic な conditional update で実施。
      // 0 行更新は「既に終了/キャンセル済」または「読取後に活動が入った」を
      // 意味し 409 にマップ (client は既存 conflict 処理 = 再取得 → 再試行)。
      //
      // #317 活動フェンス: 遅延した終了 commit が「再読込・別タブで再開された
      // 記録 (位置記録開始フェンス以降)」の後から着地して以降の点を 409 で
      // 失わせることを防ぐ。
      //
      // commit 条件は expectedActivitySeq (世代カウンタ) の等値。client は終了
      // 意図の時点 (drain より前) に読み取り GET で得た activitySeq を echo
      // する。値は意図時点でピン留めされ、記録開始フェンスは必ず世代を +1
      // するため、リクエストがどの段階で遅延しても「意図より後に記録が再開
      // された終了」は必ず不成立 (@codex R2〜R7: 読取時 updatedAt・ハンドラ
      // 到着時刻・timestamp(3) の等値はいずれも遅延/同一 ms 衝突で追い越され
      // 得る。整数の単調増加カウンタ + 意図時点ピンのみが健全)。
      //
      // token 無し (@codex R8): deploy を跨いで開いたままの旧タブとの互換のため
      // 拒否せず、従来 (改修前) と同一の条件 = status:"active" (+ stale 終了の
      // updatedAt 等値) で受ける。保護水準は現行本番と同じ = 退行ではない。
      // 旧タブの露出はタブ寿命 + 放置 session の 24h 自動終了で有界。
      //
      // stale 終了の updatedAt 等値 (@codex R8): flush は世代を進めない (R7)
      // ため、読取と commit の間に割り込む flush (半日圏外→復帰直後の一括
      // 送信等) を世代条件では検出できない。endedAt=最終活動時刻 (過去) で
      // 終了した後にその flush の点が「終了時刻より後の記録」として残らない
      // よう、stale 終了に限り従来の読取時 updatedAt 等値も併用する
      // (割り込まれたら 0 行 → 409 → 再試行では最新活動が見え stale でなくなる)。
      const result = await prisma.fieldSurveySession.updateMany({
        where: {
          id,
          status: "active",
          ...(patch.expectedActivitySeq !== undefined && {
            activitySeq: patch.expectedActivitySeq,
          }),
          ...(isStaleEnd && { updatedAt: existing.updatedAt }),
        },
        data: {
          status: patch.status,
          endedAt: effectiveEndedAt,
          ...(patch.memo !== undefined && { memo: patch.memo }),
        },
      });
      if (result.count === 0) {
        throw new ApiError(
          409,
          "session の状態が変わったため終了/キャンセルできませんでした",
          "INVALID_STATE",
        );
      }
    } else if (patch.memo !== undefined) {
      // memo のみ更新は状態に依存しないため通常 update で十分。
      await prisma.fieldSurveySession.update({
        where: { id },
        data: { memo: patch.memo },
      });
    } else if (patch.touch) {
      // B-7 (@codex R7): 活動記録専用の touch。updatedAt だけを進め、memo 等は
      // 一切変更しない。
      //
      // #317 (@codex R6/R7): fence: true の touch (位置記録の開始/再開) のみ
      // 世代 (activitySeq) を +1 する。increment は同一 ms の並行書込でも必ず
      // 値が変わる (updatedAt 等値ではここが破れる = R6)。フェンスは世代を
      // 進めるだけで何も条件にしない — 遅延したフェンスが後から着地しても
      // 「以後の古いトークンの終了を弾く」安全方向にしか働かない。
      // 通常の活動 touch (続行の記録・stale 解除) は updatedAt のみ進め、
      // 世代を変えない = 終了フロー自身の touch が意図時点のピンを壊さない。
      const touched = await prisma.fieldSurveySession.updateMany({
        where: { id, status: "active" },
        data: {
          updatedAt: new Date(),
          ...(patch.fence && { activitySeq: { increment: 1 } }),
        },
      });
      if (touched.count === 0) {
        // 並行で終了済み (@codex R9): 200 で握り潰すと client が終了済み
        // session を巡回中として使い続けるため、既存の INVALID_STATE conflict
        // に乗せて client 側の再取得へ誘導する。
        throw new ApiError(
          409,
          "active 状態でない session です",
          "INVALID_STATE",
        );
      }
    }

    const updated = await prisma.fieldSurveySession.findUnique({
      where: { id },
      select: SELECT_SESSION,
    });
    if (!updated) {
      // 直前まで存在していた行が消えるのは想定外。安全側で 404。
      throw new ApiError(404, "session が見つかりません", "NOT_FOUND");
    }

    if (patch.status === "ended") {
      // 自動終了ぶんを後から確定させた場合は、押した時刻ではなく最後に活動した
      // 時刻までを巡回時間とする（歩いていない時間を巡回に数えない）。
      const endedAtForDuration = settlingAutoEnded
        ? (settledAt ?? existing.updatedAt)
        : effectiveEndedAt;
      const durationSec = Math.max(
        0,
        Math.floor(
          (endedAtForDuration.getTime() - existing.startedAt.getTime()) / 1000,
        ),
      );
      await writeAuditLog({
        userId: session.id,
        action: "field_survey_session_end",
        targetTable: "field_survey_sessions",
        targetId: updated.id,
        detail: {
          sessionId: updated.id,
          durationSec,
          pointCount: existing.pointCount,
        },
      });
    } else if (patch.status === "cancelled") {
      await writeAuditLog({
        userId: session.id,
        action: "field_survey_session_cancel",
        targetTable: "field_survey_sessions",
        targetId: updated.id,
        detail: { sessionId: updated.id },
      });
    }

    return apiResponse({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}
