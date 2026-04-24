/**
 * CSV 取込の入口でファイル種別を判定するヘルパ。
 *
 * - まずファイル名で判定する（「受付帳」「所有者」）
 * - 両方含まれるケースはエラー（曖昧）
 * - どちらも含まれないケースは unknown（列構成フォールバックは呼び出し側の判断）
 *
 * あわせて、受付帳 HIJK 列 / 所有者 C 列を区切りなし連結でキー化するための
 * 比較用正規化を提供する。保存値は壊さず、比較用のみに使う。
 */

export type ImportFileType = "reception" | "owner" | "ambiguous" | "unknown";

export interface FileTypeDetection {
  type: ImportFileType;
  /** UI で表示するラベル。特定できない場合は null */
  label: string | null;
  /** 曖昧 / 未特定時のエラーメッセージ。正常時は null */
  error: string | null;
}

/**
 * ファイル名から種別を判定する。
 *
 * - 「受付帳」を含む → reception
 * - 「所有者」を含む → owner
 * - 両方含む → ambiguous（エラー）
 * - どちらも含まない → unknown（呼び出し側でフォールバック可）
 */
export function detectImportFileType(
  fileName: string | null | undefined,
): FileTypeDetection {
  const name = (fileName ?? "").trim();
  if (!name) {
    return {
      type: "unknown",
      label: null,
      error: "ファイル名に『受付帳』または『所有者』を含めてください",
    };
  }
  const hasReception = name.includes("受付帳");
  const hasOwner = name.includes("所有者");
  if (hasReception && hasOwner) {
    return {
      type: "ambiguous",
      label: null,
      error:
        "ファイル名が曖昧です。『受付帳』か『所有者』のどちらか一方だけを含めてください",
    };
  }
  if (hasReception) {
    return { type: "reception", label: "受付帳として認識", error: null };
  }
  if (hasOwner) {
    return { type: "owner", label: "所有者として認識", error: null };
  }
  return {
    type: "unknown",
    label: null,
    error:
      "ファイル種別を特定できませんでした。ファイル名に『受付帳』または『所有者』を含めてください",
  };
}

// ---------------------------------------------------------------------------
// 受付帳 HIJK / 所有者 C の比較用正規化キー
// ---------------------------------------------------------------------------

/**
 * HIJK / C 列の各パーツに適用する比較用正規化。
 *
 * - NFKC（全角英数→半角、全角記号→半角）
 * - ハイフン類（en-dash, em-dash, 全角ハイフン, wave dash 等）を `-` に統一
 *   ※ 長音「ー」U+30FC は HIJK/C に現れない前提なので変換対象外
 * - 全ての空白（半角/全角/タブ）を除去
 */
export function normalizeReceptionKeyPart(
  input: string | null | undefined,
): string {
  if (input == null) return "";
  return String(input)
    .normalize("NFKC")
    .replace(/[\u2010-\u2015\u2212\uFF0D\uFF5E\u301C]/g, "-")
    .replace(/[\s\u3000]+/g, "")
    .trim();
}

/**
 * 受付帳 1 行から H/I/J/K を区切りなし単純連結してキー化。
 * 所有者 C 列と突合する用途で、別物衝突は要件上考慮不要。
 */
export function buildReceptionMatchKey(parts: {
  h?: string | null;
  i?: string | null;
  j?: string | null;
  k?: string | null;
}): string {
  return (
    normalizeReceptionKeyPart(parts.h) +
    normalizeReceptionKeyPart(parts.i) +
    normalizeReceptionKeyPart(parts.j) +
    normalizeReceptionKeyPart(parts.k)
  );
}

/** 所有者 C 列を受付帳キーと同じルールで正規化。 */
export function buildOwnerMatchKey(
  cValue: string | null | undefined,
): string {
  return normalizeReceptionKeyPart(cValue);
}

// ---------------------------------------------------------------------------
// 受付帳 F 列に基づく K 列の意味振り分け
// ---------------------------------------------------------------------------

export type KColumnMeaning = "lotNumber" | "buildingNumber" | "ambiguous";

/**
 * F 列の値から K 列の意味を決める。
 *
 * - "土地" → lotNumber（地番）
 * - "建物" / "区分" / "区建"（区分建物の略記） → buildingNumber（家屋番号）
 * - それ以外 → ambiguous（呼び出し側で安全側に扱う）
 *
 * 実データで "区建" 表記が確認されたため、"区分" と同義として扱う。
 */
export function classifyReceptionKColumn(
  fValue: string | null | undefined,
): KColumnMeaning {
  const f = (fValue ?? "").trim();
  if (f === "土地") return "lotNumber";
  if (f === "建物" || f === "区分" || f === "区建") return "buildingNumber";
  return "ambiguous";
}

/**
 * K 列の値を F 列の意味に応じて lotNumber / buildingNumber に振り分ける。
 * ambiguous の場合は両方 null（保存値を壊さず、安全側で後続処理に任せる）。
 */
export function splitReceptionK(
  fValue: string | null | undefined,
  kValue: string | null | undefined,
): { lotNumber: string | null; buildingNumber: string | null } {
  const k = (kValue ?? "").trim();
  if (!k) return { lotNumber: null, buildingNumber: null };
  const meaning = classifyReceptionKColumn(fValue);
  if (meaning === "lotNumber") return { lotNumber: k, buildingNumber: null };
  if (meaning === "buildingNumber")
    return { lotNumber: null, buildingNumber: k };
  return { lotNumber: null, buildingNumber: null };
}
