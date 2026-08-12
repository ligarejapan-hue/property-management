import type { OwnerDisplayConfig } from "@/lib/api-helpers";
import { PROPERTY_TYPE_LABELS } from "@/lib/property-types";
import { honorificForOwner } from "@/lib/owner-honorific";
import {
  groupPropertyOwnersByAddress,
  selectGroupRepresentative,
  type DmRowPropertyOwner,
} from "@/lib/dm-export";
import type { LetterRecipient } from "./types";
import {
  resolveMailingAddress,
  resolveGroupZip,
} from "@/lib/owner-mailing-address";

export interface RecipientMeta {
  propertyId: string;
  representativeOwnerId: string | null;
  recipientName: string;
  recipientZip: string | null;
  recipientAddress: string | null;
  honorific: string;
  coOwnerCount: number;
  /** 同一送付先住所グループの全所有者 id(代表含む)。draft 連関(dm_recipient_draft_owners)
   *  の保存に使う(PR-A・設計§2.2: 代表以外の共有者にも反響の記録を紐づける)。 */
  groupOwnerIds: string[];
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
        // ⚠宛先は現住所を優先して解決する（必ずペアで取る）。
        //   郵便番号は**グループ全体**で決める（食い違えば空＝住所だけで配達される）。
        //   ここを代表の生値のままにすると、宛名CSVでは空にする番号を売却DMだけが刷る。
        recipientZip: resolveGroupZip(
          group.map((po) => {
            const o = po.owner as OwnerWithId;
            return resolveMailingAddress({
              zip: o.zip ?? null, address: o.address ?? null,
              currentZip: o.currentZip ?? null, currentAddress: o.currentAddress ?? null,
            }).zip;
          }),
        ),
        recipientAddress: resolveMailingAddress({
          zip: repOwner.zip ?? null, address: repOwner.address ?? null,
          currentZip: repOwner.currentZip ?? null, currentAddress: repOwner.currentAddress ?? null,
        }).address,
        honorific,
        coOwnerCount: group.length,
        groupOwnerIds: group
          .map((po) => (po.owner as OwnerWithId).id)
          .filter((v): v is string => typeof v === "string" && v.length > 0),
      });
    }
  }
  return { recipients, meta };
}

// 生成(課金)を最大 max 通に抑える。物件を途中で分断せず、物件単位で「丸ごと入れる/今回は繰り越す」。
// 共有者が別住所に多数いる1物件が数百通に膨らむ同期生成の暴走(Codex R9-P1/R10-P1)を防ぎ、かつ、ある物件だけ
// 宛先が欠けたまま保存され再バッチで二重生成される事故(Codex R8)も防ぐ。1物件が単独で上限を超える場合もその物件は
// 生成せず繰り越す(=上限を超える有料生成/PII外部送信をしない)。後続の(残り予算に収まる)物件は引き続き詰める。
// recipients と meta は buildRecipientsFromProperties が物件ごとに連続して積む前提。
export function capRecipientsByProperty(
  recipients: LetterRecipient[],
  meta: RecipientMeta[],
  max: number,
): { recipients: LetterRecipient[]; meta: RecipientMeta[]; truncated: boolean } {
  if (recipients.length <= max) return { recipients, meta, truncated: false };
  const outRecipients: LetterRecipient[] = [];
  const outMeta: RecipientMeta[] = [];
  let used = 0;
  let truncated = false;
  let i = 0;
  while (i < meta.length) {
    const pid = meta[i].propertyId;
    let j = i;
    while (j < meta.length && meta[j].propertyId === pid) j++; // 物件 pid のブロック [i, j)
    if (used + (j - i) <= max) {
      for (let k = i; k < j; k++) { outRecipients.push(recipients[k]); outMeta.push(meta[k]); } // 丸ごと収まる=採用
      used += j - i;
    } else {
      truncated = true; // 残り予算に収まらない物件は今回は生成しない(繰り越し)。分断も上限超過もしない
    }
    i = j;
  }
  return { recipients: outRecipients, meta: outMeta, truncated };
}
