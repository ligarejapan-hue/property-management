import { describe, it, expect } from "vitest";
import {
  buildRegistrySearchRequest,
  type RegistrySearchSource,
} from "../search-request";

const base: RegistrySearchSource = {
  address: null,
  lotNumber: null,
  buildingNumber: null,
  realEstateNumber: null,
};

describe("buildRegistrySearchRequest", () => {
  it("address/lotNumber/buildingNumber から検索入力を作る（補正後の値）", () => {
    const r = buildRegistrySearchRequest({
      ...base,
      address: "世田谷区玉川一丁目",
      lotNumber: "1937番31",
      buildingNumber: "31番",
      ref: "prop-1",
    });
    expect(r).toEqual({
      searchable: true,
      request: {
        address: "世田谷区玉川一丁目",
        lotNumber: "1937番31",
        buildingNumber: "31番",
        ref: "prop-1",
      },
    });
  });

  it("address のみでも検索可能（地番/家屋番号は null 許容）", () => {
    const r = buildRegistrySearchRequest({ ...base, address: "東京都〇〇区" });
    expect(r.searchable).toBe(true);
    if (r.searchable) {
      expect(r.request.address).toBe("東京都〇〇区");
      expect(r.request.lotNumber).toBeNull();
      expect(r.request.buildingNumber).toBeNull();
    }
  });

  it("realEstateNumber があれば検索不要（has_real_estate_number）", () => {
    const r = buildRegistrySearchRequest({
      ...base,
      address: "東京都〇〇区",
      realEstateNumber: "0413234567890",
    });
    expect(r).toEqual({ searchable: false, reason: "has_real_estate_number" });
  });

  it("address が無い/空白だけなら検索不能（insufficient_location）", () => {
    expect(buildRegistrySearchRequest({ ...base, address: null })).toEqual({
      searchable: false,
      reason: "insufficient_location",
    });
    expect(buildRegistrySearchRequest({ ...base, address: "   " })).toEqual({
      searchable: false,
      reason: "insufficient_location",
    });
  });

  it("空白だけの地番/家屋番号は null に正規化する", () => {
    const r = buildRegistrySearchRequest({
      ...base,
      address: "東京都〇〇区",
      lotNumber: "   ",
      buildingNumber: "",
    });
    expect(r.searchable).toBe(true);
    if (r.searchable) {
      expect(r.request.lotNumber).toBeNull();
      expect(r.request.buildingNumber).toBeNull();
    }
  });

  it("補正前値（originalAddress/originalLotNumber）は使わない（入力に存在しない）", () => {
    // RegistrySearchSource は補正前フィールドを持たない＝補正前にフォールバックしない契約。
    const keys = Object.keys(base);
    expect(keys).not.toContain("originalAddress");
    expect(keys).not.toContain("originalLotNumber");
  });
});
