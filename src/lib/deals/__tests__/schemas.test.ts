import { describe, it, expect } from "vitest";
import {
  dealCreateSchema, dealUpdateSchema, partyInputSchema, partyUpdateSchema,
  dealSettingsUpdateSchema, propertySnapshotSchema, EMPTY_SNAPSHOT,
} from "../schemas";

const UID = "66666666-6666-4666-8666-666666666666";

describe("取引の作成", () => {
  it("名前と事業区分があれば作れる・名前の前後の空白は落とす", () => {
    expect(dealCreateSchema.parse({ name: " 試験の取引 ", businessType: "brokerage" })).toMatchObject({ name: "試験の取引", businessType: "brokerage" });
  });
  it("名前が空・事業区分が知らない値は弾く", () => {
    expect(() => dealCreateSchema.parse({ name: "  ", businessType: "brokerage" })).toThrow();
    expect(() => dealCreateSchema.parse({ name: "a", businessType: "leaseback" })).toThrow();
  });
});

describe("取引の更新", () => {
  it("版の番号が要る・知らない項目は弾く", () => {
    expect(() => dealUpdateSchema.parse({ name: "a" })).toThrow();
    expect(() => dealUpdateSchema.parse({ version: 1, buildingTax: 100 })).toThrow();
  });
  it("空文字の場所は null にする・日時は ISO だけ", () => {
    expect(dealUpdateSchema.parse({ version: 1, contractPlace: " " }).contractPlace).toBeNull();
    expect(dealUpdateSchema.parse({ version: 1, contractAt: "2026-07-01T01:30:00.000Z" }).contractAt).toBe("2026-07-01T01:30:00.000Z");
    expect(() => dealUpdateSchema.parse({ version: 1, contractAt: "2026/07/01" })).toThrow();
  });
  it("担当は UUID か null", () => {
    expect(dealUpdateSchema.parse({ version: 1, assigneeId: UID }).assigneeId).toBe(UID);
    expect(dealUpdateSchema.parse({ version: 1, assigneeId: null }).assigneeId).toBeNull();
    expect(() => dealUpdateSchema.parse({ version: 1, assigneeId: "abc" })).toThrow();
  });
});

describe("物件の写し", () => {
  it("空の写しは検証を通る", () => {
    expect(propertySnapshotSchema.parse(EMPTY_SNAPSHOT)).toEqual(EMPTY_SNAPSHOT);
  });
  it("築月は 1〜12・面積は 0 以上", () => {
    expect(() => propertySnapshotSchema.parse({ ...EMPTY_SNAPSHOT, builtMonth: 13 })).toThrow();
    expect(() => propertySnapshotSchema.parse({ ...EMPTY_SNAPSHOT, landArea: -1 })).toThrow();
  });
});

describe("当事者", () => {
  it("持分は分子・分母の両方か、どちらも無し・分子は分母以下", () => {
    const base = { role: "seller", partyType: "individual", name: "試験 太郎" };
    expect(partyInputSchema.parse({ ...base, shareNum: 1, shareDen: 2 })).toMatchObject({ shareNum: 1, shareDen: 2 });
    expect(() => partyInputSchema.parse({ ...base, shareNum: 1 })).toThrow();
    expect(() => partyInputSchema.parse({ ...base, shareNum: 3, shareDen: 2 })).toThrow();
    expect(partyInputSchema.parse(base).isSelf).toBe(false);
  });
  it("更新は版の番号つきの一部だけでよい", () => {
    expect(partyUpdateSchema.parse({ version: 2, phone: "03-0000-0000" })).toEqual({ version: 2, phone: "03-0000-0000" });
  });
});

describe("取引の設定", () => {
  it("物件種別は基本の4つを必ず含み、鍵が重ならない", () => {
    const four = [
      { key: "unit", label: "区分マンション", base: "unit" }, { key: "house", label: "戸建", base: "house" },
      { key: "land", label: "土地", base: "land" }, { key: "building", label: "一棟", base: "building" },
    ];
    expect(dealSettingsUpdateSchema.parse({ version: 0, propertyKinds: [...four, { key: "shop_unit", label: "店舗区分", base: "unit" }] }).propertyKinds).toHaveLength(5);
    expect(() => dealSettingsUpdateSchema.parse({ version: 0, propertyKinds: four.slice(1) })).toThrow();
    expect(() => dealSettingsUpdateSchema.parse({ version: 0, propertyKinds: [...four, four[0]] })).toThrow();
    expect(() => dealSettingsUpdateSchema.parse({ version: 0, propertyKinds: [...four, { key: "Bad Key", label: "x", base: "unit" }] })).toThrow();
  });
  it("基本の4種別は元の種別を変えられない(M1)", () => {
    const four = [
      { key: "unit", label: "区分マンション", base: "unit" }, { key: "house", label: "戸建", base: "house" },
      { key: "land", label: "土地", base: "land" }, { key: "building", label: "一棟", base: "building" },
    ];
    expect(() => dealSettingsUpdateSchema.parse({ version: 1, propertyKinds: [{ ...four[0], base: "land" }, ...four.slice(1)] })).toThrow();
  });
  it("口座番号は数字7桁まで", () => {
    expect(() => dealSettingsUpdateSchema.parse({ version: 1, bankAccount: { bankName: null, branchName: null, accountType: "ordinary", accountNumber: "12a4567", accountHolder: null } })).toThrow();
  });
});
