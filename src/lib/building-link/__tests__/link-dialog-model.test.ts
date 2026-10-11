import { describe, it, expect } from "vitest";
import {
  initialLinkChoice,
  allowsAutoLink,
  linkConfirmButtonLabel,
  buildingNameLinkMode,
  linkNeedsSuggestions,
} from "@/lib/building-link/link-dialog-model";
import type { BuildingSuggestion } from "@/lib/building-link/suggest";

const AREA = "東京都品川区西五反田5丁目";
const s = (o: Partial<BuildingSuggestion>): BuildingSuggestion => ({
  id: "b1", name: "パーク第一", area: "東京都品川区西五反田5丁目", unitCount: 3, sameName: false, sameArea: false, ...o,
});

describe("initialLinkChoice(物件名から棟につなぐ確認の、最初に選んでおくもの)", () => {
  it("同じ町丁目に同じ名前の棟があれば、その棟", () =>
    expect(initialLinkChoice([s({ id: "x", sameName: true, sameArea: true })], "ready", AREA)).toEqual({ kind: "existing", buildingId: "x" }));
  it("並びの先頭でなくても、同じ名前・同じ町丁目の棟を選ぶ", () =>
    expect(initialLinkChoice([s({ id: "a", sameName: true }), s({ id: "b", sameName: true, sameArea: true })], "ready", AREA))
      .toEqual({ kind: "existing", buildingId: "b" }));
  it("同じ名前でも丁目が違うだけなら選ばず、新しい棟", () =>
    expect(initialLinkChoice([s({ sameName: true, sameArea: false })], "ready", AREA)).toEqual({ kind: "new" }));
  it("候補が無ければ新しい棟", () => expect(initialLinkChoice([], "ready", AREA)).toEqual({ kind: "new" }));
  it("古い棟を全部確かめられなかった(partial)ときは新しい棟ではなく自動の判断を選んでおく(@codex P2)", () =>
    expect(initialLinkChoice([s({})], "partial", AREA)).toEqual({ kind: "auto" }));
  it("partial で候補が0件でも、自動の判断で先へ進める(行き止まりにしない)", () =>
    expect(initialLinkChoice([], "partial", AREA)).toEqual({ kind: "auto" }));
  it("partial でも同じ町丁目・同じ名前の棟が見えていればそれを選ぶ", () =>
    expect(initialLinkChoice([s({ id: "z", sameName: true, sameArea: true })], "partial", AREA)).toEqual({ kind: "existing", buildingId: "z" }));
  it("partial で住所から町丁目が読めない物件は自動の判断も選ばない(サーバーが探さず作ってしまう・@codex P2)", () => {
    expect(initialLinkChoice([], "partial", "")).toBeNull();
    expect(allowsAutoLink("partial", "")).toBe(false);
    expect(allowsAutoLink("partial", AREA)).toBe(true);
    expect(allowsAutoLink("ready", AREA)).toBe(false);
  });
  it("読み込み中・失敗は何も選ばない", () => {
    expect(initialLinkChoice([], "loading", AREA)).toBeNull();
    expect(initialLinkChoice([], "error", AREA)).toBeNull();
  });
});

describe("linkConfirmButtonLabel", () => {
  it("既存の棟なら「この棟につなぐ」・新しい棟なら「新しい棟を作ってつなぐ」", () => {
    expect(linkConfirmButtonLabel({ kind: "existing", buildingId: "x" })).toBe("この棟につなぐ");
    expect(linkConfirmButtonLabel({ kind: "new" })).toBe("新しい棟を作ってつなぐ");
    expect(linkConfirmButtonLabel(null)).toBe("つなぐ");
  });
});

describe("buildingNameLinkMode(基本情報の物件名をどう出すか)", () => {
  const base = { propertyType: "apartment_unit", buildingName: "ハマイハイライズ", building: null, canWrite: true, lockedByOther: false };
  it("棟につながっていれば棟の画面へのリンク", () =>
    expect(buildingNameLinkMode({ ...base, building: { id: "b1" } })).toBe("link"));
  it("区分(旧)でも棟があればリンク", () =>
    expect(buildingNameLinkMode({ ...base, propertyType: "unit", building: { id: "b1" } })).toBe("link"));
  it("棟につながっていない区分マンションで編集できるなら、つなぐ確認を開く", () =>
    expect(buildingNameLinkMode(base)).toBe("connect"));
  it("見るだけの人・ほかの人が編集中なら文字だけ", () => {
    expect(buildingNameLinkMode({ ...base, canWrite: false })).toBe("text");
    expect(buildingNameLinkMode({ ...base, lockedByOther: true })).toBe("text");
  });
  it("区分マンション以外(一棟など)は棟につながないので文字だけ", () =>
    expect(buildingNameLinkMode({ ...base, propertyType: "apartment_building" })).toBe("text"));
  it("物件名が空白だけなら文字だけ", () =>
    expect(buildingNameLinkMode({ ...base, buildingName: "　" })).toBe("text"));
});

describe("linkNeedsSuggestions(候補を探せる物件名か・@codex P2)", () => {
  it("比べる形が2文字以上なら候補を探す", () => expect(linkNeedsSuggestions("パーク")).toBe(true));
  it("1文字の物件名は候補を探せない=自動の判断(同じ町丁目の同じ名前へ・無ければ作る)に任せる", () => {
    expect(linkNeedsSuggestions("A")).toBe(false);
    expect(linkConfirmButtonLabel({ kind: "auto" })).toBe("つなぐ");
  });
});
