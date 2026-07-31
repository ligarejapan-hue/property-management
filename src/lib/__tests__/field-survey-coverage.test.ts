import { describe, it, expect } from "vitest";
import {
  canTrustCoverageLegend,
  snapBboxToCells,
  COVERAGE_CELL_LIMIT,
  COVERAGE_CELL_SIZES,
  coarserCoverageCellSize,
  maxCellsForBbox,
  COVERAGE_CELL_STEPS,
  COVERAGE_DEFAULT_DAYS,
  COVERAGE_HEAT_STYLES,
  COVERAGE_PERIOD_DAYS,
  coverageCellBounds,
  coverageCellIndexOf,
  coverageCellLabel,
  coverageCellMeters,
  coverageFromAt,
  coverageHeatTier,
  coveragePeriodLabel,
  groupCoverageCellsByTier,
  resolveCoverageCellSize,
  type CoverageCell,
  type CoverageCellSize,
} from "../field-survey-coverage";

// 踏破ヒート（巡回で歩いた場所の蓄積表示）の純関数。
//
// 業務目的: 街を歩いて目視で古い家を探すので、短期間に同じ道を二度歩くのは無駄。
// 「どこを踏破済みか」を全員で溜めて次に回るエリアを決める。
// 色は**全社合計**（Aさん1回 + Bさん1回 = 2回）で、誰の分かは区別しない。

describe("格子の粗さは bbox から自動で決まる（利用者に選ばせない）", () => {
  it("さらに寄った（約1km四方まで）は 25m 格子", () => {
    // 2026-07-31 追加の最細段。街を1本ずつ見るための粒度。
    // 上限は 42 マス分 = 約 1.07km 四方（描画上限 2,000 マスから逆算）。
    expect(
      resolveCoverageCellSize({
        south: 35.68,
        north: 35.68 + 0.009,
        west: 139.76,
        east: 139.76 + 0.011,
      }),
    ).toBe("ultrafine");
  });

  it("約1.1km四方を超えたら 50m 格子へ落ちる（境界の外側）", () => {
    expect(
      resolveCoverageCellSize({
        south: 35.68,
        north: 35.68 + 0.0105,
        west: 139.76,
        east: 139.76 + 0.0125,
      }),
    ).toBe("fine");
  });

  it("街を歩く寄り（約2km四方まで）は 50m 格子", () => {
    // ⚠上限は「3km四方」から狭めた。50m 格子で 3km 四方だと最大 3,600 マスになり
    // 描画上限(2,000)を超えて色が全部消えるため（= 踏破済みを未踏破と誤読する）。
    // 現在の上限は 43 マス分 = 約 2.15km 四方。
    expect(
      resolveCoverageCellSize({
        south: 35.68,
        north: 35.68 + 0.018,
        west: 139.76,
        east: 139.76 + 0.022,
      }),
    ).toBe("fine");
  });

  it("約2.2km四方を超えたら 250m 格子へ落ちる（境界の外側）", () => {
    expect(
      resolveCoverageCellSize({
        south: 35.68,
        north: 35.68 + 0.021,
        west: 139.76,
        east: 139.76 + 0.026,
      }),
    ).toBe("mid");
  });

  it("市内をまとめて見る寄り（約10km四方まで）は 250m 格子", () => {
    expect(
      resolveCoverageCellSize({
        south: 35.68,
        north: 35.68 + 0.05,
        west: 139.76,
        east: 139.76 + 0.05,
      }),
    ).toBe("mid");
  });

  it("それより広ければ 1.25km 格子", () => {
    expect(
      resolveCoverageCellSize({
        south: 35.4,
        north: 35.9,
        west: 139.5,
        east: 140.0,
      }),
    ).toBe("wide");
  });

  it("縦横どちらかが超えれば粗い段へ落ちる（片方だけ広い場合を取りこぼさない）", () => {
    // 緯度は fine 内だが経度が超える
    expect(
      resolveCoverageCellSize({
        south: 35.68,
        north: 35.68 + 0.01,
        west: 139.7,
        east: 139.7 + 0.05,
      }),
    ).toBe("mid");
  });

  it("北緯・南緯の順が逆でも同じ判定になる（絶対値で見る）", () => {
    const a = resolveCoverageCellSize({
      south: 35.698,
      north: 35.68,
      west: 139.78,
      east: 139.76,
    });
    expect(a).toBe("fine");
  });
});

describe("粗い段は細かい段のちょうど整数倍（寄り引きで境界が食い違わない）", () => {
  it("fine は ultrafine の2倍・mid は fine の5倍・wide は mid の5倍", () => {
    const { ultrafine, fine, mid, wide } = COVERAGE_CELL_STEPS;
    // 浮動小数の誤差を避けるため整数比で比較する
    expect(Math.round((fine.latStep / ultrafine.latStep) * 1e6)).toBe(2 * 1e6);
    expect(Math.round((fine.lngStep / ultrafine.lngStep) * 1e6)).toBe(2 * 1e6);
    expect(Math.round((mid.latStep / fine.latStep) * 1e6)).toBe(5 * 1e6);
    expect(Math.round((mid.lngStep / fine.lngStep) * 1e6)).toBe(5 * 1e6);
    expect(Math.round((wide.latStep / mid.latStep) * 1e6)).toBe(5 * 1e6);
    expect(Math.round((wide.lngStep / mid.lngStep) * 1e6)).toBe(5 * 1e6);
  });

  it("隣り合う段は必ず整数倍（段を足しても崩れないことを総当たりで縛る）", () => {
    // ⚠段が増えたときに1組だけ書き忘れる、を防ぐ。
    for (let i = 0; i < COVERAGE_CELL_SIZES.length - 1; i++) {
      const finer = COVERAGE_CELL_STEPS[COVERAGE_CELL_SIZES[i]];
      const coarser = COVERAGE_CELL_STEPS[COVERAGE_CELL_SIZES[i + 1]];
      for (const axis of ["latStep", "lngStep"] as const) {
        const ratio = coarser[axis] / finer[axis];
        expect(Math.abs(ratio - Math.round(ratio))).toBeLessThan(1e-9);
        expect(Math.round(ratio)).toBeGreaterThan(1);
      }
    }
  });

  it("細かいセルは粗いセルに完全に含まれる（境界がまたがらない）", () => {
    const lat = 35.6812345;
    const lng = 139.7654321;
    // 全ての隣接段で確認する（ultrafine⊂fine / fine⊂mid / mid⊂wide）
    for (let i = 0; i < COVERAGE_CELL_SIZES.length - 1; i++) {
      const finer = COVERAGE_CELL_STEPS[COVERAGE_CELL_SIZES[i]];
      const coarser = COVERAGE_CELL_STEPS[COVERAGE_CELL_SIZES[i + 1]];
      const finerBounds = coverageCellBounds(
        coverageCellIndexOf(lat, lng, finer),
        finer,
      );
      const coarserBounds = coverageCellBounds(
        coverageCellIndexOf(lat, lng, coarser),
        coarser,
      );
      expect(finerBounds.south).toBeGreaterThanOrEqual(
        coarserBounds.south - 1e-9,
      );
      expect(finerBounds.north).toBeLessThanOrEqual(coarserBounds.north + 1e-9);
      expect(finerBounds.west).toBeGreaterThanOrEqual(coarserBounds.west - 1e-9);
      expect(finerBounds.east).toBeLessThanOrEqual(coarserBounds.east + 1e-9);
    }
  });
});

describe("セル番号と矩形は往復できる（描画のズレを防ぐ）", () => {
  it("座標 → セル番号 → 矩形 に元の座標が含まれる", () => {
    for (const cell of ["fine", "mid", "wide"] as const) {
      const step = COVERAGE_CELL_STEPS[cell];
      for (const [lat, lng] of [
        [35.681236, 139.767125],
        [43.06417, 141.34694],
        [26.2124, 127.6809],
        [0.0000001, 0.0000001],
      ]) {
        const idx = coverageCellIndexOf(lat, lng, step);
        const b = coverageCellBounds(idx, step);
        expect(lat).toBeGreaterThanOrEqual(b.south);
        expect(lat).toBeLessThan(b.north);
        expect(lng).toBeGreaterThanOrEqual(b.west);
        expect(lng).toBeLessThan(b.east);
      }
    }
  });

  it("南半球・西経（負の座標）でも成立する（floor の丸め方向）", () => {
    const step = COVERAGE_CELL_STEPS.fine;
    const lat = -33.8688;
    const lng = -70.6693;
    const idx = coverageCellIndexOf(lat, lng, step);
    const b = coverageCellBounds(idx, step);
    expect(lat).toBeGreaterThanOrEqual(b.south);
    expect(lat).toBeLessThan(b.north);
    expect(lng).toBeGreaterThanOrEqual(b.west);
    expect(lng).toBeLessThan(b.east);
  });
});

describe("1マスの実寸（画面に出す説明）", () => {
  it("ultrafine は約25m 四方", () => {
    const m = coverageCellMeters("ultrafine");
    expect(m.lat).toBe(25);
    expect(m.lng).toBe(25);
  });

  it("fine は約50m 四方", () => {
    const m = coverageCellMeters("fine");
    expect(m.lat).toBe(50);
    expect(m.lng).toBe(50);
  });

  it("mid は約250m・wide は約1.25km", () => {
    expect(coverageCellMeters("mid").lat).toBe(250);
    expect(coverageCellMeters("wide").lat).toBe(1252);
  });

  it("ラベルは m と km を使い分ける", () => {
    expect(coverageCellLabel("ultrafine")).toBe("約25m");
    expect(coverageCellLabel("fine")).toBe("約50m");
    expect(coverageCellLabel("mid")).toBe("約250m");
    expect(coverageCellLabel("wide")).toBe("約1.3km");
  });
});

describe("回数 → 色の段（4段・青から赤へ）", () => {
  it("1回=1段 / 2〜3回=2段 / 4〜6回=3段 / 7回以上=4段", () => {
    expect(coverageHeatTier(1)).toBe(1);
    expect(coverageHeatTier(2)).toBe(2);
    expect(coverageHeatTier(3)).toBe(2);
    expect(coverageHeatTier(4)).toBe(3);
    expect(coverageHeatTier(6)).toBe(3);
    expect(coverageHeatTier(7)).toBe(4);
    expect(coverageHeatTier(999)).toBe(4);
  });

  it("0回・負・非数は色を付けない（未踏破は塗らない）", () => {
    // ⚠未踏破をグレーで塗ると山林・河川まで埋まって道路名が読めなくなる
    // (ユーザー判断: 「③色なし」)。色が付かないこと自体が「誰も通っていない」の表現。
    expect(coverageHeatTier(0)).toBeNull();
    expect(coverageHeatTier(-1)).toBeNull();
    expect(coverageHeatTier(Number.NaN)).toBeNull();
  });

  it("段が進むほど不透明度が上がる（色相と濃さの二重表現）", () => {
    const o = [1, 2, 3, 4].map(
      (t) => COVERAGE_HEAT_STYLES[t as 1 | 2 | 3 | 4].fillOpacity,
    );
    for (let i = 1; i < o.length; i++) {
      expect(o[i]).toBeGreaterThan(o[i - 1]);
    }
  });

  it("最上位は登録済み物件マーカーの赤 (#EA4335) と別の色にする", () => {
    // 同じ赤だと「よく歩いた道」と「登録済み物件」が地図上で混ざる
    expect(COVERAGE_HEAT_STYLES[4].fillColor.toUpperCase()).not.toBe("#EA4335");
  });

  it("4段だけ（半透明の塗りは5段以上だと屋外で見分けられない）", () => {
    expect(Object.keys(COVERAGE_HEAT_STYLES)).toHaveLength(4);
  });
});

describe("期間は「直近1年」と「全期間」だけ（ユーザー決定）", () => {
  it("選択肢は2つ・既定は直近1年", () => {
    expect(COVERAGE_PERIOD_DAYS).toEqual([365, 0]);
    expect(COVERAGE_DEFAULT_DAYS).toBe(365);
  });

  it("表示名", () => {
    expect(coveragePeriodLabel(365)).toBe("直近1年");
    expect(coveragePeriodLabel(0)).toBe("全期間");
  });

  it("日数から集計の下限時刻を出す（全期間は下限なし）", () => {
    const now = new Date("2026-07-28T00:00:00.000Z");
    expect(coverageFromAt(365, now)?.toISOString()).toBe(
      "2025-07-28T00:00:00.000Z",
    );
    expect(coverageFromAt(0, now)).toBeNull();
    expect(coverageFromAt(-5, now)).toBeNull();
    expect(coverageFromAt(Number.NaN, now)).toBeNull();
  });
});

describe("同じ色のセルは束ねる（描画する図形の数を抑える）", () => {
  it("段ごとにまとめ、0回のセルは捨てる", () => {
    const cells: CoverageCell[] = [
      { y: 1, x: 1, p: 1 },
      { y: 1, x: 2, p: 3 },
      { y: 2, x: 1, p: 2 },
      { y: 2, x: 2, p: 9 },
      { y: 3, x: 3, p: 0 },
    ];
    const grouped = groupCoverageCellsByTier(cells);
    expect(grouped.get(1)).toHaveLength(1);
    expect(grouped.get(2)).toHaveLength(2);
    expect(grouped.get(4)).toHaveLength(1);
    expect(grouped.has(3)).toBe(false);
    // 0回は色を持たないので、どの段にも入らない
    const total = [...grouped.values()].reduce((n, l) => n + l.length, 0);
    expect(total).toBe(4);
  });

  it("空でも落ちない", () => {
    expect(groupCoverageCellsByTier([]).size).toBe(0);
  });
});

describe("上限（取りこぼしを黙って出さないための値）", () => {
  it("2000セル", () => {
    expect(COVERAGE_CELL_LIMIT).toBe(2000);
  });

  it("**どの段でも**、その段が担当する最大の bbox で上限内に収まる", () => {
    // ⚠ここが崩れると、歩き尽くしたエリアに寄ったときに fail-closed で
    // 色が全部消え、「誰も通っていない」と誤読して踏破済みエリアへ人を出す。
    //
    // 以前この表明は `<= COVERAGE_CELL_LIMIT * 2` で、名前に反して
    // **上限内に収まることを検査していなかった**（実値 3,600 > 2,000）。
    // ⚠段を足したらここも自動で増えるよう、定義そのものを回す。
    for (const cell of COVERAGE_CELL_SIZES) {
      // その段が選ばれる最大の bbox = 1段細かい判定を外れる直前の広さ
      const span = maxSpanForCell(cell);
      const worst = maxCellsForBbox(
        { south: 35.0, north: 35.0 + span.lat, west: 139.0, east: 139.0 + span.lng },
        cell,
      );
      expect(worst).toBeLessThanOrEqual(COVERAGE_CELL_LIMIT);
    }
  });

  it("bbox の最大値(0.5度)でも wide なら上限内（逃げ場が必ずある）", () => {
    const worst = maxCellsForBbox(
      { south: 35.0, north: 35.5, west: 139.0, east: 139.5 },
      "wide",
    );
    expect(worst).toBeLessThanOrEqual(COVERAGE_CELL_LIMIT);
  });

  it("1段粗い粒度をたどれる（超過時に粗くして描き切るため）", () => {
    expect(coarserCoverageCellSize("ultrafine")).toBe("fine");
    expect(coarserCoverageCellSize("fine")).toBe("mid");
    expect(coarserCoverageCellSize("mid")).toBe("wide");
    // wide より粗い段は無い = ここまで来て溢れたら fail-closed しかない
    expect(coarserCoverageCellSize("wide")).toBeNull();
  });
});

describe("この層は人を識別する情報を持たない（PII 露出面を構造的に小さくする)", () => {
  it("セルは格子番号と回数だけ", () => {
    const cell: CoverageCell = { y: 1, x: 2, p: 3 };
    expect(Object.keys(cell).sort()).toEqual(["p", "x", "y"]);
  });
});

/**
 * その段が選ばれる最大の bbox の広さ（度）。
 * fine/mid は自動判定の閾値そのもの、wide は bbox 自体の上限(0.5度)。
 * ⚠実装の閾値を直接読めないので、判定関数を二分探索して**実際に選ばれる境界**を
 * 求める。閾値定数を変えてもこのテストが追随する。
 */
function maxSpanForCell(cell: CoverageCellSize): {
  lat: number;
  lng: number;
} {
  if (cell === "wide") return { lat: 0.5, lng: 0.5 };
  const find = (axis: "lat" | "lng"): number => {
    let lo = 0;
    let hi = 0.5;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      const bbox =
        axis === "lat"
          ? { south: 35, north: 35 + mid, west: 139, east: 139 }
          : { south: 35, north: 35, west: 139, east: 139 + mid };
      if (resolveCoverageCellSize(bbox) === cell) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  return { lat: find("lat"), lng: find("lng") };
}

describe("集計の範囲は格子の境界まで広げる (@codex #332)", () => {
  // ⚠画面の端が1つのセルを横切っていると、そのセルは**画面内の点しか
  // 数えられない**。クライアントはセル全体を塗るので、数ピクセル動かすだけで
  // 同じセルの色が変わる（3回歩いた道が1回に見える／見えている部分が
  // 未踏破に見える）。集計の入力をセル単位に揃えて、どこから見ても同じ値にする。

  const step = COVERAGE_CELL_STEPS.fine;

  it("四辺が必ず格子の線に乗る", () => {
    const q = snapBboxToCells(
      { south: 35.681234, north: 35.685678, west: 139.761234, east: 139.765678 },
      step,
    );
    for (const [v, s2] of [
      [q.south, step.latStep],
      [q.north, step.latStep],
      [q.west, step.lngStep],
      [q.east, step.lngStep],
    ]) {
      expect(Math.abs(v / s2 - Math.round(v / s2))).toBeLessThan(1e-6);
    }
  });

  it("必ず外側へ広がる（内側に食い込んで点を落とさない）", () => {
    const bbox = {
      south: 35.681234,
      north: 35.685678,
      west: 139.761234,
      east: 139.765678,
    };
    const q = snapBboxToCells(bbox, step);
    expect(q.south).toBeLessThanOrEqual(bbox.south);
    expect(q.north).toBeGreaterThanOrEqual(bbox.north);
    expect(q.west).toBeLessThanOrEqual(bbox.west);
    expect(q.east).toBeGreaterThanOrEqual(bbox.east);
  });

  it("少しずらしても同じセル境界に落ちる（動かすたびに色が変わらない）", () => {
    // 1セルの 1/10 だけずらした2つの画面
    const a = snapBboxToCells(
      { south: 35.6812, north: 35.6857, west: 139.7612, east: 139.7657 },
      step,
    );
    const b = snapBboxToCells(
      {
        south: 35.6812 + step.latStep / 10,
        north: 35.6857 + step.latStep / 10,
        west: 139.7612,
        east: 139.7657,
      },
      step,
    );
    // 端のセルが増減することはあっても、共通部分のセル境界は一致する
    expect(Math.abs((a.south - b.south) / step.latStep) % 1).toBeLessThan(1e-6);
  });

  it("広がるのは縦横それぞれ最大1セル分（上限を破らない）", () => {
    const bbox = { south: 35.0, north: 35.0 + 0.0189, west: 139.0, east: 139.0 + 0.0231 };
    const q = snapBboxToCells(bbox, step);
    expect(maxCellsForBbox(q, "fine")).toBeLessThanOrEqual(COVERAGE_CELL_LIMIT);
  });

  it("既に境界に乗っていれば変えない", () => {
    const south = 100 * step.latStep;
    const west = 200 * step.lngStep;
    const q = snapBboxToCells(
      { south, north: south + step.latStep, west, east: west + step.lngStep },
      step,
    );
    expect(Math.abs(q.south - south)).toBeLessThan(1e-9);
    expect(Math.abs(q.west - west)).toBeLessThan(1e-9);
  });
});

describe("凡例を出してよいのは取得できたときだけ (@codex #332)", () => {
  // ⚠この画面は「色が無い＝誰も通っていない」と読ませる。まだ分からない状態で
  // 同じ凡例を出すと、踏破済みのエリアへ人を送り出すことになる。
  it("ready のときだけ true", () => {
    expect(canTrustCoverageLegend("ready")).toBe(true);
  });

  it("確認中・範囲過大・取得失敗・レイヤーOFF では false", () => {
    for (const s of ["loading", "too-wide", "unavailable", "off"] as const) {
      expect(canTrustCoverageLegend(s)).toBe(false);
    }
  });
});
