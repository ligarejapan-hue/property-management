/**
 * 謄本から物件の基本情報(地番・家屋番号・構造・築年月)を読み、埋める欄を決める。純関数。
 * 2026-11-01 発注者「謄本を入れているのに基本情報に反映されない」→ 添付でも入れる・構造と築年月も読む。
 * 面積は registry-area.ts / registry-unit-floor-area.ts。書き込みは registry-pdf/fill-areas.ts。
 *
 * 謄本の並び:
 *   区分: 表題部(一棟の建物の表示)   … ①構造 │②床面積 │原因及びその日付 ← 構造はここ
 *         表題部(専有部分の建物の表示) … ①種類 │②構造 │③床面積 │原因及びその日付 ← 新築の日付はここ
 *                                        (②構造は「鉄筋コンクリート造１階建」=部屋の階数なので読まない)
 *   戸建など: 表題部(主である建物の表示) … ①種類 │②構造 │③床面積 │原因及びその日付
 *
 * ⚠**不動産番号は入れない**(発注者判断 2026-08-12「不動産番号を入れない運用」。入ると所在検索の対象外になる)。
 * ⚠**迷ったら読まない**(空のまま=人が入れる)。古い値は下線=抹消で、文字だけでは今の値と見分けられない。
 * ⚠地番・家屋番号は謄本の取得で「買う対象」を決める番号なので、取得が読める形(isReadableChiban)だけを入れる。
 */
import { BUILDING_CHANGE_CAUSE, BUILDING_SECTION, LAND_SECTION, REGISTRY_SECTION_END, cellsOf, findRegistryTable, isBlankRegistryCell } from "@/lib/registry-area";
import { isReadableChiban, toHalfWidthDigits } from "@/lib/registry-fetch/chiban-input";
import { structuredFieldsFor } from "@/lib/paste-import/structured-fields";

export interface RegistryBuildingFacts {
  /** 構造(謄本の書き方のまま・例 "鉄筋コンクリート造陸屋根5階建")。 */
  structureType: string | null;
  builtYear: number | null;
  /** 月日不詳の謄本では null(年だけ入れる)。 */
  builtMonth: number | null;
}

export interface RegistryIdentity {
  lotNumber: string | null;
  buildingNumber: string | null;
}

export type RegistryBasicValues = RegistryIdentity & RegistryBuildingFacts;

const NO_FACTS: RegistryBuildingFacts = { structureType: null, builtYear: null, builtMonth: null };

const ONE_BUILDING_SECTION = /一\s*棟\s*の\s*建\s*物\s*の\s*表\s*示/;
const EXCLUSIVE_SECTION = /専\s*有\s*部\s*分\s*の\s*建\s*物\s*の\s*表\s*示/;
const TABLE_HEADER = /床\s*面\s*積/;
const STRUCTURE_COL = /構\s*造/;
const CAUSE_COL = /原\s*因/;
const OWNER_ROW = /^所\s*有\s*者/;
/** 階建・平家建の書き方がちょうど1つ=今の構造が1つに決まる。 */
const STOREYS = /階建|平[家屋]建/g;
const ENDS_WITH_STOREYS = /(階建|平[家屋]建)$/;
/** 物件の編集画面の構造の欄の上限(route の検証と同じ)。 */
const MAX_STRUCTURE_LENGTH = 50;

const ERA_BASE: Record<string, number> = { 明治: 1867, 大正: 1911, 昭和: 1925, 平成: 1988, 令和: 2018 };
const BUILT_DATE = /(明治|大正|昭和|平成|令和)(元|[0-9]{1,2})年(?:([0-9]{1,2})月(?:[0-9]{1,2}日)?|月日不詳)新築/;

type Table = NonNullable<ReturnType<typeof findRegistryTable>>;

function readStructure(table: Table | null): string | null {
  if (!table) return null;
  let joined = "";
  for (const cells of table.rows) {
    // 表題部の下に所有者の行が来る謄本がある。氏名・住所を構造に混ぜない。
    if (OWNER_ROW.test(cells.find((c) => c !== "") ?? "")) break;
    if (table.causeCol !== -1 && BUILDING_CHANGE_CAUSE.test(cells[table.causeCol] ?? "")) return null;
    const cell = (cells[table.col] ?? "").trim();
    if (!isBlankRegistryCell(cell)) joined += cell;
  }
  const value = joined.replace(/\s/g, "");
  // ⚠階建で終わること=後ろに別の行(氏名・住所)が付いたものを構造にしない。
  if (!value.includes("造") || (value.match(STOREYS)?.length ?? 0) !== 1 || !ENDS_WITH_STOREYS.test(value)) return null;
  return value.length <= MAX_STRUCTURE_LENGTH ? value : null;
}

function readBuilt(table: Table | null): Pick<RegistryBuildingFacts, "builtYear" | "builtMonth"> | null {
  if (!table || table.causeCol === -1) return null;
  // 日付は行をまたぐことがあるので、原因の列をつなげてから読む。
  const causes = table.rows.map((cells) => cells[table.causeCol] ?? "").join("").replace(/\s/g, "");
  if ((causes.match(/新築/g)?.length ?? 0) !== 1) return null;
  const m = BUILT_DATE.exec(causes);
  if (!m) return null;
  const month = m[3] ? Number(m[3]) : null;
  if (month !== null && (month < 1 || month > 12)) return null;
  return { builtYear: ERA_BASE[m[1]] + (m[2] === "元" ? 1 : Number(m[2])), builtMonth: month };
}

/** 謄本の文字から構造と築年月を読む。⚠罫線で列に分けて読む(文字だけなら読まない)。 */
export function parseRegistryBuildingFacts(raw: string): RegistryBuildingFacts {
  const table = (section: RegExp, col: RegExp) => findRegistryTable(raw, section, TABLE_HEADER, col, REGISTRY_SECTION_END);
  const isUnit = raw.split("\n").some((l) => ONE_BUILDING_SECTION.test(l));
  if (isUnit) {
    const built = readBuilt(table(EXCLUSIVE_SECTION, CAUSE_COL)) ?? readBuilt(table(ONE_BUILDING_SECTION, CAUSE_COL));
    return { structureType: readStructure(table(ONE_BUILDING_SECTION, STRUCTURE_COL)), ...(built ?? { builtYear: null, builtMonth: null }) };
  }
  if (!raw.split("\n").some((l) => BUILDING_SECTION.test(l))) return NO_FACTS;
  const built = readBuilt(table(BUILDING_SECTION, CAUSE_COL));
  return { structureType: readStructure(table(BUILDING_SECTION, STRUCTURE_COL)), ...(built ?? { builtYear: null, builtMonth: null }) };
}

const TRAILING_SEPARATOR = /(番地|番|の|\u30ce|[\-‐‑‒–—―−ー－])$/;

/** 謄本に書かれた番号を、取得が読める形にする(町名を落とす・半角に)。読めなければ null。 */
function toStoredNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const tokens = toHalfWidthDigits(value).trim().split(/\s+/);
  const tail = tokens.pop() ?? "";
  // ⚠切れた番号を入れない(「1番1の」「の38」は読める形として通るが、正規化すると別の番号を指し、謄本の取得で別の登記を買う)。
  if (!/^[0-9]/.test(tail) || /[の\u30ce\-‐‑‒–—―−ー－]$/.test(tail)) return null;
  // ⚠前の語は町名だけ。数字や区切りが残っていれば番号の途中の空白=末尾だけ取ると別の番号になる(「1番1の 38」→38・@codex P1)。
  // 町名を落とすときは、番号だと分かる形(番・ハイフン)の末尾だけ受ける(「架空町の 38」を 38 にしない)。
  if (tokens.length > 0 && (tokens.some((t) => /[0-9]/.test(t) || TRAILING_SEPARATOR.test(t)) || !/[番\-‐‑‒–—―−ー－]/.test(tail))) {
    return null;
  }
  return isReadableChiban(tail) ? tail : null;
}

const SITE_SECTION = /敷\s*地\s*権\s*の\s*目\s*的/;
/** 番号だけの文字。⚠途中の空白を許さない(「1番 1」を「1番」にしない)。 */
const NUMBER_ONLY = /^[0-9][0-9番の\u30ce\-‐‑‒–—―−ー－]*$/;
/** 所在及び地番の欄: 町名(数字なし)に番号が続く形だけ(空白で区切られていてもよい)。 */
const ADDRESS_THEN_NUMBER = /^[^0-9]*?\s*([0-9][0-9番の\u30ce\-‐‑‒–—―−ー－]*)$/;

const SHOZAI_LABEL = /^所\s*在$/;
/** 建物の所在の欄: 町名に地番が1つ続く形だけ。⚠前の語に番・読点・及びがあれば地番が2つ以上(「二番地、1番地1」を 1番地1 にしない)。 */
const SHOZAI_THEN_NUMBER = /^[^0-9番、,，及]*?\s*([0-9][0-9番地のノ\-‐‑‒–—―−ー－]*)$/;

/**
 * 建物の謄本の表題部の「所在」の欄から地番を読む(2026-11-02 発注者「地番は謄本上の所在です」)。
 * 実物の形は「町名 1番地1」。地番の書き方(1番1)にして返す。
 * ⚠読むのは一棟の建物の表示・主である建物の表示の所在の行が1つだけのとき。
 * ⚠次の行に続き・右の欄に原因がある=折り返しか変更の履歴なので読まない(古い所在で別の登記を買わない)。
 */
function readLotFromShozai(raw: string): string | null {
  const lines = toHalfWidthDigits(raw).split("\n");
  const isBuildingSection = (l: string) => ONE_BUILDING_SECTION.test(l) || BUILDING_SECTION.test(l);
  if (lines.filter(isBuildingSection).length !== 1) return null;
  let value: string | null = null;
  let label = -1;
  // ⚠所在の行のあとに別の項目が見えないなら読まない(文字が途中で切れていると、続きの行を見落とす)。
  let closed = false;
  for (const line of lines.slice(lines.findIndex(isBuildingSection) + 1)) {
    if (REGISTRY_SECTION_END.test(line)) {
      closed = true;
      break;
    }
    const cells = cellsOf(line);
    if (!cells) continue;
    const at = cells.findIndex((c) => SHOZAI_LABEL.test(c));
    if (at !== -1) {
      if (value !== null) return null;
      if (!isBlankRegistryCell(cells[at + 2] ?? "")) return null;
      value = cells[at + 1] ?? "";
      label = at;
    } else if (value !== null) {
      if ((cells[label] ?? "") !== "") {
        closed = true;
        break;
      }
      if (!isBlankRegistryCell(cells[label + 1] ?? "") || !isBlankRegistryCell(cells[label + 2] ?? "")) return null;
    }
  }
  if (value === null || !closed) return null;
  // 外字は実物で欄の空白として出ていたので、端だけ落とす(番号の途中の外字は読まない)。
  const number = SHOZAI_THEN_NUMBER.exec(value.replace(/^[-\s]+|[-\s]+$/g, ""))?.[1];
  return number ? number.replace(/番地/g, "番") : null;
}

/**
 * 地番を表の**欄全体**から読む(謄本の取得で買う対象を決めるので、parseRegistryText の緩い読み取りを使わない・@codex P1)。
 * - 土地: 表題部の①地番の欄。数字のある行がちょうど1つ(2つ以上=分筆などの履歴で決められない)。
 * - 区分: 敷地権の目的である土地の表示の②所在及び地番の欄。土地がちょうど1筆のときだけ(符号の列で数える。行の折り返しはつなげる)。
 * - 敷地権の欄が無い区分・戸建など: 表題部の所在の欄(readLotFromShozai)。
 * ⚠欄全体が番号の形でなければ読まない=途中で切れた値を入れない。
 * ⚠土地の表・敷地権の欄がある謄本は、そこで決められなくても所在へ逃げない(2筆の区分が1筆目で入ってしまう)。
 */
function readLotNumber(raw: string): string | null {
  const land = findRegistryTable(raw, LAND_SECTION, /地\s*番.*地\s*目/, /地\s*番/, REGISTRY_SECTION_END);
  if (land) {
    const cells = land.rows.map((c) => (c[land.col] ?? "").trim()).filter((c) => /[0-9]/.test(c));
    return cells.length === 1 && NUMBER_ONLY.test(cells[0]) ? cells[0] : null;
  }
  if (raw.split("\n").some((l) => SITE_SECTION.test(l) || LAND_SECTION.test(l))) return readLotFromSite(raw);
  return readLotFromShozai(raw);
}

function readLotFromSite(raw: string): string | null {
  const site = findRegistryTable(raw, SITE_SECTION, /所\s*在\s*及\s*び\s*地\s*番/, /所\s*在\s*及\s*び\s*地\s*番/, REGISTRY_SECTION_END);
  if (!site || site.col < 1) return null;
  const parcels = site.rows.filter((c) => /[0-9]/.test(c[site.col - 1] ?? "")).length;
  if (parcels !== 1) return null;
  const joined = site.rows.map((c) => (c[site.col] ?? "").trim()).filter((c) => !isBlankRegistryCell(c)).join("");
  return ADDRESS_THEN_NUMBER.exec(joined)?.[1] ?? null;
}

const BUILDING_NUMBER_LABEL = /^家\s*屋\s*番\s*号$/;

/**
 * 家屋番号を表の**欄全体**から読む(地番と同じ理由・@codex P1)。
 * ⚠見出しの欄が「家屋番号」ちょうどの行だけ(「専有部分の家屋番号」は全部屋の範囲なので読まない)。
 * ⚠次の行に折り返している・値が2つあるなら読まない(「1番1」+「の38」の前半だけを入れない)。
 */
function readBuildingNumber(raw: string): string | null {
  const lines = raw.split("\n");
  const values = new Set<string>();
  for (const [i, line] of lines.entries()) {
    const cells = cellsOf(line);
    const label = cells?.findIndex((c) => BUILDING_NUMBER_LABEL.test(c)) ?? -1;
    if (!cells || label === -1) continue;
    // 外字(私用領域の文字)は実物で欄の空白として出ていたので落とす(parseRegistryText と同じ)。
    const value = (cells[label + 1] ?? "").replace(/[\uE000-\uF8FF]/g, "").trim();
    if (value === "") continue;
    const next = cellsOf(lines[i + 1] ?? "");
    if (next && (next[label] ?? "") === "" && (next[label + 1] ?? "") !== "") return null;
    values.add(value);
  }
  return values.size === 1 ? [...values][0] : null;
}

/**
 * 地番と家屋番号。⚠不動産番号が2つ以上ある=2件以上を1つにまとめた PDF は、どれの番号か決められないので入れない。
 */
export function registryIdentityOf(raw: string): RegistryIdentity {
  const numbers = new Set(
    [...toHalfWidthDigits(raw).matchAll(/不動産番号[：:\s│┃｜|]*([0-9][0-9\- ]{9,19})/g)].map((m) => m[1].replace(/[\s-]/g, "")),
  );
  if (numbers.size > 1) return { lotNumber: null, buildingNumber: null };
  return { lotNumber: toStoredNumber(readLotNumber(raw)), buildingNumber: toStoredNumber(readBuildingNumber(raw)) };
}

export interface RegistryBasicCurrent {
  propertyType: string;
  buildingId: string | null;
  registryStatus: string;
  lotNumber: string | null;
  buildingNumber: string | null;
  structureType: string | null;
  builtYear: number | null;
  builtMonth: number | null;
}

export type RegistryBasicFill = Partial<RegistryBasicValues>;

const isEmpty = (v: string | null) => v === null || v.trim() === "";

function planFacts(values: RegistryBuildingFacts, current: RegistryBuildingFacts): Partial<RegistryBuildingFacts> {
  const out: Partial<RegistryBuildingFacts> = {};
  if (isEmpty(current.structureType) && values.structureType) out.structureType = values.structureType;
  // 年と月は組。どちらか入っていれば触らない(手で入れた年に、別の月を混ぜない)。
  if (current.builtYear === null && current.builtMonth === null && values.builtYear !== null) {
    out.builtYear = values.builtYear;
    if (values.builtMonth !== null) out.builtMonth = values.builtMonth;
  }
  return out;
}

/**
 * 物件のどの欄を埋めるか。**空の欄だけ**。
 * ⚠土地には家屋番号を入れない(家屋番号があると謄本の取得が建物へ切り替わる)。
 * ⚠謄本の自動取得中(scheduled)は地番・家屋番号を入れない。取得は控えた番号で書類を選ぶので、途中で変わると
 *   別の対象になった物件へ添付される(物件の編集 API と同じ守り・@codex P1)。取得の完了時に同じ空欄が埋まる。
 * ⚠構造・築年月: 棟に紐づく部屋は棟の値が正なので書かない(planBuildingFactsFill)。編集画面に欄が無い種別にも書かない。
 */
export function planPropertyBasicFill(values: RegistryBasicValues, current: RegistryBasicCurrent): RegistryBasicFill {
  const out: RegistryBasicFill = {};
  if (current.registryStatus !== "scheduled") {
    if (isEmpty(current.lotNumber) && values.lotNumber) out.lotNumber = values.lotNumber;
    if (current.propertyType !== "land" && isEmpty(current.buildingNumber) && values.buildingNumber) {
      out.buildingNumber = values.buildingNumber;
    }
  }
  if (current.buildingId === null && structuredFieldsFor(current.propertyType).has("builtYear")) {
    Object.assign(out, planFacts(values, current));
  }
  return out;
}

/** 棟のどの欄を埋めるか(一棟の建物の表示は棟の情報)。空の欄だけ。 */
export function planBuildingFactsFill(values: RegistryBuildingFacts, current: RegistryBuildingFacts): Partial<RegistryBuildingFacts> {
  return planFacts(values, current);
}

export interface RegistryFillOutcome {
  /** 埋めた欄(物件・棟の項目名)。 */
  filled: string[];
  /** 埋めるはずの欄があったが、編集中の鍵のため見送った。 */
  skippedByEditLock: boolean;
  /** 文字を読めなかった(画像の PDF・時間切れ)。 */
  unreadable: boolean;
  /** 読めたが保存に失敗した(一時的なもの。押し直せば入る)。 */
  failed?: boolean;
}

const FIELD_LABELS: Record<string, string> = {
  lotNumber: "地番",
  buildingNumber: "家屋番号",
  structureType: "構造",
  builtYear: "築年月",
  builtMonth: "築年月",
  exclusiveAreaRegistry: "専有面積(登記簿)",
  landArea: "土地面積",
  totalFloorArea: "建物面積",
};

/** 画面に出す案内。⚠添付では、入れたものも入れなかった理由も無いときは黙る(`manual`=ボタンのときは必ず答える)。 */
export function registryFillNotice(outcome: RegistryFillOutcome, opts: { manual?: boolean } = {}): string | null {
  if (outcome.unreadable) return "謄本の文字を読めないため、基本情報には反映されません(画像の謄本は手で入力してください)";
  if (outcome.failed) return "基本情報への反映に失敗しました。謄本の「この謄本から基本情報に反映」を押し直してください";
  if (outcome.skippedByEditLock) return "物件を編集中の人がいるため、基本情報への反映を見送りました。編集が終わったら謄本の「この謄本から基本情報に反映」を押してください";
  const labels = [...new Set(outcome.filled.map((f) => FIELD_LABELS[f]).filter((l): l is string => l !== undefined))];
  if (labels.length > 0) return `基本情報の空いていた欄に入れました: ${labels.join("・")}`;
  return opts.manual ? "新しく入れる項目はありません(欄がすでに入っているか、謄本から読めない項目です)" : null;
}

/** 案内が注意か(緑の「入れました」ではなく、注意の色で出す)。 */
export function isRegistryWarningNotice(notice: string | null): boolean {
  return notice !== null && /反映されません|反映に失敗|見送りました/.test(notice);
}
