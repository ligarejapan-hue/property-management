import { describe, expect, it } from "vitest";
import {
  MAIN_BUILDING_KEY, MAIN_LAND_KEY, applyTargetParcels, dealParcelOptions, normalizeTargetParcels, readTargetParcels, selectedParcelKeys,
} from "../target-parcels";

const row = (id: string, kind: "land" | "building", number: string, location: string | null = null) => ({
  id, kind, location, number, realEstateNumber: null, area: null,
});
const P = {
  lotNumber: "1番1", buildingNumber: "1番1",
  extraParcels: [row("a", "land", "1番2"), row("b", "building", "1番1の2", "架空町二丁目")],
};

describe("この取引の土地・建物(2026-11-06 3回目の1つ目)", () => {
  it("選べるもの: 足した行が無ければ空(選ぶ欄を出さない)", () => {
    expect(dealParcelOptions({ lotNumber: "1番1", buildingNumber: "1番1", extraParcels: [] })).toEqual([]);
    expect(dealParcelOptions({ lotNumber: "1番1", buildingNumber: null, extraParcels: "壊れた" })).toEqual([]);
  });
  it("選べるもの: 1筆目・1棟目と足した行(番号が空の1筆目・1棟目は出さない)", () => {
    expect(dealParcelOptions(P)).toEqual([
      { key: MAIN_LAND_KEY, kind: "land", label: "土地 1番1（1筆目）" },
      { key: MAIN_BUILDING_KEY, kind: "building", label: "建物 1番1（1棟目）" },
      { key: "a", kind: "land", label: "土地 1番2" },
      { key: "b", kind: "building", label: "建物 架空町二丁目 1番1の2" },
    ]);
    expect(dealParcelOptions({ ...P, buildingNumber: " " }).map((o) => o.key)).toEqual([MAIN_LAND_KEY, "a", "b"]);
  });

  it("保存してある値を読む: 文字の配列だけ・それ以外は全部(null)", () => {
    expect(readTargetParcels(null)).toBeNull();
    expect(readTargetParcels(["a", MAIN_LAND_KEY])).toEqual(["a", MAIN_LAND_KEY]);
    expect(readTargetParcels("a")).toBeNull();
    expect(readTargetParcels([1])).toBeNull();
    expect(readTargetParcels([])).toBeNull();
  });

  it("保存する値: 全部を選んだら null・物件に無い行は不正・空は不正", () => {
    const opts = dealParcelOptions(P);
    expect(normalizeTargetParcels(opts.map((o) => o.key), opts)).toEqual({ ok: true, value: null });
    expect(normalizeTargetParcels(null, opts)).toEqual({ ok: true, value: null });
    // 並びは物件の並びにそろえる(画面の押した順で変わらない)。
    expect(normalizeTargetParcels(["a", MAIN_LAND_KEY], opts)).toEqual({ ok: true, value: [MAIN_LAND_KEY, "a"] });
    expect(normalizeTargetParcels(["zzz"], opts)).toEqual({ ok: false });
    expect(normalizeTargetParcels([], opts)).toEqual({ ok: false });
    expect(normalizeTargetParcels(["a", "a"], opts)).toEqual({ ok: true, value: ["a"] });
    // 足した行が無い物件では選べない。
    expect(normalizeTargetParcels(["a"], [])).toEqual({ ok: false });
  });

  it("選んだもの: 物件から消えた行は外し、1つも残らなければ全部(null)", () => {
    expect(selectedParcelKeys(P, null)).toBeNull();
    expect(selectedParcelKeys(P, ["a", "消えた"])).toEqual(["a"]);
    expect(selectedParcelKeys(P, ["消えた"])).toBeNull();
    // 足した行を全部消した物件=今までどおり全部。
    expect(selectedParcelKeys({ ...P, extraParcels: [] }, [MAIN_LAND_KEY])).toBeNull();
  });

  it("★選んだ土地・建物だけの物件の形: 選ばなかった1筆目は空・足した行は選んだものだけ", () => {
    expect(applyTargetParcels(P, null)).toEqual({ lotNumber: "1番1", buildingNumber: "1番1", extraParcels: P.extraParcels });
    expect(applyTargetParcels(P, ["a", MAIN_BUILDING_KEY])).toEqual({ lotNumber: null, buildingNumber: "1番1", extraParcels: [P.extraParcels[0]] });
    expect(applyTargetParcels(P, [MAIN_LAND_KEY])).toEqual({ lotNumber: "1番1", buildingNumber: null, extraParcels: [] });
    // 消えた行だけを選んでいた=全部。
    expect(applyTargetParcels(P, ["消えた"])).toEqual({ lotNumber: "1番1", buildingNumber: "1番1", extraParcels: P.extraParcels });
  });
  it("1筆目の鍵と同じ形の id の行は、1筆目を選んでも入らない(取り違えない)", () => {
    const odd = { ...P, extraParcels: [row(MAIN_LAND_KEY, "land", "9番"), row("a", "land", "1番2")] };
    expect(dealParcelOptions(odd).map((o) => o.key)).toEqual([MAIN_LAND_KEY, MAIN_BUILDING_KEY, "a"]);
    expect(applyTargetParcels(odd, [MAIN_LAND_KEY]).extraParcels).toEqual([]);
  });
});
