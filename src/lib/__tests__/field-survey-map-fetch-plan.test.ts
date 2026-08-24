/**
 * 地図の取得計画(第3弾 B4)。
 *
 * 目的は2つ:
 *  1. **無駄な取得をしない** — レイヤーを1つ切り替えただけで4本のAPIを全部
 *     叩き直していた。切ったレイヤーは取得せず消すだけ、点けたレイヤーだけ取る。
 *  2. **取得中に古い情報を黙って消さない** — 面(踏破色)と線(軌跡)は取得を
 *     始めた瞬間に空にしていたため、動かすたびに色が消えて「歩いていない」と
 *     見える時間が生まれていた。とはいえ**別の場所・別の粒度の色を出しっぱなし**に
 *     するのは fail-closed 原則に反する(誤って「踏破済み」と読める)。
 *     → 「格子の大きさが同じなら残す/変わるなら消す」を純関数で決める。
 */
import { describe, it, expect } from "vitest";
import {
  planMapFetch,
  keepCoverageWhileLoading,
  shouldRefreshHeavyOnResume,
  type MapFetchInputs,
} from "@/lib/field-survey-map-fetch-plan";

const base: MapFetchInputs = {
  layers: { properties: true, pins: true, coverage: true, tracks: true },
  coverageDays: 365,
  bboxKey: "a",
  refetchNonce: 0,
  resumeNonce: 0,
};

describe("planMapFetch: 何を取り、何を消すか", () => {
  it("初回(前回なし)は有効なレイヤーを全部取る", () => {
    const p = planMapFetch(null, base);
    expect(p.fetch).toEqual({
      properties: true,
      pins: true,
      coverage: true,
      tracks: true,
    });
    expect(p.clear).toEqual({
      properties: false,
      pins: false,
      coverage: false,
      tracks: false,
    });
  });

  it("初回でも OFF のレイヤーは取らない(既定 ON でも設定を尊重)", () => {
    const p = planMapFetch(null, {
      ...base,
      layers: { properties: false, pins: true, coverage: false, tracks: true },
    });
    expect(p.fetch.properties).toBe(false);
    expect(p.fetch.coverage).toBe(false);
    expect(p.fetch.pins).toBe(true);
    expect(p.fetch.tracks).toBe(true);
  });

  it("地図を動かした(bbox が変わった)ら有効なレイヤーを全部取り直す", () => {
    const p = planMapFetch(base, { ...base, bboxKey: "b" });
    expect(p.fetch).toEqual({
      properties: true,
      pins: true,
      coverage: true,
      tracks: true,
    });
  });

  it("レイヤーを1つ点けたら、そのレイヤーだけ取る(他は取り直さない)", () => {
    const prev: MapFetchInputs = {
      ...base,
      layers: { properties: true, pins: true, coverage: false, tracks: true },
    };
    const p = planMapFetch(prev, base);
    expect(p.fetch).toEqual({
      properties: false,
      pins: false,
      coverage: true,
      tracks: false,
    });
  });

  it("レイヤーを消したら取得せず、そのレイヤーの表示だけ消す", () => {
    const next: MapFetchInputs = {
      ...base,
      layers: { properties: true, pins: false, coverage: true, tracks: true },
    };
    const p = planMapFetch(base, next);
    expect(p.fetch.pins).toBe(false);
    expect(p.clear.pins).toBe(true);
    // 巻き添えで他が消えたり取り直したりしない
    expect(p.fetch.properties).toBe(false);
    expect(p.clear.properties).toBe(false);
    expect(p.fetch.coverage).toBe(false);
    expect(p.clear.coverage).toBe(false);
  });

  it("期間を変えたら面と線だけ取り直す(ピン・物件は無関係)", () => {
    const p = planMapFetch(base, { ...base, coverageDays: 0 });
    expect(p.fetch).toEqual({
      properties: false,
      pins: false,
      coverage: true,
      tracks: true,
    });
  });

  it("更新(refetchNonce)は有効なレイヤーを全部取り直す", () => {
    const p = planMapFetch(base, { ...base, refetchNonce: 1 });
    expect(p.fetch).toEqual({
      properties: true,
      pins: true,
      coverage: true,
      tracks: true,
    });
  });

  it("復帰(resumeNonce)ではピンと物件だけ取り直す(@codex #409 R3 P2)", () => {
    // 他の担当者が増やせるのはピンと物件だけ。踏破の面と軌跡の線は巡回終了
    // (=自分の操作)でしか増えないので、復帰のたびに重い集計を投げ直さない。
    const p = planMapFetch(base, { ...base, resumeNonce: 1 });
    expect(p.fetch).toEqual({
      properties: true,
      pins: true,
      coverage: false,
      tracks: false,
    });
  });

  it("復帰でも OFF の層は取りに行かない", () => {
    const next: MapFetchInputs = {
      ...base,
      resumeNonce: 1,
      layers: { properties: false, pins: true, coverage: true, tracks: true },
    };
    const p = planMapFetch(base, next);
    expect(p.fetch.properties).toBe(false);
    expect(p.fetch.pins).toBe(true);
  });

  it("何も変わっていなければ1本も取らない(同じ値での再評価で無駄打ちしない)", () => {
    const p = planMapFetch(base, { ...base });
    expect(p.fetch).toEqual({
      properties: false,
      pins: false,
      coverage: false,
      tracks: false,
    });
    expect(p.clear).toEqual({
      properties: false,
      pins: false,
      coverage: false,
      tracks: false,
    });
  });

  it("同時に複数変わったとき(移動+レイヤー消し)は、消した側は取らない", () => {
    const next: MapFetchInputs = {
      ...base,
      bboxKey: "b",
      layers: { properties: true, pins: true, coverage: false, tracks: true },
    };
    const p = planMapFetch(base, next);
    expect(p.fetch).toEqual({
      properties: true,
      pins: true,
      coverage: false,
      tracks: true,
    });
    expect(p.clear.coverage).toBe(true);
  });

  it("未達の層(中断・失敗)は、他に理由が無くても取り直す(@codex #409 R2 P2)", () => {
    // 取得中にレイヤーを切り替えると前の取得は中断される。前回の計画が
    // 「取った」と記録しているだけでは、次の差分計画がその層を飛ばして
    // 地図が空のまま残る。未達として持ち越せば自己修復する。
    const p = planMapFetch(base, { ...base }, new Set(["coverage"]));
    expect(p.fetch.coverage).toBe(true);
    // 巻き添えで他の層まで取り直したりしない。
    expect(p.fetch.pins).toBe(false);
    expect(p.fetch.properties).toBe(false);
    expect(p.fetch.tracks).toBe(false);
  });

  it("未達でも OFF の層は取りに行かない(消すだけ)", () => {
    const next: MapFetchInputs = {
      ...base,
      layers: { properties: true, pins: true, coverage: false, tracks: true },
    };
    const p = planMapFetch(base, next, new Set(["coverage"]));
    expect(p.fetch.coverage).toBe(false);
    expect(p.clear.coverage).toBe(true);
  });

  it("未達の指定が無いときは従来どおり(既定引数で壊れない)", () => {
    const a = planMapFetch(base, { ...base });
    const b = planMapFetch(base, { ...base }, new Set());
    expect(a).toEqual(b);
  });

  it("総当たり: fetch と clear が同時に立つ組み合わせは存在しない", () => {
    const bools = [false, true];
    const keys = ["properties", "pins", "coverage", "tracks"] as const;
    for (const pp of bools)
      for (const pn of bools)
        for (const bboxSame of bools)
          for (const daysSame of bools)
            for (const nonceSame of bools) {
              const prev: MapFetchInputs = {
                layers: {
                  properties: pp,
                  pins: pp,
                  coverage: pp,
                  tracks: pp,
                },
                coverageDays: 365,
                bboxKey: "a",
                refetchNonce: 0,
                resumeNonce: 0,
              };
              const next: MapFetchInputs = {
                layers: {
                  properties: pn,
                  pins: pn,
                  coverage: pn,
                  tracks: pn,
                },
                coverageDays: daysSame ? 365 : 0,
                bboxKey: bboxSame ? "a" : "b",
                refetchNonce: nonceSame ? 0 : 1,
                resumeNonce: 0,
              };
              for (const pend of [new Set<"properties" | "pins" | "coverage" | "tracks">(), new Set(keys)]) {
                const p = planMapFetch(prev, next, pend);
                for (const k of keys) {
                  expect(p.fetch[k] && p.clear[k]).toBe(false);
                  // OFF のレイヤーを取りに行くことは絶対にない(未達でも)
                  if (!next.layers[k]) expect(p.fetch[k]).toBe(false);
                  // ON かつ未達なら必ず取り直す
                  if (next.layers[k] && pend.has(k)) expect(p.fetch[k]).toBe(true);
                }
              }
            }
  });
});

describe("shouldRefreshHeavyOnResume: 復帰時に重い層まで取り直すか", () => {
  const MIN = 3 * 60 * 1000;

  it("一度も取っていなければ取る", () => {
    expect(shouldRefreshHeavyOnResume(1000, 0, MIN)).toBe(true);
  });

  it("直前に取ったばかりなら取らない(写真ごとの復帰で重い集計を繰り返さない)", () => {
    expect(shouldRefreshHeavyOnResume(60_000, 30_000, MIN)).toBe(false);
  });

  it("下限の時間が過ぎていれば取る(同僚が巡回を終えた分を取り込む)", () => {
    expect(shouldRefreshHeavyOnResume(0 + MIN, 0, MIN)).toBe(true);
    expect(shouldRefreshHeavyOnResume(MIN + 1, 0, MIN)).toBe(true);
  });

  it("時計が巻き戻っても取る側へ倒す(古い踏破色を出し続けない)", () => {
    expect(shouldRefreshHeavyOnResume(1000, 999_999, MIN)).toBe(true);
  });

  it("時刻が読めないときは取る側へ倒す", () => {
    expect(shouldRefreshHeavyOnResume(Number.NaN, 0, MIN)).toBe(true);
  });
});

describe("keepCoverageWhileLoading: 取得中に色を残すか", () => {
  const fine = { latStep: 0.00045, lngStep: 0.00055 };
  const mid = { latStep: 0.00225, lngStep: 0.00275 };

  it("まだ何も描いていなければ残すも何もない(false)", () => {
    expect(keepCoverageWhileLoading(null, { step: fine, days: 365 })).toBe(false);
  });

  it("格子の大きさも期間も同じなら残す(動かしても色が点滅しない)", () => {
    expect(
      keepCoverageWhileLoading({ step: fine, days: 365 }, { step: { ...fine }, days: 365 }),
    ).toBe(true);
  });

  it("格子の大きさが変わる(ズームで粒度が変わる)なら消す", () => {
    expect(
      keepCoverageWhileLoading({ step: fine, days: 365 }, { step: mid, days: 365 }),
    ).toBe(false);
  });

  it("期間が変わったら消す(全期間→直近1年で選択と表示が食い違わない)", () => {
    expect(
      keepCoverageWhileLoading({ step: fine, days: 0 }, { step: { ...fine }, days: 365 }),
    ).toBe(false);
  });

  it("次の状態が分からない(null)ときは消す=fail-closed", () => {
    expect(keepCoverageWhileLoading({ step: fine, days: 365 }, null)).toBe(false);
  });
});
