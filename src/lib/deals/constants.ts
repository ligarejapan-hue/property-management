/** 取引(設計 2026-10-23 §2)の選択肢。DB は TEXT の列・ここが許可リスト。 */
export const DEAL_BUSINESS_TYPES = ["brokerage", "resale"] as const;
export type DealBusinessType = (typeof DEAL_BUSINESS_TYPES)[number];
export const DEAL_BUSINESS_TYPE_LABELS: Record<DealBusinessType, string> = { brokerage: "仲介", resale: "買取再販" };

/** 取引態様。買取再販では使わない(自社が買主にも売主にもなる)。 */
export const DEAL_TRADE_SIDES = ["seller", "buyer", "both"] as const;
export type DealTradeSide = (typeof DEAL_TRADE_SIDES)[number];
export const DEAL_TRADE_SIDE_LABELS: Record<DealTradeSide, string> = { seller: "売主側", buyer: "買主側", both: "両手" };

export const DEAL_STATUSES = ["considering", "contracted", "settled", "cancelled"] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];
export const DEAL_STATUS_LABELS: Record<DealStatus, string> = {
  considering: "検討中", contracted: "契約済", settled: "決済済", cancelled: "中止",
};

export const DEAL_PARTY_ROLES = ["seller", "buyer", "agent", "tenant"] as const;
export type DealPartyRole = (typeof DEAL_PARTY_ROLES)[number];
export const DEAL_PARTY_ROLE_LABELS: Record<DealPartyRole, string> = { seller: "売主", buyer: "買主", agent: "代理人", tenant: "賃借人" };

export const DEAL_PARTY_TYPES = ["individual", "corporation"] as const;
export type DealPartyType = (typeof DEAL_PARTY_TYPES)[number];
export const DEAL_PARTY_TYPE_LABELS: Record<DealPartyType, string> = { individual: "個人", corporation: "法人" };

/** 帳票の出し分けに使う4つの基本の種別。設定で足す種別も、どれか1つを「元」に持つ。 */
export const BASE_PROPERTY_KINDS = ["unit", "house", "land", "building"] as const;
export type BasePropertyKind = (typeof BASE_PROPERTY_KINDS)[number];
export const BASE_PROPERTY_KIND_LABELS: Record<BasePropertyKind, string> = {
  unit: "区分マンション", house: "戸建", land: "土地", building: "一棟",
};
export interface PropertyKindDef { key: string; label: string; base: BasePropertyKind }
export const DEFAULT_PROPERTY_KINDS: PropertyKindDef[] = BASE_PROPERTY_KINDS.map((k) => ({
  key: k, label: BASE_PROPERTY_KIND_LABELS[k], base: k,
}));

export const LAND_RIGHTS = ["ownership", "leasehold"] as const;
export type LandRight = (typeof LAND_RIGHTS)[number];
export const LAND_RIGHT_LABELS: Record<LandRight, string> = { ownership: "所有権", leasehold: "借地権" };

export const BANK_ACCOUNT_TYPES = ["ordinary", "current"] as const;
export type BankAccountType = (typeof BANK_ACCOUNT_TYPES)[number];
export const BANK_ACCOUNT_TYPE_LABELS: Record<BankAccountType, string> = { ordinary: "普通", current: "当座" };
