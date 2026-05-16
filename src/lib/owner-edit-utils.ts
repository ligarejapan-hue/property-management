// owner-edit-utils.ts
// フロント側の所有者編集 payload 構築ロジック（純粋関数）。
// page.tsx の OwnerCard から切り出し、ユニットテスト可能にする。

/** field-level 権限のうち full のものだけ編集可能とする */
export interface OwnerEditableFields {
  /** owner_name:full */
  name: boolean;
  /** owner_name_kana:full（name とは独立して判定する） */
  nameKana: boolean;
  /** owner_phone:full */
  phone: boolean;
  /** owner_zip:full */
  zip: boolean;
  /** owner_address:full */
  address: boolean;
  /** owner_email:full */
  email: boolean;
}

export type OwnerFormValues = {
  name: string;
  nameKana: string;
  phone: string;
  zip: string;
  address: string;
  email: string;
};

/**
 * PATCH /api/owners/[id] 用の payload を構築する。
 * field-level full 権限がない項目は payload に含めず、DB の既存値を上書きしない。
 * name と nameKana はそれぞれ独立した権限で判定する。
 */
export function buildOwnerUpdatePayload(
  form: OwnerFormValues,
  fields: OwnerEditableFields,
  version: number,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { version };
  if (fields.name) payload.name = form.name.trim() || undefined;
  if (fields.nameKana) payload.nameKana = form.nameKana.trim() || null;
  if (fields.phone) payload.phone = form.phone.trim() || null;
  if (fields.zip) payload.zip = form.zip.trim() || null;
  if (fields.address) payload.address = form.address.trim() || null;
  if (fields.email) payload.email = form.email.trim() || null;
  return payload;
}
