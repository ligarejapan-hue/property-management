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
  it("⚠両方あるときは家屋番号だけを渡す（渡す番号は1つ・設計 §3.1.2）", () => {
    // 両方渡すと provider の土地/建物の判定と呼び出し側の意図が二重管理になる。
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
        lotNumber: null,
        buildingNumber: "31番",
        ref: "prop-1",
      },
    });
  });

  it("⚠address だけでは検索できない（サイトに渡す番号が無い・設計 §4.4）", () => {
    // 番号なしで検索すると、その地番区域が丸ごと候補になり選びようがない。
    const r = buildRegistrySearchRequest({ ...base, address: "東京都〇〇区" });
    expect(r).toEqual({ searchable: false, reason: "missing_identifier" });
  });

  it("地番だけあれば検索できる（土地として）", () => {
    const r = buildRegistrySearchRequest({
      ...base,
      address: "東京都〇〇区",
      lotNumber: "69-2",
    });
    expect(r.searchable).toBe(true);
    if (r.searchable) {
      expect(r.request.lotNumber).toBe("69-2");
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

  it("空白だけの地番/家屋番号は「無い」と同じ扱い（missing_identifier）", () => {
    // 以前は null に正規化して検索へ進んでいたが、番号なしでは候補を選べない。
    const r = buildRegistrySearchRequest({
      ...base,
      address: "東京都〇〇区",
      lotNumber: "   ",
      buildingNumber: "",
    });
    expect(r).toEqual({ searchable: false, reason: "missing_identifier" });
  });

  it("補正前値（originalAddress/originalLotNumber）は使わない（入力に存在しない）", () => {
    // RegistrySearchSource は補正前フィールドを持たない＝補正前にフォールバックしない契約。
    const keys = Object.keys(base);
    expect(keys).not.toContain("originalAddress");
    expect(keys).not.toContain("originalLotNumber");
  });
});

// ---------------------------------------------------------------------------
// 番号が無い/読めない（設計 §4.4）
// ---------------------------------------------------------------------------

describe("番号が無い/読めない", () => {
  const withAddress: RegistrySearchSource = {
    ...base,
    address: "神奈川県横浜市南区井土ケ谷中町",
    ref: "p1",
  };

  it("⚠地番も家屋番号も無ければ missing_identifier", () => {
    expect(buildRegistrySearchRequest(withAddress)).toEqual({
      searchable: false,
      reason: "missing_identifier",
    });
  });

  it("⚠読めない形なら malformed_identifier（別の筆を探させない）", () => {
    expect(
      buildRegistrySearchRequest({ ...withAddress, lotNumber: "abc1x2" }),
    ).toEqual({ searchable: false, reason: "malformed_identifier" });
  });

  it("既存の表記（1番地2 / 1ノ2）は今までどおり通る", () => {
    for (const lotNumber of ["1番地2", "1ノ2", "69ー2"]) {
      expect(
        buildRegistrySearchRequest({ ...withAddress, lotNumber }).searchable,
      ).toBe(true);
    }
  });

  it("住所が無いときは番号より先に insufficient_location を返す", () => {
    expect(
      buildRegistrySearchRequest({ ...base, address: null, lotNumber: null }),
    ).toEqual({ searchable: false, reason: "insufficient_location" });
  });

  it("不動産番号があるときは番号の検査をしない（従来どおり）", () => {
    expect(
      buildRegistrySearchRequest({
        ...withAddress,
        realEstateNumber: "0413234567890",
        lotNumber: "abc1x2",
      }),
    ).toEqual({ searchable: false, reason: "has_real_estate_number" });
  });
});

describe("渡す番号は1つだけ（設計 §3.1.2）", () => {
  const withAddress: RegistrySearchSource = {
    ...base,
    address: "神奈川県横浜市南区井土ケ谷中町",
    ref: "p1",
  };

  it("家屋番号があれば家屋番号だけ（建物として検索させる）", () => {
    const r = buildRegistrySearchRequest({
      ...withAddress,
      lotNumber: "69-2",
      buildingNumber: "12-3",
    });
    expect(r.searchable).toBe(true);
    if (r.searchable) {
      expect(r.request.buildingNumber).toBe("12-3");
      expect(r.request.lotNumber).toBeNull();
    }
  });

  it("家屋番号が無ければ地番だけ（土地として検索させる）", () => {
    const r = buildRegistrySearchRequest({ ...withAddress, lotNumber: "69-2" });
    expect(r.searchable).toBe(true);
    if (r.searchable) {
      expect(r.request.lotNumber).toBe("69-2");
      expect(r.request.buildingNumber).toBeNull();
    }
  });

  it("⚠優先された家屋番号が読めない形なら、地番へ勝手に落ちない", () => {
    // 落とすと、利用者が意図しない土地の登記を買うことになる。
    expect(
      buildRegistrySearchRequest({
        ...withAddress,
        lotNumber: "69-2",
        buildingNumber: "abc",
      }),
    ).toEqual({ searchable: false, reason: "malformed_identifier" });
  });
});
