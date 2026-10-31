/**
 * 謄本(全部事項)の表題部から、土地の**地積**と建物の**床面積の合計**を読む。純関数。
 * 2026-10-25 発注者「謄本を読み込んだ時も自動で面積を反映させたい」(土地・戸建も)。
 * 区分マンションの専有部分の床面積は registry-unit-floor-area.ts。
 *
 * 謄本の並び:
 *   表題部(土地の表示)          … ①地番 │②地目 │③地積㎡ │原因及びその日付
 *   表題部(主である建物の表示)  … ①種類 │②構造 │③床面積㎡ │原因及びその日付(床面積は「１階 ５０：００」を階ごとに1行)
 *   附属建物の表示・権利部・共同担保目録 … 読まない
 *
 * ⚠罫線(│)で区切られた**列**で読む(構造の「２階建」や権利部の数字を拾わない)。罫線が無い文字だけなら読まない。
 * ⚠**迷ったら読まない**(空のまま=人が入れる)。古い値は下線=抹消で、文字だけでは今の値と見分けられない:
 *   - 土地: 地積が2つ以上ある(地積更正・分筆などの履歴)
 *   - 建物: 同じ階が2回出る・変更の原因(増築・変更・錯誤・一部取壊しなど)がある
 *   - どちらも: 欄に数字として読めない文字がある
 * ⚠「：」「・」「．」は小数点(謄本の書き方)。全角数字も読む。
 */
import { supportsUnitFields } from "@/lib/property-building-name";
import { structuredFieldsFor } from "@/lib/paste-import/structured-fields";

export interface RegistryAreaResult {
  /** ㎡・小数2桁の文字(例 "120.50")。読めなければ null。 */
  value: string | null;
  /** 読まなかった理由(短い文。数字や住所は入れない)。読めたときは null。 */
  skippedReason: string | null;
}

function toHalfWidth(s: string): string {
  return s
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ");
}

/** 行を罫線で列に分ける。罫線が無い行は null。 */
function cellsOf(line: string): string[] | null {
  if (!/[│┃|｜]/.test(line)) return null;
  return line.split(/[│┃|｜]/).map((c) => c.trim());
}

// ⚠小数点だけの欄も空(実物: 原因の日付が折り返した行の地積の欄に「：」だけが出る・本番の謄本で確認 2026-11-01)。
const BLANK = /^(余\s*白)?$|^[:：・．.]$/;
const NUM = "([0-9]{1,7})(?:[ \\t]*[:：・．.][ \\t]*([0-9]{2}))?";
const PLAIN_AREA = new RegExp(`^${NUM}$`);
const FLOOR_AREA = /^(地[ \t]*下[ \t]*)?([0-9]{1,3})[ \t]*階[ \t]*([0-9]{1,6})(?:[ \t]*[:：・．.][ \t]*|[ \t]+)([0-9]{2})$/;
/** 建物の床面積が変わったことを示しうる登記の原因の語。 */
export const BUILDING_CHANGE_CAUSE = /増\s*築|変\s*更|更\s*正|錯\s*誤|取\s*壊|合\s*体|合\s*併|分\s*割|区\s*分/;

const toHundredths = (int: string, frac: string | undefined) => Number(int) * 100 + Number(frac ?? "0");
const format = (h: number) => `${Math.floor(h / 100)}.${String(h % 100).padStart(2, "0")}`;

interface Table {
  /** 見出しの次の行から、表の区切りまでの行(列に分けたもの)。 */
  rows: string[][];
  /** 読む列の位置。 */
  col: number;
  /** 原因及びその日付の列の位置(無ければ -1)。 */
  causeCol: number;
}

/**
 * 表題部の1つの表を探す。`section` で始まる行のあと、`header` を含む見出しの行の列で、
 * `end` に当たる行(次の表題部・権利部など)の手前までを返す。
 */
export function findRegistryTable(raw: string, section: RegExp, header: RegExp, colLabel: RegExp, end: RegExp): Table | null {
  const lines = toHalfWidth(raw).split("\n");
  // 見出しが2行に折り返されても「敷地権の目的である土地の表示」を土地の表としない(前の行も見る)。
  const isSection = (i: number) =>
    section.test(lines[i]) && !(i > 0 && /敷\s*地\s*権/.test(lines[i - 1]) && !/表\s*題\s*部/.test(lines[i]));
  const starts = lines.map((_, i) => i).filter(isSection);
  // ⚠同じ表が2つ以上ある(2筆の土地・2棟の建物を1つの PDF にまとめたもの)=どれの面積か決められない。
  if (starts.length !== 1) return null;
  const start = starts[0];
  let headerIdx = -1;
  let headerCells: string[] | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    if (end.test(lines[i])) return null;
    const cells = cellsOf(lines[i]);
    if (cells && header.test(lines[i])) {
      headerIdx = i;
      headerCells = cells;
      break;
    }
  }
  if (!headerCells) return null;
  const col = headerCells.findIndex((c) => colLabel.test(c));
  if (col === -1) return null;
  const causeCol = headerCells.findIndex((c) => /原\s*因/.test(c));
  const rows: string[][] = [];
  let closed = false;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (end.test(lines[i])) {
      closed = true;
      break;
    }
    const cells = cellsOf(lines[i]);
    if (!cells) continue;
    rows.push(cells);
  }
  // ⚠表の終わり(権利部・附属建物・次の表題部など)が文字の中に無ければ読まない。PDF の先頭の数ページだけを
  //   読んだときに表が途中で切れていると、後ろの更正・増築の行が抜けて古い値や一部の合計になる(@codex PR#593 P2)。
  if (!closed) return null;
  return { rows, col, causeCol };
}

const LAND_SECTION = /^(?!.*敷\s*地\s*権).*土\s*地\s*の\s*表\s*示/;
export const BUILDING_SECTION = /主\s*で\s*あ\s*る\s*建\s*物\s*の\s*表\s*示/;
export const REGISTRY_SECTION_END = /表\s*題\s*部|附\s*属\s*建\s*物\s*の\s*表\s*示|権\s*利\s*部|甲\s*区|乙\s*区|共\s*同\s*担\s*保/;

/** 土地の謄本の地積。 */
export function parseLandArea(raw: string): RegistryAreaResult {
  const table = findRegistryTable(raw, LAND_SECTION, /地\s*番.*地\s*積|地\s*積.*地\s*番/, /地\s*積/, REGISTRY_SECTION_END);
  if (!table) return { value: null, skippedReason: "土地の表示が読めません" };
  const values: number[] = [];
  for (const cells of table.rows) {
    const cell = (cells[table.col] ?? "").replace(/㎡/g, "").trim();
    if (BLANK.test(cell)) continue;
    const m = PLAIN_AREA.exec(cell);
    if (!m) return { value: null, skippedReason: "地積が読めません" };
    values.push(toHundredths(m[1], m[2]));
  }
  if (values.length === 0) return { value: null, skippedReason: "地積が読めません" };
  if (values.length > 1) return { value: null, skippedReason: "地積に変更の履歴があり、今の値を決められません" };
  return { value: format(values[0]), skippedReason: null };
}

/** 建物(区分でない)の謄本の床面積の合計(各階の合計・附属建物は入れない)。 */
export function parseBuildingFloorArea(raw: string): RegistryAreaResult {
  const table = findRegistryTable(raw, BUILDING_SECTION, /床\s*面\s*積/, /床\s*面\s*積/, REGISTRY_SECTION_END);
  if (!table) return { value: null, skippedReason: "建物の表示が読めません" };
  const history: RegistryAreaResult = { value: null, skippedReason: "床面積に変更の履歴があり、今の値を決められません" };
  const byFloor = new Map<string, number>();
  const plain: number[] = [];
  for (const cells of table.rows) {
    if (table.causeCol !== -1 && BUILDING_CHANGE_CAUSE.test(cells[table.causeCol] ?? "")) return history;
    const cell = (cells[table.col] ?? "").replace(/㎡/g, "").trim();
    if (BLANK.test(cell)) continue;
    const f = FLOOR_AREA.exec(cell);
    if (f) {
      const floor = `${f[1] ? "B" : ""}${Number(f[2])}`;
      if (byFloor.has(floor)) return history;
      byFloor.set(floor, toHundredths(f[3], f[4]));
      continue;
    }
    const p = PLAIN_AREA.exec(cell);
    if (!p) return { value: null, skippedReason: "床面積が読めません" };
    plain.push(toHundredths(p[1], p[2]));
  }
  // 階の書き方がある行と無い行が混ざる・階の無い数字が2つ以上=どれが今の値か決められない。
  if (plain.length > 0 && (byFloor.size > 0 || plain.length > 1)) return history;
  if (plain.length === 1) return { value: format(plain[0]), skippedReason: null };
  if (byFloor.size === 0) return { value: null, skippedReason: "床面積が読めません" };
  let total = 0;
  for (const v of byFloor.values()) total += v;
  return { value: format(total), skippedReason: null };
}

/** 謄本から読めた面積(読めないものは null)。 */
export interface RegistryAreas {
  unitFloorArea: string | null;
  landArea: string | null;
  buildingFloorArea: string | null;
}

/** 謄本の読み取り結果(parseRegistryText)から面積だけを取り出す。 */
export function registryAreasOf(parsed: {
  unitFloorArea?: string | null;
  landAreaRegistry?: string | null;
  buildingFloorArea?: string | null;
}): RegistryAreas {
  return {
    unitFloorArea: parsed.unitFloorArea ?? null,
    landArea: parsed.landAreaRegistry ?? null,
    buildingFloorArea: parsed.buildingFloorArea ?? null,
  };
}

/** 埋めるかを決めるのに使う、物件の今の値。 */
export interface RegistryAreaCurrent {
  propertyType: string;
  exclusiveAreaRegistry: unknown;
  landArea: unknown;
  landAreaMethod: string | null;
  totalFloorArea: unknown;
}

export interface RegistryAreaFill {
  exclusiveAreaRegistry?: string;
  landArea?: string;
  landAreaMethod?: string;
  totalFloorArea?: string;
}

/** 謄本からの面積の計測方式(公簿=登記簿の面積)。 */
export const REGISTRY_LAND_AREA_METHOD = "公簿";

/**
 * 物件のどの欄を埋めるか。**空の欄だけ**(手で入れた値・前の謄本で入った値は上書きしない)。
 * 種別ごとに使う欄は、編集画面の「販売」区分で見える欄と同じ(structuredFieldsFor)+区分の専有面積。
 * - 区分マンション: 専有面積(登記簿)
 * - 土地: 土地面積(+計測方式が空なら「公簿」)
 * - 戸建・一棟: 土地面積(土地の謄本)・建物面積(延べ)(建物の謄本)
 */
export function planRegistryAreaFill(areas: RegistryAreas, current: RegistryAreaCurrent): RegistryAreaFill {
  const out: RegistryAreaFill = {};
  if (supportsUnitFields(current.propertyType) && current.exclusiveAreaRegistry == null && areas.unitFloorArea) {
    out.exclusiveAreaRegistry = areas.unitFloorArea;
  }
  const fields = structuredFieldsFor(current.propertyType);
  if (fields.has("landArea") && current.landArea == null && areas.landArea) {
    out.landArea = areas.landArea;
    if (!current.landAreaMethod || current.landAreaMethod.trim() === "") out.landAreaMethod = REGISTRY_LAND_AREA_METHOD;
  }
  if (fields.has("totalFloorArea") && current.totalFloorArea == null && areas.buildingFloorArea) {
    out.totalFloorArea = areas.buildingFloorArea;
  }
  return out;
}
