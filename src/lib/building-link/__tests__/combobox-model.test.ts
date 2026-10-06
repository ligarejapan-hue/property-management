import { describe, it, expect } from "vitest";
import { shouldFetchSuggestions, isLatestRequest, nextActiveIndex, suggestionBadges, choiceSummary, pickAtIndex, shouldHandleListKey, suggestQueryString, shouldOpenOnArrow, suggestArea, resultMatches, listState, canUseListKeys, areaChanged, selectedInArea } from "@/lib/building-link/combobox-model";

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

describe("listState(読み込みが終わるまで「新しい棟」を選ばせない・@codex R3)", () => {
  const ok = { query: "パーク第一", area: "東京都港区六本木1丁目", status: "ok" as const, data: [] };
  const err = { ...ok, status: "error" as const };
  it("結果がまだ無ければ loading", () => {
    expect(listState(null, "パーク第一", "東京都港区六本木1丁目")).toBe("loading");
  });
  it("★前の入力・前の丁目の結果なら loading(古い結果を完了扱いにしない)", () => {
    expect(listState(ok, "パーク第二", "東京都港区六本木1丁目")).toBe("loading");
    expect(listState(ok, "パーク第一", "東京都港区赤坂2丁目")).toBe("loading");
    expect(listState(err, "パーク第二", "東京都港区六本木1丁目")).toBe("loading");
  });
  it("★今の名前+丁目で失敗していれば error", () => {
    expect(listState(err, "パーク第一", "東京都港区六本木1丁目")).toBe("error");
  });
  it("今の名前+丁目で成功していれば ready(候補0件でも)", () => {
    expect(listState(ok, "パーク第一", "東京都港区六本木1丁目")).toBe("ready");
  });
  it("★上下キー・Enter で選べるのは ready のときだけ", () => {
    expect(canUseListKeys("ready")).toBe(true);
    expect(canUseListKeys("loading")).toBe(false);
    expect(canUseListKeys("error")).toBe(false);
  });
});

describe("areaChanged(住所の町丁目が変わったか・@codex R4)", () => {
  it("★町丁目が変わったら true(選んだ棟を外す)", () => {
    expect(areaChanged("東京都港区六本木1丁目1-2", "東京都港区赤坂2丁目3-4")).toBe(true);
    expect(areaChanged("", "東京都港区六本木1丁目1-2")).toBe(true);
    expect(areaChanged("東京都港区六本木1丁目1-2", "")).toBe(true);
  });
  it("番地だけの直しは false(選んだ棟を保つ)", () => {
    expect(areaChanged("東京都港区六本木1丁目1-2", "東京都港区六本木1丁目1-3")).toBe(false);
    expect(areaChanged("", "")).toBe(false);
  });
});

describe("selectedInArea(選んだ丁目と今の丁目が同じときだけ選んだ棟を使う)", () => {
  const s = { id: "b1", name: "パーク第一", area: "東京都港区六本木1丁目", unitCount: 3, sameName: true, sameArea: true };
  it("同じ丁目なら選んだ棟", () => {
    expect(selectedInArea({ suggestion: s, area: "東京都港区六本木1丁目" }, "東京都港区六本木1丁目")).toBe(s);
  });
  it("★丁目が変わったら null(古い要約を出さない)", () => {
    expect(selectedInArea({ suggestion: s, area: "東京都港区六本木1丁目" }, "東京都港区赤坂2丁目")).toBeNull();
    expect(selectedInArea(null, "東京都港区六本木1丁目")).toBeNull();
  });
});

describe("listState partial(古い棟を全部は確かめられなかった・@codex R5)", () => {
  const base = { query: "パーク第一", area: "東京都港区六本木1丁目", status: "ok" as const, data: [] };
  it("★complete=false なら partial", () => {
    expect(listState({ ...base, complete: false }, "パーク第一", "東京都港区六本木1丁目")).toBe("partial");
  });
  it("complete=true・省略なら ready", () => {
    expect(listState({ ...base, complete: true }, "パーク第一", "東京都港区六本木1丁目")).toBe("ready");
    expect(listState(base, "パーク第一", "東京都港区六本木1丁目")).toBe("ready");
  });
  it("partial でも候補は上下キー・Enter で選べる", () => {
    expect(canUseListKeys("partial")).toBe(true);
  });
  it("★partial では一番下の「新しい棟」を選べない(pickAtIndex の allowNew=false)", () => {
    const s = { id: "b1", name: "パーク第一", area: "", unitCount: 1, sameName: true, sameArea: false };
    expect(pickAtIndex(0, [s], false)).toBe(s);
    expect(pickAtIndex(1, [s], false)).toBeNull();
    expect(pickAtIndex(0, [], false)).toBeNull();
  });
});

describe("areaChanged 町丁目が分からない住所(@codex R5)", () => {
  it("★分からない→分からないでも、住所が変われば true", () => {
    expect(areaChanged("小笠原村父島字東町", "八丈町大賀郷")).toBe(true);
  });
  it("分からない住所で、同じ文字(前後の空白・全角半角の違いだけ)なら false", () => {
    expect(areaChanged("小笠原村父島字東町", " 小笠原村父島字東町 ")).toBe(false);
  });
  it("★空→丁目つきの住所は true", () => {
    expect(areaChanged("", "東京都港区六本木1丁目1-2")).toBe(true);
  });
  it("両方分かるなら町丁目で比べる(番地だけの直しは false)", () => {
    expect(areaChanged("東京都港区六本木1丁目1-2", "東京都港区六本木1丁目9-9")).toBe(false);
  });
});
