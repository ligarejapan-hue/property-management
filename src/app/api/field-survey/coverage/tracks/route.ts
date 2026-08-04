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
  COVERAGE_TRACK_GAP_METERS,
  COVERAGE_TRACK_GAP_SECONDS,
  COVERAGE_TRACK_POINT_BUDGET,
  COVERAGE_TRACK_SESSION_LIMIT,
  planTrackFetch,
  splitTrackAtGaps,
  type TrackPointInput,
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
//  - field_survey:read のみ。**read_all は要求しない**。
//
//    ⚠これは @codex #334 P1 の指摘（既存の sessions/[id]/track-points が他人の
//    巡回に read_all/manage を要求しているのだから合わせるべき）と**意図的に
//    異なる**。一度 read_all を要求する実装にしたが、発注者の判断で戻した。
//
//    発注者（不動産事業部責任者）の判断:
//    **「歩いたルートは全員が見られるようにする。制限する必要のない情報」**
//    （2026-07-28「全員の記録は見せていいよ」→ 2026-07-29 に再確認）。
//
//    業務上の根拠: この機能の目的は「同じ道を二度歩く無駄をなくす」こと。
//    街を歩く当人が他の人の歩いた道を見られなければ意味がない。既定の権限
//    テンプレートでは現地担当が read_all を持たないため、read_all を要求すると
//    **歩く人だけが見られず、歩かない事務席が見られる**逆転が起きる。
//
//    ⚠したがって「read_all を足せば済む」ではなく、**この API は read で通す**
//    のが正しい。read_all は他人のピンや、勤怠証拠にあたる生の巡回記録
//    （時刻・担当者つき）まで広げてしまい、線を見せる目的には過大。
//
//  - 見せるのは道筋だけで、勤怠の証拠にあたる情報は**返さない**:
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

/**
 * 候補の巡回。点数は量の見積もりにだけ使う。
 * ⚠pointCount は**表示対象（bbox 内かつ期間内）の点数** (@codex #334 P2)。
 * 巡回全体の点数 (s.point_count) で見積もると、画面をかすめただけの長い
 * 巡回が予算を食い尽くし、画面内の他の巡回が落ちる。
 */
interface SessionRow {
  id: string;
  pointCount: number;
}

/**
 * 線の点。
 * ⚠`sessionId` と `gapBefore` は**サーバ内でしか使わない**（線の切り分け用）。
 * 応答には座標しか載せない。
 */
interface PointRow {
  sessionId: string;
  lat: number;
  lng: number;
  /** 生の（間引く前の）一つ前の点との間に記録の途切れがあるか。SQL が計算。 */
  gapBefore: boolean;
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

    // ⚠read だけで通す（発注者判断。上のコメント参照）。read_all は要求しない。
    if (!hasPermission(permissions, "field_survey", "read")) {
      throw new ApiError(403, "閲覧権限がありません", "FORBIDDEN");
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
    // ⚠SQL には Date ではなく **オフセット付き ISO 文字列**で束縛する。
    // Prisma は Date をオフセット無しの UTC 壁時計テキストで送るため、
    // `::timestamptz` を当てるとセッションのタイムゾーンで解釈され、
    // UTC 以外の DB では 9 時間ずれる（dev の Asia/Tokyo で実測。cells と同じ）。
    const fromAtIso = fromAt?.toISOString() ?? null;

    // ── 1. 表示範囲に点を持つ「終了した巡回」を新しい順に拾う ──────────
    //
    // ⚠期間の絞り込みは**点**に掛ける（巡回が期間の境をまたぐことがある）。
    // ⚠`recorded_at` は timestamp without time zone に UTC の壁時計値が入って
    //   いるため、timestamptz と直接比べず naive(UTC) 同士で比べる
    //   （直接比べるとセッションのタイムゾーンで解釈されて 9 時間ずれる）。
    const sessionRows = await prisma.$queryRaw<SessionRow[]>`
      SELECT s.id::text  AS "id",
             count(*)::int AS "pointCount"
      FROM field_survey_sessions s
      JOIN field_survey_track_points tp ON tp.session_id = s.id
      WHERE s.status::text = 'ended'
        -- ⚠自動終了した後に位置記録が届いた巡回は除く (@codex #356 P1)。
        -- 終了扱いのまま位置が更新され続けると、実行中の巡回を隠す守りを抜けて
        -- **まだ歩いている人の経路が他スタッフに追える**（線はマスより直接的）。
        -- NULL (既存行・通常の終了) は対象に含めるため IS NOT TRUE で判定する。
        AND s.reconcile_pending IS NOT TRUE
        AND tp.lat >= ${south}::numeric
        AND tp.lat < ${north}::numeric
        AND tp.lng >= ${west}::numeric
        AND tp.lng < ${east}::numeric
        AND (
          ${fromAtIso}::timestamptz IS NULL
          OR tp.recorded_at >= (${fromAtIso}::timestamptz AT TIME ZONE 'UTC')
        )
      GROUP BY s.id
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
        unrenderableTrips: 0,
        truncated: plan.truncated || hasMoreCandidates,
        lines: [],
      });
    }

    // ── 2. 選んだ巡回の点を読む ─────────────────────────────
    //
    // ⚠**表示範囲で絞る**が、素朴に切ってはいけない (@codex #334 P2)。
    //   範囲外の点をただ落とすと、画面を出入りする巡回で「出た所」と
    //   「戻った所」が1本につながり、通っていない道を横切る線が描かれる。
    //   かといって絞らないと、画面をかすめただけの長い巡回の**画面外の点**が
    //   点数予算を食い尽くし（寄せても直らない）、見えない場所の生座標まで
    //   応答に載る。そこで
    //     - 範囲内の点に加えて**出入りの境の1点だけ**食み出して残す
    //       （inb / prev_inb / next_inb。線が画面端で不自然に止まらない）
    //     - **範囲外を挟んで戻ってきた所は切れ目**にする（一つ前の生の点が
    //       残っていない = NOT(prev2_inb OR prev_inb OR inb) を gapBefore に
    //       合流。範囲外に3点以上出た場合だけ成立し、1〜2点かすめた程度は
    //       境の点ごと残るので線は切れない）
    //   とする。候補側の pointCount も表示対象の点数なので、予算は画面に
    //   描く量だけで数えられる。
    //
    // ⚠間引きは巡回内の**通し番号 (rn) の剰余**で行い、**各巡回の最初と最後は
    //   必ず残す** (@codex #334 P1)。`sequence` の生の剰余だと、点が2つしかない
    //   短い巡回が `thinStep=2` で1点に減り、後段の「2点未満は線にしない」で
    //   黙って消える。planTrackFetch は残した数に数えているので落とした件数にも
    //   出ず、**歩いた道が「誰も通っていない」ように見える**。
    //   rn は連番の抜け（保存失敗など）にも影響されない。
    //   rn/cnt は**表示対象に絞った後**の並びで振る（範囲外の点は最初から
    //   描く対象ではないため）。
    //
    // ⚠**記録の途切れ（線を切る所）は間引く前に、生の隣どうしで判定する**
    //   (@codex #334 P2)。lag で一つ前の点との間隔（2分 / haversine 200m）を
    //   見て切れ目の印 `gapBefore` を立て、**印の付いた点と、その直前の点
    //   （= 次の点に印がある点）は間引きでも必ず残す**。こうしないと
    //     - 途切れの前後の点が間引きで落ち、断片が1点になって線ごと消える
    //       （2点+途切れ+2点の巡回が thinStep=3 で全滅する）
    //     - 取ってきた点から JS で判定し直すと、間引き後は間隔が thinStep 倍に
    //       開くので、続けて移動した道にも偽の切れ目が出る
    //   の2つが起きる。JS は印に従って切るだけで、間隔の再判定はしない。
    //
    // ⚠**期間の下限は点にも掛ける** (@codex #334 P2)。境をまたぐ巡回は
    //   「最近の点が1つでもある」だけで候補に入るので、掛けないと「直近1年」の
    //   線に1年より前の座標が混ざり、面の色と期間が食い違う。
    //   点は時刻順なので、下限で落ちるのは**先頭の連続した区間**だけ。
    //   線の途中に穴が空いて直線で結ばれることはない。
    //   （lag も除外後の並びで取るので、境の直後の点に偽の印は付かない。
    //     先頭になった点は prev が無く、印なしで線の頭になるだけ。）
    //
    // ⚠並び順は **候補の新しい順（ids の並び = unnest WITH ORDINALITY の pos）**
    //   (@codex #334 P2)。sessionId（UUID の字句順）で並べると、安全弁の LIMIT が
    //   どの巡回を切るか運任せになり、**一番新しい巡回が丸ごと消える**ことがある
    //   （planTrackFetch は一番新しい1本を必ず残す約束をしている）。新しい順なら
    //   切られるのは常に末尾 = 一番古い巡回。
    //
    // ⚠lat/lng は Decimal(10,7)。`::float8` にしないと Prisma が Decimal を
    //   返し、JSON 化で文字列になってクライアントの描画が全滅する。
    const ids = plan.sessionIds;
    const pointRows = await prisma.$queryRaw<PointRow[]>`
      SELECT x."sessionId", x."lat", x."lng", x."gapBefore"
      FROM (
        SELECT k."sessionId", k."lat", k."lng", k."gapBefore", k.pos,
               row_number()        OVER kwin AS rn,
               count(*)            OVER (PARTITION BY k."sessionId") AS cnt,
               lead(k."gapBefore") OVER kwin AS "gapAfter"
        FROM (
          SELECT w."sessionId", w."lat", w."lng", w.seq, w.pos,
                 (w.prev_at IS NOT NULL AND (
                   abs(extract(epoch from (w.rec_at - w.prev_at)))
                     > ${COVERAGE_TRACK_GAP_SECONDS}::float8
                   OR 2 * 6371000 * asin(least(1.0::float8, sqrt(
                        power(sin(radians(w."lat" - w.prev_lat) / 2), 2)
                        + cos(radians(w.prev_lat)) * cos(radians(w."lat"))
                          * power(sin(radians(w."lng" - w.prev_lng) / 2), 2)
                      ))) > ${COVERAGE_TRACK_GAP_METERS}::float8
                   OR NOT (COALESCE(w.prev2_inb, false)
                           OR COALESCE(w.prev_inb, false) OR w.inb)
                 )) AS "gapBefore"
          FROM (
            SELECT r."sessionId", r."lat", r."lng", r.seq, r.pos,
                   r.rec_at, r.inb,
                   lag(r.rec_at)   OVER win AS prev_at,
                   lag(r."lat")    OVER win AS prev_lat,
                   lag(r."lng")    OVER win AS prev_lng,
                   lag(r.inb)      OVER win AS prev_inb,
                   lag(r.inb, 2)   OVER win AS prev2_inb,
                   lead(r.inb)     OVER win AS next_inb
            FROM (
              SELECT tp.session_id::text AS "sessionId",
                     tp.lat::float8      AS "lat",
                     tp.lng::float8      AS "lng",
                     tp.sequence         AS seq,
                     ord.pos             AS pos,
                     tp.recorded_at      AS rec_at,
                     (tp.lat >= ${south}::numeric AND tp.lat < ${north}::numeric
                      AND tp.lng >= ${west}::numeric AND tp.lng < ${east}::numeric)
                                         AS inb
              FROM field_survey_track_points tp
              JOIN unnest(ARRAY[${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}])
                   WITH ORDINALITY AS ord(sid, pos)
                ON ord.sid = tp.session_id
              WHERE (
                  ${fromAtIso}::timestamptz IS NULL
                  OR tp.recorded_at >= (${fromAtIso}::timestamptz AT TIME ZONE 'UTC')
                )
            ) r
            WINDOW win AS (PARTITION BY r."sessionId" ORDER BY r.seq)
          ) w
          WHERE COALESCE(w.prev_inb, false) OR w.inb OR COALESCE(w.next_inb, false)
        ) k
        WINDOW kwin AS (PARTITION BY k."sessionId" ORDER BY k.seq)
      ) x
      WHERE ${plan.thinStep}::int = 1
         OR x.rn = 1
         OR x.rn = x.cnt
         OR (x.rn - 1) % ${plan.thinStep}::int = 0
         OR x."gapBefore"
         OR COALESCE(x."gapAfter", false)
      ORDER BY x.pos, x.rn
      LIMIT ${HARD_ROW_CAP + 1}
    `;

    // 安全弁に当たったら、末尾の巡回は点が欠けている可能性があるので丸ごと
    // 落とす（欠けた線をそのまま描くと、行っていない所を通ったように見える）。
    // ⚠並びは候補の新しい順なので、切られる末尾は**常に一番古い巡回**
    // (@codex #334 P2)。UUID 順だと一番新しい巡回が消えることがあった。
    let rows = pointRows;
    let droppedTrips = droppedBase;
    let droppedTripsExact = exactBase;
    let truncated = plan.truncated || hasMoreCandidates;
    if (pointRows.length > HARD_ROW_CAP) {
      const lastId = pointRows[HARD_ROW_CAP]?.sessionId ?? null;
      rows = pointRows
        .slice(0, HARD_ROW_CAP)
        .filter((r) => r.sessionId !== lastId);
      // ⚠ここでは本数を数えない (@codex #334 P2)。丸ごと落とした巡回は byId に
      // 現れないので、後段の「選んだのに1本も線にならなかった巡回」
      // (ids.length - byId.size) が1回だけ数える。ここでも足すと同じ巡回を
      // 2回数え、「◯件以上」の下限が実際より大きい嘘になる。
      // 安全弁に当たった時点で、その先に何本あるかは数えていない。
      droppedTripsExact = false;
      truncated = true;
    }

    // ── 3. 巡回ごとにまとめ、記録の途切れで線を切る（id は応答に出さない） ──
    //
    // ⚠**同じ巡回でも切る必要がある** (@codex #334 P2)。位置記録を途中で止めて
    // 再開したり GPS が一時停止すると、次の点は同じ巡回のまま遠く離れる。
    // 1本につなぐとその間を直線が横切り、**通っていない道を「歩いた」と示す**。
    // 切る位置は SQL が生の隣接点から立てた印（gapBefore）に従う。
    const byId = new Map<string, TrackPointInput[]>();
    for (const r of rows) {
      let pts = byId.get(r.sessionId);
      if (!pts) {
        pts = [];
        byId.set(r.sessionId, pts);
      }
      pts.push({ lat: r.lat, lng: r.lng, gapBefore: r.gapBefore });
    }
    const lines: { lat: number; lng: number }[][] = [];
    // ⚠**点が足りず線にできない巡回は、量の打ち切りと分けて数える**
    //   (@codex #334 P2)。droppedTrips に混ぜると、UI が「線が多いため古い
    //   巡回を省いた。寄せるか期間を絞ると出る」と案内するが、描けない巡回は
    //   寄せても出ないし、一番新しい巡回のこともある（開始してすぐ記録を
    //   止めた巡回など）。嘘の指示になるので別の断りとして返す。
    let unrenderableTrips = 0;
    for (const pts of byId.values()) {
      const segs = splitTrackAtGaps(pts);
      // 全部が1点未満の断片になって消えた巡回（黙って減らさない）。
      if (segs.length === 0) unrenderableTrips += 1;
      lines.push(...segs);
    }
    // 安全弁で丸ごと落とした巡回（byId に現れない）は量の打ち切り側。
    const capDropped = ids.length - byId.size;
    if (capDropped > 0) {
      droppedTrips += capDropped;
      truncated = true;
    }

    return trackResponse({
      days,
      thinStep: plan.thinStep,
      droppedTrips,
      droppedTripsExact,
      unrenderableTrips,
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
  /** 量が多くて落とした本数。寄せる/期間を絞ると解消する種類の欠け。 */
  droppedTrips: number;
  /** false なら「droppedTrips 件以上」の意味。画面の文言を変える。 */
  droppedTripsExact: boolean;
  /**
   * 点が足りず線にできなかった本数 (@codex #334 P2)。量とは別の断り。
   * 寄せても出ないので「寄せると出る」と案内してはいけない。常に正確な数。
   */
  unrenderableTrips: number;
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
