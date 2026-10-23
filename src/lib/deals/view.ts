import type { Prisma } from "@/generated/prisma";
import { readBroker, readSnapshot } from "./snapshot";
import { readAssessments, readCosts, readLeases, readOverrides, readTerms } from "./inputs";
import type { Assessments, CounterpartyBroker, Costs, Lease, Overrides, PropertySnapshot, SettlementTerms } from "./schemas";

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const yen = (v: bigint | null) => (v === null ? null : Number(v));
const userName = { select: { id: true, name: true } } as const;

export const DEAL_LIST_SELECT = {
  id: true, dealNo: true, name: true, businessType: true, status: true, contractAt: true, settlementAt: true,
  assignee: userName,
} satisfies Prisma.DealSelect;

export interface DealListItem {
  id: string; dealNo: string; name: string; businessType: string; status: string;
  contractAt: string | null; settlementAt: string | null; assigneeName: string | null;
}

export function toDealListItem(r: Prisma.DealGetPayload<{ select: typeof DEAL_LIST_SELECT }>): DealListItem {
  return {
    id: r.id, dealNo: r.dealNo, name: r.name, businessType: r.businessType, status: r.status,
    contractAt: iso(r.contractAt), settlementAt: iso(r.settlementAt), assigneeName: r.assignee?.name ?? null,
  };
}

export const DEAL_PARTY_SELECT = {
  id: true, role: true, partyType: true, name: true, representative: true, address: true, phone: true,
  shareNum: true, shareDen: true, isSelf: true, sortOrder: true, version: true,
} satisfies Prisma.DealPartySelect;
export type DealPartyView = Prisma.DealPartyGetPayload<{ select: typeof DEAL_PARTY_SELECT }>;

export const DEAL_DETAIL_SELECT = {
  id: true, dealNo: true, name: true, businessType: true, tradeSide: true, status: true,
  assigneeId: true, licensedAgentId: true, salesStaffId: true, opsStaffId: true,
  propertyId: true, propertyKind: true, hasOc: true,
  contractAt: true, contractPlace: true, settlementAt: true, settlementPlace: true,
  price: true, buildingTax: true, deposit: true, taxRateBp: true,
  propertySnapshot: true, counterpartyBroker: true, version: true, createdAt: true, updatedAt: true,
  assessments: true, costs: true, settlementTerms: true, leases: true, overrides: true,
  parties: { select: DEAL_PARTY_SELECT, orderBy: [{ role: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }] },
} satisfies Prisma.DealSelect;

export interface DealView {
  id: string; dealNo: string; name: string; businessType: string; tradeSide: string | null; status: string;
  assigneeId: string | null; licensedAgentId: string | null; salesStaffId: string | null; opsStaffId: string | null;
  propertyId: string | null; propertyKind: string | null; hasOc: boolean;
  contractAt: string | null; contractPlace: string | null; settlementAt: string | null; settlementPlace: string | null;
  price: number | null; buildingTax: number | null; deposit: number | null; taxRateBp: number;
  propertySnapshot: PropertySnapshot; counterpartyBroker: CounterpartyBroker;
  assessments: Assessments; costs: Costs; settlementTerms: SettlementTerms; leases: Lease[]; overrides: Overrides;
  version: number; createdAt: string; updatedAt: string; parties: DealPartyView[];
}

export function toDealView(r: Prisma.DealGetPayload<{ select: typeof DEAL_DETAIL_SELECT }>): DealView {
  return {
    id: r.id, dealNo: r.dealNo, name: r.name, businessType: r.businessType, tradeSide: r.tradeSide, status: r.status,
    assigneeId: r.assigneeId, licensedAgentId: r.licensedAgentId, salesStaffId: r.salesStaffId, opsStaffId: r.opsStaffId,
    propertyId: r.propertyId, propertyKind: r.propertyKind, hasOc: r.hasOc,
    contractAt: iso(r.contractAt), contractPlace: r.contractPlace, settlementAt: iso(r.settlementAt), settlementPlace: r.settlementPlace,
    price: yen(r.price), buildingTax: yen(r.buildingTax), deposit: yen(r.deposit), taxRateBp: r.taxRateBp,
    propertySnapshot: readSnapshot(r.propertySnapshot), counterpartyBroker: readBroker(r.counterpartyBroker),
    assessments: readAssessments(r.assessments), costs: readCosts(r.costs), settlementTerms: readTerms(r.settlementTerms),
    leases: readLeases(r.leases), overrides: readOverrides(r.overrides),
    version: r.version, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), parties: r.parties,
  };
}
