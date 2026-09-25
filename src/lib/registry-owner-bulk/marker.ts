/**
 * 「謄本から所有者をまとめて反映」の行を見分ける印（ピュア）。
 *
 * ⚠取込記録の種別は**既存の「所有者事項PDF一括」(`registry_pdf_bulk`)に相乗り**する。
 *   データベースの種別(enum)を増やすと取り消せない変更になるため、受付帳×所有者が
 *   `owner_csv` に相乗りしているのと同じ手を取る(→ `reception-owner-link.ts`)。
 *   相乗りする以上、**行の見分けは厳しく**する: 種別が一致し、かつこの印がある行だけ。
 *   甘くすると、PDFを上げた一括取込の行をこちらの処理に流してしまう。
 */

/** 相乗り先の取込種別。 */
export const REGISTRY_OWNER_APPLY_JOB_TYPE = "registry_pdf_bulk";

/** 行の印（値）。 */
export const REGISTRY_OWNER_APPLY_KIND = "registry_owner_apply";

/** 行の印（キー）。 */
export const REGISTRY_OWNER_APPLY_KIND_KEY = "__kind";

/**
 * 行に書き込む内容。
 * ⚠**所有者の氏名・住所は入れない**(謄本から読んだ個人の情報を取込記録に残さない)。
 *   `address` は**物件の**住所で、結果の一覧で「どの物件か」を示すためだけに持つ。
 */
export interface RegistryOwnerApplyRowData {
  propertyId: string;
  address?: string;
}

/** 行の内容を組み立てる（物件の住所が無い物件では省く）。 */
export function buildRegistryOwnerApplyRawData(input: {
  propertyId: string;
  address: string | null;
}): Record<string, string> {
  return {
    [REGISTRY_OWNER_APPLY_KIND_KEY]: REGISTRY_OWNER_APPLY_KIND,
    propertyId: input.propertyId,
    ...(input.address ? { address: input.address } : {}),
  };
}

/** 行の内容から物件IDを取り出す。形が違えば null。 */
export function readRegistryOwnerApplyRow(
  rawData: unknown,
): RegistryOwnerApplyRowData | null {
  if (!rawData || typeof rawData !== "object" || Array.isArray(rawData)) return null;
  const row = rawData as Record<string, unknown>;
  const propertyId = row.propertyId;
  if (typeof propertyId !== "string" || propertyId === "") return null;
  const address = typeof row.address === "string" && row.address !== "" ? row.address : undefined;
  return { propertyId, ...(address ? { address } : {}) };
}

/**
 * 行が「まとめて反映の行」かを厳格に判定する。
 * 種別が相乗り先であること + 印があること + 物件IDが読めること。
 */
export function isRegistryOwnerApplyRow(jobType: string, rawData: unknown): boolean {
  if (jobType !== REGISTRY_OWNER_APPLY_JOB_TYPE) return false;
  if (!rawData || typeof rawData !== "object" || Array.isArray(rawData)) return false;
  const row = rawData as Record<string, unknown>;
  if (row[REGISTRY_OWNER_APPLY_KIND_KEY] !== REGISTRY_OWNER_APPLY_KIND) return false;
  return readRegistryOwnerApplyRow(rawData) !== null;
}
