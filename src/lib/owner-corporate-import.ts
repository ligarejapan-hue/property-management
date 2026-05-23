// Phase D: 取込時に Owner.corporateNumber を「安全な場合のみ」保存するためのヘルパー群。
//
// 設計上の不変条件:
// - 候補が 1 件 + 13桁正規化 OK のときだけ保存対象とする（detect は既に正規化済の 13桁 dedup 配列を返す）
// - 既存 Owner.corporateNumber が null のときのみ updateMany で空欄埋め
//   （where 条件で corporateNumber: null を要求するため、レース時は count=0 で何もしない）
// - 既存と同一値 → noop（書込なし）
// - 既存と異なる値 → conflict（自動上書きしない）
// - 候補が複数 → multi（自動保存しない）
// - 戻り値・ログメッセージに法人番号生値・会社名・住所・候補リストを残さない
//   （AuditLog / ImportJobRow.errorMessage の PII ポリシーと整合）
//
// name/address からの法人番号除去（cleanup）は Phase D のスコープ外。

import { detectCorporateNumberInOwnerLike } from "./corporate-number";

export type CorporateImportAction =
  | "none" // 候補なし
  | "save" // 1 件で正規化 OK、新規 or 既存空欄に書込対象
  | "noop" // 既存 corporateNumber と同一値
  | "multi" // 候補複数 → スキップ
  | "conflict"; // 既存と異なる → スキップ

export interface OwnerLikeInput {
  name?: string | null;
  address?: string | null;
  note?: string | null;
}

export interface CorporateImportDecision {
  /** 採用された 13桁法人番号。save / noop の場合のみ非 null。 */
  corporateNumber: string | null;
  action: CorporateImportAction;
}

/**
 * Owner-like から法人番号候補を検出し、書込可否を判定する純関数。
 * DB アクセス・I/O は一切行わない。
 *
 * @param owner 検出対象（name / address / note）
 * @param existingCorporateNumber 既存 Owner.corporateNumber（新規 Owner なら null）
 */
export function decideCorporateImport(
  owner: OwnerLikeInput,
  existingCorporateNumber: string | null = null,
): CorporateImportDecision {
  const detect = detectCorporateNumberInOwnerLike(owner);
  if (detect.candidates.length === 0) {
    return { corporateNumber: null, action: "none" };
  }
  if (detect.candidates.length >= 2) {
    return { corporateNumber: null, action: "multi" };
  }
  const candidate = detect.candidates[0];
  if (existingCorporateNumber == null) {
    return { corporateNumber: candidate, action: "save" };
  }
  if (existingCorporateNumber === candidate) {
    return { corporateNumber: candidate, action: "noop" };
  }
  return { corporateNumber: null, action: "conflict" };
}

export interface CorporateImportSummary {
  /** 1 件以上候補を検出した回数（noop / multi / conflict / save 全て含む） */
  detected: number;
  /** 実際に保存対象になった回数（新規作成 data に乗せた回数 + 既存空欄埋め updateMany が成功した回数） */
  saved: number;
  /** 候補複数でスキップした回数 */
  skippedMulti: number;
  /** 既存値と競合してスキップした回数 */
  skippedConflict: number;
}

export function emptyCorporateImportSummary(): CorporateImportSummary {
  return { detected: 0, saved: 0, skippedMulti: 0, skippedConflict: 0 };
}

/**
 * decision を summary に加算する。
 * - save: detected++, saved++
 * - noop: detected++
 * - multi: detected++, skippedMulti++
 * - conflict: detected++, skippedConflict++
 * - none: 何もしない
 *
 * 注意: action="save" を返してきた段階では「書込対象として選ばれた」だけで、
 * 既存空欄埋めの updateMany が count=0 になるケース（race）は呼び出し側で saved を
 * インクリメントしないよう制御すること。新規 Owner 作成パスでは常に成功扱いでよい。
 */
export function tallyCorporateDecision(
  summary: CorporateImportSummary,
  decision: CorporateImportDecision,
): void {
  switch (decision.action) {
    case "save":
      summary.detected++;
      summary.saved++;
      return;
    case "noop":
      summary.detected++;
      return;
    case "multi":
      summary.detected++;
      summary.skippedMulti++;
      return;
    case "conflict":
      summary.detected++;
      summary.skippedConflict++;
      return;
    case "none":
    default:
      return;
  }
}

/**
 * decision に対応する「ImportJobRow.errorMessage に追記する」非PIIメッセージ。
 * 法人番号生値・会社名・住所・候補リストを含めない。
 */
export function corporateImportMessage(
  decision: CorporateImportDecision,
): string | null {
  switch (decision.action) {
    case "multi":
      return "corporate_number: 複数候補のためスキップ";
    case "conflict":
      return "corporate_number: 既存値と競合のためスキップ";
    default:
      return null;
  }
}

/**
 * 既存 errorMessage に追加メッセージを区切り連結する。
 * - extra が null/空なら base をそのまま返す
 * - base が null/空なら extra を返す
 */
export function appendImportMessage(
  base: string | null | undefined,
  extra: string | null,
): string | null {
  const e = extra && extra.trim() !== "" ? extra : null;
  const b = base && base.trim() !== "" ? base : null;
  if (!e) return b;
  if (!b) return e;
  return `${b} / ${e}`;
}
