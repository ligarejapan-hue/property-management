/**
 * 査定報告書(SRE AI査定 CLOUD「不動産価格査定報告書」)の PDF の文字から、
 * お客様向け資料「査定のご報告」の下書きに使う数字を読む。純関数(2026-11-10 発注者依頼)。
 *
 * 実物3件(戸建・マンション・土地)の pdf-parse 出力の並び:
 *   「物件詳細」… 「見出し \t 値 \t 見出し \t 値」の行(目次にも「1.物件詳細」が出るので、
 *               見出しだけの行「物件詳細」の次の行にタブがあるものを本体とみなす)
 *   「査定結果 \t 査定日:YYYY年M月D日」… 売出しの3案(スピード/スタンダード/チャレンジ)か、
 *               価格の幅(下限〜上限)のどちらか。物件の種類で並びが違う。
 *   「成約想定価格 \t 1,304 万円 土地 1,214 万円 ( 88万円/坪 )」+ 次の行「建物 90 万円 ( 4.6万円/坪 )」
 *   「AI査定価格 …」 同じ形。マンション・土地は「( 253.4万円/坪 )」だけ。
 *   「土地評価 査定額の -70%」または「… +0万円」/「流通性比率 \t 査定額 + 物件評価価格の ±0%」
 *   「評価」の表 … 「土地 \t 土地形状 \t -1 \t -100万円 \t 備考」の行(土地の報告書)
 *
 * ⚠**依頼者の氏名は読まない・返さない**(1ページ目と「ごあいさつ」の「◯◯様」)。
 * ⚠所在地は**町丁目まで**しか返さない(番地は返さない)。担当者のコメント・総評も返さない。
 * ⚠pdf-parse は「西」「長」を部首の文字(⻄ ⻑)、「戸」を「戶」で返す。NFKC では戻らないので表で直す。
 * ⚠ Prisma / next / node:fs を import しないこと。
 */

import { coarsePropertyLocation } from "@/lib/sale-dm-letter/tags";

export const APPRAISAL_PARSER_VERSION = 1;

export type AppraisalPropertyKind = "house" | "mansion" | "land";

/** 金額はすべて万円。坪単価は万円/坪。読めなければ null。 */
export interface AppraisalValue {
  total: number | null;
  /** マンション・土地の「( 253.4万円/坪 )」。戸建は土地・建物それぞれにある。 */
  tsubo: number | null;
  land: number | null;
  landTsubo: number | null;
  building: number | null;
  buildingTsubo: number | null;
}

export interface AppraisalAdjustmentItem {
  category: string;
  label: string;
  /** 評点(-5〜+5)。総合評価の表では補正率(%)。 */
  score: number | null;
  /** 調整金額(万円)。無ければ null。 */
  amount: number | null;
}

export interface AppraisalAdjustment {
  /** 「土地評価 査定額の -70%」 */
  landPercent: number | null;
  /** 「土地評価 査定額の +0万円」 */
  landAmount: number | null;
  /** 「(接道状況/方位)」などの補正の項目名 */
  landReason: string | null;
  /** 「流通性比率 … ±0%」 */
  liquidityPercent: number | null;
  items: AppraisalAdjustmentItem[];
}

export type AppraisalPlanName = "speed" | "standard" | "challenge";

export interface AppraisalPlan {
  name: AppraisalPlanName;
  price: number;
  tsubo: number | null;
}

export interface AppraisalPriceRange {
  min: number;
  max: number;
  minTsubo: number | null;
  maxTsubo: number | null;
}

export type AppraisalWarning =
  | "not_sre"
  | "missing_expected"
  | "missing_ai"
  | "missing_plans"
  | "plan_order"
  | "unknown_kind";

export interface AppraisalExtract {
  parserVersion: number;
  source: "sre" | "unknown";
  kind: AppraisalPropertyKind | null;
  /** YYYY-MM-DD */
  appraisedOn: string | null;
  /** 所在地の町丁目まで(例「東京都世田谷区池尻4丁目」)。番地は入れない。 */
  area: string | null;
  railLine: string | null;
  station: string | null;
  walkMinutes: number | null;
  landSqm: number | null;
  landTsubo: number | null;
  floorSqm: number | null;
  exclusiveSqm: number | null;
  /** YYYY-MM */
  builtYearMonth: string | null;
  structure: string | null;
  layout: string | null;
  floorInfo: string | null;
  roadAccess: string | null;
  roadDetail: string | null;
  notes: string | null;
  expected: AppraisalValue;
  ai: AppraisalValue;
  adjustment: AppraisalAdjustment;
  plans: AppraisalPlan[];
  range: AppraisalPriceRange | null;
  warnings: AppraisalWarning[];
  /** 周辺施設(2026-11-11・「周辺施設情報」の地図と表から読む)。古い下書きには無い。 */
  facilities?: DeckFacility[];
}

/** 周辺施設。x・y は物件から東西(東が+)・南北(北が+)のメートル。地図から読めなければ null(一覧だけに出す)。 */
export interface DeckFacility {
  cat: string;
  name: string;
  /** 直線距離(m) */
  dist: number;
  /** 推定徒歩(分) */
  min: number;
  x: number | null;
  y: number | null;
  /** 担当者が資料から外した */
  hidden?: boolean;
}

/** NFKC で戻らない字(pdf-parse が返す部首・異体の字)。実物で見つかったものと、同じ並びの字。 */
const CHAR_FIXES: Record<string, string> = {
  "⻄": "西",
  "⻑": "長",
  "戶": "戸",
  "⻘": "青",
  "⻝": "食",
  "⻤": "鬼",
  "⻩": "黄",
  "⻭": "歯",
  "⻲": "亀",
  "⻨": "麦",
  "⻯": "竜",
  "⻁": "虎",
  "⻂": "衤",
  "⻌": "辶",
};
const CHAR_FIX_RE = new RegExp(`[${Object.keys(CHAR_FIXES).join("")}]`, "g");

export function normalizeSreText(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(CHAR_FIX_RE, (c) => CHAR_FIXES[c] ?? c)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/∕/g, "/");
}

function cleanCell(s: string): string {
  return s.replace(/[ 　]+/g, " ").trim();
}

function toLines(text: string): string[] {
  return normalizeSreText(text)
    .split(/\r?\n/)
    .map((l) => l.split("\t").map(cleanCell).join("\t").replace(/^\t+|\t+$/g, ""))
    .filter((l) => l !== "");
}

const num = (s: string | undefined | null): number | null => {
  if (s == null) return null;
  const t = s.replace(/[,，\s]/g, "").replace(/^[−–]/, "-").replace(/^±/, "");
  if (!/^[+-]?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

const textOrNull = (s: string | undefined): string | null => {
  if (s == null) return null;
  const t = s.trim();
  return t === "" || t === "-" ? null : t;
};

/** 物件詳細の「見出し \t 値 \t 見出し \t 値」を読む。 */
function readDetails(lines: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const start = lines.findIndex((l, i) => l === "物件詳細" && (lines[i + 1] ?? "").includes("\t"));
  if (start < 0) return map;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "本書の査定方法" || /^株式会社.*\d+$/.test(line) || /^-- \d+ of \d+ --$/.test(line)) break;
    const cells = line.split("\t");
    if (cells.length < 2) {
      // 「バルコニー面積 6.12m2」のようにタブが無い行
      const m = /^(\S+)\s+(.+)$/.exec(line);
      if (m && !map.has(m[1])) map.set(m[1], m[2]);
      continue;
    }
    for (let c = 0; c + 1 < cells.length; c += 2) {
      const key = cells[c].trim();
      if (key && !map.has(key)) map.set(key, cells[c + 1].trim());
    }
  }
  return map;
}

/** 「45.59m2 (約13.79坪)」→ [45.59, 13.79] */
function readArea(s: string | undefined): [number | null, number | null] {
  if (!s) return [null, null];
  const sqm = /([\d.,]+)\s*m2/.exec(s);
  const tsubo = /約\s*([\d.,]+)\s*坪/.exec(s);
  return [num(sqm?.[1]), num(tsubo?.[1])];
}

/**
 * 所在地を町丁目までにする(番地は捨てる)。漢数字の番地(「四丁目二十六番八号」)も
 * 既存の coarsePropertyLocation(DM の文面で使う「番地を出さない」判定)に任せる(@codex #690)。
 */
export function trimToChome(address: string | null): string | null {
  if (!address) return null;
  // ⚠空白は消さない: 空白の後の建物名を落とす判定に使われる(@codex #690 R2)
  const out = coarsePropertyLocation(address.trim());
  if (!out) return null;
  // 番地だけ(先頭が数字)のときは町名が無い=返さない
  return /^[0-9０-９]/.test(out) ? null : out;
}

const PLAN_WORDS: Array<[AppraisalPlanName, RegExp]> = [
  ["speed", /^スピード/],
  ["standard", /^スタンダード/],
  ["challenge", /^チャレンジ/],
];

/** 「1,080 万円」の価格(坪単価「259.7万円/坪」は除く)。 */
const PRICE_RE = /(?<![\d.])(\d{1,3}(?:,\d{3})+|\d+)\s*万円(?!\s*\/\s*坪)/;
const TSUBO_RE = /([\d.]+)\s*万円\s*\/\s*坪/;

function emptyValue(): AppraisalValue {
  return { total: null, tsubo: null, land: null, landTsubo: null, building: null, buildingTsubo: null };
}

/** 「成約想定価格 \t 1,304 万円 土地 1,214 万円 ( 88万円/坪 )」の1行目と、続く「建物 …」の行。 */
function readValue(line: string, next: string | undefined, label: string): AppraisalValue {
  const v = emptyValue();
  const body = line.slice(line.indexOf(label) + label.length);
  const landAt = body.search(/土地\s*[\d,]+\s*万円/);
  const head = landAt >= 0 ? body.slice(0, landAt) : body;
  v.total = num(PRICE_RE.exec(head)?.[1]);
  if (landAt >= 0) {
    const land = /土地\s*([\d,]+)\s*万円(?:\s*\(\s*([\d.]+)\s*万円\s*\/\s*坪)?/.exec(body.slice(landAt));
    v.land = num(land?.[1]);
    v.landTsubo = num(land?.[2]);
  } else {
    v.tsubo = num(TSUBO_RE.exec(head)?.[1]);
  }
  if (next && /^建物\s*[\d,]+\s*万円/.test(next)) {
    const b = /^建物\s*([\d,]+)\s*万円(?:\s*\(\s*([\d.]+)\s*万円\s*\/\s*坪)?/.exec(next);
    v.building = num(b?.[1]);
    v.buildingTsubo = num(b?.[2]);
  }
  return v;
}

export function parseAppraisalReport(text: string): AppraisalExtract {
  const lines = toLines(text);
  const isSre = lines.some((l) => l.includes("不動産価格査定報告書"));
  const d = readDetails(lines);

  const [landSqm, landTsubo] = readArea(d.get("土地面積"));
  const [floorSqm] = readArea(d.get("延床面積"));
  const [exclusiveSqm] = readArea(d.get("専有面積"));
  const kind: AppraisalPropertyKind | null =
    exclusiveSqm != null ? "mansion" : floorSqm != null ? "house" : landSqm != null ? "land" : null;

  const access = d.get("交通") ?? "";
  const st = /^(.*?)「(.+?)」\s*徒歩\s*(\d+)\s*分/.exec(access);
  const built = /(\d{4})年(\d{1,2})月/.exec(d.get("建築年月") ?? "");

  // 査定日(査定結果の見出しの行)
  let appraisedOn: string | null = null;
  const dateLine = lines.find((l) => /^査定結果\s+査定日[:：]/.test(l));
  const dm = dateLine ? /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(dateLine) : null;
  if (dm) appraisedOn = `${dm[1]}-${dm[2].padStart(2, "0")}-${dm[3].padStart(2, "0")}`;

  // 成約想定価格・AI査定価格(査定結果の数字の行。マーケットデータ等に同じ語は出ない)
  let expected = emptyValue();
  let ai = emptyValue();
  const iExp = lines.findIndex((l) => /^成約想定価格\s+[\d,]+\s*万円/.test(l));
  const iAi = lines.findIndex((l) => /^AI査定価格\s+[\d,]+\s*万円/.test(l));
  if (iExp >= 0) expected = readValue(lines[iExp], lines[iExp + 1], "成約想定価格");
  if (iAi >= 0) ai = readValue(lines[iAi], lines[iAi + 1], "AI査定価格");

  // 売出しの3案 または 価格の幅(査定日の行 〜 成約想定価格の行)
  const plans: AppraisalPlan[] = [];
  let range: AppraisalPriceRange | null = null;
  const iDate = dateLine ? lines.indexOf(dateLine) : -1;
  if (iDate >= 0 && iExp > iDate) {
    const block = lines.slice(iDate + 1, iExp);
    let cur: AppraisalPlanName | null = null;
    const loose: Array<{ price: number; tsubo: number | null }> = [];
    const looseTsubo: number[] = [];
    for (const line of block) {
      // コメント欄の金額(「査定価格1400万円前後」など)は3案・価格の幅に入れない(@codex #690)。
      if (/^コメント/.test(line)) break;
      const word = PLAN_WORDS.find(([, re]) => re.test(line));
      if (word) cur = word[0];
      const price = num(PRICE_RE.exec(line)?.[1]);
      const tsubo = num(TSUBO_RE.exec(line)?.[1]);
      if (price != null) {
        if (cur && !plans.some((p) => p.name === cur)) plans.push({ name: cur, price, tsubo });
        else if (!cur) loose.push({ price, tsubo });
      } else if (tsubo != null && !cur) {
        looseTsubo.push(tsubo);
      }
    }
    // 価格の幅は「下限・上限」の2つだけのとき(3つ以上あれば何を表すか分からない=読まない)。
    if (plans.length === 0 && loose.length === 2) {
      const a = loose[0];
      const b = loose[loose.length - 1];
      const [lo, hi] = a.price <= b.price ? [a, b] : [b, a];
      const ts = looseTsubo.length >= 2 ? [...looseTsubo].sort((x, y) => x - y) : null;
      range = {
        min: lo.price,
        max: hi.price,
        minTsubo: lo.tsubo ?? ts?.[0] ?? null,
        maxTsubo: hi.tsubo ?? ts?.[ts.length - 1] ?? null,
      };
    }
  }

  // 補正(査定結果の「土地評価 査定額の …」「流通性比率 …」)
  const adjustment: AppraisalAdjustment = {
    landPercent: null,
    landAmount: null,
    landReason: null,
    liquidityPercent: null,
    items: [],
  };
  const iLand = lines.findIndex((l) => /^土地評価\s*査定額の/.test(l));
  if (iLand >= 0) {
    const m = /査定額の\s*([+\-−±]?\s*[\d,]+)\s*(%|万円)/.exec(lines[iLand]);
    if (m) {
      const v = num(m[1].replace(/\s/g, ""));
      if (m[2] === "%") adjustment.landPercent = v;
      else adjustment.landAmount = v;
    }
    const r = /^[(（](.+)[)）]$/.exec(lines[iLand + 1] ?? "");
    if (r) adjustment.landReason = r[1].trim();
  }
  const liq = lines.find((l) => /^流通性比率\s+査定額/.test(l));
  const lm = liq ? /物件評価価格の\s*([+\-−±]?\s*\d+(?:\.\d+)?)\s*%/.exec(liq) : null;
  if (lm) adjustment.liquidityPercent = num(lm[1].replace(/\s/g, ""));

  // 評価の表(土地の報告書)「土地 \t 土地形状 \t -1 \t -100万円 \t 備考」
  const iTable = lines.findIndex((l) => /^カテゴリ\t内容\t評価\t調整金額/.test(l));
  if (iTable >= 0) {
    for (let i = iTable + 1; i < lines.length; i++) {
      const c = lines[i].split("\t");
      if (c.length < 4) break;
      const score = num(c[2]);
      const amount = num(/([+\-−±]?[\d,]+)\s*万円/.exec(c[3])?.[1]);
      if (score == null && amount == null) break;
      adjustment.items.push({ category: c[0], label: c[1], score, amount });
    }
  }
  // 総合評価の表(戸建)「土地 \t -70 \t 接道状況/方位」
  const iTotal = lines.findIndex((l) => /^種別\t合計\t入力項目/.test(l));
  if (iTotal >= 0) {
    for (let i = iTotal + 1; i < lines.length; i++) {
      const c = lines[i].split("\t");
      if (c.length < 2 || !/^(土地|建物)$/.test(c[0])) break;
      const score = num(c[1]);
      if (score == null || score === 0) continue;
      adjustment.items.push({ category: c[0], label: c[2] ?? "", score, amount: null });
    }
  }

  const warnings: AppraisalWarning[] = [];
  if (!isSre) warnings.push("not_sre");
  if (kind == null) warnings.push("unknown_kind");
  if (expected.total == null) warnings.push("missing_expected");
  if (ai.total == null) warnings.push("missing_ai");
  if (plans.length === 0 && range == null) warnings.push("missing_plans");
  const price = (n: AppraisalPlanName) => plans.find((p) => p.name === n)?.price;
  const sp = price("speed");
  const sd = price("standard");
  const ch = price("challenge");
  if ((sp != null && sd != null && sd < sp) || (sd != null && ch != null && ch < sd) || (sp != null && ch != null && ch < sp)) {
    warnings.push("plan_order");
  }

  return {
    parserVersion: APPRAISAL_PARSER_VERSION,
    source: isSre ? "sre" : "unknown",
    kind,
    appraisedOn,
    area: trimToChome(textOrNull(d.get("所有地"))),
    railLine: st ? textOrNull(st[1]) : null,
    station: st ? `${st[2]}` : null,
    walkMinutes: st ? Number(st[3]) : null,
    landSqm,
    landTsubo,
    floorSqm,
    exclusiveSqm,
    builtYearMonth: built ? `${built[1]}-${built[2].padStart(2, "0")}` : null,
    structure: textOrNull(d.get("構造")),
    layout: textOrNull(d.get("間取り")),
    floorInfo: textOrNull(d.get("所在階")),
    roadAccess: textOrNull(d.get("接道状況")),
    roadDetail: textOrNull(d.get("接道")),
    notes: textOrNull(d.get("特記事項")),
    expected,
    ai,
    adjustment,
    plans,
    range,
    warnings,
  };
}
