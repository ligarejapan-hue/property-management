import type { OwnerDisplayConfig } from "@/lib/api-helpers";
import { PROPERTY_TYPE_LABELS } from "@/lib/property-types";
import { honorificForOwner } from "@/lib/owner-honorific";
import {
  groupPropertyOwnersByAddress,
  selectGroupRepresentative,
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
