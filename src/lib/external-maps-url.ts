/**
 * external-maps-url.ts — **一般向け Google マップ**へのリンクを組み立てる純関数。
 *
 * ⚠これは Maps Platform（アプリ内に地図を描く有料API）とは**別物**で、
 * リンクを開くだけなので**課金されない**。
 *
 * 用途: 事務所で候補を物件化するか判断するとき、現地の様子をストリートビューで
 * 確認したい（ユーザー要望 2026-07-28）。アプリ内にストリートビューを埋め込むと
 * Maps Platform の課金対象になるため、**通常の Google マップを別タブで開く**形にする。
 *
 * 同種の前例: src/lib/sales-sheet/maps-url.ts（住所検索リンク・地図QR用）。
 * そちらは住所文字列から、こちらは座標から組み立てる。
 */

/**
 * URL に載せる座標の小数桁。6桁 ≒ 0.1m で、建物を指すのに十分。
 * これ以上の桁は精度の意味が無く、URL を無駄に長くするだけ。
 */
const COORD_DECIMALS = 6;

function isValidLat(lat: number): boolean {
  return Number.isFinite(lat) && lat >= -90 && lat <= 90;
}

function isValidLng(lng: number): boolean {
  return Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

/**
 * 座標からストリートビューを開く URL（公式の Maps URL スキーム）。
 * `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=<lat>,<lng>`
 *
 * 座標が不正なら null（リンクを出さない）。
 * 近くにパノラマが無い場所では Google 側が地図表示に切り替わる（こちらでは判定不能）。
 */
export function buildStreetViewUrl(
  lat: number | null | undefined,
  lng: number | null | undefined,
): string | null {
  if (lat == null || lng == null) return null;
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!isValidLat(latNum) || !isValidLng(lngNum)) return null;
  const viewpoint = `${latNum.toFixed(COORD_DECIMALS)},${lngNum.toFixed(COORD_DECIMALS)}`;
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${encodeURIComponent(viewpoint)}`;
}

/**
 * 座標から一般向け Google マップの地図表示を開く URL。
 * ストリートビューが無い場所の代替や、周辺を見たいときに使う。
 */
export function buildExternalMapUrl(
  lat: number | null | undefined,
  lng: number | null | undefined,
): string | null {
  if (lat == null || lng == null) return null;
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!isValidLat(latNum) || !isValidLng(lngNum)) return null;
  const query = `${latNum.toFixed(COORD_DECIMALS)},${lngNum.toFixed(COORD_DECIMALS)}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
