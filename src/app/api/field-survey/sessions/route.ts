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
import {
  createFieldSurveySessionSchema,
  fieldSurveySessionListQuerySchema,
} from "@/lib/validators";
import {
  isSessionStale,
  STALE_AUTO_END_THRESHOLD_MS,
} from "@/lib/field-survey-trip-util";

// Prisma の unique constraint 違反 (P2002) を class import なしで判定する。
// `@/generated/prisma` から Prisma.PrismaClientKnownRequestError を import すると
// Edge runtime や bundling の都合で副作用が出やすいため、duck typing で扱う。
function isPrismaUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}

// ---------- POST /api/field-survey/sessions ----------
// 巡回開始。同一スタッフに active session が既にあれば 409 で安全側に倒す。

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "field_survey", "write")) {
      throw new ApiError(403, "巡回開始の権限がありません", "FORBIDDEN");
    }

    const body = await parseJsonBody(request);
    const { memo } = createFieldSurveySessionSchema.parse(body);

    // 事前チェック (happy path のレイテンシ短縮と分かりやすいエラー応答用)。
    // race 条件は DB の partial unique index (one_active_per_staff_uniq) で
    // 担保し、P2002 を ACTIVE_SESSION_EXISTS にマップする (下記 catch)。
    const existingActive = await prisma.fieldSurveySession.findFirst({
      where: { staffUserId: session.id, status: "active" },
      select: { id: true, startedAt: true, updatedAt: true, pointCount: true },
    });
    if (existingActive) {
      // B-7 (UI総点検): 終了し忘れで放置された active session は
      // ここで自動終了してから新規開始を通す (終了し忘れによる 409 詰み解消)。
      // - 放置判定は startedAt でなく最終活動時刻 (updatedAt ≒ 最後の位置記録/
      //   メモ更新) で行う (@codex R3: 開始から 24h 超でも現に記録が続いている
      //   session を別端末からの開始で誤終了しない)。
      // - endedAt も updatedAt を使い、巡回時間を実際より長く記録しない。
      if (
        !isSessionStale(
          existingActive.updatedAt,
          new Date(),
          STALE_AUTO_END_THRESHOLD_MS,
        )
      ) {
        throw new ApiError(
          409,
          "active な巡回 session が既に存在します。先に終了してください",
          "ACTIVE_SESSION_EXISTS",
        );
      }
    }

    // 自動終了 (放置 session がある場合) と新規作成は 1 トランザクションで行う。
    // - @codex R1 P2: updatedAt を conditional write の条件に含め、読取後の
    //   track point flush と競合したら書かない (endedAt / 監査 detail は条件
    //   一致したスナップショットなので常に整合)。
    // - @codex R2 P2: create が失敗 (非 P2002 含む) したら自動終了ごと rollback
    //   し、「既存 session だけ終了して新規が無い」中途半端な状態を残さない。
    //   監査ログはトランザクション成功後にのみ書く。
    // - @codex R3 P2: 条件が外れて再読取した session がまだ active なら、それは
    //   「直前に活動があった」= 放置ではないので自動終了せず 409 に倒す
    //   (@updatedAt は更新の度に現在時刻になるため、再判定は常に非 stale)。
    let created;
    let autoEndedSnapshot: typeof existingActive = null;
    try {
      const result = await prisma.$transaction(async (tx) => {
        let endedSnapshot: typeof existingActive = null;
        if (existingActive) {
          const autoEnded = await tx.fieldSurveySession.updateMany({
            where: {
              id: existingActive.id,
              status: "active",
              updatedAt: existingActive.updatedAt,
            },
            data: { status: "ended", endedAt: existingActive.updatedAt },
          });
          if (autoEnded.count > 0) {
            endedSnapshot = existingActive;
          } else {
            // 0 行更新 = 並行で終了済み or 直前に活動があった。再読取して判別。
            const fresh = await tx.fieldSurveySession.findFirst({
              where: { id: existingActive.id, status: "active" },
              select: { id: true },
            });
            if (fresh) {
              // まだ active = updatedAt が進んだ直後 (活動中)。放置ではないので
              // 自動終了せず、従来どおり 409 (rollback で無傷)。
              throw new ApiError(
                409,
                "active な巡回 session が既に存在します。先に終了してください",
                "ACTIVE_SESSION_EXISTS",
              );
            }
            // 終了済み → そのまま新規作成へ
          }
        }
        const createdRow = await tx.fieldSurveySession.create({
          data: {
            staffUserId: session.id,
            startedAt: new Date(),
            status: "active",
            memo: memo ?? null,
          },
          select: {
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
          },
        });
        return { createdRow, endedSnapshot };
      });
      created = result.createdRow;
      autoEndedSnapshot = result.endedSnapshot;
    } catch (err) {
      // partial unique index 違反 (同一 staff の active 重複) を 409 に変換。
      // 並行 POST のうち、後発リクエストは findFirst 後にここへ到達しうる。
      // rollback により自動終了も取り消される (安全側 = 既存 session は残る)。
      if (isPrismaUniqueViolation(err)) {
        throw new ApiError(
          409,
          "active な巡回 session が既に存在します。先に終了してください",
          "ACTIVE_SESSION_EXISTS",
        );
      }
      throw err;
    }

    if (autoEndedSnapshot) {
      await writeAuditLog({
        userId: session.id,
        action: "field_survey_session_auto_end",
        targetTable: "field_survey_sessions",
        targetId: autoEndedSnapshot.id,
        detail: {
          sessionId: autoEndedSnapshot.id,
          reason: "stale_on_new_start",
          pointCount: autoEndedSnapshot.pointCount,
        },
      });
    }
    await writeAuditLog({
      userId: session.id,
      action: "field_survey_session_start",
      targetTable: "field_survey_sessions",
      targetId: created.id,
      detail: { sessionId: created.id },
    });

    return apiResponse({ data: created }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- GET /api/field-survey/sessions ----------
// 自分の session 一覧（pagination 必須）。
// staffUserId クエリは field_survey:read_all 必須。read_all が無ければ
// 強制的に session.id でフィルタする（own only）。

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "field_survey", "read")) {
      throw new ApiError(403, "閲覧権限がありません", "FORBIDDEN");
    }

    const { searchParams } = new URL(request.url);
    const queryObj: Record<string, string> = {};
    searchParams.forEach((v, k) => {
      queryObj[k] = v;
    });
    const { page, limit, staffUserId, status, scope } =
      fieldSurveySessionListQuerySchema.parse(queryObj);

    const hasReadAll = hasPermission(permissions, "field_survey", "read_all");
    const hasManage = hasPermission(permissions, "field_survey", "manage");
    const canSeeAll = hasReadAll || hasManage;

    // scope=all は read_all / manage のみ。一般スタッフは自分の session のみ。
    if (scope === "all" && !canSeeAll) {
      throw new ApiError(
        403,
        "全スタッフの巡回を閲覧する権限がありません",
        "FORBIDDEN",
      );
    }

    const where: {
      staffUserId?: string;
      status?: "active" | "ended" | "cancelled";
    } = {};

    if (canSeeAll && staffUserId) {
      // 認可済み caller の明示 staffUserId フィルタは scope に依らず尊重する。
      // (Codex P2: scope 未指定でも staffUserId を黙って own に倒して別人の
      //  session を返さない。pre-1-J の staffUserId フィルタ互換も維持。)
      where.staffUserId = staffUserId;
    } else if (scope === "all" && canSeeAll) {
      // staffUserId 未指定の全スタッフ閲覧 (read_all/manage のみ到達)。
    } else {
      // mine: 非 canSeeAll の他人 staffUserId 指定は無視して session.id 強制。
      where.staffUserId = session.id;
    }
    if (status) where.status = status;

    const [total, sessions] = await Promise.all([
      prisma.fieldSurveySession.count({ where }),
      prisma.fieldSurveySession.findMany({
        where,
        orderBy: { startedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          staffUserId: true,
          startedAt: true,
          endedAt: true,
          status: true,
          pointCount: true,
          activitySeq: true,
          createdAt: true,
          updatedAt: true,
          staff: { select: { name: true } },
        },
      }),
    ]);

    // ⚠**他人の巡回を含む一覧閲覧は監査する**（総点検P3）。session 詳細
    // (field_survey_session_view) と軌跡 (track-points GET) の他人閲覧は監査
    // 済みなのに、同じメタ情報（担当者・開始/終了時刻 = 勤怠に相当）を
    // まとめて見られる一覧だけ無監査という非対称があった。1 リクエスト 1 件
    // （ページ単位）で、detail に座標・氏名は入れない。自分の分のみの閲覧
    // (mine) は従来どおり監査しない（高頻度・自分のデータのため）。
    // ⚠判定は上の where 構築と**同じ分岐**で行う (@codex #337)。staffUserId を
    // 明示指定した場合は scope に依らずその人だけに絞られるので、
    // `scope=all&staffUserId=<自分>` は実際には自分の分しか返らない。
    // scope だけ見て「他人を含む」と扱うと、自分専用の閲覧に他スタッフ閲覧の
    // 監査が付き、監査記録として嘘になる。
    const listsOthers =
      canSeeAll &&
      (staffUserId ? staffUserId !== session.id : scope === "all");
    if (listsOthers) {
      await writeAuditLog({
        userId: session.id,
        action: "field_survey_session_list_view",
        targetTable: "field_survey_sessions",
        // targetId は一覧のため無し（ページ単位の 1 件）
        detail: {
          scope: staffUserId ? "staff" : "all",
          viewedStaffUserId: staffUserId ?? null,
          page,
          returned: sessions.length,
        },
      });
    }

    // pinCount は archived を除いた紐付け pin 数。ページ分の session id をまとめて
    // groupBy で集計し N+1 を避ける (座標・memo 等は取得しない)。
    const ids = sessions.map((s) => s.id);
    const pinCounts = ids.length
      ? await prisma.fieldSurveyPin.groupBy({
          by: ["sessionId"],
          where: { sessionId: { in: ids }, status: { not: "archived" } },
          _count: { _all: true },
        })
      : [];
    const pinCountMap = new Map(
      pinCounts.map((p) => [p.sessionId, p._count._all]),
    );

    const data = sessions.map((s) => ({
      id: s.id,
      staffUserId: s.staffUserId,
      staffName: s.staff?.name ?? null,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      status: s.status,
      pointCount: s.pointCount,
      // #317: 終了フェンスの世代カウンタ (復元 client が stale 直接終了の
      // トークンに使う)。非 PII。
      activitySeq: s.activitySeq,
      pinCount: pinCountMap.get(s.id) ?? 0,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));

    return apiResponse({
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
