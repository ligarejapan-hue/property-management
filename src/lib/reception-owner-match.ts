/**
 * 受付帳CSV × 所有者CSV × 既存物件 の突合ヘルパ（ピュア）。
 *
 * - 受付帳: H/I/J/K/F は位置指定（0-indexed: H=7, I=8, J=9, K=10, F=5）
 * - 所有者: C列=index2 が突合キー。氏名/住所/建物名/部屋番号はヘッダ名で検出
 * - DB 依存なし。上流 API ルートから既存Property一覧を渡して突合する
 */
import {
  buildReceptionMatchKey,
  buildOwnerMatchKey,
  normalizeReceptionKeyPart,
  splitReceptionK,
} from "./import-file-type";

// ---------- 型 ----------

export interface ParsedReceptionRow {
  rowNumber: number;
  matchKey: string;
  fColumn: string;
  kColumn: string;
  lotNumber: string | null;
  buildingNumber: string | null;
  /** B列(=index 1) の DL マーク。〇 / ○ / 前後空白付き 〇 / 前後空白付き ○ を検出 */
  dlMarked: boolean;
  /** E列(=index 4) の新既値（"新規" / "既存" / "" / その他） */
  shinkiValue: string;
  /** L列(=index 11) の「他」値。共有名義人の有無を示す補助情報 */
  coOwnersNote: string;
  /** H+I+J の連結（都道府県+区+住所）。Property.address 候補。すべて空の場合は null */
  propertyAddress: string | null;
  /**
   * 明らかな非データ行は突合/レビューの対象から外す。
   * - "empty": F/H/I/J/K（物件関連列）が全て空
   * - "header_repeat": 受付帳ヘッダの反復
   * - "aggregate": 合計/小計/総計/件数/total 等の集計行
   * - "filter_dl": 取込物件選択（DL）の条件で除外
   * - "filter_shinki": 新既条件で除外
   * undefined のときは通常のデータ行として扱う。
   */
  excluded?: ExcludedReason;
}

export type ExcludedReason =
  | "empty"
  | "header_repeat"
  | "aggregate"
  | "co_collateral"
  | "filter_dl"
  | "filter_shinki";

// ---------- 取込条件フィルタ ----------

export type DlFilterMode = "marked" | "unmarked" | "all";
export type ShinkiFilterMode = "existing" | "new" | "all";

export interface ReceptionFilterOptions {
  dl: DlFilterMode;
  shinki: ShinkiFilterMode;
}

/** 既定値: DLに〇がついている物件のみ × 既存のみ */
export const DEFAULT_RECEPTION_FILTER_OPTIONS: ReceptionFilterOptions = {
  dl: "marked",
  shinki: "existing",
};

/** B列(DL)の値が「〇あり」と判定されるか。〇/○ + 前後空白を許容 */
export function isReceptionDlMarked(value: string | null | undefined): boolean {
  if (value == null) return false;
  const t = String(value).trim();
  return t === "〇" || t === "○";
}

/** E列(新既)の正規化値を返す。空白除去のみで値はそのまま */
function normalizeShinki(value: string | null | undefined): string {
  if (value == null) return "";
  return String(value).trim();
}

/**
 * 受付帳の新既値を分類する。
 * 実データには `既` / `新` の1文字表記と、`既存` / `新規` の表記が混在する。
 * 前後空白は trim で吸収し、いずれの表記も同じ意味として扱う。
 *
 * - existing: 既 / 既存
 * - new:      新 / 新規
 * - unknown:  null / undefined / 空 / 上記以外（曖昧寄せはしない）
 */
export function classifyShinki(
  value: string | null | undefined,
): "existing" | "new" | "unknown" {
  const t = normalizeShinki(value);
  if (t === "既" || t === "既存") return "existing";
  if (t === "新" || t === "新規") return "new";
  return "unknown";
}

export interface ParsedOwnerRow {
  rowNumber: number;
  /**
   * 受付帳CSVの「物件住所」と突合する正規化キー。
   * 優先順:
   *   1. ヘッダ「物件住所」列の値
   *   2. なければ C列(=index 2) を後方互換のフォールバックとして使う
   */
  matchKey: string;
  /** 後方互換: C列(=index 2) の生値。matchKey の派生元として残す */
  cColumn: string;
  /** ヘッダ「物件住所」列の値（なければ null） */
  propertyAddress: string | null;
  name: string | null;
  /**
   * 表示用の所有者住所。
   * 都道府県 + 所有者市区郡 + 所有者住所(町名番地) + 建物名 を連結。
   * 〒 / 物件住所 は混ぜない。連結時に区切り文字は入れず、空欄は空文字扱い。
   */
  address: string | null;
  prefecture: string | null;
  city: string | null;
  streetAddress: string | null;
  buildingName: string | null;
  roomNo: string | null;
  zip: string | null;
  /** ヘッダ「DM」列の生値。DM対象フラグの判定材料として保持（Property.dmStatus は自動更新しない） */
  dm: string | null;
}

export interface PropertyCandidate {
  id: string;
  address: string;
  lotNumber: string | null;
  buildingNumber: string | null;
  buildingName: string | null;
  roomNo: string | null;
}

export type PropertyMatchStatus = "matched" | "not_found" | "multiple" | "no_key";

export interface PropertyMatchOutcome {
  status: PropertyMatchStatus;
  property?: PropertyCandidate;
  candidates?: PropertyCandidate[];
}

export interface CombinedMatch {
  reception: ParsedReceptionRow;
  owners: ParsedOwnerRow[];
  propertyMatch: PropertyMatchOutcome;
}

// ---------- 受付帳 ----------

/**
 * 受付帳の行配列（positional string[]）から ParsedReceptionRow[] を作る。
 * rows[i] は index=0 の A列から始まる。
 *
 * 明らかな非データ行（物件列が全て空 / ヘッダ反復 / 集計キーワード）は
 * `excluded` フラグを立てる。突合/レビュー側で対象外扱いする。
 */
export function parseReceptionRows(rows: string[][]): ParsedReceptionRow[] {
  return rows.map((row, i) => {
    const dlRaw = row[1] ?? "";
    const shinkiRaw = row[4] ?? "";
    const f = (row[5] ?? "").trim();
    const h = (row[7] ?? "").trim();
    const iCol = (row[8] ?? "").trim();
    const j = (row[9] ?? "").trim();
    const k = (row[10] ?? "").trim();
    const otherRaw = (row[11] ?? "").trim();
    const matchKey = buildReceptionMatchKey({ h, i: iCol, j, k });
    const { lotNumber, buildingNumber } = splitReceptionK(f, k);
    const addrParts = [h, iCol, j].filter((v) => v !== "");
    return {
      rowNumber: i + 2,
      matchKey,
      fColumn: f,
      kColumn: k,
      lotNumber,
      buildingNumber,
      propertyAddress: addrParts.length > 0 ? addrParts.join("") : null,
      dlMarked: isReceptionDlMarked(dlRaw),
      shinkiValue: normalizeShinki(shinkiRaw),
      coOwnersNote: otherRaw,
      excluded: detectExcludedReason(row, { f, h, iCol, j, k }),
    };
  });
}

/**
 * 受付帳行に対し、DL/新既のフィルタ条件を適用して `excluded` を再設定して返す。
 * - 既存の excluded（empty/header_repeat/aggregate/co_collateral）は最優先で残す
 * - フィルタにマッチしない行は filter_dl / filter_shinki として excluded に立てる
 *   （DL を先に評価して、両方該当する場合は filter_dl が記録される）
 * - 受付帳パース→フィルタ適用→buildCombinedMatches の順で呼ぶことで、
 *   プレビューと取込実行で対象が必ず一致する。
 */
export function applyReceptionFilters(
  rows: readonly ParsedReceptionRow[],
  options: ReceptionFilterOptions,
): ParsedReceptionRow[] {
  return rows.map((r) => {
    if (r.excluded) return r;
    if (options.dl === "marked" && !r.dlMarked) {
      return { ...r, excluded: "filter_dl" as const };
    }
    if (options.dl === "unmarked" && r.dlMarked) {
      return { ...r, excluded: "filter_dl" as const };
    }
    if (options.shinki !== "all") {
      if (classifyShinki(r.shinkiValue) !== options.shinki) {
        return { ...r, excluded: "filter_shinki" as const };
      }
    }
    return r;
  });
}

/**
 * 受付帳1行を「明らかな非データ行」として除外すべきか判定する。
 *
 * 安全側運用のため、除外ルールは限定的・明示的に定義する：
 *  - empty: F/H/I/J/K（区分 + 都道府県/区/住所/番地）が全て空
 *    → 物件識別子が一切無く、突合キーも作れないため本来の取込対象外。
 *  - header_repeat: H列=「都道府県」「都道府県名」かつ I列=「区」「市区町村」
 *    → 受付帳ヘッダの反復（シート内に再掲されるケース）。
 *  - aggregate: 先頭14列のどこかに「合計/小計/総計/件数/total」等が単独値として入る
 *    → 集計/小計行。
 *
 * これ以外のノイズ（masked 行・共同担保通知等）は人判断が必要なので
 * 勝手に除外しない。
 */
function detectExcludedReason(
  row: readonly string[],
  p: { f: string; h: string; iCol: string; j: string; k: string },
): ExcludedReason | undefined {
  // header_repeat: 都道府県/区 列にヘッダ文字列が再出現
  if ((p.h === "都道府県" || p.h === "都道府県名") &&
      (p.iCol === "区" || p.iCol === "市区町村")) {
    return "header_repeat";
  }
  // aggregate: 先頭14列に集計キーワードが単独値で出現
  // （empty 判定より先に評価する：「合計」のみ入った小計行を empty と誤認しないため）
  const AGG_RE = /^(合計|小計|総計|件数|total)$/i;
  const upper = Math.min(row.length, 14);
  for (let idx = 0; idx < upper; idx++) {
    const v = (row[idx] ?? "").trim();
    if (v && AGG_RE.test(v)) return "aggregate";
  }
  // co_collateral: F列="共担"（共同担保の付随行、地番/家屋番号を持たない）
  // empty より先に評価する：共担行は H/I/J/K が空なので empty と被るため
  if (p.f === "共担") return "co_collateral";
  // empty: 物件関連列（F/H/I/J/K）がすべて空
  if (!p.f && !p.h && !p.iCol && !p.j && !p.k) return "empty";
  return undefined;
}

// ---------- 所有者 ----------

/**
 * 所有者CSV ヘッダ名 → 論理フィールド のマップ（固定）。
 * 既存 owner-csv ルートと揃える。
 */
type OwnerField =
  | "name"
  | "propertyAddress"
  | "prefecture"
  | "city"
  | "streetAddress"
  | "buildingName"
  | "roomNo"
  | "zip"
  | "dm";

/**
 * 所有者CSV ヘッダ名 → 論理フィールドのマップ（固定）。
 *
 * - 「物件住所」: 受付帳CSVと突合する紐づけキー（最優先）
 * - 「都道府県」/「所有者市区郡」/「所有者住所」/「建物名」: 連結して所有者住所(表示用)を組み立てる
 * - 「〒」/「郵便番号」: 所有者郵便番号
 * - 「No」: 取り込まない（紐づけキーにも使わない） → このマップに含めない
 *
 * 「住所」(無印) は後方互換のため streetAddress として扱う（旧CSVが該当列を持つケース）。
 */
const OWNER_HEADER_TO_FIELD: Record<string, OwnerField> = {
  "氏名": "name",
  "所有者氏名": "name",
  "所有者名": "name",
  "物件住所": "propertyAddress",
  "都道府県": "prefecture",
  "所有者市区郡": "city",
  "所有者住所": "streetAddress",
  "住所": "streetAddress",
  "建物名": "buildingName",
  "マンション名": "buildingName",
  "部屋番号": "roomNo",
  "号室": "roomNo",
  "郵便番号": "zip",
  "〒": "zip",
  "DM": "dm",
};

/**
 * 所有者CSVの positional rows からパース。headers はヘッダ行の配列。
 * C列は index=2 を固定キーとする（ヘッダ名に関係なく位置で拾う）。
 */
export function parseOwnerRows(
  headers: string[],
  rows: string[][],
): ParsedOwnerRow[] {
  // header → column index 逆引き
  const headerIndex: Partial<Record<OwnerField, number>> = {};
  headers.forEach((h, idx) => {
    const key = OWNER_HEADER_TO_FIELD[h.trim()];
    if (key && headerIndex[key] === undefined) {
      headerIndex[key] = idx;
    }
  });

  return rows.map((row, i) => {
    const cColumn = row[2] ?? "";
    const pick = (k: OwnerField) => {
      const idx = headerIndex[k];
      if (idx === undefined) return null;
      const v = (row[idx] ?? "").trim();
      return v || null;
    };

    // 紐づけキー: 「物件住所」ヘッダがあればそれを優先。無ければ C列の生値で後方互換。
    const propertyAddress = pick("propertyAddress");
    const matchSource = propertyAddress ?? cColumn;

    const prefecture = pick("prefecture");
    const city = pick("city");
    const streetAddress = pick("streetAddress");
    const buildingName = pick("buildingName");
    // 表示用の所有者住所を組み立て: 区切りなし連結、空欄は空文字扱い
    const combinedParts = [prefecture, city, streetAddress, buildingName]
      .map((v) => (v ?? "").trim())
      .filter((v) => v !== "");
    const combinedAddress = combinedParts.length > 0 ? combinedParts.join("") : null;

    return {
      rowNumber: i + 2,
      matchKey: buildOwnerMatchKey(matchSource),
      cColumn,
      propertyAddress,
      name: pick("name"),
      address: combinedAddress,
      prefecture,
      city,
      streetAddress,
      buildingName,
      roomNo: pick("roomNo"),
      zip: pick("zip"),
      dm: pick("dm"),
    };
  });
}

// ---------- 突合 ----------

/**
 * 受付帳1行に対し、所有者CSVから同じキーの全行を集める。
 * 空キーの行は常に0件扱い。
 */
export function matchReceptionToOwners(
  reception: readonly ParsedReceptionRow[],
  owners: readonly ParsedOwnerRow[],
): Map<number, ParsedOwnerRow[]> {
  const byKey = new Map<string, ParsedOwnerRow[]>();
  for (const o of owners) {
    if (!o.matchKey) continue;
    const arr = byKey.get(o.matchKey) ?? [];
    arr.push(o);
    byKey.set(o.matchKey, arr);
  }
  const result = new Map<number, ParsedOwnerRow[]>();
  for (const r of reception) {
    if (!r.matchKey) {
      result.set(r.rowNumber, []);
      continue;
    }
    result.set(r.rowNumber, byKey.get(r.matchKey) ?? []);
  }
  return result;
}

/**
 * 受付帳1行に対して、lotNumber/buildingNumber ベースで物件候補を探す。
 * 比較は normalizeReceptionKeyPart による正規化一致。
 */
export function matchPropertyByReception(
  reception: ParsedReceptionRow,
  properties: readonly PropertyCandidate[],
): PropertyMatchOutcome {
  const hits: PropertyCandidate[] = [];
  const target = reception.lotNumber
    ? { field: "lotNumber" as const, value: normalizeReceptionKeyPart(reception.lotNumber) }
    : reception.buildingNumber
      ? { field: "buildingNumber" as const, value: normalizeReceptionKeyPart(reception.buildingNumber) }
      : null;

  if (!target || !target.value) {
    return { status: "no_key" };
  }

  for (const p of properties) {
    const v = normalizeReceptionKeyPart(
      target.field === "lotNumber" ? p.lotNumber : p.buildingNumber,
    );
    if (v && v === target.value) hits.push(p);
  }
  if (hits.length === 0) return { status: "not_found" };
  if (hits.length === 1) return { status: "matched", property: hits[0] };
  return { status: "multiple", candidates: hits };
}

// ---------- サマリ集計 ----------

export interface MatchSummary {
  receptionCount: number;
  ownerCount: number;
  ownerMatchedCount: number;    // 所有者が1件以上ヒットした受付帳行数
  ownerUnmatchedCount: number;  // 所有者0件
  propertyMatchedCount: number; // 物件が一意に特定できた受付帳行数
  propertyNotFoundCount: number;
  propertyMultipleCount: number;
  propertyNoKeyCount: number;
  /** 非データ行 + フィルタ除外の合計 */
  excludedCount: number;
  excludedEmptyCount: number;
  excludedHeaderRepeatCount: number;
  excludedAggregateCount: number;
  excludedCoCollateralCount: number;
  /** 取込物件選択（DL）条件で除外された行数 */
  filteredByDlCount: number;
  /** 新既条件で除外された行数 */
  filteredByShinkiCount: number;
}

export function summarizeMatches(
  reception: readonly ParsedReceptionRow[],
  ownersCount: number,
  combined: readonly CombinedMatch[],
): MatchSummary {
  let ownerMatched = 0;
  let ownerUnmatched = 0;
  let propMatched = 0;
  let propNotFound = 0;
  let propMultiple = 0;
  let propNoKey = 0;
  for (const c of combined) {
    if (c.owners.length > 0) ownerMatched++;
    else ownerUnmatched++;
    switch (c.propertyMatch.status) {
      case "matched":
        propMatched++;
        break;
      case "not_found":
        propNotFound++;
        break;
      case "multiple":
        propMultiple++;
        break;
      case "no_key":
        propNoKey++;
        break;
    }
  }
  let excEmpty = 0;
  let excHeader = 0;
  let excAgg = 0;
  let excCo = 0;
  let excDl = 0;
  let excShinki = 0;
  for (const r of reception) {
    if (r.excluded === "empty") excEmpty++;
    else if (r.excluded === "header_repeat") excHeader++;
    else if (r.excluded === "aggregate") excAgg++;
    else if (r.excluded === "co_collateral") excCo++;
    else if (r.excluded === "filter_dl") excDl++;
    else if (r.excluded === "filter_shinki") excShinki++;
  }
  return {
    receptionCount: reception.length,
    ownerCount: ownersCount,
    ownerMatchedCount: ownerMatched,
    ownerUnmatchedCount: ownerUnmatched,
    propertyMatchedCount: propMatched,
    propertyNotFoundCount: propNotFound,
    propertyMultipleCount: propMultiple,
    propertyNoKeyCount: propNoKey,
    excludedCount: excEmpty + excHeader + excAgg + excCo + excDl + excShinki,
    excludedEmptyCount: excEmpty,
    excludedHeaderRepeatCount: excHeader,
    excludedAggregateCount: excAgg,
    excludedCoCollateralCount: excCo,
    filteredByDlCount: excDl,
    filteredByShinkiCount: excShinki,
  };
}

/**
 * 受付帳 + 所有者 + 既存物件 を束ねた CombinedMatch[] を作る。
 * 順序は reception の行順を保持する。
 */
export function buildCombinedMatches(
  reception: readonly ParsedReceptionRow[],
  owners: readonly ParsedOwnerRow[],
  properties: readonly PropertyCandidate[],
): CombinedMatch[] {
  // 除外行は突合・レビュー対象から外す（受付帳の excludedCount は summary に別集計）
  const active = reception.filter((r) => !r.excluded);
  const ownerMap = matchReceptionToOwners(active, owners);
  return active.map((r) => ({
    reception: r,
    owners: ownerMap.get(r.rowNumber) ?? [],
    propertyMatch: matchPropertyByReception(r, properties),
  }));
}

// ---------- Review 理由 ----------

export type ReviewReason =
  | "owner_unmatched"    // 所有者未突合
  | "property_not_found" // 物件未特定
  | "property_multiple"  // 複数候補
  | "property_no_key";   // 受付帳側に地番/家屋番号なし

export function getReviewReason(m: CombinedMatch): ReviewReason | null {
  if (m.owners.length === 0) return "owner_unmatched";
  if (m.propertyMatch.status === "not_found") return "property_not_found";
  if (m.propertyMatch.status === "multiple") return "property_multiple";
  if (m.propertyMatch.status === "no_key") return "property_no_key";
  return null;
}

export const REVIEW_REASON_LABEL: Record<ReviewReason, string> = {
  owner_unmatched: "要レビュー（所有者未突合）",
  property_not_found: "要レビュー（物件未特定）",
  property_multiple: "要レビュー（複数候補）",
  property_no_key: "要レビュー（キー不足）",
};
