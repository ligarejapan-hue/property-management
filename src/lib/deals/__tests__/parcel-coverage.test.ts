import { describe, expect, it } from "vitest";
import { expectedParcels, parcelCoverage, parcelNumberKey } from "../parcel-coverage";

const extra = (kind: "land" | "building", number: string, o: { location?: string; realEstateNumber?: string } = {}) => (
  { id: `${kind}-${number}`, kind, location: o.location ?? null, number, realEstateNumber: o.realEstateNumber ?? null, area: null }
);
const BOTH = ["土地", "建物"] as const;

describe("地番・家屋番号の比べる形", () => {
  it("書き方の違いをそろえる", () => {
    for (const v of ["1番1", "1番地1", "1-1", "１番１", " 1番1 "]) expect(parcelNumberKey(v)).toBe("1-1");
    expect(parcelNumberKey("12番")).toBe("12");
    expect(parcelNumberKey("")).toBeNull();
    expect(parcelNumberKey(null)).toBeNull();
  });
});

describe("謄本が要る筆(棟)", () => {
  it("ほかの土地・建物が無ければ空(筆ごとには見ない)", () => {
    expect(expectedParcels({ lotNumber: "1番", buildingNumber: "1番1", extraParcels: [] }, BOTH)).toEqual([]);
    expect(expectedParcels({ lotNumber: "1番", buildingNumber: null, extraParcels: "壊れた" }, BOTH)).toEqual([]);
  });
  it("1筆目・1棟目と足した行を並べる・要らない種類と空の番号は外す", () => {
    const ps = expectedParcels({
      lotNumber: "1番", buildingNumber: " ", extraParcels: [extra("land", "2番", { location: "架空町二丁目" }), extra("building", "1番2")],
    }, ["土地"]);
    expect(ps.map((p) => p.label)).toEqual(["土地 1番", "土地 架空町二丁目 2番"]);
  });
});

describe("謄本が無い筆(棟)", () => {
  const expected = expectedParcels({
    lotNumber: "1番", buildingNumber: "1番1", extraParcels: [extra("land", "2番", { realEstateNumber: "1234-5678" })],
  }, BOTH);
  it("種類と番号で比べる(土地の1番と建物の1番は別)", () => {
    expect(parcelCoverage(expected, [{ side: "建物", number: "1番", realEstateNumber: null, address: null }]).missing).toEqual(["土地 1番", "建物 1番1", "土地 2番"]);
  });
  it("不動産番号が両方にあれば不動産番号で比べる(番号が同じでも別の不動産番号なら違う筆)", () => {
    const c = parcelCoverage(expected, [
      { side: "土地", number: "1番", realEstateNumber: null, address: null },
      { side: "建物", number: "1番1", realEstateNumber: "9999", address: null },
      { side: "土地", number: "2番", realEstateNumber: "99999999", address: null },
    ]);
    expect(c).toEqual({ missing: ["土地 2番"], unplaced: false });
    expect(parcelCoverage(expected, [
      { side: "土地", number: "1番", realEstateNumber: null, address: null },
      { side: "建物", number: "1番1", realEstateNumber: null, address: null },
      { side: "土地", number: null, realEstateNumber: "12345678", address: null },
    ])).toEqual({ missing: [], unplaced: false });
  });
  it("★同じ番号の筆は所在で分ける・決められなければ unplaced(1通で2筆を満たさない・@codex P1)", () => {
    const twins = expectedParcels({ lotNumber: "1番", buildingNumber: null, address: "架空市架空町一丁目3", extraParcels: [extra("land", "1番", { location: "架空町二丁目" })] }, ["土地"]);
    const cert = (address: string | null) => ({ side: "土地" as const, number: "1番", realEstateNumber: null, address });
    expect(parcelCoverage(twins, [cert("架空市架空町二丁目")])).toEqual({ missing: ["土地 1番"], unplaced: false });
    expect(parcelCoverage(twins, [cert("架空市架空町一丁目")])).toEqual({ missing: ["土地 架空町二丁目 1番"], unplaced: false });
    expect(parcelCoverage(twins, [cert(null)])).toEqual({ missing: ["土地 1番", "土地 架空町二丁目 1番"], unplaced: true });
  });
  it("番号を読めず不動産番号でも決まらない謄本は unplaced", () => {
    expect(parcelCoverage(expected, [{ side: "土地", number: null, realEstateNumber: "0000", address: null }]).unplaced).toBe(true);
    expect(parcelCoverage([], [{ side: "土地", number: null, realEstateNumber: null, address: null }])).toEqual({ missing: [], unplaced: false });
  });
});
