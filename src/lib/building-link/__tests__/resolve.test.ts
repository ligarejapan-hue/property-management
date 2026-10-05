import { describe, it, expect } from "vitest";
import {
  decideBuildingLink,
  buildingLinkLockKey,
  AUTO_CHOICE,
  type DecideInput,
} from "@/lib/building-link/resolve";

const base: DecideInput = {
  propertyType: "apartment_unit",
  buildingName: "パークハウス第一",
  nameKey: "パークハウス第1",
  areaKey: "東京都大田区南雪谷1丁目",
  choice: AUTO_CHOICE,
  current: null,
  chosen: null,
  candidates: [],
};
const cand = (id: string, unitCount: number, iso: string) => ({
  id, name: `棟${id}`, unitCount, createdAt: new Date(iso),
});

describe("decideBuildingLink", () => {
  it("区分マンション以外は unlink", () => {
    expect(decideBuildingLink({ ...base, propertyType: "apartment_building" })).toEqual({ kind: "unlink" });
  });
  it("旧値 unit は今の棟を残す(keep)", () => {
    expect(
      decideBuildingLink({ ...base, propertyType: "unit", current: { id: "b0", name: "旧棟", nameKey: "旧棟" } }),
    ).toEqual({ kind: "keep" });
  });
  it("物件名が空は unlink", () => {
    expect(decideBuildingLink({ ...base, buildingName: null, nameKey: null })).toEqual({ kind: "unlink" });
  });
  it("choice=existing はその棟へ link", () => {
    expect(
      decideBuildingLink({ ...base, choice: { kind: "existing", buildingId: "b9" }, chosen: { id: "b9", name: "正式名" } }),
    ).toEqual({ kind: "link", buildingId: "b9", buildingName: "正式名", warnings: [] });
  });
  it("choice=existing で棟が無いなら chosen_missing", () => {
    expect(
      decideBuildingLink({ ...base, choice: { kind: "existing", buildingId: "b9" }, chosen: null }),
    ).toEqual({ kind: "chosen_missing" });
  });
  it("choice=new は create(候補があっても)", () => {
    expect(
      decideBuildingLink({ ...base, choice: { kind: "new" }, candidates: [cand("a", 3, "2026-01-01")] }),
    ).toEqual({ kind: "create", warnings: [] });
  });
  it("auto・候補1件はその棟へ link", () => {
    expect(decideBuildingLink({ ...base, candidates: [cand("a", 3, "2026-01-01")] })).toEqual({
      kind: "link", buildingId: "a", buildingName: "棟a", warnings: [],
    });
  });
  it("auto・候補0件は create", () => {
    expect(decideBuildingLink(base)).toEqual({ kind: "create", warnings: [] });
  });
  it("auto・候補2件以上は部屋数最多へ+duplicate_names", () => {
    const d = decideBuildingLink({
      ...base,
      candidates: [cand("a", 2, "2026-01-01"), cand("b", 5, "2026-02-01")],
    });
    expect(d).toEqual({ kind: "link", buildingId: "b", buildingName: "棟b", warnings: ["duplicate_names"] });
  });
  it("部屋数が同じなら作成が古い方", () => {
    const d = decideBuildingLink({
      ...base,
      candidates: [cand("new", 3, "2026-03-01"), cand("old", 3, "2026-01-01")],
    });
    expect(d).toMatchObject({ kind: "link", buildingId: "old" });
  });
  it("auto・町丁目が取れないなら create+area_unknown", () => {
    expect(decideBuildingLink({ ...base, areaKey: null })).toEqual({ kind: "create", warnings: ["area_unknown"] });
  });
  it("今の棟と比べる形が同じ名前なら、丁目が違っても今の棟のまま(付け替えない)", () => {
    const d = decideBuildingLink({
      ...base,
      areaKey: "東京都大田区南雪谷2丁目",
      current: { id: "cur", name: "パークハウス第１", nameKey: "パークハウス第1" },
      candidates: [cand("other", 9, "2020-01-01")],
    });
    expect(d).toEqual({ kind: "link", buildingId: "cur", buildingName: "パークハウス第１", warnings: [] });
  });
  it("今の棟と比べる形が違えば付け替えの判断をする", () => {
    const d = decideBuildingLink({
      ...base,
      current: { id: "cur", name: "別の棟", nameKey: "別の棟" },
      candidates: [],
    });
    expect(d).toEqual({ kind: "create", warnings: [] });
  });
});

describe("buildingLinkLockKey", () => {
  it("町丁目と比べる形をつなぐ", () => {
    expect(buildingLinkLockKey("東京都大田区南雪谷1丁目", "x")).toBe("building-link:東京都大田区南雪谷1丁目:x");
  });
  it("町丁目が無いときは名前だけ", () => {
    expect(buildingLinkLockKey(null, "x")).toBe("building-link::x");
  });
});
