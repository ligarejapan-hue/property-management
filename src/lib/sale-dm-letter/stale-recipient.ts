/**
 * 売却DMの下書きが「古い宛先のまま」かどうかを判定する。
 *
 * 設計: docs/superpowers/specs/2026-08-10-owner-current-address-design.md §4 / §6
 *
 * ## なぜ要るのか
 * 下書きは作った時点の宛先（郵便番号・住所）を控えている。作ってから確定するまでの間に
 * 担当者が**現住所を入れる／直す**と、控えは古い住所のまま残る。そのまま確定して印刷すると、
 * **引っ越し前の住所へ送る**（現住所を入れた意味が消える）。
 *
 * → 確定の時点で「いまの解決結果」と突き合わせ、食い違えば確定させずに作り直してもらう。
 */
import { normalizeAddress } from "@/lib/normalize";
import {
  normalizeZipForGroup,
  resolveMailingAddress,
  resolveGroupZip,
  type OwnerAddressFields,
} from "@/lib/owner-mailing-address";

export interface DraftRecipientSnapshot {
  id: string;
  recipientZip: string | null;
  recipientAddress: string | null;
}

/** その下書きの宛先を決める所有者たち（代表 + 同じ送付先の共有者）。 */
export interface DraftOwnerSet {
  representative: OwnerAddressFields | null;
  /** 代表を含むグループ全員。郵便番号はここ全体で決める（設計 §4.0）。 */
  group: OwnerAddressFields[];
}

export interface ResolvedRecipient {
  zip: string | null;
  address: string | null;
}

/** いまの所有者の値から宛先を決め直す。 */
export function resolveDraftRecipient(
  owners: DraftOwnerSet,
): ResolvedRecipient {
  const address = owners.representative
    ? resolveMailingAddress(owners.representative).address
    : null;
  const zip = resolveGroupZip(
    owners.group.map((o) => resolveMailingAddress(o).zip),
  );
  return { zip, address };
}

/**
 * 控えた宛先と、いまの解決結果が食い違うか。
 *
 * ⚠書き方の違い（空白・ハイフン）では食い違い扱いにしない。
 *   実際に届く先が変わったときだけ止める。
 */
export function isRecipientStale(
  saved: DraftRecipientSnapshot,
  now: ResolvedRecipient,
): boolean {
  const addressChanged =
    normalizeAddress(saved.recipientAddress) !== normalizeAddress(now.address);
  const zipChanged =
    normalizeZipForGroup(saved.recipientZip) !== normalizeZipForGroup(now.zip);
  return addressChanged || zipChanged;
}
