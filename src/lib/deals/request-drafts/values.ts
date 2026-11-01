import { yen } from "../calc/format";
import { jstDateString, formatJstDateTime } from "../datetime";
import { bankAccountText, dateJa } from "../documents/business/common";
import type { BankAccount, Lease } from "../schemas";
import type { DealPartyView, DealView } from "../view";
import type { RequestFieldValue, RequestFieldValues, RequestRecipient } from "./templates";

/**
 * 差し込み欄の値を作る。**純関数だけ**。氏名・住所は権限で欄ごと空にする(発注者決定 2026-11-02=所有者情報の表示レベルに合わせる)。
 * ⚠ここで作った値は画面に返すだけ。監査・console には出さない。
 */
export interface RequestAccess {
  /** 氏名をそのまま見られる。 */
  name: boolean;
  /** 住所をそのまま見られる。 */
  address: boolean;
  /** 取引を編集できる(提出用リンク・振込先)。 */
  canManage: boolean;
  /** その物件を見られる(棟の管理会社)。 */
  canOpenProperty: boolean;
}
export type RequestRecipientTarget = { kind: "seller"; party: DealPartyView } | { kind: "tenant"; lease: Lease };

export interface RequestFieldInput {
  deal: DealView;
  settlement: { ready: boolean; totalSellerToBuyer: number; totalBuyerToSeller: number; paymentAtSettlement: number | null };
  company: { nameJa: string; tel: string; address: string };
  bankAccount: BankAccount;
  access: RequestAccess;
  assigneeName: string | null;
  buildingManagementCompany: string | null;
  /** 決済時に持参するもの。 */
  documents: string[];
  recipient: RequestRecipientTarget | null;
  docLink: { url: string; expiresOn: string } | null;
}

const text = (v: string | null | undefined): RequestFieldValue => (v ? { value: v } : { blank: "missing" });
const money = (n: number | null | undefined): RequestFieldValue => (n === null || n === undefined ? { blank: "missing" } : { value: `${yen(n)}円` });
const joined = (vs: (string | null | undefined)[]): string | null => [...new Set(vs.filter((v): v is string => !!v))].join("・") || null;
const dateOf = (iso: string | null) => dateJa(jstDateString(new Date(iso as string)));
/** 時刻を入れていない日時(0:00)は日付だけ。 */
function dateTimeOf(iso: string | null): RequestFieldValue {
  if (!iso) return { blank: "missing" };
  const time = formatJstDateTime(iso).split(" ")[1];
  return { value: time === "00:00" ? dateOf(iso) : `${dateOf(iso)} ${time}` };
}

/** 当事者の氏名や住所。権限がなければ値の有無にかかわらず空(自社の分は個人の情報ではないので入れる)。 */
function partyField(parties: DealPartyView[], allowed: boolean, pick: (p: DealPartyView) => string | null): RequestFieldValue {
  if (!parties.length) return { blank: "missing" };
  if (!allowed && parties.some((p) => !p.isSelf)) return { blank: "permission" };
  return text(joined(parties.map(pick)));
}

export function buildRequestFieldValues(i: RequestFieldInput): RequestFieldValues {
  const { deal: d, access, settlement: s, recipient, docLink } = i;
  const snap = d.propertySnapshot;
  const sellers = recipient?.kind === "seller" ? [recipient.party] : d.parties.filter((p) => p.role === "seller");
  const buyers = d.parties.filter((p) => p.role === "buyer");
  const tenants = recipient?.kind === "tenant" ? [recipient.lease] : d.leases.filter((l) => l.tenant);
  const settled = (n: number | null): RequestFieldValue => (s.ready ? money(n) : { blank: "missing" });

  const managerFromBuilding = access.canOpenProperty ? i.buildingManagementCompany : null;
  const managerFromLeases = joined(d.leases.map((l) => l.manager));
  const manager: RequestFieldValue = managerFromBuilding || managerFromLeases
    ? { value: (managerFromBuilding || managerFromLeases) as string }
    : d.propertyId && !access.canOpenProperty ? { blank: "permission" } : { blank: "missing" };

  // リンクは人ごと。宛先の売主を選んだ文面にだけ入れる(別の人のリンクを送らない)。
  const linkBlank: RequestFieldValue = { blank: access.canManage ? "no_link" : "permission" };
  const link = access.canManage && recipient?.kind === "seller" ? docLink : null;
  const selfBuyer = buyers.some((p) => p.isSelf);

  return {
    物件名: text([snap.buildingName, snap.roomNo].filter(Boolean).join(" ")),
    所在: text(snap.address),
    地番: text(snap.lotNumber),
    部屋番号: text(recipient?.kind === "tenant" ? recipient.lease.room : snap.roomNo),
    決済日時: dateTimeOf(d.settlementAt),
    決済日: d.settlementAt ? { value: dateOf(d.settlementAt) } : { blank: "missing" },
    決済場所: text(d.settlementPlace),
    契約日時: dateTimeOf(d.contractAt),
    売買価格: money(d.price),
    売主から買主への精算額: settled(s.totalSellerToBuyer),
    買主から売主への精算額: settled(s.totalBuyerToSeller),
    決済時のお支払額: settled(s.paymentAtSettlement),
    取引番号: text(d.dealNo),
    会社名: text(i.company.nameJa),
    会社電話: text(i.company.tel),
    会社住所: text(i.company.address),
    担当者名: text(i.assigneeName),
    司法書士名: text(d.costs.scrivener.name),
    司法書士担当者: text(d.costs.scrivener.staff),
    相手業者名: text(d.counterpartyBroker.company),
    相手業者担当者: text(d.counterpartyBroker.staff),
    管理会社名: manager,
    売主名: partyField(sellers, access.name, (p) => p.name),
    売主住所: partyField(sellers, access.address, (p) => p.address),
    買主名: partyField(buyers, access.name, (p) => p.name),
    賃借人名: !tenants.length ? { blank: "missing" } : access.name ? text(joined(tenants.map((l) => l.tenant))) : { blank: "permission" },
    必要書類: i.documents.length ? { value: i.documents.map((x) => `・${x}`).join("\n") } : { blank: "missing" },
    提出用リンク: link ? { value: link.url } : linkBlank,
    リンクの期限: link ? { value: dateJa(link.expiresOn) } : linkBlank,
    提出用リンクのご案内: link
      ? { value: `下のリンクから、スマートフォンで書類をご提出いただけます。\n${link.url}\nリンクの期限:${dateJa(link.expiresOn)}` }
      : linkBlank,
    賃料振込先: !access.canManage ? { blank: "permission" } : selfBuyer ? text(bankAccountText({ settings: { bankAccount: i.bankAccount } })) : { blank: "missing" },
  };
}

export interface RequestRecipientOption { id: string; label: string }

/** 人ごとに作る文面の宛先。氏名の権限がなければ選択肢にも名前を出さない。 */
export function recipientOptions(kind: RequestRecipient, deal: DealView, canSeeName: boolean): RequestRecipientOption[] {
  if (kind === "seller") {
    return deal.parties.filter((p) => p.role === "seller" && !p.isSelf)
      .map((p, n) => ({ id: p.id, label: canSeeName ? `売主 ${p.name}` : `売主 ${n + 1}` }));
  }
  if (kind === "tenant") {
    return deal.leases.flatMap((l, n) => {
      if (!l.tenant) return [];
      const room = l.room ?? `${n + 1}件目`;
      return [{ id: String(n), label: canSeeName ? `${room} ${l.tenant}` : room }];
    });
  }
  return [];
}

/** 選んだ宛先。選択肢に無ければ null。 */
export function recipientTarget(kind: RequestRecipient, deal: DealView, id: string): RequestRecipientTarget | null {
  if (kind === "seller") {
    const party = deal.parties.find((p) => p.id === id && p.role === "seller" && !p.isSelf);
    return party ? { kind, party } : null;
  }
  if (kind === "tenant") {
    if (!/^\d{1,3}$/.test(id)) return null;
    const lease = deal.leases[Number(id)];
    return lease?.tenant ? { kind, lease } : null;
  }
  return null;
}
