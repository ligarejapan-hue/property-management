/**
 * デジタル庁「アドレス・ベース・レジストリ」CSV の解釈(純関数・取込スクリプトから使う)。
 * 号レベルの住所自動入力(第3弾)用に、2種類のファイルを読む:
 *
 * 1. 町字マスター (mt_town_pref*.csv・UTF-8)
 *    列(実測 2026-08-02): lg_code,machiaza_id,machiaza_type,pref,...,city(9),...,ward(12),
 *    ...,oaza_cho(15),...,chome(18),...,chome_number(20),koaza(21),...
 *    → (lg_code, machiaza_id) → 表示名 {prefecture, city(市区+政令市の区), town(大字+小字), chome(算用数字)}
 *
 * 2. 住居表示-住居マスター位置参照拡張 (mt_rsdtdsp_rsdt_pos_pref*.csv・UTF-8)
 *    列(実測): lg_code(0),machiaza_id(1),blk_id(2),rsdt_id(3),rsdt2_id(4),
 *    rsdt_addr_flg(5),...,rep_lon(7),rep_lat(8),...
 *    blk_id/rsdt_id はゼロ埋め数値("006"→6番, "001"→1号)。rsdt2_id は枝番(東京都で0.4%)。
 *
 * - 廃止行: 東京都の実測では ablt_date 入り行ゼロだが、将来に備え ablt_date(34) 非空は除外。
 * - 不正・欠損行は黙って落とさず件数を返す(取込レポートで見える化)。
 */
import { splitCsvLine } from "./parse-isj";

export interface AbrTownEntry {
  prefecture: string;
  city: string;
  town: string;
  /** 丁目(算用数字の文字列)。丁目なし町字は ""。 */
  chome: string;
}

/** ヘッダ行から使用列の位置を列名で解決する(列順ドリフト検知)。 */
function requireColumns(
  header: string[],
  names: string[],
  fileLabel: string,
): Record<string, number> {
  const idx: Record<string, number> = {};
  for (const name of names) {
    const i = header.indexOf(name);
    if (i < 0) {
      throw new Error(
        `${fileLabel} のヘッダに列「${name}」がありません。データの版を確認してください`,
      );
    }
    idx[name] = i;
  }
  return idx;
}

/** BOM 除去(ABR は UTF-8。先頭ファイルに BOM が付くことがある)。 */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export interface AbrTownParseResult {
  /** key = `${lg_code}:${machiaza_id}` */
  towns: Map<string, AbrTownEntry>;
  skipped: number;
}

export function parseAbrTownCsv(text: string): AbrTownParseResult {
  const lines = stripBom(text)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  if (lines.length === 0) return { towns: new Map(), skipped: 0 };
  const header = splitCsvLine(lines[0]);
  const col = requireColumns(
    header,
    ["lg_code", "machiaza_id", "pref", "county", "city", "ward", "oaza_cho", "chome_number", "koaza", "ablt_date"],
    "町字マスター",
  );
  const towns = new Map<string, AbrTownEntry>();
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    const lg = (c[col.lg_code] ?? "").trim();
    const machiaza = (c[col.machiaza_id] ?? "").trim();
    const prefecture = (c[col.pref] ?? "").trim();
    // 郡部は county=「西多摩郡」+ city=「檜原村」、政令市は city=「横浜市」+
    // ward=「中区」に分かれる → 表示は 郡+市町村+区 の連結(Codex P2: 郡を
    // 落とすと「東京都檜原村…」のような不完全な住所が保存される)。
    const city = `${(c[col.county] ?? "").trim()}${(c[col.city] ?? "").trim()}${(c[col.ward] ?? "").trim()}`;
    const town = `${(c[col.oaza_cho] ?? "").trim()}${(c[col.koaza] ?? "").trim()}`;
    const chome = (c[col.chome_number] ?? "").trim();
    if ((c[col.ablt_date] ?? "").trim() !== "") continue; // 廃止済み町字
    if (!lg || !machiaza || !prefecture || !city || !town || (chome !== "" && !/^\d+$/.test(chome))) {
      skipped++;
      continue;
    }
    towns.set(`${lg}:${machiaza}`, { prefecture, city, town, chome });
  }
  return { towns, skipped };
}

export interface AbrResidenceRow {
  prefecture: string;
  city: string;
  town: string;
  chome: string;
  /** 番(先頭ゼロなし)。 */
  block: string;
  /** 号(枝番があれば "4-2" 形)。 */
  rsdt: string;
  lat: number;
  lng: number;
}

/** 位置参照拡張のヘッダを検証し、使用列の位置を返す。 */
export function parseAbrRsdtHeader(headerLine: string): Record<string, number> {
  return requireColumns(
    splitCsvLine(stripBom(headerLine)),
    ["lg_code", "machiaza_id", "blk_id", "rsdt_id", "rsdt2_id", "rep_lon", "rep_lat"],
    "住居マスター位置参照拡張",
  );
}

function isPlausibleJapan(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= 20 &&
    lat <= 46 &&
    lng >= 122 &&
    lng <= 154
  );
}

/**
 * 位置参照拡張の1データ行 → 行データ。町字に紐づかない・不正値は null(=skip)。
 * ⚠大きなファイル(東京都175万行)を streaming で読む前提の行単位 API。
 *
 * ⚠ABR の**予約IDレンジ**は実番号ではない(社内レビュー実データ検証・大阪/北海道で実在):
 *   - 街区ID「000」= 道路方式(街区なし・北海道浦河町等)
 *   - 街区ID「901〜999」= 数字以外を含む街区符号(「南2」「中2」等)の独自連番
 *     (大阪市西区千代崎=京セラドーム周辺で実在。ID から実符号は復元不能)
 *   - 住居ID「901〜999」・住居2ID「10001〜」も同様の連番
 *   これらを parseInt すると「千代崎3-903-1」のような**実在しない住所**を組み立てて
 *   しまうため skip する(該当地点は番データ/GSI へフォールバック)。
 */
export function parseAbrRsdtLine(
  line: string,
  col: Record<string, number>,
  towns: Map<string, AbrTownEntry>,
): AbrResidenceRow | null {
  const c = splitCsvLine(line);
  const lg = (c[col.lg_code] ?? "").trim();
  const machiaza = (c[col.machiaza_id] ?? "").trim();
  const blkRaw = (c[col.blk_id] ?? "").trim();
  const rsdtRaw = (c[col.rsdt_id] ?? "").trim();
  const rsdt2Raw = (c[col.rsdt2_id] ?? "").trim();
  const lng = Number(c[col.rep_lon]);
  const lat = Number(c[col.rep_lat]);
  const townEntry = towns.get(`${lg}:${machiaza}`);
  if (
    !townEntry ||
    !/^\d+$/.test(blkRaw) ||
    !/^\d+$/.test(rsdtRaw) ||
    (rsdt2Raw !== "" && !/^\d+$/.test(rsdt2Raw)) ||
    !isPlausibleJapan(lat, lng)
  ) {
    return null;
  }
  const blkNum = parseInt(blkRaw, 10);
  const rsdtNum = parseInt(rsdtRaw, 10);
  const rsdt2Num = rsdt2Raw !== "" ? parseInt(rsdt2Raw, 10) : null;
  if (
    blkNum <= 0 ||
    blkNum >= 901 ||
    rsdtNum <= 0 ||
    rsdtNum >= 901 ||
    (rsdt2Num !== null && (rsdt2Num <= 0 || rsdt2Num >= 10001))
  ) {
    return null; // 予約レンジ=実番号でない(上記コメント参照)
  }
  const block = String(blkNum);
  const rsdt = String(rsdtNum) + (rsdt2Num !== null ? `-${rsdt2Num}` : "");
  return { ...townEntry, block, rsdt, lat, lng };
}

/**
 * 号までの住所文字列を組み立てる。
 * - 丁目あり: 東京都杉並区西荻北3-19-4
 * - 丁目なし: 東京都千代田区一番町10-3 (正式は「10番3号」だが追記不要のハイフン形で統一)
 */
export function formatResidenceAddress(row: {
  prefecture: string;
  city: string;
  town: string;
  chome: string;
  block: string;
  rsdt: string;
}): string {
  const chomePart = row.chome !== "" ? `${row.chome}-` : "";
  return `${row.prefecture}${row.city}${row.town}${chomePart}${row.block}-${row.rsdt}`;
}
