/**
 * 最近傍の街区点選択(純関数・prisma 非依存)。DB I/O は lookup.ts が担う。
 */
import { formatBlockAddress } from "./format";

/** これより遠い最近傍は不採用(隣町を拾わない)。実測の点間隔は市街地で数十m。 */
export const MAX_BLOCK_DISTANCE_M = 150;

export interface BlockLookupHit {
  address: string;
  town: string;
  /** 街区点までの距離(m・整数)。応答には含めずログ/テスト用。 */
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
  let best: BlockLookupHit | null = null;
  for (const c of candidates) {
    const d = haversineMeters(lat, lng, c.lat, c.lng);
    if (d > maxDistanceM) continue;
    if (best === null || d < best.distanceM) {
      best = {
        address: formatBlockAddress(c),
        town: c.town,
        distanceM: Math.round(d),
        isResidential: c.isResidential,
      };
    }
  }
  return best;
}
