/**
 * ピン座標 → 最近傍の街区点 →「番」までの住所(server-side・外部送信ゼロ)。
 *
 * 二段検索: (lat,lng) の bounding box で DB から候補を絞り(複合 index 使用)、
 * アプリ側で Haversine 距離の最小を取る(選択は nearest.ts の純関数)。
 * 閾値超過・候補ゼロ・データ未取込は null
 * (呼び出し側が国土地理院=町丁目までへフォールバック)。
 */
import prisma from "@/lib/prisma";
import { pickNearestBlock, type BlockLookupHit } from "./nearest";

export {
  MAX_BLOCK_DISTANCE_M,
  haversineMeters,
  pickNearestBlock,
  type BlockLookupHit,
} from "./nearest";

/** bounding box の半径(度)。±0.002° ≒ 緯度222m/経度180m(35°N) > 閾値150m を包含。 */
const BBOX_DEG = 0.002;

/**
 * DB から最近傍の街区を引く。データ未取込の地域・閾値超過は null。
 * DB エラーは throw せず null(自動入力は補助機能=ローカル照合の障害で全体を
 * 落とさず、呼び出し側の GSI フォールバックに任せる)。
 */
export async function findNearestBlock(
  lat: number,
  lng: number,
): Promise<BlockLookupHit | null> {
  try {
    const rows = await prisma.addressBlockPoint.findMany({
      where: {
        lat: { gte: lat - BBOX_DEG, lte: lat + BBOX_DEG },
        lng: { gte: lng - BBOX_DEG, lte: lng + BBOX_DEG },
      },
      select: {
        prefecture: true,
        city: true,
        town: true,
        block: true,
        lat: true,
        lng: true,
        isResidential: true,
      },
    });
    return pickNearestBlock(
      lat,
      lng,
      rows.map((r) => ({ ...r, lat: Number(r.lat), lng: Number(r.lng) })),
    );
  } catch {
    // ⚠座標・エラー詳細はログへ出さない(位置情報を漏らさない)。
    return null;
  }
}
