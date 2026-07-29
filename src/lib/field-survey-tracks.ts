/**
 * 踏破の「線」（過去に歩いた道筋）を地図に重ねるための量の制御。
 *
 * 業務目的: 街を歩いて目視で古い家を探すので、同じ道の二度歩きは無駄。
 * 面（マス）の色は「どのあたりを回ったか」を示すが、
 *  - マス（50m）は道より広いので、通っていない裏路地まで塗られる
 *  - 点と点の間をつながないので、車移動や電波切れで虫食いになる
 * ため、**実際に歩いた筋は線でしか出せない**（ユーザー指摘 2026-07-29）。
 *
 * ⚠線は生の点をそのまま描くので、集計と違って点数がそのまま効く。
 * 全期間を引きで開くと数万点になり、屋外のスマホで地図が固まる。
 * そこで
 *   1. まず**間引く**（何点かに1点だけ描く）= 全体の形は保たれる
 *   2. それでも収まらない分だけ**古い巡回から落とす**
 * の順で抑える。**線を途中で打ち切る案は採らない**（途切れた線は
 * 「そこで引き返した」ように見えて誤読を生む）。
 */

/** 1リクエストで描く点の目安。これを超えないよう間引き幅を決める。 */
export const COVERAGE_TRACK_POINT_BUDGET = 8000;

/**
 * 間引き幅の上限。
 *
 * ⚠**「10秒に1点」ではない**（本番実測 2026-07-29 で判明）。点の採用条件は
 * `field-survey-geolocation-util.ts` の
 *   「前回から 10 秒経過」**または**「前回から 5m 移動」
 * の **OR** なので、徒歩では 5m 側が先に効く。
 * 本番実測（257点）: 間隔の中央値 **5 秒**・平均 7.4 秒。
 * したがって 6 点に 1 点は約 30〜45m 間隔であり、当初書いていた 66m ではない。
 *
 * それでもこの上限を 6 に置くのは、街歩きの曲がり角（道幅・角の丸み）を
 * 30〜45m 間隔でぎりぎり拾えるため。これ以上粗くすると線が道から外れて
 * 曲がり角を突っ切るようになる。
 */
export const COVERAGE_TRACK_MAX_THIN_STEP = 6;

/** 1リクエストで扱う巡回の本数上限（新しい順に採る）。 */
export const COVERAGE_TRACK_SESSION_LIMIT = 200;

/** 線を引く候補となる巡回（点数だけ見る。人名・日時は持ち込まない）。 */
export interface TrackSessionCandidate {
  id: string;
  pointCount: number;
}

export interface TrackFetchPlan {
  /** 実際に線を引く巡回の id（呼び出し順＝新しい順を保つ）。 */
  sessionIds: string[];
  /** 何点に 1 点だけ描くか。1 なら間引かない。 */
  thinStep: number;
  /** 量が多くて落とした巡回の本数。 */
  droppedTrips: number;
  /** 落とした線があるか（画面に必ず断りを出すために使う）。 */
  truncated: boolean;
}

/**
 * 描く線の量を決める。**候補は新しい順で渡すこと**（落とすのは末尾＝古い方）。
 *
 * ⚠一番新しい 1 本だけは、単体で上限を超えていても必ず残す。
 * 「今日歩いた道が 1 本も出ない」のが業務上いちばん困るため。
 */
export function planTrackFetch(
  candidates: TrackSessionCandidate[],
  pointBudget: number = COVERAGE_TRACK_POINT_BUDGET,
): TrackFetchPlan {
  const budget = Math.max(1, Math.floor(pointBudget));

  // 本数の上限で先に頭打ちにする（1本あたりの点数が少なくても、
  // 図形が数百枚になると地図が重くなる）。
  const capped = candidates.slice(0, COVERAGE_TRACK_SESSION_LIMIT);
  let droppedTrips = candidates.length - capped.length;

  if (capped.length === 0) {
    return { sessionIds: [], thinStep: 1, droppedTrips, truncated: droppedTrips > 0 };
  }

  const total = capped.reduce((sum, c) => sum + Math.max(0, c.pointCount), 0);

  // 1. 間引きで収める。上限を超える分は次の段で本数を減らす。
  const needed = total <= budget ? 1 : Math.ceil(total / budget);
  const thinStep = Math.min(
    COVERAGE_TRACK_MAX_THIN_STEP,
    Math.max(1, needed),
  );

  // 2. この間引き幅で扱える生点数。ここに収まるところまで新しい順に採る。
  const capacity = budget * thinStep;
  const sessionIds: string[] = [];
  let used = 0;
  for (const c of capped) {
    const n = Math.max(0, c.pointCount);
    // 一番新しい 1 本は無条件で入れる（0 本にしない）。
    if (sessionIds.length > 0 && used + n > capacity) break;
    sessionIds.push(c.id);
    used += n;
  }
  droppedTrips += capped.length - sessionIds.length;

  return {
    sessionIds,
    thinStep,
    droppedTrips,
    truncated: droppedTrips > 0,
  };
}
