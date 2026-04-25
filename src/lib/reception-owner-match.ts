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
  /**
   * 明らかな非データ行は突合/レビューの対象から外す。
   * - "empty": F/H/I/J/K（物件関連列）が全て空
   * - "header_repeat": 受付帳ヘッダの反復
   * - "aggregate": 合計/小計/総計/件数/total 等の集計行
   * undefined のときは通常のデータ行として扱う。
   */
  excluded?: ExcludedReason;
}

export type ExcludedReason =
  | "empty"
  | "header_repeat"
  | "aggregate"
  | "co_collateral";

export interface ParsedOwnerRow {
  rowNumber: number;
  matchKey: string;
  cColumn: string;
  name: string | null;
  address: string | null;
  buildingName: string | null;
  roomNo: string | null;
  zip: string | null;
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
    const f = (row[5] ?? "").trim();
    const h = (row[7] ?? "").trim();
    const iCol = (row[8] ?? "").trim();
    const j = (row[9] ?? "").trim();
    const k = (row[10] ?? "").trim();
    const matchKey = buildReceptionMatchKey({ h, i: iCol, j, k });
    const { lotNumber, buildingNumber } = splitReceptionK(f, k);
    return {
      rowNumber: i + 2,
      matchKey,
      fColumn: f,
      kColumn: k,
      lotNumber,
      buildingNumber,
      excluded: detectExcludedReason(row, { f, h, iCol, j, k }),
    };
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
type OwnerField = "name" | "address" | "buildingName" | "roomNo" | "zip";

const OWNER_HEADER_TO_FIELD: Record<string, OwnerField> = {
  "氏名": "name",
  "所有者氏名": "name",
  "住所": "address",
  "所有者住所": "address",
  "建物名": "buildingName",
  "マンション名": "buildingName",
  "部屋番号": "roomNo",
  "号室": "roomNo",
  "郵便番号": "zip",
  "〒": "zip",
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
    return {
      rowNumber: i + 2,
      matchKey: buildOwnerMatchKey(cColumn),
      cColumn,
      name: pick("name"),
      address: pick("address"),
      buildingName: pick("buildingName"),
      roomNo: pick("roomNo"),
      zip: pick("zip"),
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
  /** 非データ行として除外した合計（empty+header_repeat+aggregate） */
  excludedCount: number;
  excludedEmptyCount: number;
  excludedHeaderRepeatCount: number;
  excludedAggregateCount: number;
  excludedCoCollateralCount: number;
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
  for (const r of reception) {
    if (r.excluded === "empty") excEmpty++;
    else if (r.excluded === "header_repeat") excHeader++;
    else if (r.excluded === "aggregate") excAgg++;
    else if (r.excluded === "co_collateral") excCo++;
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
    excludedCount: excEmpty + excHeader + excAgg + excCo,
    excludedEmptyCount: excEmpty,
    excludedHeaderRepeatCount: excHeader,
    excludedAggregateCount: excAgg,
    excludedCoCollateralCount: excCo,
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
