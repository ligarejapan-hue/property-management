import { NextRequest } from "next/server";
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
import {
  COVERAGE_CELL_LIMIT,
  COVERAGE_CELL_STEPS,
  coverageCellLabel,
  coverageFromAt,
  resolveCoverageCellSize,
  type CoverageCell,
} from "@/lib/field-survey-coverage";

// ---------- GET /api/field-survey/coverage/cells ----------
//
// 踏破ヒート（巡回で歩いた場所の蓄積）を格子に集計して返す。
//
// 業務目的: 街を歩いて目視で古い家を探すので、短期間に同じ道を二度歩くのは無駄。
// 「どこを踏破済みか」を全員で溜めて、次に回るエリアを決める。
//
// ⚠**全社合計**で返す（ユーザー決定 2026-07-28: 「Aさんが1度通れば1回、
// Bさんが1度通れば2回と全体で見てほしい」）。誰の分かを区別しないので、
// scope パラメータも staff の絞り込みも持たない。
//
// 権限:
//  - field_survey:read のみ。**read_all は要求しない**。
//    返すのは格子番号と回数だけで人を識別できないため、他人の生軌跡を見る権限
//    （= 勤怠の証拠にあたる sessions/[id]/track-points）とは別物として扱う。
//
// response:
//  - **生座標を1つも返さない**。格子番号 (y, x) と通過した巡回本数 (p) のみ。
//  - 人名・日時・セッションIDを返さない。
//  - クライアントは latStep/lngStep から矩形を復元する（丸め幅を応答に含めるのは、
//    クライアントとサーバで幅がずれると全セルが1マスずれるため）。
//
// AuditLog は書かない（地図の pan/zoom で高頻度に呼ばれる。
// /api/field-survey/map/properties と同方針。丸め済み・人名なし・日時なしが根拠）。

/** 集計 SQL が返す行。numeric/bigint を JSON に載せないため int にキャストする。 */
interface CoverageRow {
  y: number;
  x: number;
  p: number;
}

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
    const { north, south, east, west, days } =
      fieldSurveyCoverageQuerySchema.parse(queryObj);

    // 格子の粗さは bbox から自動で決める（利用者に選ばせない）。
    const cell = resolveCoverageCellSize({ north, south, east, west });
    const { latStep, lngStep } = COVERAGE_CELL_STEPS[cell];
    const fromAt = coverageFromAt(days, new Date());

    // ⚠Prisma の groupBy は式でグループ化できないため $queryRaw を使う。
    // 作法は properties/[id]/candidates/route.ts と同じ（タグ付きテンプレート +
    // ${} 束縛 + 明示キャスト + AS "camelCase"）。$queryRawUnsafe は使わない。
    //
    // ⚠キャストを外すと壊れる箇所:
    //  - count(...) は bigint。::int にしないと JSON 化で BigInt が例外になる。
    //  - floor(...) は numeric。::int にしないと文字列で返り、クライアントの
    //    矩形計算が全滅する。
    //
    // 数え方 = **(担当者, 通った日) の組の数**（ユーザー決定 2026-07-28）:
    //  - 同じ人が同じ日に何度通っても 1 回（朝と夕方に2回巡回しても1回。
    //    1回の巡回で往復しても1回。立ち止まっただけで色が跳ねない）
    //  - 別の人が通れば別に数える（「Aさんが1度通れば1回、Bさんが1度通れば2回」）
    //
    // 日付は **JST の暦日**で切る。UTC で切ると日本時間の朝が前日に入り、
    // 「同じ日」の境界が業務実感とずれる（既存の日付フィルタも JST 境界で
    // 統一済み = property-list-query.ts の jstDayBoundary）。
    //
    // ⚠staff_user_id は集計の内側だけで使い、応答には出さない（誰の分かは返さない）。
    //
    // cancelled のセッションは数えない（開始してすぐ取り消した巡回は踏破ではない）。
    const rows = await prisma.$queryRaw<CoverageRow[]>`
      SELECT floor(tp.lat / ${latStep}::numeric)::int AS "y",
             floor(tp.lng / ${lngStep}::numeric)::int AS "x",
             count(DISTINCT (
               s.staff_user_id,
               (tp.recorded_at AT TIME ZONE 'Asia/Tokyo')::date
             ))::int                                  AS "p"
      FROM field_survey_track_points tp
      JOIN field_survey_sessions s ON s.id = tp.session_id
      WHERE tp.lat >= ${south}::numeric
        AND tp.lat <= ${north}::numeric
        AND tp.lng >= ${west}::numeric
        AND tp.lng <= ${east}::numeric
        AND s.status::text <> 'cancelled'
        AND (${fromAt}::timestamptz IS NULL OR tp.recorded_at >= ${fromAt}::timestamptz)
      GROUP BY 1, 2
      ORDER BY 1, 2
      LIMIT ${COVERAGE_CELL_LIMIT + 1}
    `;

    // ⚠打ち切りは fail-closed。この画面は「色が無い＝誰も通っていない」と読ませる
    // ので、一部だけ返すと**行った場所を未踏破と誤って指示する**ことになる。
    // 上限を超えたら色を一切出さず、地図を寄せてもらう。
    const truncated = rows.length > COVERAGE_CELL_LIMIT;
    const cells: CoverageCell[] = truncated
      ? []
      : rows.map((r) => ({ y: r.y, x: r.x, p: r.p }));

    return apiResponse({
      data: {
        cell,
        cellLabel: coverageCellLabel(cell),
        latStep,
        lngStep,
        days,
        cellCount: cells.length,
        maxPasses: cells.reduce((m, c) => (c.p > m ? c.p : m), 0),
        truncated,
        cells,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
