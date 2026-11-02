import type { PermissionEntry } from "@/lib/api-helpers";
import { resolveOwnerMemoBodyVisibility, type OwnerMemoBodyVisibility } from "@/lib/owner-memo";
import { hasPermission, resolveOwnerDisplayConfig, type OwnerDisplayConfigShape } from "@/lib/permissions";
import { canAccessPropertyRecord, type PropertyAccessRecord } from "@/lib/property-access";

export interface TimelineAccess {
  /** 物件の出どころ(コメント・次にやること・反響・調査・物件と棟の変更履歴)。 */
  property: boolean;
  /** 所有者とのつながりの変更履歴(元の画面=owner:read)。 */
  ownerLinks: boolean;
  /** つながりの備考の値の見せ方(owner_note のレベル)。 */
  ownerNote: OwnerMemoBodyVisibility;
  /** 所有者本体の変更履歴の、項目ごとの表示レベル。 */
  ownerLevels: OwnerDisplayConfigShape;
  /** 所有者メモの見せ方。hidden=読まない。 */
  memo: OwnerMemoBodyVisibility;
  /** DM の記録(元の画面=property:read+owner:read)。 */
  dm: boolean;
  /** DM の備考の表示レベル。 */
  noteLevel: string;
  /** 変更履歴の問い合わせ者の表示レベル。null=「（非表示）」。 */
  inquirerLevel: string | null;
  /** 資料の送付(元の画面=反響の受付の権限+物件)。 */
  material: boolean;
  /** 取引の出どころ。 */
  deal: boolean;
  /** 差し戻しの理由(元の画面=deal:write)。 */
  dealManage: boolean;
}

/**
 * 出どころごとの権限(元の画面の判定と同じ)。ここで閉じた出どころはクエリも流さない=件数も出ない。
 * property=null は物件につながらない取引。
 */
export function timelineAccess(
  session: { id: string; role: string },
  perms: PermissionEntry[],
  property: PropertyAccessRecord | null,
): TimelineAccess {
  const propertyOk = !!property && hasPermission(perms, "property", "read") && canAccessPropertyRecord(session, property);
  const ownerRead = hasPermission(perms, "owner", "read");
  const noteVisibility = resolveOwnerMemoBodyVisibility(perms);
  const config = resolveOwnerDisplayConfig(perms);
  return {
    property: propertyOk,
    ownerLinks: propertyOk && ownerRead,
    ownerNote: noteVisibility,
    ownerLevels: config,
    memo: propertyOk && ownerRead ? noteVisibility : "hidden",
    dm: propertyOk && ownerRead,
    noteLevel: config.note,
    inquirerLevel: ownerRead ? config.name : null,
    material: propertyOk && hasPermission(perms, "agent_inquiry", "read"),
    deal: hasPermission(perms, "deal", "read"),
    dealManage: hasPermission(perms, "deal", "write"),
  };
}
