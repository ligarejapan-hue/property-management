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
import { TRIP_AUTO_END_REASON } from "@/lib/field-survey-auto-end";
import { writeAuditLog } from "@/lib/audit";
import {
  fieldSurveyTrackPointBatchSchema,
  fieldSurveyTrackPointListQuerySchema,
} from "@/lib/validators";

// ---------- POST /api/field-survey/sessions/[id]/track-points ----------
//
// Phase 1-B: 巡回 session の GPS track 点を batch で append する。
// - field_survey:write 必須。manage 不所持時は own session のみ。
// - active session 以外には保存しない (409 INVALID_STATE)。
// - recordedAt は session.startedAt - 5min 〜 now + 1min の範囲のみ許可
//   (端末の時計ずれ・改ざんに対する clock-skew 上限)。
// - (sessionId, sequence) unique と skipDuplicates で retry 冪等化。
//   実 insert 件数だけ session.pointCount を増やす。
// - transaction 内で全工程を行い、increment 時に status='active' を where に
//   含めて atomic に判定する。終了直後の race で 0 行更新なら全 rollback。
// - AuditLog は書かない (高頻度 append。session start/end と pointCount で監査)。

const CLOCK_SKEW_PAST_MS = 5 * 60 * 1000;
const CLOCK_SKEW_FUTURE_MS = 1 * 60 * 1000;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "field_survey", "write")) {
      throw new ApiError(403, "track point の保存権限がありません", "FORBIDDEN");
    }

    const body = await parseJsonBody(request);
    const { points } = fieldSurveyTrackPointBatchSchema.parse(body);

    const hasManage = hasPermission(permissions, "field_survey", "manage");

    const result = await prisma.$transaction(async (tx) => {
      const sess = await tx.fieldSurveySession.findUnique({
        where: { id },
        // endReason は「自動終了した巡回か」の判定に使う(@codex #356 P1)。
        select: {
          id: true,
          staffUserId: true,
          status: true,
          startedAt: true,
          endReason: true,
        },
      });
      if (!sess) {
        throw new ApiError(404, "session が見つかりません", "NOT_FOUND");
      }
      if (!hasManage && sess.staffUserId !== session.id) {
        throw new ApiError(
          403,
          "他スタッフの session には保存できません",
          "FORBIDDEN",
        );
      }
      // ⚠**自動終了した巡回も受け入れる**(@codex #356 P1)。ここで弾くと、後段で
      // 用意した受け入れ条件に**到達しない**(前回の修正はこの関門に阻まれて
      // 効いていなかった)。圏外で貯めた位置記録が復帰後に捨てられる。
      // 人が押して終えた巡回(endReason=null)は従来どおり弾く。
      const acceptable =
        sess.status === "active" ||
        (sess.status === "ended" && sess.endReason === TRIP_AUTO_END_REASON);
      if (!acceptable) {
        throw new ApiError(
          409,
          "active 状態でない session には保存できません",
          "INVALID_STATE",
        );
      }

      // recordedAt clock-skew 検証。startedAt より過去すぎ / now より未来すぎは
      // クライアント側の時計改ざん / バグの可能性。エラー応答に座標は含めない。
      const now = Date.now();
      const minTs = sess.startedAt.getTime() - CLOCK_SKEW_PAST_MS;
      const maxTs = now + CLOCK_SKEW_FUTURE_MS;
      for (let i = 0; i < points.length; i++) {
        const ts = new Date(points[i].recordedAt).getTime();
        if (ts < minTs || ts > maxTs) {
          throw new ApiError(
            422,
            `points[${i}].recordedAt が許容範囲外です`,
            "RECORDED_AT_OUT_OF_RANGE",
          );
        }
      }

      const inserted = await tx.fieldSurveyTrackPoint.createMany({
        data: points.map((p) => ({
          sessionId: id,
          sequence: p.sequence,
          lat: p.lat,
          lng: p.lng,
          accuracy: p.accuracy ?? null,
          recordedAt: new Date(p.recordedAt),
        })),
        skipDuplicates: true,
      });

      if (inserted.count > 0) {
        // 実 insert 件数のみ加算。session が終了済になっていたら 0 行更新 →
        // throw して transaction を rollback。
        // #317 (@codex R7): flush は世代 (activitySeq) を進めない。世代は
        // 「記録の開始 (フェンス)」だけが進める。これにより終了フローが
        // 意図時点でピンした世代が自分の drain (最終 flush) で壊れず、かつ
        // 他 client の記録再開 (フェンス) では必ず壊れる、が両立する。
        // ⚠**自動終了した巡回も受け取る**(@codex #356 P1)。圏外では送信できず
        // 端末に貯まるが、その間は活動が記録されないので無操作扱いで自動終了され
        // 得る。ここで弾くと**歩いた記録がまるごと失われる**(電波の悪い場所を回る
        // のがこの機能の主目的なので致命的)。人が押した終了(endReason=null)は
        // 従来どおり弾く=意図して終えた巡回に後から足さない。
        const upd = await tx.fieldSurveySession.updateMany({
          where: {
            id,
            OR: [
              { status: "active" },
              { status: "ended", endReason: TRIP_AUTO_END_REASON },
            ],
          },
          data: {
            pointCount: { increment: inserted.count },
            // ⚠**自動終了した巡回に記録が届いた = まだ歩いている可能性がある**
            // (@codex #356 P1)。踏破マップは「終了した巡回」を全員に見せる一方
            // 「実行中の巡回」は隠すことで、同僚の現在位置が追えないようにして
            // いる。自動終了で終了扱いになった巡回に位置が届き続けると、この守り
            // を抜けて**まだ歩いている人の現在位置が他スタッフに見える**。
            // 印が立っている間は踏破マップに出さず、次の見回りで無操作1時間を
            // 再確認できたら外す。
            ...(sess.status === "ended" ? { reconcilePending: true } : {}),
          },
        });
        if (upd.count === 0) {
          throw new ApiError(
            409,
            "session の状態が変わりました",
            "INVALID_STATE",
          );
        }
      }

      return {
        acceptedCount: inserted.count,
        skippedCount: points.length - inserted.count,
      };
    });

    return apiResponse({ data: result });
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- GET /api/field-survey/sessions/[id]/track-points ----------
//
// ルート再描画用。field_survey:read 必須。
// 自分の session は read のみで可。他人 session は read_all または manage 必須。
// 他人 session 取得時のみ AuditLog を書く (detail に座標を含めない)。

const SELECT_POINT = {
  sequence: true,
  lat: true,
  lng: true,
  accuracy: true,
  recordedAt: true,
} as const;

export async function GET(
  request: NextRequest,
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
      // reconcilePending: 未確定の自動終了を他スタッフに見せないための判定(下記)。
      select: { id: true, staffUserId: true, reconcilePending: true },
    });
    if (!sess) {
      throw new ApiError(404, "session が見つかりません", "NOT_FOUND");
    }

    const isOwn = sess.staffUserId === session.id;
    const hasReadAll = hasPermission(permissions, "field_survey", "read_all");
    const hasManage = hasPermission(permissions, "field_survey", "manage");
    if (!isOwn && !hasReadAll && !hasManage) {
      throw new ApiError(
        403,
        "他スタッフの session は閲覧できません",
        "FORBIDDEN",
      );
    }
    // ⚠**確定していない自動終了の生の軌跡は、他スタッフに見せない**
    // (@codex #356 P1)。自動終了は「本人がまだ歩いているかもしれない」状態でも
    // 起きるため、ここを開けたままにすると管理者が**歩いている最中の経路を
    // 追える**(実行中の巡回を隠す守りを自動終了が迂回する)。
    // 一覧から隠すのと同じ扱いにそろえ、直接の id 指定でも 404 にする。
    // 本人は従来どおり見られる(自分の記録の確認を妨げない)。
    if (!isOwn && sess.reconcilePending === true) {
      throw new ApiError(404, "session が見つかりません", "NOT_FOUND");
    }

    const { searchParams } = new URL(request.url);
    const queryObj: Record<string, string> = {};
    searchParams.forEach((v, k) => {
      queryObj[k] = v;
    });
    const { from, to, cursorSequence, limit } =
      fieldSurveyTrackPointListQuerySchema.parse(queryObj);

    const where: {
      sessionId: string;
      recordedAt?: { gte?: Date; lte?: Date };
      sequence?: { gt: number };
    } = { sessionId: id };
    if (from || to) {
      where.recordedAt = {};
      if (from) where.recordedAt.gte = new Date(from);
      if (to) where.recordedAt.lte = new Date(to);
    }
    if (cursorSequence !== undefined) {
      where.sequence = { gt: cursorSequence };
    }

    // take limit + 1 で「次ページの有無」を判定する。
    const rows = await prisma.fieldSurveyTrackPoint.findMany({
      where,
      orderBy: { sequence: "asc" },
      take: limit + 1,
      select: SELECT_POINT,
    });

    const hasNext = rows.length > limit;
    const data = hasNext ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasNext && data.length > 0 ? data[data.length - 1].sequence : null;

    if (!isOwn) {
      // 他スタッフのルート閲覧のみ監査対象。detail には座標を含めない。
      await writeAuditLog({
        userId: session.id,
        action: "field_survey_track_view",
        targetTable: "field_survey_track_points",
        targetId: id,
        detail: {
          sessionId: id,
          viewedStaffUserId: sess.staffUserId,
          pointsReturned: data.length,
          hasFrom: from !== undefined,
          hasTo: to !== undefined,
        },
      });
    }

    return apiResponse({ data, nextCursor });
  } catch (error) {
    return handleApiError(error);
  }
}
