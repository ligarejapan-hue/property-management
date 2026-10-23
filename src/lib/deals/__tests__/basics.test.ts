import { describe, it, expect } from "vitest";
import {
  DEAL_STATUSES, DEAL_STATUS_LABELS, DEAL_BUSINESS_TYPE_LABELS, DEAL_TRADE_SIDE_LABELS,
  DEAL_PARTY_ROLE_LABELS, DEFAULT_PROPERTY_KINDS,
} from "../constants";
import { propertyKindFromPropertyType } from "../property-kind";
import { jstYear, nextDealNo } from "../deal-no";
import { jstDateString, isoToJstLocal, jstLocalToIso, formatJstDateTime } from "../datetime";

describe("選択肢", () => {
  it("状態は4つで、日本語名がある", () => {
    expect(DEAL_STATUSES).toEqual(["considering", "contracted", "settled", "cancelled"]);
    expect(DEAL_STATUS_LABELS).toEqual({ considering: "検討中", contracted: "契約済", settled: "決済済", cancelled: "中止" });
  });
  it("事業区分・取引態様・当事者の役割の日本語名", () => {
    expect(DEAL_BUSINESS_TYPE_LABELS).toEqual({ brokerage: "仲介", resale: "買取再販" });
    expect(DEAL_TRADE_SIDE_LABELS).toEqual({ seller: "売主側", buyer: "買主側", both: "両手" });
    expect(DEAL_PARTY_ROLE_LABELS).toEqual({ seller: "売主", buyer: "買主", agent: "代理人", tenant: "賃借人" });
  });
  it("物件種別の初期値は4つ", () => {
    expect(DEFAULT_PROPERTY_KINDS.map((k) => [k.key, k.label, k.base])).toEqual([
      ["unit", "区分マンション", "unit"],
      ["house", "戸建", "house"],
      ["land", "土地", "land"],
      ["building", "一棟", "building"],
    ]);
  });
});

describe("物件の種類 → 取引の物件種別", () => {
  it.each([
    ["apartment_unit", "unit"], ["unit", "unit"],
    ["house", "house"], ["land", "land"],
    ["apartment_building", "building"], ["apartment_block", "building"], ["building", "building"],
    ["store", null], ["parking", null], ["unknown", null],
  ])("%s → %s", (t, k) => {
    expect(propertyKindFromPropertyType(t)).toBe(k);
  });
});

describe("取引番号", () => {
  it("日本時間の年で数える(UTC の大晦日 15:00 は日本の元日)", () => {
    expect(jstYear(new Date("2026-12-31T14:59:59Z"))).toBe(2026);
    expect(jstYear(new Date("2026-12-31T15:00:00Z"))).toBe(2027);
  });
  it("その年の最初は 0001、次は1つ足す、前の年の番号は無視する", () => {
    expect(nextDealNo(2026, null)).toBe("2026-0001");
    expect(nextDealNo(2026, "2026-0041")).toBe("2026-0042");
    expect(nextDealNo(2027, "2026-0041")).toBe("2027-0001");
  });
  it("1年に 9999 件を超えたら止める", () => {
    expect(() => nextDealNo(2026, "2026-9999")).toThrow();
  });
});

describe("日時", () => {
  it("日本時間の日付", () => {
    expect(jstDateString(new Date("2026-06-30T15:00:00Z"))).toBe("2026-07-01");
  });
  it("ISO と画面の入力(日本時間)を行き来する", () => {
    expect(isoToJstLocal("2026-07-01T01:30:00.000Z")).toBe("2026-07-01T10:30");
    expect(jstLocalToIso("2026-07-01T10:30")).toBe("2026-07-01T01:30:00.000Z");
    expect(isoToJstLocal(null)).toBe("");
    expect(jstLocalToIso("")).toBeNull();
  });
  it("表示用", () => {
    expect(formatJstDateTime("2026-07-01T01:30:00.000Z")).toBe("2026/07/01 10:30");
    expect(formatJstDateTime(null)).toBe("");
  });
});
