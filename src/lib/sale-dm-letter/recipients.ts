import type { OwnerDisplayConfig } from "@/lib/api-helpers";
import { PROPERTY_TYPE_LABELS } from "@/lib/property-types";
import { honorificForOwner } from "@/lib/owner-honorific";
import {
  groupPropertyOwnersByAddress,
  selectGroupRepresentative,
  OTHER_CO_OWNERS_SUFFIX,
  type DmRowPropertyOwner,
} from "@/lib/dm-export";
import type { LetterRecipient } from "./types";

export interface RecipientMeta {
  propertyId: string;
  representativeOwnerId: string | null;
  recipientName: string;
  recipientZip: string | null;
  recipientAddress: string | null;
  honorific: string;
  coOwnerCount: number;
}

// route の select は owner.id も取得するが、DmRowPropertyOwner の owner 型は id を含まないため widen する。
type OwnerWithId = DmRowPropertyOwner["owner"] & { id?: string };

type PropertyForRecipients = {
  id: string;
  address: string;
  propertyType: string;
  roomNo: string | null;
  propertyOwners: DmRowPropertyOwner[];
};

/**
 * 印刷/CSV 用の宛名敬称を組み立てる。送付先が複数共有者(coOwnerCount>1)なら
 * 代表者の base 敬称に「他共有者様」を付す(prompt.ts と同整形・dm-export の敬称列と一致)。
 * draft は base 敬称(様/御中)と coOwnerCount を別々に保存し、表示(print/CSV)時に合成する。
 * base のまま保存するのは prompt 側が coOwnerCount から宛名を再合成するため(二重付与防止)。
 */
export function composeAddresseeHonorific(honorific: string, coOwnerCount: number): string {
  return coOwnerCount > 1 ? `${honorific} ${OTHER_CO_OWNERS_SUFFIX}` : honorific;
}

// dm-export の「1送付先住所=1通」グルーピングを再利用。groups は DmRowPropertyOwner[][]。
// 各グループの代表は selectGroupRepresentative で取り、敬称は honorificForOwner(name, hasCorporateNumber)。
export function buildRecipientsFromProperties(
  properties: PropertyForRecipients[],
  _ownerDisplayConfig: OwnerDisplayConfig,
): { recipients: LetterRecipient[]; meta: RecipientMeta[] } {
  const recipients: LetterRecipient[] = [];
  const meta: RecipientMeta[] = [];

  for (const p of properties) {
    const { groups } = groupPropertyOwnersByAddress(p.propertyOwners);
    for (const group of groups) {
      const repPo = selectGroupRepresentative(group);
      const repOwner = repPo.owner as OwnerWithId;
      const hasCorporateNumber =
        typeof repOwner.corporateNumber === "string" && repOwner.corporateNumber.length > 0;
      const honorific = honorificForOwner(repOwner.name, hasCorporateNumber);
      recipients.push({
        representativeName: repOwner.name ?? "",
        honorific,
        coOwnerCount: group.length,
        propertyAddress: p.address,
        propertyTypeLabel: PROPERTY_TYPE_LABELS[p.propertyType] ?? p.propertyType,
        roomNo: p.roomNo,
      });
      meta.push({
        propertyId: p.id,
        representativeOwnerId: repOwner.id ?? null,
        recipientName: repOwner.name ?? "",
        recipientZip: repOwner.zip ?? null,
        recipientAddress: repOwner.address ?? null,
        honorific,
        coOwnerCount: group.length,
      });
    }
  }
  return { recipients, meta };
}
