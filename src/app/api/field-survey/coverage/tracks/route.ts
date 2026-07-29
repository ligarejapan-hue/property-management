import { NextRequest } from "next/server";
import { Prisma } from "@/generated/prisma";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  apiResponse,
  handleApiError,
  ApiError,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { fieldSurveyCoverageQuerySchema } from "@/lib/validators";
import { coverageFromAt } from "@/lib/field-survey-coverage";
import {
  COVERAGE_TRACK_POINT_BUDGET,
  COVERAGE_TRACK_SESSION_LIMIT,
  planTrackFetch,
  type TrackSessionCandidate,
} from "@/lib/field-survey-tracks";

// ---------- GET /api/field-survey/coverage/tracks ----------
//
// 過去に歩いた道筋（線）を、いま見えている範囲について返す。
//
// 業務目的: 街を歩いて目視で古い家を探すので、同じ道の二度歩きは無駄。
// 面（マス）の色は「どのあたりを回ったか」を示すが、マス(50m)は道より広く、
// 点と点の間もつながないので、**実際に歩いた筋は線でしか出せない**
// （ユーザー指摘 2026-07-29「以前のシステムは線で表示されていた」）。
//
// 権限:
//  - field_survey:read **かつ** read_all または manage。
//    ⚠当初は read だけで通す実装にしたが、それは既存の境界を崩していた
//    (@codex #334 P1)。集計 (coverage/cells) が read だけで済むのは「格子番号と
//    回数」しか返さないからで、こちらは**生の座標**を返す。ID や時刻を削っても
//    「他人の GPS 軌跡そのもの」であることは変わらず、
//    sessions/[id]/track-points が他人の巡回に read_all/manage を要求している
//    のと同じ性質の情報である。
//    → **誰に見せるかは権限画面で決める**。全員に見せたい職場なら現地スタッフに
//      read_all を付ければよく、既定で崩す話ではない。
//    → read だけの人にも「どこを誰も回っていないか」は coverage/cells の色で
//      届くので、次に回るエリアを決める業務自体は成立する。
//  - その上で、勤怠の証拠にあたる情報は**返さない**:
//      * 誰の巡回か（staff_user_id・氏名）
//      * いつ歩いたか（recorded_at・started_at・ended_at）
//      * どの巡回か（session id）
//    返すのは「ここに道筋があった」という形だけ。線の切れ目を保つために
//    巡回ごとに配列を分けるが、並び順以外の意味を持たない添字で区切る。
//  - ⚠**終了した巡回だけ**を返す。進行中を含めると、稼働が2〜3人の職場では
//    地図を更新し続けるだけで同僚の現在の移動が追える（cells と同じ理由）。
//    自分の進行中の線は、地図上に別途リアルタイムで出ている。
//
// AuditLog は書かない（地図の pan/zoom で高頻度に呼ばれる。cells と同方針）。
// ただし cells と違い生座標を返すため、**応答を保存させない**
// （no-store。端末やプロキシに軌跡が残らないようにする）。

/** 候補の巡回。点数は量の見積もりにだけ使う。 */
interface SessionRow {
  id: string;
  pointCount: number;
}

/** 線の点。session ごとに分けるためのキーは応答に出さない。 */
interface PointRow {
  sessionId: string;
  lat: number;
  lng: number;
}

/**
 * 実際に読む行数の安全弁。`point_count` が実データとずれていた場合でも、
 * 想定外の巨大クエリにならないようにする（本番実測では全行一致だが、
 * 集計値を信用しきらない）。
 */
const HARD_ROW_CAP = COVERAGE_TRACK_POINT_BUDGET * 2;

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "field_survey", "read")) {
      throw new ApiError(403, "閲覧権限がありません", "FORBIDDEN");
    }
    // ⚠他人の生軌跡にあたるため、集計 (coverage/cells) より上の権限を要る。
    // 既存の sessions/[id]/track-points と同じ境界に合わせる (@codex #334 P1)。
    const canSeeOthers =
      hasPermission(permissions, "field_survey", "read_all") ||
      hasPermission(permissions, "field_survey", "manage");
    if (!canSeeOthers) {
      throw new ApiError(
        403,
        "他の担当者の記録を見る権限がありません",
        "FORBIDDEN",
      );
    }

    const { searchParams } = new URL(request.url);
    const queryObj: Record<string, string> = {};
    searchParams.forEach((v, k) => {
      queryObj[k] = v;
    });
    // bbox と期間の条件は面（cells）と同じものを使う。
    // 片方だけ違う範囲を見ていると、色と線が食い違って読めなくなる。
    const { north, south, east, west, days } =
      fieldSurveyCoverageQuerySchema.parse(queryObj);
    const fromAt = coverageFromAt(days, new Date());

    // ── 1. 表示範囲に点を持つ「終了した巡回」を新しい順に拾う ──────────
    //
    // ⚠期間の絞り込みは**点**に掛ける（巡回が期間の境をまたぐことがある）。
    // ⚠`recorded_at` は timestamp without time zone に UTC の壁時計値が入って
    //   いるため、timestamptz と直接比べず naive(UTC) 同士で比べる
    //   （直接比べるとセッションのタイムゾーンで解釈されて 9 時間ずれる）。
    const sessionRows = await prisma.$queryRaw<SessionRow[]>`
      SELECT s.id::text        AS "id",
             s.point_count::int AS "pointCount"
      FROM field_survey_sessions s
      WHERE s.status::text = 'ended'
        AND EXISTS (
          SELECT 1
          FROM field_survey_track_points tp
          WHERE tp.session_id = s.id
            AND tp.lat >= ${south}::numeric
            AND tp.lat < ${north}::numeric
            AND tp.lng >= ${west}::numeric
            AND tp.lng < ${east}::numeric
            AND (
              ${fromAt}::timestamptz IS NULL
              OR tp.recorded_at >= (${fromAt}::timestamptz AT TIME ZONE 'UTC')
            )
        )
      ORDER BY COALESCE(s.ended_at, s.started_at) DESC
      LIMIT ${COVERAGE_TRACK_SESSION_LIMIT + 1}
    `;

    // ⚠上限 +1 で引いているので、**上限を超えた本数は分からない** (@codex #334 P2)。
    // 「1件だけ足りない」と表示すると、実際は何十件も欠けているのに
    // ほぼ完全に見えてしまう。分からないときは「◯件以上」と伝える。
    const hasMoreCandidates = sessionRows.length > COVERAGE_TRACK_SESSION_LIMIT;
    const candidates: TrackSessionCandidate[] = sessionRows
      .slice(0, COVERAGE_TRACK_SESSION_LIMIT)
      .map((r) => ({ id: r.id, pointCount: r.pointCount }));
    const plan = planTrackFetch(candidates);
    /** 落とした本数を正確に数えられたか。false なら表示は「◯件以上」。 */
    const exactBase = !hasMoreCandidates;
    const droppedBase = plan.droppedTrips + (hasMoreCandidates ? 1 : 0);

    if (plan.sessionIds.length === 0) {
      return trackResponse({
        days,
        thinStep: plan.thinStep,
        droppedTrips: droppedBase,
        droppedTripsExact: exactBase,
        truncated: plan.truncated || hasMoreCandidates,
        lines: [],
      });
    }

    // ── 2. 選んだ巡回の点を読む ─────────────────────────────
    //
    // ⚠**表示範囲で切らない**。範囲外の点を落とすと、画面を出入りする巡回で
    // 「出た所」と「戻った所」が直線で結ばれ、通っていない道を横切る線が
    // 描かれる。範囲外は地図側が勝手に切り取ってくれる。
    //
    // ⚠間引きは `sequence % step`（sequence は巡回ごとの連番）。先頭から
    // 等間隔に間引かれるので、線の形は保たれる。途中で打ち切る方式は採らない
    //（途切れた線は「そこで引き返した」ように見えて誤読を生む）。
    //
    // ⚠**期間の下限は点にも掛ける** (@codex #334 P2)。境をまたぐ巡回は
    //   「最近の点が1つでもある」だけで候補に入るので、掛けないと「直近1年」の
    //   線に1年より前の座標が混ざり、面の色と期間が食い違う。
    //   点は時刻順なので、下限で落ちるのは**先頭の連続した区間**だけ。
    //   線の途中に穴が空いて直線で結ばれることはない。
    //
    // ⚠lat/lng は Decimal(10,7)。`::float8` にしないと Prisma が Decimal を
    //   返し、JSON 化で文字列になってクライアントの描画が全滅する。
    const ids = plan.sessionIds;
    const pointRows = await prisma.$queryRaw<PointRow[]>`
      SELECT tp.session_id::text AS "sessionId",
             tp.lat::float8      AS "lat",
             tp.lng::float8      AS "lng"
      FROM field_survey_track_points tp
      WHERE tp.session_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
        AND (
          ${fromAt}::timestamptz IS NULL
          OR tp.recorded_at >= (${fromAt}::timestamptz AT TIME ZONE 'UTC')
        )
        AND (${plan.thinStep}::int = 1 OR tp.sequence % ${plan.thinStep}::int = 0)
      ORDER BY tp.session_id, tp.sequence
      LIMIT ${HARD_ROW_CAP + 1}
    `;

    // 安全弁に当たったら、末尾の巡回は点が欠けている可能性があるので丸ごと
    // 落とす（欠けた線をそのまま描くと、行っていない所を通ったように見える）。
    let rows = pointRows;
    let droppedTrips = droppedBase;
    let droppedTripsExact = exactBase;
    let truncated = plan.truncated || hasMoreCandidates;
    if (pointRows.length > HARD_ROW_CAP) {
      const lastId = pointRows[HARD_ROW_CAP]?.sessionId ?? null;
      rows = pointRows
        .slice(0, HARD_ROW_CAP)
        .filter((r) => r.sessionId !== lastId);
      droppedTrips += 1;
      // 安全弁に当たった時点で、その先に何本あるかは数えていない。
      droppedTripsExact = false;
      truncated = true;
    }

    // ── 3. 巡回ごとに線へまとめる（id は応答に出さない） ───────────
    const byId = new Map<string, { lat: number; lng: number }[]>();
    for (const r of rows) {
      let line = byId.get(r.sessionId);
      if (!line) {
        line = [];
        byId.set(r.sessionId, line);
      }
      line.push({ lat: r.lat, lng: r.lng });
    }
    // 点が 1 つしかない巡回は線にならない（描いても何も出ない）。
    const lines = [...byId.values()].filter((line) => line.length >= 2);

    return trackResponse({
      days,
      thinStep: plan.thinStep,
      droppedTrips,
      droppedTripsExact,
      truncated,
      lines,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

function trackResponse(data: {
  days: number;
  thinStep: number;
  droppedTrips: number;
  /** false なら「droppedTrips 件以上」の意味。画面の文言を変える。 */
  droppedTripsExact: boolean;
  truncated: boolean;
  lines: { lat: number; lng: number }[][];
}) {
  const res = apiResponse({
    data: {
      ...data,
      lineCount: data.lines.length,
      pointCount: data.lines.reduce((sum, l) => sum + l.length, 0),
    },
  });
  // ⚠生座標を返すので端末・プロキシに残さない（PII キャッシュ方針に合わせる）。
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}
