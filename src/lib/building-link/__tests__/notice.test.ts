import { describe, it, expect, afterEach, vi } from "vitest";
import type { BuildingLinkWarning } from "@/lib/building-link/resolve";
import { buildingLinkNoticeLines, stashBuildingLinkNotice, takeBuildingLinkNotice } from "@/lib/building-link/notice";

const o = (over = {}) => ({ action: "linked" as const, building: { id: "b1", name: "パーク第一" }, previousBuildingId: null, renamedFrom: null, warnings: [] as BuildingLinkWarning[], ...over });

describe("buildingLinkNoticeLines", () => {
  it("link", () => expect(buildingLinkNoticeLines(o())[0].text).toBe("棟「パーク第一」につなぎました"));
  it("そろえたときは入力を添える", () =>
    expect(buildingLinkNoticeLines(o({ renamedFrom: "パーク第１" }))[0].text).toBe("棟「パーク第一」につなぎました(入力: パーク第１)"));
  it("create は確認のお願いと棟の画面へのリンク", () => {
    const [l] = buildingLinkNoticeLines(o({ action: "created" }));
    expect(l).toMatchObject({ text: "棟「パーク第一」を新しく作りました。正式な表記か確認してください", href: "/buildings/b1" });
  });
  it("注意", () => {
    const lines = buildingLinkNoticeLines(o({ warnings: ["duplicate_names"] }));
    expect(lines.map((l) => l.text)).toContain("同じ名前の棟が複数あります。棟の一覧で確かめてください");
    const lines2 = buildingLinkNoticeLines(o({ action: "created", warnings: ["area_unknown"] }));
    expect(lines2.map((l) => l.text)).toContain("住所から町丁目を読み取れなかったため、新しい棟として作りました");
  });
  it("kept でそろえていなければ何も出さない・none も出さない", () => {
    expect(buildingLinkNoticeLines(o({ action: "kept" }))).toEqual([]);
    expect(buildingLinkNoticeLines(o({ action: "none", building: null }))).toEqual([]);
    expect(buildingLinkNoticeLines(null)).toEqual([]);
  });
  it("外したとき", () =>
    expect(buildingLinkNoticeLines(o({ action: "unlinked", building: null }))[0].text).toBe("棟から外しました"));
});

describe("stash/take", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("1回だけ取り出せる", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    stashBuildingLinkNotice("p1", o());
    expect(takeBuildingLinkNotice("p1")).toMatchObject({ action: "linked" });
    expect(takeBuildingLinkNotice("p1")).toBeNull();
  });
  it("sessionStorage が使えなくても落ちない", () => {
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); }, removeItem: () => {} });
    expect(() => stashBuildingLinkNotice("p1", o())).not.toThrow();
    expect(takeBuildingLinkNotice("p1")).toBeNull();
  });
  it("sessionStorage が存在しなくても落ちない", () => {
    expect(() => stashBuildingLinkNotice("p1", o())).not.toThrow();
    expect(takeBuildingLinkNotice("p1")).toBeNull();
  });
});
