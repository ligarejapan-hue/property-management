import { describe, expect, it } from "vitest";
import { applyParcelChange, retargetDealParcels } from "../property-parcel-changes";

const row = (id: string, kind: "land" | "building", number: string, o: { location?: string | null; area?: number | null; realEstateNumber?: string | null } = {}) => ({
  id, kind, location: o.location ?? null, number, realEstateNumber: o.realEstateNumber ?? null, area: o.area ?? null,
});
const P = {
  lotNumber: "1番1",
  extraParcels: [row("a", "land", "2番", { location: "架空町二丁目", area: 50, realEstateNumber: "111" }), row("b", "building", "1番1の2"), row("c", "land", "3番")],
};
let n = 0;
const newId = () => `new${++n}`;

describe("分筆・合筆の記録(2026-11-06 3回目の2つ目)", () => {
  it("★1筆目の分筆: 1筆目の地番は分けた1つ目に・残りは足した行(所在は物件と同じ)", () => {
    n = 0;
    const r = applyParcelChange(P, { op: "split", source: "main:land", pieces: [{ number: "１番１", area: 100 }, { number: "1番5", area: 20.5 }] }, newId);
    expect(r).toMatchObject({ ok: true, lotNumber: "1番1", addedKeys: ["new1"], removedKeys: [], resultKey: "main:land" });
    if (!r.ok) throw new Error();
    expect(r.extraParcels[0]).toEqual(row("new1", "land", "1番5", { area: 20.5 }));
    expect(r.extraParcels.slice(1)).toEqual(P.extraParcels);
    expect(r.comment).toBe("分筆を記録しました：土地 1番1 → 1番1（100㎡）・1番5（20.5㎡）");
  });
  it("★足した行の分筆: 行の id・所在・不動産番号は1つ目に残し、残りはすぐ後ろに同じ所在で足す", () => {
    n = 0;
    const r = applyParcelChange(P, { op: "split", source: "a", pieces: [{ number: "2番1", area: 30 }, { number: "2番2", area: null }, { number: "2番3", area: 5 }] }, newId);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.lotNumber).toBe("1番1");
    expect(r.extraParcels.map((x) => [x.id, x.number, x.location, x.realEstateNumber, x.area])).toEqual([
      ["a", "2番1", "架空町二丁目", "111", 30],
      ["new1", "2番2", "架空町二丁目", null, null],
      ["new2", "2番3", "架空町二丁目", null, 5],
      ["b", "1番1の2", null, null, null],
      ["c", "3番", null, null, null],
    ]);
    expect(r.addedKeys).toEqual(["new1", "new2"]);
    expect(r.comment).toBe("分筆を記録しました：土地 架空町二丁目 2番 → 2番1（30㎡）・2番2・2番3（5㎡）");
  });
  it("分筆できない: 2つ未満・同じ番号・空の番号・建物・無い行・地番が空の1筆目・行が多すぎる", () => {
    const bad = (input: Parameters<typeof applyParcelChange>[1], p = P) => expect(applyParcelChange(p, input, newId).ok).toBe(false);
    bad({ op: "split", source: "a", pieces: [{ number: "2番1", area: null }] });
    bad({ op: "split", source: "a", pieces: [{ number: "2番1", area: null }, { number: "２番１", area: null }] });
    bad({ op: "split", source: "a", pieces: [{ number: "2番1", area: null }, { number: " ", area: null }] });
    bad({ op: "split", source: "b", pieces: [{ number: "1", area: null }, { number: "2", area: null }] });
    bad({ op: "split", source: "zzz", pieces: [{ number: "1", area: null }, { number: "2", area: null }] });
    bad({ op: "split", source: "main:land", pieces: [{ number: "1", area: null }, { number: "2", area: null }] }, { ...P, lotNumber: " " });
    bad({ op: "split", source: "main:land", pieces: Array.from({ length: 30 }, (_, i) => ({ number: `9番${i}`, area: null })) });
  });

  it("★合筆: 1筆目を含めば1筆目に・ほかの行は消える", () => {
    const r = applyParcelChange(P, { op: "merge", keys: ["c", "main:land"], number: "1番1", area: null }, newId);
    if (!r.ok) throw new Error();
    expect(r).toMatchObject({ lotNumber: "1番1", resultKey: "main:land", removedKeys: ["c"], addedKeys: [] });
    expect(r.extraParcels.map((x) => x.id)).toEqual(["a", "b"]);
    expect(r.comment).toBe("合筆を記録しました：土地 1番1・3番 → 1番1");
  });
  it("合筆: 足した行どうしは前の行に・面積を入れる", () => {
    const r = applyParcelChange(P, { op: "merge", keys: ["c", "a"], number: "2番", area: 80 }, newId);
    if (!r.ok) throw new Error();
    expect(r.resultKey).toBe("a");
    expect(r.extraParcels).toEqual([{ ...P.extraParcels[0], number: "2番", area: 80 }, P.extraParcels[1]]);
    expect(r.comment).toBe("合筆を記録しました：土地 架空町二丁目 2番・3番 → 2番（80㎡）");
  });
  it("合筆できない: 1つだけ・建物・無い行・同じ行を2回・空の番号", () => {
    const bad = (input: Parameters<typeof applyParcelChange>[1]) => expect(applyParcelChange(P, input, newId).ok).toBe(false);
    bad({ op: "merge", keys: ["a"], number: "2番", area: null });
    bad({ op: "merge", keys: ["a", "b"], number: "2番", area: null });
    bad({ op: "merge", keys: ["a", "zzz"], number: "2番", area: null });
    bad({ op: "merge", keys: ["a", "a"], number: "2番", area: null });
    bad({ op: "merge", keys: ["a", "c"], number: " ", area: null });
  });

  it("★取引の選び: 分けた筆を選んでいた取引には新しい筆も足す・選んでいない取引と全部(null)は変えない(undefined=書かない)", () => {
    const split = { op: "split" as const, source: "a", addedKeys: ["n1", "n2"], removedKeys: [], resultKey: "a" };
    expect(retargetDealParcels(["main:land", "a", "b"], split)).toEqual(["main:land", "a", "n1", "n2", "b"]);
    expect(retargetDealParcels(["main:land"], split)).toBeUndefined();
    expect(retargetDealParcels(null, split)).toBeUndefined();
  });
  it("★取引の選び: 合わせた筆のどれかを選んでいた取引は、合わせた筆にする・消えた行は外す", () => {
    const merge = { op: "merge" as const, source: null, addedKeys: [], removedKeys: ["c"], resultKey: "a" };
    expect(retargetDealParcels(["c"], merge)).toEqual(["a"]);
    expect(retargetDealParcels(["a", "c", "b"], merge)).toEqual(["a", "b"]);
    expect(retargetDealParcels(["b"], merge)).toBeUndefined();
    // 残った筆だけを選んでいた取引は変えない(版を上げて編集中の人を 409 にしない)。
    expect(retargetDealParcels(["a"], merge)).toBeUndefined();
  });
});
