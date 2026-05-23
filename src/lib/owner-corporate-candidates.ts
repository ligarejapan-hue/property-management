// Phase E: 既存 Owner から法人番号混入候補を dry-run で検出するヘルパー（純関数）。
//
// 設計上の不変条件:
// - DB アクセス・I/O は行わない（呼び出し側で findMany 済の Owner を渡す）
// - 法人番号生値・会社名・住所・候補リストを返却型に直接含めず、必ず display-level
//   に従ったマスキングを通す
// - 「種別」は decideCorporateImport の action から導出（PR #34 で導入された分類を再利用）
// - candidate 0 件（none）は呼び出し側で除外する（戻り値 null）

import {
  decideCorporateImport,
  type CorporateImportDecision,
} from "./owner-corporate-import";
import { detectCorporateNumberInOwnerLike } from "./corporate-number";
import { maskCorporateNumber } from "./display-level";
import { maskValue } from "./permissions";

/** Phase E 用 candidate 種別。decideCorporateImport の action から派生。 */
export type CorporateCandidateType = "missing" | "same" | "conflict" | "multi";

/** Phase E API レスポンス 1 件分の最小形（PII フリーまたはマスク済）。 */
export interface CorporateCandidateRow {
  ownerId: string;
  /** owner_name の display-level に従ったマスク済名（hidden の場合 null） */
  ownerNameMasked: string | null;
  /** owner_address の display-level に従ったマスク済住所（hidden の場合 null） */
  ownerAddressMasked: string | null;
  /**
   * owner_corporate_number の display-level に従ってマスクした既存法人番号。
   * 事前確定方針 (Phase E):
   * - full → 生値
   * - edit / read / masked / partial → maskCorporateNumber（先頭4桁＋***）
   * - hidden → null
   * - そもそも Owner.corporateNumber が null → null
   */
  existingCorporateNumberMasked: string | null;
  /** 検出候補 1 件の場合のみ非 null。display-level に従いマスク。multi では null。 */
  candidateCorporateNumberMasked: string | null;
  /** "none" は呼び出し側で除外済。0 = none / 1 / "many" の概念分類。 */
  candidateCount: 1 | "many";
  /** 検出されたフィールド名のみ（生値は返さない） */
  detectedIn: Array<"name" | "address" | "note">;
  /** 種別 */
  type: CorporateCandidateType;
  /** Owner.version（optimistic lock 用に UI から保持） */
  version: number;
  /** Owner 詳細遷移用の相対 URL */
  detailUrl: string;
}

/** classify 関数の入力（findMany で select 必須フィールドのみ） */
export interface OwnerForCandidate {
  id: string;
  name: string;
  address: string | null;
  note: string | null;
  corporateNumber: string | null;
  version: number;
}

/** display-level config の最小形（getOwnerDisplayConfig の戻りから必要列のみ） */
export interface CandidateDisplayConfig {
  name: "hidden" | "masked" | "partial" | "full" | "read" | "edit";
  address: "hidden" | "masked" | "partial" | "full" | "read" | "edit";
  corporateNumber: "hidden" | "masked" | "partial" | "full" | "read" | "edit";
  /**
   * owner_note の display-level。
   * Codex P1 対応:
   *   raw-visible (full / read / edit) のときだけ note を法人番号検出対象に含める。
   *   hidden / masked / partial のユーザーには note 由来の候補・detectedIn を一切返さない
   *   （field-level permission bypass 防止）。
   */
  note: "hidden" | "masked" | "partial" | "full" | "read" | "edit";
}

/**
 * owner_note を法人番号検出の入力に渡してよいかを判定する。
 * raw-visible = full / read / edit のみ true。
 */
function isNoteRawVisible(level: CandidateDisplayConfig["note"]): boolean {
  return level === "full" || level === "read" || level === "edit";
}

/**
 * 法人番号を display-level に応じてマスクする。事前確定方針 (Phase E):
 * - hidden → null（owner 不在の場合は呼び出し側で null を渡す）
 * - edit / read / masked / partial → maskCorporateNumber（先頭4桁＋***）
 * - full → 生値
 *
 * 注意: owner_corporate_number は他フィールド（name/address 等）と異なり、
 * edit / read であってもマスクする方針。full 権限のときだけ完全な 13桁を返す。
 */
function maskCorporateField(
  value: string | null,
  level: CandidateDisplayConfig["corporateNumber"],
): string | null {
  if (value == null) return null;
  switch (level) {
    case "hidden":
      return null;
    case "full":
      return value;
    case "edit":
    case "read":
    case "masked":
    case "partial":
    default:
      return maskCorporateNumber(value);
  }
}

/**
 * 1 Owner を分類して candidate 行を返す。
 * 該当なし（candidate 0 件）の場合は null を返す。
 */
export function classifyOwnerCorporateCandidate(
  owner: OwnerForCandidate,
  displayConfig: CandidateDisplayConfig,
): CorporateCandidateRow | null {
  // Codex P1 対応: owner_note が hidden / masked / partial のユーザーには
  // note を検出入力から除外する。これにより:
  //  - detectedIn に "note" が漏れない
  //  - hidden note のみに 13桁が含まれる Owner は候補化されない
  //  - hidden note 由来の競合・複数候補にもならない（multi/conflict 経由の bypass 防止）
  const noteForDetect = isNoteRawVisible(displayConfig.note) ? owner.note : null;

  // detect は内部で normalize 済み 13桁 dedup 配列を返す
  const detect = detectCorporateNumberInOwnerLike({
    name: owner.name,
    address: owner.address,
    note: noteForDetect,
  });

  // 0 件 → 候補なし。呼び出し側で除外できるよう null を返す。
  if (detect.candidates.length === 0) return null;

  // decideCorporateImport の action から Phase E 種別へ写像。
  // PR #34 helper の action を再利用するため挙動は単一の source of truth。
  // ここでも noteForDetect を渡し、note 権限がなければ note 由来の候補が出ないようにする。
  const decision: CorporateImportDecision = decideCorporateImport(
    { name: owner.name, address: owner.address, note: noteForDetect },
    owner.corporateNumber,
  );

  let type: CorporateCandidateType;
  let candidateCount: 1 | "many";
  let candidateRaw: string | null;
  switch (decision.action) {
    case "save":
      type = "missing";
      candidateCount = 1;
      candidateRaw = decision.corporateNumber;
      break;
    case "noop":
      type = "same";
      candidateCount = 1;
      candidateRaw = decision.corporateNumber;
      break;
    case "conflict":
      type = "conflict";
      candidateCount = 1;
      // conflict 時は detect.candidates[0] が「検出された候補」（既存値とは別）
      candidateRaw = detect.candidates[0] ?? null;
      break;
    case "multi":
      type = "multi";
      candidateCount = "many";
      // multi は単一候補を出さない（PII 防止と判断ノイズ回避）
      candidateRaw = null;
      break;
    default:
      return null;
  }

  // name / address は permissions.maskValue を使う（既存 correction-candidates と統一）。
  // 法人番号は maskCorporateNumber を使う（display-level.ts と統一）。
  return {
    ownerId: owner.id,
    ownerNameMasked: maskValue(owner.name, displayConfig.name),
    ownerAddressMasked: maskValue(owner.address, displayConfig.address),
    existingCorporateNumberMasked: maskCorporateField(
      owner.corporateNumber,
      displayConfig.corporateNumber,
    ),
    candidateCorporateNumberMasked: maskCorporateField(
      candidateRaw,
      displayConfig.corporateNumber,
    ),
    candidateCount,
    detectedIn: detect.detectedIn,
    type,
    version: owner.version,
    detailUrl: `/admin/owners/${owner.id}`,
  };
}

/** 集計対象の最小情報。type のみで足りる。 */
export interface CorporateCandidateSummary {
  missing: number;
  conflict: number;
  multi: number;
  same: number;
  totalCandidates: number;
}

export function emptyCorporateCandidateSummary(): CorporateCandidateSummary {
  return { missing: 0, conflict: 0, multi: 0, same: 0, totalCandidates: 0 };
}

export function tallyCorporateCandidate(
  summary: CorporateCandidateSummary,
  type: CorporateCandidateType,
): void {
  summary[type]++;
  summary.totalCandidates++;
}
