import { isoToJstLocal, jstLocalToIso } from "./datetime";
import { agentLabel } from "@/lib/agent-inquiry/desk-form";
import type { AgentHit } from "@/lib/api-client";
import { composePlace, parsePlace, type PlaceForm } from "./place";
import { EMPTY_SNAPSHOT, type PropertySnapshot } from "./schemas";
import type { DealPartyView, DealView } from "./view";

const nn = (v: string) => (v.trim() === "" ? null : v.trim());

export interface BasicForm {
  businessType: string; tradeSide: string; status: string;
  assigneeId: string; licensedAgentId: string; salesStaffId: string; opsStaffId: string;
  propertyKind: string; hasOc: boolean;
  contractAt: string; contractPlace: PlaceForm; settlementAt: string; settlementPlace: PlaceForm;
  brokerCompany: string; brokerStaff: string; brokerTel: string;
}

export function basicFormFromDeal(d: DealView): BasicForm {
  return {
    businessType: d.businessType, tradeSide: d.tradeSide ?? "", status: d.status,
    assigneeId: d.assigneeId ?? "", licensedAgentId: d.licensedAgentId ?? "", salesStaffId: d.salesStaffId ?? "", opsStaffId: d.opsStaffId ?? "",
    propertyKind: d.propertyKind ?? "", hasOc: d.hasOc,
    contractAt: isoToJstLocal(d.contractAt), contractPlace: parsePlace(d.contractPlace, false),
    settlementAt: isoToJstLocal(d.settlementAt), settlementPlace: parsePlace(d.settlementPlace, true),
    brokerCompany: d.counterpartyBroker.company ?? "", brokerStaff: d.counterpartyBroker.staff ?? "", brokerTel: d.counterpartyBroker.tel ?? "",
  };
}

const NULLABLE_TEXT = ["tradeSide", "assigneeId", "licensedAgentId", "salesStaffId", "opsStaffId", "propertyKind"] as const;

/** 読み込んだときから変わった項目だけ(PATCH は部分更新)。 */
export function basicPatch(f: BasicForm, d: DealView): Record<string, unknown> {
  const base = basicFormFromDeal(d);
  const out: Record<string, unknown> = {};
  if (f.businessType !== base.businessType) out.businessType = f.businessType;
  if (f.status !== base.status) out.status = f.status;
  if (f.hasOc !== base.hasOc) out.hasOc = f.hasOc;
  for (const k of NULLABLE_TEXT) if (f[k] !== base[k]) out[k] = nn(f[k]);
  for (const k of ["contractAt", "settlementAt"] as const) if (f[k] !== base[k]) out[k] = jstLocalToIso(f[k]);
  for (const k of ["contractPlace", "settlementPlace"] as const) {
    const place = composePlace(f[k]);
    if (place !== composePlace(base[k])) out[k] = nn(place);
  }
  if (f.brokerCompany !== base.brokerCompany || f.brokerStaff !== base.brokerStaff || f.brokerTel !== base.brokerTel) {
    out.counterpartyBroker = { company: nn(f.brokerCompany), staff: nn(f.brokerStaff), tel: nn(f.brokerTel) };
  }
  return out;
}

/** 業者一覧から選んだ会社を入れる。別の会社に変えたら、前の会社の担当は残さない。 */
export function applyBrokerPick(f: BasicForm, hit: AgentHit): BasicForm {
  const company = agentLabel(hit);
  const changed = f.brokerCompany.trim() !== "" && f.brokerCompany.trim() !== company;
  return { ...f, brokerCompany: company, brokerTel: hit.phone, brokerStaff: changed ? "" : f.brokerStaff };
}

export type SnapshotForm = Record<keyof PropertySnapshot, string>;
const NUMBER_KEYS = ["builtYear", "builtMonth", "floorArea", "landArea"] as const;

export function snapshotFormFromDeal(d: DealView): SnapshotForm {
  const s = d.propertySnapshot;
  const out = {} as SnapshotForm;
  for (const k of Object.keys(EMPTY_SNAPSHOT) as (keyof PropertySnapshot)[]) out[k] = s[k] === null ? "" : String(s[k]);
  return out;
}

export function snapshotFromForm(f: SnapshotForm): PropertySnapshot {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(EMPTY_SNAPSHOT) as (keyof PropertySnapshot)[]) {
    if ((NUMBER_KEYS as readonly string[]).includes(k)) {
      const n = Number(f[k]);
      out[k] = f[k].trim() === "" || !Number.isFinite(n) ? null : n;
    } else if (k === "landRight") {
      out[k] = f[k] === "ownership" || f[k] === "leasehold" ? f[k] : null;
    } else {
      out[k] = nn(f[k]);
    }
  }
  return out as PropertySnapshot;
}

export interface PartyForm {
  role: string; partyType: string; name: string; representative: string; address: string; phone: string;
  shareNum: string; shareDen: string; isSelf: boolean;
}
export const EMPTY_PARTY_FORM: PartyForm = {
  role: "seller", partyType: "individual", name: "", representative: "", address: "", phone: "", shareNum: "", shareDen: "", isSelf: false,
};

export function partyFormFromView(p: DealPartyView): PartyForm {
  return {
    role: p.role, partyType: p.partyType, name: p.name, representative: p.representative ?? "", address: p.address ?? "",
    phone: p.phone ?? "", shareNum: p.shareNum === null ? "" : String(p.shareNum), shareDen: p.shareDen === null ? "" : String(p.shareDen),
    isSelf: p.isSelf,
  };
}

const intOrNull = (v: string) => {
  const n = Number(v);
  return v.trim() === "" || !Number.isInteger(n) ? null : n;
};

export function partyBodyFromForm(f: PartyForm) {
  return {
    role: f.role, partyType: f.partyType, name: f.name.trim(), representative: nn(f.representative), address: nn(f.address),
    phone: nn(f.phone), shareNum: intOrNull(f.shareNum), shareDen: intOrNull(f.shareDen), isSelf: f.isSelf,
  };
}
