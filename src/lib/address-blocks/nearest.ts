/**
 * 最近傍の街区点/住居点選択(純関数・prisma 非依存)。DB I/O は lookup.ts /
 * residence-lookup.ts が担う。
 */
import { formatBlockAddress } from "./format";
import { formatResidenceAddress } from "./parse-abr";

/** これより遠い最近傍は不採用。実測の点間隔は市街地で数十m(実測ヒットは12〜19m)。
 * ⚠取込エリアの**境界の外**に立つピンが、境界越しの点を拾う誤マッチ(Codex R7 P2)を
 * 減らすため控えめにする。カバー範囲外は GSI(町丁目)へフォールバックするだけで壊れない。 */
export const MAX_BLOCK_DISTANCE_M = 100;

/** 地番の自動セット(物件の地番欄)はさらに厳しく。誤った地番は謄本取得の誤請求に
 * つながり得るため、点のほぼ真上(実測の正常ヒット水準)のときだけ提案する。 */
export const LOT_PREFILL_MAX_DISTANCE_M = 50;

export interface BlockLookupHit {
  address: string;
  town: string;
  /** 街区符号(住居表示) or 地番(住居表示未実施)。isResidential=false のとき
   * この値は**地番そのもの**=物件の地番欄の初期値候補として返す(要確認)。 */
  block: string;
  /** 街区点までの距離(m・**実数のまま丸めない**)。応答には含めず、閾値判定
   * (地番提案の50m等)とログ/テスト用。丸めると境界(50.4m→50)で判定がずれる。 */
  distanceM: number;
  isResidential: boolean;
}

/** Haversine 距離(m)。 */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 候補行(既に number 化済み)から最近傍1件を選ぶ。閾値超過・候補ゼロは null。 */
export function pickNearestBlock(
  lat: number,
  lng: number,
  candidates: Array<{
    prefecture: string;
    city: string;
    town: string;
    block: string;
    lat: number;
    lng: number;
    isResidential: boolean;
  }>,
  maxDistanceM: number = MAX_BLOCK_DISTANCE_M,
): BlockLookupHit | null {
  // 距離は終始**丸めない生値**で扱う(Codex R1/R10 P2: 丸めると近傍比較でも
  // 閾値判定[地番提案の50m]でも境界でずれる)。表示用途は現状無い。
  let best: BlockLookupHit | null = null;
  for (const c of candidates) {
    const d = haversineMeters(lat, lng, c.lat, c.lng);
    if (d > maxDistanceM) continue;
    if (best === null || d < best.distanceM) {
      best = {
        address: formatBlockAddress(c),
        town: c.town,
        block: c.block,
        distanceM: d,
        isResidential: c.isResidential,
      };
    }
  }
  return best;
}

/** 号レベル(住居点)の採用閾値。点は家1軒ごとにあり実測ヒットは数m〜十数m。
 * 遠い点は隣家・境界越しの誤りやすさが増すため街区(100m)より厳しくする。 */
export const RSDT_MAX_DISTANCE_M = 50;

export interface ResidenceLookupHit {
  address: string;
  town: string;
  /** 住居点までの距離(m・実数のまま丸めない)。 */
  distanceM: number;
}

/** 候補行(既に number 化済み)から最近傍の住居点を選ぶ。閾値超過・候補ゼロは null。 */
export function pickNearestResidence(
  lat: number,
  lng: number,
  candidates: Array<{
    prefecture: string;
    city: string;
    town: string;
    chome: string;
    koaza: string;
    block: string;
    rsdt: string;
    lat: number;
    lng: number;
  }>,
  maxDistanceM: number = RSDT_MAX_DISTANCE_M,
): ResidenceLookupHit | null {
  let best: ResidenceLookupHit | null = null;
  for (const c of candidates) {
    const d = haversineMeters(lat, lng, c.lat, c.lng);
    if (d > maxDistanceM) continue;
    if (best === null || d < best.distanceM) {
      best = {
        address: formatResidenceAddress(c),
        town: `${c.town}${c.chome !== "" ? `${c.chome}丁目` : ""}${c.koaza}`,
        distanceM: d,
      };
    }
  }
  return best;
}
