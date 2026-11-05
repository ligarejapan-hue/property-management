import { describe, expect, it } from "vitest";
import {
  extraParcelsSchema, extraParcelsText, fillExtraParcelArea, joinedParcelNumbers, parcelNumberLabel, readExtraParcels, registryParcelTarget,
} from "../property-parcels";

const land = (id: string, number: string, area: number | string | null = null, o: Record<string, unknown> = {}) =>
  ({ id, kind: "land", location: null, number, realEstateNumber: null, area, ...o });
const bldg = (id: string, number: string, area: number | null = null) => ({ id, kind: "building", location: null, number, realEstateNumber: null, area });

describe("ほかの土地・建物(2026-11-05 案A 1回目)", () => {
  it("形: 数字は半角・空は null・面積は文字でも数でも", () => {
    const [p] = extraParcelsSchema.parse([land("a", " １番２ ", "６１．９５", { location: " 架空市１丁目 ", realEstateNumber: "" })]);
    expect(p).toEqual({ id: "a", kind: "land", location: "架空市1丁目", number: "1番2", realEstateNumber: null, area: 61.95 });
    expect(extraParcelsSchema.parse([land("b", "3", "")])[0].area).toBeNull();
  });
  it("形: 番号が空・面積の小数3桁・マイナス・重なった行・多すぎは通さない", () => {
    expect(extraParcelsSchema.safeParse([land("a", " ")]).success).toBe(false);
    expect(extraParcelsSchema.safeParse([land("a", "1", "1.234")]).success).toBe(false);
    expect(extraParcelsSchema.safeParse([land("a", "1", "-1")]).success).toBe(false);
    expect(extraParcelsSchema.safeParse([land("a", "1"), land("a", "2")]).success).toBe(false);
    expect(extraParcelsSchema.safeParse(Array.from({ length: 31 }, (_, i) => land(`x${i}`, `${i}`))).success).toBe(false);
    expect(extraParcelsSchema.safeParse([{ ...land("a", "1"), extra: 1 }]).success).toBe(false);
  });
  it("読む: 配列でない・形の合わない行は捨てる", () => {
    expect(readExtraParcels(null)).toEqual([]);
    expect(readExtraParcels([land("a", "1番2"), { id: "b" }])).toHaveLength(1);
  });
  it("見出し: 足した分があれば「ほか◯筆/棟」・1筆目が空でも出す", () => {
    const raw = [land("a", "1番2"), land("b", "1番3"), bldg("c", "1番1の2")];
    expect(parcelNumberLabel("1番1", raw, "land")).toBe("1番1 ほか2筆");
    expect(parcelNumberLabel("1番1", raw, "building")).toBe("1番1 ほか1棟");
    expect(parcelNumberLabel(null, raw, "building")).toBe("ほか1棟");
    expect(parcelNumberLabel("1番1", [], "land")).toBe("1番1");
  });
  it("書類の地番: 1筆目から順に「、」でつなぐ", () => {
    expect(joinedParcelNumbers("1番1", [land("a", "1番2"), bldg("b", "9")], "land")).toBe("1番1、1番2");
    expect(joinedParcelNumbers(null, [], "land")).toBeNull();
  });
  it("変更履歴の文字", () => {
    expect(extraParcelsText([land("a", "1番2", 61.95, { location: "架空市", realEstateNumber: "0123" })])).toBe("土地 架空市 1番2 不動産番号 0123 61.95㎡");
    expect(extraParcelsText([])).toBeNull();
  });
});

describe("謄本がどの土地・建物のものか(2回目)", () => {
  const P = { lotNumber: "1番1", buildingNumber: "1番1", extraParcels: [land("a", "1番2"), bldg("b", "1番1の2")] };
  it("1筆目・足した行・どれでもない", () => {
    expect(registryParcelTarget({ lotNumber: "1番地1", buildingNumber: null }, P)).toEqual({ target: "main" });
    expect(registryParcelTarget({ lotNumber: "１番２", buildingNumber: null }, P)).toEqual({ target: "extra", id: "a", kind: "land" });
    expect(registryParcelTarget({ lotNumber: "1番1", buildingNumber: "1番1の2" }, P)).toEqual({ target: "extra", id: "b", kind: "building" });
    expect(registryParcelTarget({ lotNumber: "1番3", buildingNumber: null }, P)).toEqual({ target: "unknown", kind: "land", number: "1番3", hasExtras: true });
  });
  it("番号を読めない: 足した行がある物件では unknown(どの筆か分からない)・無ければ 1筆目(今までどおり)", () => {
    expect(registryParcelTarget({ lotNumber: null, buildingNumber: null }, P)).toEqual({ target: "unknown", kind: null, number: "", hasExtras: true });
    expect(registryParcelTarget({ lotNumber: null, buildingNumber: null }, { ...P, extraParcels: [] })).toEqual({ target: "main" });
  });
  it("物件の欄が空: 足した行の番号なら足した行・そうでなければ 1筆目", () => {
    expect(registryParcelTarget({ lotNumber: "1番2", buildingNumber: null }, { ...P, lotNumber: null })).toEqual({ target: "extra", id: "a", kind: "land" });
    expect(registryParcelTarget({ lotNumber: "1番5", buildingNumber: null }, { ...P, lotNumber: null })).toEqual({ target: "main" });
  });
  it("足した行の空いている面積だけ入れる", () => {
    expect(fillExtraParcelArea(P.extraParcels, "a", 61.954)).toEqual([{ ...land("a", "1番2"), area: 61.95 }, bldg("b", "1番1の2")]);
    expect(fillExtraParcelArea([land("a", "1番2", 10)], "a", 61.95)).toBeNull();
    expect(fillExtraParcelArea(P.extraParcels, "a", null)).toBeNull();
    expect(fillExtraParcelArea(P.extraParcels, "x", 1)).toBeNull();
    expect(fillExtraParcelArea(P.extraParcels, "a", Number.NaN)).toBeNull();
  });
});
