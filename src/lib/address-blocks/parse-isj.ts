/**
 * 国土交通省「位置参照情報」街区レベル CSV の解釈(純関数・取込スクリプトから使う)。
 *
 * 実測フォーマット(24.0a・2026-08-01 確認):
 *   "都道府県名","市区町村名","大字・丁目名","小字・通称名","街区符号・地番",
 *   "座標系番号","Ｘ座標","Ｙ座標","緯度","経度","住居表示フラグ","代表フラグ",
 *   "更新前履歴フラグ","更新後履歴フラグ"
 *   例: "東京都","杉並区","西荻北四丁目","","27","9",...,"35.709027","139.591289","1","1","0","0"
 *
 * - 文字コードは Shift_JIS。decode は呼び出し側(スクリプト)が行い、ここは文字列を受ける。
 * - 代表フラグは 0/1 とも取り込む(点密度が上がり最近傍マッチが安定する)。
 * - 更新前履歴フラグ=1 の行(更新前の旧データ)は除外する。
 * - 不正・欠損行は黙って落とさず件数を返す(取込レポートで見える化)。
 */

export interface IsjBlockRow {
  prefecture: string;
  city: string;
  town: string;
  block: string;
  lat: number;
  lng: number;
  isResidential: boolean;
}

export interface IsjParseResult {
  rows: IsjBlockRow[];
  skipped: number; // 不正・欠損で除外した行数(履歴行は含まない)
  history: number; // 更新前履歴フラグ=1 で除外した行数
}

/**
 * ダブルクォート囲み CSV の1行を分解する(フィールド内カンマ・"" エスケープ対応)。
 * ISJ の実データは全フィールド quoted だが、素の値が来ても壊れないようにする。
 */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

/** 日本国内としてもっともらしい緯度経度か(reverse-geocode 側と同じ範囲)。 */
function isPlausible(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= 20 &&
    lat <= 46 &&
    lng >= 122 &&
    lng <= 154
  );
}

/** CSV 全文(decode 済み文字列)を行データへ。ヘッダ行は列名で検証する。 */
export function parseIsjCsv(text: string): IsjParseResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) {
    return { rows: [], skipped: 0, history: 0 };
  }
  const header = splitCsvLine(lines[0]);
  // 列順のドリフト(将来の版でずれた場合)に気づけるよう、使う列だけ位置を検証する。
  const expect: Array<[number, string]> = [
    [0, "都道府県名"],
    [1, "市区町村名"],
    [2, "大字・丁目名"],
    [3, "小字・通称名"],
    [4, "街区符号・地番"],
    [8, "緯度"],
    [9, "経度"],
    [10, "住居表示フラグ"],
    [12, "更新前履歴フラグ"],
  ];
  for (const [idx, name] of expect) {
    if (header[idx] !== name) {
      throw new Error(
        `ISJ CSV のヘッダが想定と異なります(列${idx}: 期待=${name} 実際=${header[idx] ?? "(欠落)"})。データの版を確認してください`,
      );
    }
  }

  const rows: IsjBlockRow[] = [];
  let skipped = 0;
  let history = 0;
  for (let i = 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    if (c.length < 13) {
      skipped++;
      continue;
    }
    if (c[12] === "1") {
      history++; // 更新前の旧レコード
      continue;
    }
    const prefecture = c[0].trim();
    const city = c[1].trim();
    // 小字・通称名(列3)は大字に連結して保持する(Codex P2: 捨てると地番地域で
    // 「大字+小字+地番」の小字が欠け、同じ地番を持つ別の小字と区別できない)。
    // 大字(列2)が空の行は不正として弾く(小字だけの住所は組み立てない)。
    const oaza = c[2].trim();
    const koaza = c[3].trim();
    const town = oaza === "" ? "" : `${oaza}${koaza}`;
    const block = c[4].trim();
    const lat = Number(c[8]);
    const lng = Number(c[9]);
    const flag = c[10];
    if (
      !prefecture ||
      !city ||
      !town ||
      !block ||
      !isPlausible(lat, lng) ||
      (flag !== "0" && flag !== "1")
    ) {
      skipped++;
      continue;
    }
    rows.push({
      prefecture,
      city,
      town,
      block,
      lat,
      lng,
      isResidential: flag === "1",
    });
  }
  return { rows, skipped, history };
}
