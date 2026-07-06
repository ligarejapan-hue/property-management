import { describe, it, expect } from "vitest";
import { MANSION_FIELDS, LAND_FIELDS, type SheetField } from "../field-model";
import {
  USE_DISTRICT,
  TAX,
  TRANSACTION_TYPE,
  COMPENSATION,
  AD_TYPE,
  LAND_CATEGORY,
  AREA_METHOD_LAND,
  SETBACK_UNIT,
  PROPERTY_TYPE_LAND,
} from "../option-master";

const byKey = (k: string): SheetField | undefined => MANSION_FIELDS.find((f) => f.key === k);
const byLandKey = (k: string): SheetField | undefined => LAND_FIELDS.find((f) => f.key === k);

describe("MANSION_FIELDS", () => {
  it("価格は number・万円固定", () => {
    const price = byKey("price");
    expect(price?.widget).toBe("number");
    expect(price?.unit).toBe("万円");
  });
  it("用途地域は multiselect・選択肢マスタ・自動反映元zoningDistrict", () => {
    const y = byKey("useDistrict");
    expect(y?.widget).toBe("multiselect");
    expect(y?.options).toEqual(USE_DISTRICT);
    expect(y?.autoFrom).toBe("zoningDistrict");
  });
  it("消費税はselect(課税/不課税)・controlOnly(表の行にしない)", () => {
    const t = byKey("tax");
    expect(t?.widget).toBe("select");
    expect(t?.options).toEqual(TAX);
    expect(t?.controlOnly).toBe(true);
  });
  it("うち消費税は税=課税のときだけ表示", () => {
    const s = byKey("taxAmount");
    expect(s?.showWhen).toEqual({ field: "tax", equals: "課税" });
    expect(s?.unit).toBe("万円");
  });
  it("複数選択はマンションでは用途地域のみ(地目/接道/地域地区/都市計画はF2で追加)", () => {
    for (const k of ["useDistrict"]) {
      expect(byKey(k)?.widget, k).toBe("multiselect");
    }
  });
  it("会社セクション: 取引態様・報酬・広告は select・選択肢マスタ準拠", () => {
    const tt = byKey("transactionType");
    expect(tt?.widget).toBe("select");
    expect(tt?.options).toEqual(TRANSACTION_TYPE);
    expect(tt?.section).toBe("会社");

    const comp = byKey("compensation");
    expect(comp?.widget).toBe("select");
    expect(comp?.options).toEqual(COMPENSATION);
    expect(comp?.section).toBe("会社");

    const ad = byKey("adType");
    expect(ad?.widget).toBe("select");
    expect(ad?.options).toEqual(AD_TYPE);
    expect(ad?.section).toBe("会社");
  });
  it("会社セクション: 担当者・取引士・特記事項は text", () => {
    for (const k of ["staff", "agent", "specialNotes"]) {
      const f = byKey(k);
      expect(f?.widget, k).toBe("text");
      expect(f?.section, k).toBe("会社");
    }
  });
});

describe("LAND_FIELDS（[F2-A Task3]）", () => {
  it("物件種目は select・売土地用の選択肢マスタ(売地/借地権/底地権)", () => {
    const t = byLandKey("propertyType");
    expect(t?.widget).toBe("select");
    expect(t?.options).toEqual(PROPERTY_TYPE_LAND);
    expect(t?.section).toBe("価格");
  });
  it("価格は number・万円固定", () => {
    const price = byLandKey("price");
    expect(price?.widget).toBe("number");
    expect(price?.unit).toBe("万円");
  });
  it("用途地域は multiselect・選択肢マスタ・自動反映元zoningDistrict(マンションと同じ語彙)", () => {
    const y = byLandKey("useDistrict");
    expect(y?.widget).toBe("multiselect");
    expect(y?.options).toEqual(USE_DISTRICT);
    expect(y?.autoFrom).toBe("zoningDistrict");
  });
  it("消費税(tax/taxAmount)キーは存在しない(土地は非課税)", () => {
    expect(LAND_FIELDS.some((f) => f.key === "tax")).toBe(false);
    expect(LAND_FIELDS.some((f) => f.key === "taxAmount")).toBe(false);
  });
  it("地目は multiselect・選択肢マスタ(併記対象)", () => {
    const c = byLandKey("landCategory");
    expect(c?.widget).toBe("multiselect");
    expect(c?.options).toEqual(LAND_CATEGORY);
    expect(c?.section).toBe("土地");
  });
  it("面積計測方式はselect・選択肢マスタ・controlOnly(表の行にせず土地面積へ合成)", () => {
    const m = byLandKey("areaMethod");
    expect(m?.widget).toBe("select");
    expect(m?.options).toEqual(AREA_METHOD_LAND);
    expect(m?.controlOnly).toBe(true);
  });
  it("セットバック単位はselect・選択肢マスタ・controlOnly(表の行にせずセットバックへ合成)", () => {
    const su = byLandKey("setbackUnit");
    expect(su?.widget).toBe("select");
    expect(su?.options).toEqual(SETBACK_UNIT);
    expect(su?.controlOnly).toBe(true);
  });
  it("複数選択は地目/接道方向/都市計画/用途地域/地域地区の5項目", () => {
    for (const k of ["landCategory", "roadDirections", "cityPlanning", "useDistrict", "areaZone"]) {
      expect(byLandKey(k)?.widget, k).toBe("multiselect");
    }
  });
  it("会社セクション: 取引態様・報酬・広告は select・選択肢マスタ準拠(マンションと同じ語彙)", () => {
    const tt = byLandKey("transactionType");
    expect(tt?.widget).toBe("select");
    expect(tt?.options).toEqual(TRANSACTION_TYPE);
    expect(tt?.section).toBe("会社");

    const comp = byLandKey("compensation");
    expect(comp?.widget).toBe("select");
    expect(comp?.options).toEqual(COMPENSATION);
    expect(comp?.section).toBe("会社");

    const ad = byLandKey("adType");
    expect(ad?.widget).toBe("select");
    expect(ad?.options).toEqual(AD_TYPE);
    expect(ad?.section).toBe("会社");
  });
  it("会社セクション: 担当者・取引士・特記事項は text", () => {
    for (const k of ["staff", "agent", "specialNotes"]) {
      const f = byLandKey(k);
      expect(f?.widget, k).toBe("text");
      expect(f?.section, k).toBe("会社");
    }
  });
});
