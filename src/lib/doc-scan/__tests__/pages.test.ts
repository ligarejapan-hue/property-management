import { describe, expect, it } from "vitest";
import { MAX_SCAN_PAGES, addPage, movePage, removePage } from "../pages";

const p = (id: string) => ({ id });

describe("撮った書類の並び", () => {
  it("撮った順に後ろへ足す", () => {
    expect(addPage([p("a")], p("b"))).toEqual({ ok: true, pages: [p("a"), p("b")] });
  });

  it("30枚を超えては足さない", () => {
    const full = Array.from({ length: MAX_SCAN_PAGES }, (_, i) => p(String(i)));
    expect(MAX_SCAN_PAGES).toBe(30);
    expect(addPage(full, p("x"))).toEqual({ ok: false, pages: full });
  });

  it("前へ・後ろへ動かす", () => {
    const pages = [p("a"), p("b"), p("c")];
    expect(movePage(pages, "b", -1)).toEqual([p("b"), p("a"), p("c")]);
    expect(movePage(pages, "b", 1)).toEqual([p("a"), p("c"), p("b")]);
  });

  it("端からは動かさない(同じ参照を返す)", () => {
    const pages = [p("a"), p("b")];
    expect(movePage(pages, "a", -1)).toBe(pages);
    expect(movePage(pages, "b", 1)).toBe(pages);
    expect(movePage(pages, "zz", 1)).toBe(pages);
  });

  it("消す", () => {
    expect(removePage([p("a"), p("b")], "a")).toEqual([p("b")]);
  });
});
