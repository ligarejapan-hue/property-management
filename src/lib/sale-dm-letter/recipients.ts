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

// 宛名敬称の合成は client/server 共有のリーフモジュール(addressee.ts)へ移設。
// 既存の import 元(recipients)を維持するため re-export する(print/export route は変更不要)。
export { composeAddresseeHonorific } from "./addressee";

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

// 生成(課金)を最大 max 通に抑える。ただし物件を途中で分断しない=物件単位で丸ごと含める/落とす。
// 共有者が別住所に多数いる1物件が数百通に膨らむ同期生成の暴走(Codex R9-P1)を防ぎつつ、ある物件だけ宛先が
// 欠けたまま保存され再バッチで二重生成される事故(Codex R8)も防ぐ。recipients と meta は buildRecipientsFromProperties
// が物件ごとに連続して積むため、物件境界での slice が成立する前提。max 通に収まらない先頭1物件だけは分断を避けて
// 丸ごと生成する(選択した1物件は必ず出す。共有者数で有界)。
export function capRecipientsByProperty(
  recipients: LetterRecipient[],
  meta: RecipientMeta[],
  max: number,
): { recipients: LetterRecipient[]; meta: RecipientMeta[]; truncated: boolean } {
  if (recipients.length <= max) return { recipients, meta, truncated: false };
  let cut = 0;
  let i = 0;
  while (i < meta.length) {
    const pid = meta[i].propertyId;
    let j = i;
    while (j < meta.length && meta[j].propertyId === pid) j++; // 物件 pid のブロック [i, j)
    if (j <= max) {
      cut = j; // 丸ごと含めても max 以内=採用して次の物件へ
      i = j;
    } else {
      if (cut === 0) cut = j; // 先頭物件だけで超過=その1物件は分断せず丸ごと出す
      break; // これ以上足すと超過=直前の物件境界で打ち切り
    }
  }
  return { recipients: recipients.slice(0, cut), meta: meta.slice(0, cut), truncated: cut < recipients.length };
}
