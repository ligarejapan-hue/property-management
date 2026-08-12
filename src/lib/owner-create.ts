// owner-create.ts
// 所有者作成時の「field-level write 権限チェック」と「重複判定」を純関数化。
// /api/properties/[id]/owners/create-and-link（atomic create-and-link）で使用し、
// 既存 /api/owners POST の挙動と同等になるよう mirror する
// （同じ resource マップ・同じ normalizeName/normalizeAddress による一致判定）。
// 純関数のため prisma / api-helpers を import しない（呼び出し側で ApiError 化・DB 取得する）。
import type { PermissionEntry } from "@/lib/api-helpers";
import { hasExplicitWritePerm } from "@/lib/permissions";
import { normalizeName, normalizeAddress } from "@/lib/normalize";

export interface OwnerCreateData {
  name: string;
  nameKana?: string | null;
  phone?: string | null;
  /** 登記上の郵便番号 */
  zip?: string | null;
  /** 登記上の住所 */
  address?: string | null;
  /** 現住所の郵便番号（⚠住所とペアでのみ書く。resolveCurrentAddressWrite 参照） */
  currentZip?: string | null;
  /** 現住所 */
  currentAddress?: string | null;
  note?: string | null;
  email?: string | null;
  corporateNumber?: string | null;
  companyRegistryNumber?: string | null;
  externalLinkKey?: string | null;
}

// field → 権限 resource（/api/owners POST の createFieldWriteChecks と同一順・同一 resource）。
const OWNER_FIELD_WRITE_RESOURCES: Array<{
  key: keyof OwnerCreateData;
  resource: string;
  label: string;
}> = [
  { key: "name", resource: "owner_name", label: "name" },
  { key: "nameKana", resource: "owner_name_kana", label: "nameKana" },
  { key: "phone", resource: "owner_phone", label: "phone" },
  { key: "zip", resource: "owner_zip", label: "zip" },
  { key: "address", resource: "owner_address", label: "address" },
  // ⚠現住所は登記上の住所と同じ機微度なので、同じ field-level 権限で扱う
  // （専用の resource は作らない。companyRegistryNumber が corporateNumber を流用するのと同型）。
  { key: "currentZip", resource: "owner_zip", label: "currentZip" },
  { key: "currentAddress", resource: "owner_address", label: "currentAddress" },
  { key: "email", resource: "owner_email", label: "email" },
  { key: "note", resource: "owner_note", label: "note" },
  { key: "corporateNumber", resource: "owner_corporate_number", label: "corporateNumber" },
  // 会社法人等番号(12桁)は法人番号(13桁)と同じ field-level 権限で扱う。
  { key: "companyRegistryNumber", resource: "owner_corporate_number", label: "companyRegistryNumber" },
];

/**
 * 提供された（非 null/undefined）フィールドのうち、最初に write 権限が無いものを返す。
 * 全て書き込み可能なら null。owner_<field> の full/edit（hasExplicitWritePerm）を要求する。
 */
export function findMissingOwnerFieldWritePerm(
  permissions: PermissionEntry[],
  data: OwnerCreateData,
): { resource: string; label: string } | null {
  for (const { key, resource, label } of OWNER_FIELD_WRITE_RESOURCES) {
    if (data[key] != null && !hasExplicitWritePerm(permissions, resource)) {
      return { resource, label };
    }
  }
  return null;
}

/**
 * 重複判定（/api/owners POST と同等）。
 * address が指定されている場合のみ、正規化氏名 + 正規化住所の一致で既存 owner id を返す。
 * address なしでは判定しない（既存仕様。orphan 防止は呼び出し側の transaction が担保）。
 */
export function findDuplicateOwnerId(
  data: { name: string; address?: string | null },
  candidates: Array<{ id: string; name: string; address: string | null }>,
): string | null {
  if (!data.address) return null;
  const normName = normalizeName(data.name);
  const normAddr = normalizeAddress(data.address);
  const dup = candidates.find(
    (c) =>
      normalizeName(c.name) === normName &&
      c.address != null &&
      normalizeAddress(c.address) === normAddr,
  );
  return dup ? dup.id : null;
}
