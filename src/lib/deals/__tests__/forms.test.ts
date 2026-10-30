import { describe, it, expect } from "vitest";
import { DEFAULT_FUNDING_INPUTS } from "../funding-schema";
import { DEFAULT_BUSINESS_INPUTS } from "../business-schema";
import { agentLabel } from "@/lib/agent-inquiry/desk-form";
import {
  applyBrokerPick, basicFormFromDeal, basicPatch, snapshotFormFromDeal, snapshotFromForm,
  EMPTY_PARTY_FORM, partyBodyFromForm, partyFormFromView,
} from "../forms";
import { EMPTY_PLACE } from "../place";
import { EMPTY_SNAPSHOT, EMPTY_BROKER, DEFAULT_ASSESSMENTS, DEFAULT_COSTS, DEFAULT_TERMS } from "../schemas";
import type { DealView } from "../view";

const deal: DealView = {
  id: "d", dealNo: "2026-0001", name: "試験の取引", businessType: "brokerage", tradeSide: "both", status: "considering",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "unit", hasOc: false,
  contractAt: "2026-07-01T01:30:00.000Z", contractPlace: null, settlementAt: null, settlementPlace: null,
  price: null, buildingTax: null, deposit: null, taxRateBp: 1000,
  propertySnapshot: { ...EMPTY_SNAPSHOT, roomNo: "201", floorArea: 65.4 }, counterpartyBroker: EMPTY_BROKER,
  assessments: DEFAULT_ASSESSMENTS, costs: DEFAULT_COSTS, settlementTerms: DEFAULT_TERMS, leases: [], overrides: {},
  version: 3, createdAt: "", updatedAt: "", parties: [], fundingPlan: DEFAULT_FUNDING_INPUTS, businessPlan: DEFAULT_BUSINESS_INPUTS,
};

describe("基本タブ", () => {
  it("変えた項目だけを送る・日本時間の入力を ISO に・空は null", () => {
    const f = basicFormFromDeal(deal);
    expect(f.contractAt).toBe("2026-07-01T10:30");
    expect(basicPatch(f, deal)).toEqual({});
    expect(basicPatch({
      ...f, status: "contracted", contractAt: "2026-07-02T09:00", tradeSide: "",
      contractPlace: { ...EMPTY_PLACE, kind: "その他", other: "試験区の事務所" },
    }, deal)).toEqual({
      status: "contracted", contractAt: "2026-07-02T00:00:00.000Z", contractPlace: "試験区の事務所", tradeSide: null,
    });
  });
  it("取引名は入力欄にも送る項目にも無い", () => {
    const f = basicFormFromDeal(deal);
    expect(f).not.toHaveProperty("name");
    expect(basicPatch(f, deal)).not.toHaveProperty("name");
  });
  it("決済場所は銀行名と支店名をまとめて送る", () => {
    const f = basicFormFromDeal(deal);
    expect(basicPatch({ ...f, settlementPlace: { ...EMPTY_PLACE, kind: "銀行", bank: "試験銀行", branch: "渋谷支店" } }, deal)).toEqual({
      settlementPlace: "試験銀行　渋谷支店",
    });
  });
  it("場所を未設定に戻すと null・触らなければ送らない", () => {
    const placed = { ...deal, contractPlace: "売主宅" };
    const f = basicFormFromDeal(placed);
    expect(f.contractPlace.kind).toBe("売主宅");
    expect(basicPatch(f, placed)).toEqual({});
    expect(basicPatch({ ...f, contractPlace: EMPTY_PLACE }, placed)).toEqual({ contractPlace: null });
  });
  it("今までの手入力に全角の空白があっても、開いただけでは変更にならない", () => {
    const placed = { ...deal, contractPlace: "試験区役所　会議室" };
    expect(basicPatch(basicFormFromDeal(placed), placed)).toEqual({});
  });
  it("相手方の仲介会社は3項目まとめて送る", () => {
    const f = basicFormFromDeal(deal);
    expect(basicPatch({ ...f, brokerCompany: "試験不動産" }, deal)).toEqual({
      counterpartyBroker: { company: "試験不動産", staff: null, tel: null },
    });
  });
});

describe("相手方の仲介会社を業者一覧から選ぶ", () => {
  const hit = { id: "a", companyName: "試験不動産", branchName: "渋谷支店", phone: "03-1234-5678", lastContact: null, matchedBy: "text" as const };
  it("会社名(支店名つき)と代表電話が入る", () => {
    const next = applyBrokerPick(basicFormFromDeal(deal), hit);
    expect(next.brokerCompany).toBe(agentLabel(hit));
    expect(next.brokerCompany).toContain("渋谷支店");
    expect(next.brokerTel).toBe("03-1234-5678");
  });
  it("別の会社に選び直したら前の担当を消す", () => {
    const f = { ...basicFormFromDeal(deal), brokerCompany: "前の不動産", brokerStaff: "前の担当" };
    expect(applyBrokerPick(f, hit).brokerStaff).toBe("");
  });
  it("初めて選ぶときと同じ会社のときは、入れてある担当を残す", () => {
    const f = { ...basicFormFromDeal(deal), brokerStaff: "試験 太郎" };
    expect(applyBrokerPick(f, hit).brokerStaff).toBe("試験 太郎");
    const same = { ...f, brokerCompany: agentLabel(hit) };
    expect(applyBrokerPick(same, hit).brokerStaff).toBe("試験 太郎");
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
