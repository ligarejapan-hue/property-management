import { describe, it, expect } from "vitest";
import { shouldFetchSuggestions, isLatestRequest, nextActiveIndex, suggestionBadges, choiceSummary, pickAtIndex, shouldHandleListKey, suggestQueryString, shouldOpenOnArrow, suggestArea, resultMatches } from "@/lib/building-link/combobox-model";

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

describe("suggestQueryString(候補の問い合わせに番地を載せない)", () => {
  it("★住所は町丁目までに丸めて area で送り、address は送らない", () => {
    const qs = suggestQueryString("パーク第一", "東京都港区六本木1丁目1-2 パーク第一303");
    const p = new URLSearchParams(qs);
    expect(p.get("name")).toBe("パーク第一");
    expect(p.has("address")).toBe(false);
    expect(qs).not.toContain("address=");
    expect(p.get("area")).toBe("東京都港区六本木1丁目");
    expect(qs).not.toContain(encodeURIComponent("1-2"));
  });
  it("住所が空なら area は空", () => {
    expect(new URLSearchParams(suggestQueryString("パーク第一", "")).get("area")).toBe("");
  });
});

describe("shouldOpenOnArrow(閉じた一覧を上下キーで開き直す)", () => {
  it("閉じていて上下キー・変換中でない・候補を引ける長さなら開く", () => {
    expect(shouldOpenOnArrow({ open: false, key: "ArrowDown", isComposing: false, value: "パーク第一" })).toBe(true);
    expect(shouldOpenOnArrow({ open: false, key: "ArrowUp", isComposing: false, value: "パーク第一" })).toBe(true);
  });
  it("開いている・別のキー・変換中・短すぎるなら開かない", () => {
    expect(shouldOpenOnArrow({ open: true, key: "ArrowDown", isComposing: false, value: "パーク第一" })).toBe(false);
    expect(shouldOpenOnArrow({ open: false, key: "Enter", isComposing: false, value: "パーク第一" })).toBe(false);
    expect(shouldOpenOnArrow({ open: false, key: "ArrowDown", isComposing: true, value: "パーク第一" })).toBe(false);
    expect(shouldOpenOnArrow({ open: false, key: "ArrowDown", isComposing: false, value: "あ" })).toBe(false);
  });
});

describe("resultMatches(手元の候補が今の入力・今の丁目のものか・@codex R2)", () => {
  const result = { query: "パーク第一", area: "東京都港区六本木1丁目", data: [] };
  it("同じ名前+同じ丁目なら出す", () => {
    expect(resultMatches(result, "パーク第一", "東京都港区六本木1丁目")).toBe(true);
  });
  it("★同じ名前でも丁目が変わったら出さない(前の丁目で並べた候補を選ばせない)", () => {
    expect(resultMatches(result, "パーク第一", "東京都港区赤坂2丁目")).toBe(false);
    expect(resultMatches(result, "パーク第一", "")).toBe(false);
  });
  it("名前が違えば出さない", () => {
    expect(resultMatches(result, "パーク第二", "東京都港区六本木1丁目")).toBe(false);
  });
  it("suggestArea は問い合わせに載せる area と同じ値", () => {
    const addr = "東京都港区六本木1丁目1-2";
    expect(new URLSearchParams(suggestQueryString("パーク第一", addr)).get("area")).toBe(suggestArea(addr));
    expect(suggestArea("")).toBe("");
  });
});
