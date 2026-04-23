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
}

export interface ParsedOwnerRow {
  rowNumber: number;
  matchKey: string;
  cColumn: string;
  name: string | null;
  address: string | null;
  buildingName: string | null;
  roomNo: string | null;
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
 */
export function parseReceptionRows(rows: string[][]): ParsedReceptionRow[] {
  return rows.map((row, i) => {
    const f = row[5] ?? "";
    const h = row[7] ?? "";
    const iCol = row[8] ?? "";
    const j = row[9] ?? "";
    const k = row[10] ?? "";
    const matchKey = buildReceptionMatchKey({ h, i: iCol, j, k });
    const { lotNumber, buildingNumber } = splitReceptionK(f, k);
    return {
      rowNumber: i + 2,
      matchKey,
      fColumn: f,
      kColumn: k,
      lotNumber,
      buildingNumber,
    };
  });
}

// ---------- 所有者 ----------

/**
 * 所有者CSV ヘッダ名 → 論理フィールド のマップ（固定）。
 * 既存 owner-csv ルートと揃える。
 */
const OWNER_HEADER_TO_FIELD: Record<string, "name" | "address" | "buildingName" | "roomNo"> = {
  "氏名": "name",
  "所有者氏名": "name",
  "住所": "address",
  "所有者住所": "address",
  "建物名": "buildingName",
  "マンション名": "buildingName",
  "部屋番号": "roomNo",
  "号室": "roomNo",
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
  const headerIndex: Partial<Record<"name" | "address" | "buildingName" | "roomNo", number>> = {};
  headers.forEach((h, idx) => {
    const key = OWNER_HEADER_TO_FIELD[h.trim()];
    if (key && headerIndex[key] === undefined) {
      headerIndex[key] = idx;
    }
  });

  return rows.map((row, i) => {
    const cColumn = row[2] ?? "";
    const pick = (k: "name" | "address" | "buildingName" | "roomNo") => {
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
  return {
    receptionCount: reception.length,
    ownerCount: ownersCount,
    ownerMatchedCount: ownerMatched,
    ownerUnmatchedCount: ownerUnmatched,
    propertyMatchedCount: propMatched,
    propertyNotFoundCount: propNotFound,
    propertyMultipleCount: propMultiple,
    propertyNoKeyCount: propNoKey,
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
  const ownerMap = matchReceptionToOwners(reception, owners);
  return reception.map((r) => ({
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
