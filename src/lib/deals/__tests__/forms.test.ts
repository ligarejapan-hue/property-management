import { describe, it, expect } from "vitest";
import { DEFAULT_FUNDING_INPUTS } from "../funding-schema";
import {
  basicFormFromDeal, basicPatch, snapshotFormFromDeal, snapshotFromForm,
  EMPTY_PARTY_FORM, partyBodyFromForm, partyFormFromView,
} from "../forms";
import { EMPTY_SNAPSHOT, EMPTY_BROKER, DEFAULT_ASSESSMENTS, DEFAULT_COSTS, DEFAULT_TERMS } from "../schemas";
import type { DealView } from "../view";

const deal: DealView = {
  id: "d", dealNo: "2026-0001", name: "試験の取引", businessType: "brokerage", tradeSide: "both", status: "considering",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "unit", hasOc: false,
  contractAt: "2026-07-01T01:30:00.000Z", contractPlace: null, settlementAt: null, settlementPlace: null,
  price: null, buildingTax: null, deposit: null, taxRateBp: 1000,
  propertySnapshot: { ...EMPTY_SNAPSHOT, roomNo: "201", floorArea: 65.4 }, counterpartyBroker: EMPTY_BROKER,
  assessments: DEFAULT_ASSESSMENTS, costs: DEFAULT_COSTS, settlementTerms: DEFAULT_TERMS, leases: [], overrides: {},
  version: 3, createdAt: "", updatedAt: "", parties: [], fundingPlan: DEFAULT_FUNDING_INPUTS,
};

describe("基本タブ", () => {
  it("変えた項目だけを送る・日本時間の入力を ISO に・空は null", () => {
    const f = basicFormFromDeal(deal);
    expect(f.contractAt).toBe("2026-07-01T10:30");
    expect(basicPatch(f, deal)).toEqual({});
    expect(basicPatch({ ...f, status: "contracted", contractAt: "2026-07-02T09:00", contractPlace: "試験区の事務所", tradeSide: "" }, deal)).toEqual({
      status: "contracted", contractAt: "2026-07-02T00:00:00.000Z", contractPlace: "試験区の事務所", tradeSide: null,
    });
  });
  it("相手方の仲介会社は3項目まとめて送る", () => {
    const f = basicFormFromDeal(deal);
    expect(basicPatch({ ...f, brokerCompany: "試験不動産" }, deal)).toEqual({
      counterpartyBroker: { company: "試験不動産", staff: null, tel: null },
    });
  });
});

describe("物件タブ", () => {
  it("数の欄は数に・読めなければ null", () => {
    const f = snapshotFormFromDeal(deal);
    expect(f.floorArea).toBe("65.4");
    expect(snapshotFromForm({ ...f, landArea: "120.5", builtYear: "abc", landRight: "leasehold" })).toEqual({
      ...EMPTY_SNAPSHOT, roomNo: "201", floorArea: 65.4, landArea: 120.5, builtYear: null, landRight: "leasehold",
    });
  });
});

describe("当事者", () => {
  it("空は null・持分は数", () => {
    expect(partyBodyFromForm({ ...EMPTY_PARTY_FORM, name: "試験 太郎", shareNum: "1", shareDen: "2" })).toEqual({
      role: "seller", partyType: "individual", name: "試験 太郎", representative: null, address: null, phone: null,
      shareNum: 1, shareDen: 2, isSelf: false,
    });
  });
  it("保存済みから入力の形へ", () => {
    const f = partyFormFromView({ id: "p", role: "buyer", partyType: "corporation", name: "試験株式会社", representative: null, address: null, phone: null, shareNum: null, shareDen: null, isSelf: false, sortOrder: 0, version: 1 });
    expect(f).toMatchObject({ role: "buyer", partyType: "corporation", name: "試験株式会社", shareNum: "", representative: "" });
  });
});
