/**
 * 書類の本文に、登録済みの物件名(棟名)が出ているかを探す(純関数)。
 *
 * 査定報告書は「名称」「所在地」の見出しから手がかりを読めるが、契約書・管理規約などは書式がまちまち。
 * そこで、DB にある物件名を本文の先頭から総当たりで探し、見つかれば候補の手がかりにする
 * (候補を出すだけで自動では添付しない=受け取り箱の方針)。
 */
import { normalizeForMatch, TEXT_SCAN_LIMIT } from "@/lib/doc-classify/classify";

export interface KnownNameHit {
  buildingName: string;
  roomNo: string | null;
}

/** 物件名として探す最短の長さ(短い名前は本文の別の語に当たりやすい)。 */
const MIN_NAME_LENGTH = 3;
/** 名前の直後、ここまでの文字に「305号室」「305号」があれば部屋番号とみなす。 */
const ROOM_WINDOW = 16;

/**
 * 本文の先頭 3,000 文字に、`names` のどれかが出ていれば、**最も前に出た**名前と、その直後の部屋番号を返す。
 * 比べる形は NFKC・空白なし・小文字(名前も本文も同じにそろえる)。返す名前は DB の表記のまま。
 */
export function findKnownBuildingName(
  text: string | null | undefined,
  names: readonly string[],
): KnownNameHit | null {
  if (!text) return null;
  const body = normalizeForMatch(text.slice(0, TEXT_SCAN_LIMIT));
  if (body === "") return null;
  let best: { name: string; at: number; len: number } | null = null;
  for (const raw of names) {
    const key = normalizeForMatch(raw);
    if (key.length < MIN_NAME_LENGTH) continue;
    const at = body.indexOf(key);
    if (at < 0) continue;
    // 同じ位置なら長い名前(「東急ドエル」より「東急ドエル世田谷」)を採る
    if (best === null || at < best.at || (at === best.at && key.length > best.len)) {
      best = { name: raw, at, len: key.length };
    }
  }
  if (best === null) return null;
  const after = body.slice(best.at + best.len, best.at + best.len + ROOM_WINDOW);
  const room = /(\d{1,4})号/.exec(after);
  return { buildingName: best.name, roomNo: room ? room[1] : null };
}
