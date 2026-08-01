/**
 * ピン座標 → 最近傍の住居点(号レベル) → 号までの住所(server-side・外部送信ゼロ)。
 * 第3弾。データ未取込・閾値(50m)超過は null(呼び出し側が街区→GSI へフォールバック)。
 *
 * ⚠DB エラーは**握りつぶさず throw**(街区 lookup と同じ方針): null に落とすと
 * 「ローカルに無い」と区別できず GSI フォールバック=座標の外部送信が走り、
 * 「手元のデータで見つからない場合のみ送信」という事前開示に反する。
 */
import prisma from "@/lib/prisma";
import { pickNearestResidence, type ResidenceLookupHit } from "./nearest";

export { RSDT_MAX_DISTANCE_M, type ResidenceLookupHit } from "./nearest";

/** bounding box の半径(度)。±0.0008° ≒ 緯度89m/経度72m(35°N) > 閾値50m を包含。 */
const BBOX_DEG = 0.0008;

export async function findNearestResidence(
  lat: number,
  lng: number,
): Promise<ResidenceLookupHit | null> {
  const rows = await prisma.addressResidencePoint.findMany({
    where: {
      lat: { gte: lat - BBOX_DEG, lte: lat + BBOX_DEG },
      lng: { gte: lng - BBOX_DEG, lte: lng + BBOX_DEG },
    },
    select: {
      prefecture: true,
      city: true,
      town: true,
      chome: true,
      koaza: true,
      block: true,
      rsdt: true,
      lat: true,
      lng: true,
    },
  });
  return pickNearestResidence(
    lat,
    lng,
    rows.map((r) => ({ ...r, lat: Number(r.lat), lng: Number(r.lng) })),
  );
}
