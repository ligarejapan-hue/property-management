/**
 * 物件に GPS 座標がないとき、住所から地図の中心を求める(2026-11-11 発注者指示)。
 *
 * 国土地理院の住所検索(msearch.gsi.go.jp・無料・登録不要)を使う。調査情報の取得(reinfolib-provider)と同じ先。
 * - 求めた座標は地図を作るためだけに使い、物件の GPS 座標には保存しない(物件のデータを変えない)。
 * - 住所の番地まで当たらないこともあるため、資料には「位置は住所から求めた目安」と書く。
 * ⚠住所・座標はログに出さない。
 */
import { isUsableLocation, type FetchLike } from "./build";

const GSI_ADDRESS_SEARCH = "https://msearch.gsi.go.jp/address-search/AddressSearch";
const TIMEOUT_MS = 8_000;

type GsiFeature = { geometry?: { coordinates?: unknown } };

export async function geocodeAddress(
  address: string | null | undefined,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<{ lat: number; lng: number } | null> {
  const q = (address ?? "").trim();
  if (!q || q.length > 200) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${GSI_ADDRESS_SEARCH}?q=${encodeURIComponent(q)}`, {
      signal: ctl.signal,
      headers: { "User-Agent": "property-management-appraisal-map/1.0" },
    });
    if (!res.ok) return null;
    const list = JSON.parse(new TextDecoder().decode(await res.arrayBuffer())) as unknown;
    if (!Array.isArray(list) || list.length === 0) return null;
    const c = (list[0] as GsiFeature).geometry?.coordinates;
    if (!Array.isArray(c) || c.length < 2) return null;
    const lng = Number(c[0]);
    const lat = Number(c[1]);
    return isUsableLocation(lat, lng) ? { lat, lng } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
