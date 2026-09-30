import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import HomeInquiryCounts, { HomeInquiryCountsView } from "../home-inquiry-counts";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("ホームの反響の件数(設計 方針9)", () => {
  it("未対応の反響と今日・明日の内見の件数を出す", () => {
    const out = renderToStaticMarkup(<HomeInquiryCountsView counts={{ open: 3, upcomingViewings: 1 }} />);
    expect(out).toContain("未対応の反響");
    expect(out).toMatch(/>3<span[^>]*>件<\/span>/);
    expect(out).toContain("今日・明日の内見");
    expect(out).toMatch(/>1<span[^>]*>件<\/span>/);
  });
  it("どちらも受付の窓を名前付きの窓で開く(noopener を付けない)", () => {
    const out = renderToStaticMarkup(<HomeInquiryCountsView counts={{ open: 0, upcomingViewings: 0 }} />);
    expect((out.match(/<a href="\/inquiry-desk" target="pm-inquiry-desk"/g) ?? []).length).toBe(2);
    expect(out).not.toContain("noopener");
  });
  it("読めるまで(権限が無い・失敗も含む)は何も出さない", () => {
    expect(renderToStaticMarkup(<HomeInquiryCounts />)).toBe("");
  });
  it("失敗したら消す(古い件数を残さない)", () => {
    const src = read("src/components/home/home-inquiry-counts.tsx");
    expect(src).toMatch(/catch[\s\S]{0,120}setCounts\(null\)/);
  });
  it("ホームの題名の下・カードの上に置く", () => {
    const src = read("src/components/home/HomeContent.tsx");
    const a = src.indexOf("<PageHeader");
    const b = src.indexOf("<HomeInquiryCounts />");
    const c = src.indexOf("cards.map(");
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });
});
