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
  snapBboxToCells,
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
//  - ⚠ただし「集計だから個人は分からない」は**それだけでは成り立たない**
//    (@codex #332 P1)。稼働が2〜3人の職場で進行中の巡回まで含めると、地図を
//    更新し続けるだけで同僚の現在の移動が追えてしまう（50m マスが増えていく
//    様子がその人の経路そのものになる）。**終了した巡回だけを数える**ことで
//    この経路を塞いでいる（下の SQL の status='ended'）。この2つは
//    セットで初めて「read だけで全社分を見せてよい」が成立する。
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
    // ⚠SQL には Date ではなく **オフセット付き ISO 文字列**で束縛する。
    // Prisma は Date をオフセット無しの UTC 壁時計テキスト
    // （例 '2026-07-01 03:16:40'）で送るため、`::timestamptz` を当てると
    // **セッションのタイムゾーンで解釈**され、UTC 以外の DB では 9 時間ずれる
    // （dev の Asia/Tokyo で実測。'...Z' 付き文字列ならどの TZ でも同じ瞬間になる）。
    const fromAtIso = fromAt?.toISOString() ?? null;

    // ⚠集計の範囲は**格子の境界まで広げる** (@codex #332 P2)。画面の端が
    // セルを横切っていると、そのセルは画面内の点しか数えられず、
    // クライアントはセル全体を塗るので**数ピクセル動かすだけで色が変わる**
    // （3回歩いた道が1回に見える／見えている部分が未踏破に見える）。
    const q = snapBboxToCells({ north, south, east, west }, { latStep, lngStep });

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
    // ⚠`recorded_at` は **timestamp without time zone に UTC の壁時計値**が
    // 入っている。そこへいきなり `AT TIME ZONE 'Asia/Tokyo'` を当てると
    // 「その値は既に東京時刻である」と解釈され、9 時間ずれる (@codex #332 P2)。
    // 本番実測: 保存値 `2026-07-20 23:00`(= JST 7/21 08:00) が
    //   いきなり Asia/Tokyo → 7/20 ✗ / 一度 UTC と解釈してから → 7/21 ✓
    // つまり **JST の 0〜9 時に記録した点が前日に数えられていた**。朝から歩く
    // 業務なので実害がある。必ず `AT TIME ZONE 'UTC'` を先に通すこと。
    //
    // ⚠同じ理由で期間の下限比較も naive(UTC) 同士で行う。timestamptz と直接
    // 比べると、naive 側が**セッションのタイムゾーン**で解釈されて 9 時間ずれる。
    //
    // ⚠staff_user_id は集計の内側だけで使い、応答には出さない（誰の分かは返さない）。
    //
    // ⚠**終了した巡回だけ**を数える (@codex #332 P1)。cancelled を除くだけでは
    // 足りない。進行中の巡回を含めると、稼働が2〜3人の職場では**地図を更新し
    // 続けるだけで同僚の現在の移動が追える**（50m マスが増えていく様子がその人の
    // 経路そのものになる）。集計で人名を伏せても、少人数かつリアルタイムだと
    // 実質的に個人の追跡になる。
    // 終了後に出るのは業務上は十分（「今日そこを歩いた」= 二度歩きを避ける情報は
    // 巡回が終わってから効く）。自分の進行中の経路は地図上の線で見えている。
    const rows = await prisma.$queryRaw<CoverageRow[]>`
      SELECT floor(tp.lat / ${latStep}::numeric)::int AS "y",
             floor(tp.lng / ${lngStep}::numeric)::int AS "x",
             count(DISTINCT (
               s.staff_user_id,
               ((tp.recorded_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Tokyo')::date
             ))::int                                  AS "p"
      FROM field_survey_track_points tp
      JOIN field_survey_sessions s ON s.id = tp.session_id
      WHERE tp.lat >= ${q.south}::numeric
        AND tp.lat < ${q.north}::numeric
        AND tp.lng >= ${q.west}::numeric
        AND tp.lng < ${q.east}::numeric
        AND s.status::text = 'ended'
        AND (
          ${fromAtIso}::timestamptz IS NULL
          OR tp.recorded_at >= (${fromAtIso}::timestamptz AT TIME ZONE 'UTC')
        )
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
