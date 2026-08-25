import { describe, it, expect } from "vitest";
import { propertyTypeForRaw } from "../property-type-dictionary";

describe("propertyTypeForRaw（物件種別の言い換え）", () => {
  it("実サンプルの2つを変換する", () => {
    expect(propertyTypeForRaw("分譲マンション（区分所有）")).toEqual({
      value: "apartment_unit", confident: true,
    });
    expect(propertyTypeForRaw("一般住宅")).toEqual({ value: "house", confident: true });
  });

  it("よくある言い回しを変換する", () => {
    expect(propertyTypeForRaw("土地").value).toBe("land");
    expect(propertyTypeForRaw("戸建").value).toBe("house");
    expect(propertyTypeForRaw("一戸建て").value).toBe("house");
    expect(propertyTypeForRaw("一棟マンション").value).toBe("apartment_building");
    expect(propertyTypeForRaw("店舗").value).toBe("store");
    expect(propertyTypeForRaw("事務所").value).toBe("office");
  });

  it("⚠知らない種別は unknown にして confident=false（推測で決めない）", () => {
    expect(propertyTypeForRaw("宇宙ステーション")).toEqual({
      value: "unknown", confident: false,
    });
    expect(propertyTypeForRaw("")).toEqual({ value: "unknown", confident: false });
  });

  it("⚠「一棟マンション」を「マンション」より先に判定する（部分一致の順序）", () => {
    expect(propertyTypeForRaw("一棟マンション").value).toBe("apartment_building");
    expect(propertyTypeForRaw("マンション").value).toBe("apartment_unit");
  });
});
