import { describe, it, expect } from "vitest";
import { shouldFetchSuggestions, isLatestRequest, nextActiveIndex, suggestionBadges, choiceSummary, pickAtIndex, shouldHandleListKey } from "@/lib/building-link/combobox-model";

const s = { id: "b1", name: "パーク第一", area: "東京都大田区南雪谷1丁目", unitCount: 3, sameName: true, sameArea: true };

describe("combobox-model", () => {
  it("比べる形で2文字から候補を引く", () => {
    expect(shouldFetchSuggestions("パ")).toBe(false);
    expect(shouldFetchSuggestions(" パー ")).toBe(true);
  });
  it("古い応答は捨てる", () => {
    expect(isLatestRequest(1, 2)).toBe(false);
    expect(isLatestRequest(2, 2)).toBe(true);
  });
  it("上下キーは一番下の『新しい棟として登録する』まで回る", () => {
    expect(nextActiveIndex(-1, "ArrowDown", 3)).toBe(0);
    expect(nextActiveIndex(2, "ArrowDown", 3)).toBe(0);
    expect(nextActiveIndex(0, "ArrowUp", 3)).toBe(2);
  });
  it("印", () => {
    expect(suggestionBadges(s)).toEqual(["同じ名前"]);
    expect(suggestionBadges({ ...s, sameArea: false })).toEqual(["同じ名前", "丁目が違います"]);
    expect(suggestionBadges({ ...s, sameName: false, sameArea: false })).toEqual([]);
  });
  it("選んだ内容の一文", () => {
    expect(choiceSummary({ kind: "existing", buildingId: "b1" }, s)).toBe("棟「パーク第一」(東京都大田区南雪谷1丁目・3部屋)につなぎます");
    expect(choiceSummary({ kind: "new" }, null)).toBe("新しい棟として登録します");
    expect(choiceSummary({ kind: "auto" }, null)).toBeNull();
  });
  it("強調中の行から選ぶ(範囲外は何も選ばない)", () => {
    expect(pickAtIndex(0, [s])).toBe(s);
    expect(pickAtIndex(1, [s])).toBe("new");
    expect(pickAtIndex(3, [s])).toBeNull(); // 一覧が縮んだ後の古い index
    expect(pickAtIndex(-1, [s])).toBeNull();
    expect(pickAtIndex(0, [])).toBe("new");
  });
  it("日本語変換中は候補のキー操作をしない", () => {
    expect(shouldHandleListKey(true)).toBe(false);
    expect(shouldHandleListKey(false)).toBe(true);
  });
});
