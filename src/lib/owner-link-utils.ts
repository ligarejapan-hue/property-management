// owner-link-utils.ts
// 物件詳細「所有者を追加」(既存所有者の紐付け / 新規作成して紐付け) フロント側の
// 純粋ロジック。OwnerLinkModal から切り出し、ユニットテスト可能にする
// (owner-edit-utils.ts と同方針: payload 構築・活性条件・既定値を純関数化)。

/** 新規所有者作成フォームの入力値（全て文字列・空文字許容）。 */
export type OwnerCreateFormValues = {
  name: string;
  nameKana: string;
  phone: string;
  /** 登記上の郵便番号 */
  zip: string;
  /** 登記上の住所 */
  address: string;
  /** 現住所（分けていなければ空文字＝未設定） */
  currentAddress: string;
  /** 現住所の郵便番号 */
  currentZip: string;
  email: string;
};

/** POST /api/owners 用 payload（createOwnerSchema に対応）。 */
export interface OwnerCreatePayload {
  name: string;
  nameKana?: string | null;
  phone?: string | null;
  zip?: string | null;
  address?: string | null;
  /** ⚠住所と郵便番号は必ずペアで送る（サーバー側 resolveCurrentAddressWrite が規則を持つ）。 */
  currentAddress?: string | null;
  currentZip?: string | null;
  email?: string | null;
}

/**
 * POST /api/owners 用の payload を構築する。
 * - name は必須（呼び出し側で canSubmitOwnerCreate により事前ガード）。
 * - 任意項目は trim 後に空文字なら null（DB に空文字を書かない）。
 *   サーバ側 createOwnerSchema が email 形式などを再検証する。
 */
export function buildCreateOwnerPayload(
  form: OwnerCreateFormValues,
): OwnerCreatePayload {
  return {
    name: form.name.trim(),
    nameKana: form.nameKana.trim() || null,
    phone: form.phone.trim() || null,
    zip: form.zip.trim() || null,
    address: form.address.trim() || null,
    // ⚠現住所は**必ずペアで**送る。片方だけ送ると、サーバー側の規則で
    // 400（郵便番号だけ）または郵便番号のクリア（住所だけ）になる。
    currentAddress: form.currentAddress.trim() || null,
    currentZip: form.currentZip.trim() || null,
    email: form.email.trim() || null,
  };
}

/** 新規作成ボタンの活性条件: 氏名（name）が trim 後に非空であること。 */
export function canSubmitOwnerCreate(form: { name: string }): boolean {
  return form.name.trim().length > 0;
}

/**
 * 「所有者を追加」導線（既存紐付け / 新規作成）を表示してよいか。
 * - canRead（owner:read）: 所有者タブ自体が閲覧可能であること。
 * - canWrite（owner:write）: 追加・紐付け操作の権限があること。
 * owner:write が無いユーザー（field_staff 等）には導線を一切出さない。
 */
export function canShowAddOwner(canRead: boolean, canWrite: boolean): boolean {
  return canRead && canWrite;
}

/**
 * 紐付け時の isPrimary 既定値。
 * 既存所有者が 0 件のときだけ true（最初の 1 人を主所有者にする）。
 * 既に所有者がいる物件への追加は、既存の主所有者を勝手に降格させないため false。
 */
export function defaultIsPrimaryForLink(existingOwnerCount: number): boolean {
  return existingOwnerCount === 0;
}

/** POST /api/properties/[id]/owners 用 payload（linkOwnerSchema に対応）。 */
export interface LinkOwnerPayload {
  ownerId: string;
  relationship?: string | null;
  isPrimary: boolean;
}

/**
 * 紐付け payload を構築する。
 * relationship は trim 後に空文字なら null。isPrimary はそのまま透過する。
 */
export function buildLinkOwnerPayload(
  ownerId: string,
  relationship: string,
  isPrimary: boolean,
): LinkOwnerPayload {
  return {
    ownerId,
    relationship: relationship.trim() || null,
    isPrimary,
  };
}

/**
 * 既存所有者の選択を submit してよいか。
 * - selected が現在の検索結果（hits）に含まれる（query 変更後の古い選択は不可）。
 * - selected が既にこの物件に紐付いていない（existingOwnerIds に含まれない）。
 *   既存紐付け owner を再度紐付けると PropertyOwner の @@unique([propertyId, ownerId]) 違反で
 *   500 になるため、UI 側で submit を不可にする（Codex）。
 */
export function isSelectedOwnerSubmittable(
  selected: { id: string } | null,
  hits: Array<{ id: string }>,
  existingOwnerIds: string[],
): boolean {
  return (
    selected !== null &&
    hits.some((h) => h.id === selected.id) &&
    !isExistingLinkedOwner(selected.id, existingOwnerIds)
  );
}

/** owner が既にこの物件に紐付いているか（existingOwnerIds に含まれるか）。 */
export function isExistingLinkedOwner(
  ownerId: string,
  existingOwnerIds: string[],
): boolean {
  return existingOwnerIds.includes(ownerId);
}

/** 検索結果の owner を選択可能か（既にこの物件へ紐付け済みの owner は選択不可）。 */
export function isOwnerSearchHitSelectable(
  hit: { id: string },
  existingOwnerIds: string[],
): boolean {
  return !isExistingLinkedOwner(hit.id, existingOwnerIds);
}

/**
 * stale 検索レスポンス破棄判定（Codex）。
 * debounce 後に開始した検索リクエストへ単調増加のシーケンス番号を振り、レスポンス解決時点で
 * 最新（latest）のリクエストでなければ結果を反映しない。これにより、後から解決した古い検索の
 * 結果が新しいクエリの結果（searchHits）を上書きするのを防ぐ。
 */
export function isLatestSearch(requestSeq: number, latestSeq: number): boolean {
  return requestSeq === latestSeq;
}

/** atomic create-and-link 用 payload（owner 作成フィールド + relationship/isPrimary）。 */
export interface CreateAndLinkPayload extends OwnerCreatePayload {
  relationship?: string | null;
  isPrimary: boolean;
}

/**
 * 新規作成して紐付ける atomic エンドポイント用の payload を構築する。
 * owner 作成 payload（buildCreateOwnerPayload）に relationship（空→null）と isPrimary を統合する。
 * フロントで createOwner → linkOwnerToProperty を逐次実行する代わりに 1 リクエストで送る（orphan 防止）。
 */
export function buildCreateAndLinkPayload(
  form: OwnerCreateFormValues,
  relationship: string,
  isPrimary: boolean,
): CreateAndLinkPayload {
  return {
    ...buildCreateOwnerPayload(form),
    relationship: relationship.trim() || null,
    isPrimary,
  };
}
