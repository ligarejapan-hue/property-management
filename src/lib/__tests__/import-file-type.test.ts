import { describe, it, expect } from "vitest";
import {
  detectImportFileType,
  normalizeReceptionKeyPart,
  buildReceptionMatchKey,
  buildOwnerMatchKey,
  classifyReceptionKColumn,
  splitReceptionK,
} from "../import-file-type";

describe("detectImportFileType", () => {
  it("ファイル名に「受付帳」を含めば reception", () => {
    const r = detectImportFileType("2026-04_受付帳.csv");
    expect(r.type).toBe("reception");
    expect(r.label).toBe("受付帳として認識");
    expect(r.error).toBeNull();
  });

  it("ファイル名に「所有者」を含めば owner", () => {
    const r = detectImportFileType("所有者リスト_20260423.csv");
    expect(r.type).toBe("owner");
    expect(r.label).toBe("所有者として認識");
  });

  it("両方含めば ambiguous + エラー", () => {
    const r = detectImportFileType("受付帳_所有者_merge.csv");
    expect(r.type).toBe("ambiguous");
    expect(r.label).toBeNull();
    expect(r.error).toMatch(/曖昧/);
  });

  it("どちらも含まなければ unknown + エラー", () => {
    const r = detectImportFileType("random.csv");
    expect(r.type).toBe("unknown");
    expect(r.error).toMatch(/受付帳.*所有者/);
  });

  it("null/空文字は unknown", () => {
    expect(detectImportFileType(null).type).toBe("unknown");
    expect(detectImportFileType("").type).toBe("unknown");
  });
});

describe("normalizeReceptionKeyPart", () => {
  it("NFKC で全角英数を半角化", () => {
    expect(normalizeReceptionKeyPart("ＡＢＣ１２３")).toBe("ABC123");
  });

  it("各種ハイフン類を - に統一", () => {
    expect(normalizeReceptionKeyPart("1\u20102\u20113\u20124\u20135\u20146")).toBe(
      "1-2-3-4-5-6",
    );
    expect(normalizeReceptionKeyPart("1\uFF0D2")).toBe("1-2");
  });

  it("空白（半角/全角/タブ）はすべて除去", () => {
    expect(normalizeReceptionKeyPart("　ABC 　\t123 ")).toBe("ABC123");
  });

  it("null/undefined は空文字", () => {
    expect(normalizeReceptionKeyPart(null)).toBe("");
    expect(normalizeReceptionKeyPart(undefined)).toBe("");
  });
});

describe("buildReceptionMatchKey / buildOwnerMatchKey", () => {
  it("受付帳 HIJK を区切りなし連結してキー化する", () => {
    const key = buildReceptionMatchKey({
      h: "東京都",
      i: "港区",
      j: "1-2-3",
      k: "100",
    });
    expect(key).toBe("東京都港区1-2-3100");
  });

  it("所有者 C 列が同じ正規化ルールで等しくなる", () => {
    const reception = buildReceptionMatchKey({
      h: "東京都",
      i: "港区",
      j: "１－２－３",
      k: "１００",
    });
    const owner = buildOwnerMatchKey("東京都 港区 1\u20132-3 100");
    expect(reception).toBe(owner);
  });

  it("null/undefined パーツは空扱い", () => {
    expect(buildReceptionMatchKey({ h: null, i: null, j: "x", k: "y" })).toBe(
      "xy",
    );
  });
});

describe("classifyReceptionKColumn / splitReceptionK", () => {
  it("F列=土地 → K列は地番", () => {
    expect(classifyReceptionKColumn("土地")).toBe("lotNumber");
    expect(splitReceptionK("土地", "100-1")).toEqual({
      lotNumber: "100-1",
      buildingNumber: null,
    });
  });

  it("F列=建物 → K列は家屋番号", () => {
    expect(classifyReceptionKColumn("建物")).toBe("buildingNumber");
    expect(splitReceptionK("建物", "100-1")).toEqual({
      lotNumber: null,
      buildingNumber: "100-1",
    });
  });

  it("F列=区分 → K列は家屋番号", () => {
    expect(classifyReceptionKColumn("区分")).toBe("buildingNumber");
    expect(splitReceptionK("区分", "A-101")).toEqual({
      lotNumber: null,
      buildingNumber: "A-101",
    });
  });

  it("F列=区建（区分建物の略記）→ K列は家屋番号", () => {
    expect(classifyReceptionKColumn("区建")).toBe("buildingNumber");
    expect(splitReceptionK("区建", "1088-1-7")).toEqual({
      lotNumber: null,
      buildingNumber: "1088-1-7",
    });
  });

  it("F列が想定外は ambiguous、両方 null", () => {
    expect(classifyReceptionKColumn("未定")).toBe("ambiguous");
    expect(splitReceptionK("未定", "100")).toEqual({
      lotNumber: null,
      buildingNumber: null,
    });
    expect(splitReceptionK(null, "100")).toEqual({
      lotNumber: null,
      buildingNumber: null,
    });
  });

  it("K列が空なら両方 null", () => {
    expect(splitReceptionK("土地", "")).toEqual({
      lotNumber: null,
      buildingNumber: null,
    });
  });
});
