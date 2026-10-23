import { describe, it, expect } from "vitest";
import { normalizeTradeSide, toDealUpdateData, dealChangeValues, DEAL_TRACKED_FIELDS } from "../change-values";
import { buildChangeLogEntries } from "@/lib/change-log";

describe("取引態様", () => {
  it("買取再販では常に空", () => {
    expect(normalizeTradeSide("resale", "both")).toBeNull();
    expect(normalizeTradeSide("brokerage", "both")).toBe("both");
    expect(normalizeTradeSide("brokerage", undefined)).toBeNull();
  });
});

describe("更新データ", () => {
  it("送られた項目だけ・日時は Date にする", () => {
    expect(toDealUpdateData({ name: "新しい名前", contractAt: "2026-07-01T01:30:00.000Z", settlementAt: null }, "brokerage")).toEqual({
      name: "新しい名前", contractAt: new Date("2026-07-01T01:30:00.000Z"), settlementAt: null,
    });
  });
  it("買取再販へ切り替えたら取引態様を空にする(態様を送っていなくても)", () => {
    expect(toDealUpdateData({ businessType: "resale" }, "brokerage")).toEqual({ businessType: "resale", tradeSide: null });
  });
  it("買取再販のまま態様だけ送っても空のまま", () => {
    expect(toDealUpdateData({ tradeSide: "seller" }, "resale")).toEqual({ tradeSide: null });
  });
  it("仲介へ戻すときは送った態様を使う", () => {
    expect(toDealUpdateData({ businessType: "brokerage", tradeSide: "buyer" }, "resale")).toEqual({ businessType: "brokerage", tradeSide: "buyer" });
  });
  it("写しと相手方の仲介会社は、そのまま入れる", () => {
    const broker = { company: "試験不動産", staff: null, tel: null };
    expect(toDealUpdateData({ counterpartyBroker: broker }, "brokerage")).toEqual({ counterpartyBroker: broker });
  });
});

describe("変更履歴の値", () => {
  it("追跡する項目だけ・日時は ISO 文字列", () => {
    const v = dealChangeValues({ name: "a", contractAt: new Date("2026-07-01T01:30:00.000Z"), price: BigInt(1), propertySnapshot: {} });
    expect(v).toEqual({ name: "a", contractAt: "2026-07-01T01:30:00.000Z", price: BigInt(1) });
  });
  it("変わった項目だけが履歴の行になる", () => {
    const old = dealChangeValues({ name: "a", status: "considering", contractAt: null });
    const neu = dealChangeValues({ name: "a", status: "contracted", contractAt: null });
    const rows = buildChangeLogEntries({ targetTable: "deals", targetId: "d", changedBy: "u", oldValues: old, newValues: neu, trackedFields: DEAL_TRACKED_FIELDS });
    expect(rows.map((r) => [r.fieldName, r.oldValue, r.newValue])).toEqual([["status", "considering", "contracted"]]);
  });
});

describe("段2の項目", () => {
  it("金額は BigInt・空は null・JSON はそのまま", () => {
    expect(toDealUpdateData({ price: 1000, deposit: null, leases: [] }, "brokerage")).toEqual({ price: BigInt(1000), deposit: null, leases: [] });
  });
  it("金額と税率も変更履歴に残す", () => {
    expect(DEAL_TRACKED_FIELDS).toEqual(expect.arrayContaining(["price", "deposit", "taxRateBp"]));
  });
});
