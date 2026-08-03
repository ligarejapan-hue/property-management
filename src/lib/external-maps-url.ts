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
 * 建物を1棟ずつ見分けられる倍率。**ピンが立たない**形式なので、
 * 引いた画で開くと「画面の中心がどの家か」が分からなくなる。
 */
const MAP_ZOOM = 19;

/**
 * 座標から一般向け Google マップの地図表示を開く URL。
 * ストリートビューが無い場所の代替や、周辺を見たいときに使う。
 *
 * ⚠**「地図表示」形式 (`map_action=map`) を使う**。2026-08-03 発注者から
 * 「開いた地図が航空写真になっているので、地図タイプを既定にしてほしい」。
 * Google マップは**利用者が最後に選んだ地図タイプを憶えている**ため、一度
 * 航空写真にすると以後ずっと航空写真で開く。URL 側で打ち消すには
 * `basemap=roadmap` が要る。
 *
 * ⚠**`basemap` は「検索」形式では効かない**。公式仕様で検索形式が受け付ける
 * のは `query` / `query_place_id` だけ (2026-08-03 に Maps URLs の公式ドキュメント
 * で確認)。よって検索形式のままでは指定できず、地図表示形式へ切り替えた。
 *
 * ⚠**引き換えに赤いピンは立たない**(地図表示形式は marker を持てない)。
 * 画面の中心がその場所になる。住所の確認用途では、番地の区画や建物名が
 * 読める通常の地図のほうが航空写真より適しているため、この交換は妥当と判断。
 * 中心が曖昧にならないよう倍率を建物単位まで寄せる。
 */
export function buildExternalMapUrl(
  lat: number | null | undefined,
  lng: number | null | undefined,
): string | null {
  if (lat == null || lng == null) return null;
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!isValidLat(latNum) || !isValidLng(lngNum)) return null;
  const center = `${latNum.toFixed(COORD_DECIMALS)},${lngNum.toFixed(COORD_DECIMALS)}`;
  return (
    "https://www.google.com/maps/@?api=1&map_action=map" +
    `&center=${encodeURIComponent(center)}` +
    `&zoom=${MAP_ZOOM}` +
    "&basemap=roadmap"
  );
}
