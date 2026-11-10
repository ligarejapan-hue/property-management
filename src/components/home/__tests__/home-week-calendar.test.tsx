import { vi, describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));

import HomeWeekCalendar, { HomeWeekCalendarView } from "../home-week-calendar";
import type { WeekItem, WeekResponse } from "@/lib/home/week";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const item = (p: Partial<WeekItem>): WeekItem => ({
  key: "k", kind: "next_action", date: "2026-11-10", time: null, title: "中野区", sub: null, who: null,
  href: "/properties/p1", desk: false, overdue: false, ...p,
});
const data = (p: Partial<WeekResponse> = {}): WeekResponse => ({
  weekStart: "2026-11-09", scope: "mine", canSeeAll: false, hasMore: false,
  items: [
    item({ key: "a", sub: "電話" }),
    item({ key: "b", kind: "viewing", time: "11:00", sub: "案内", title: "テストハイツ", href: "/inquiry-desk", desk: true }),
    item({ key: "c", kind: "contract", date: "2026-11-12", time: "10:30", sub: "2026-0009", title: "テスト荘", href: "/deals/d1" }),
    item({ key: "d", date: "2026-11-09", overdue: true }),
  ],
  ...p,
});

describe("ホームの今週の予定(案4)", () => {
  it("見出し・凡例・種類の文字を出す(色だけに頼らない)", () => {
    const out = renderToStaticMarkup(<HomeWeekCalendarView data={data()} today="2026-11-10" />);
    expect(out).toContain("今週の予定（11/9〜11/15）");
    for (const w of ["次回対応", "期限切れ", "内見", "契約", "決済", "終日"]) expect(out).toContain(w);
    expect(out).toContain("11:00 内見 案内 テストハイツ");
    expect(out).toContain("10:30 契約 2026-0009 テスト荘");
  });
  it("内見は受付の窓で開き、物件・取引はアプリ内のリンク", () => {
    const out = renderToStaticMarkup(<HomeWeekCalendarView data={data()} today="2026-11-10" />);
    expect(out).toMatch(/<a href="\/inquiry-desk" target="pm-inquiry-desk"/);
    expect(out).toContain('href="/deals/d1"');
    expect(out).toContain('href="/properties/p1"');
  });
  it("「全員」の切り替えは管理者(canSeeAll)だけに出す", () => {
    expect(renderToStaticMarkup(<HomeWeekCalendarView data={data()} today="2026-11-10" />)).not.toContain("全員");
    expect(renderToStaticMarkup(<HomeWeekCalendarView data={data({ canSeeAll: true })} today="2026-11-10" />)).toContain("全員");
  });
  it("土日の列は予定がある時だけ。予定が無い週はその旨を出す", () => {
    const empty = renderToStaticMarkup(<HomeWeekCalendarView data={data({ items: [] })} today="2026-11-10" />);
    expect(empty).not.toContain("土 11/14");
    expect(empty).toContain("この週の予定はありません。");
    const sat = renderToStaticMarkup(<HomeWeekCalendarView data={data({ items: [item({ date: "2026-11-14" })] })} today="2026-11-10" />);
    expect(sat).toContain("土 11/14");
  });
  it("別の週は「週の予定」と出す", () => {
    expect(renderToStaticMarkup(<HomeWeekCalendarView data={data({ weekStart: "2026-11-16", items: [] })} today="2026-11-10" />)).toContain("週の予定（11/16〜11/22）");
  });
  it("読めるまで(権限が無い・失敗も含む)は何も出さない。失敗したら消す", () => {
    expect(renderToStaticMarkup(<HomeWeekCalendar />)).toBe("");
    expect(read("src/components/home/home-week-calendar.tsx")).toMatch(/catch[\s\S]{0,120}setData\(null\)/);
  });
  it("ホームでは自分の段取りの下・カードの上に置く", () => {
    const src = read("src/components/home/HomeContent.tsx");
    const a = src.indexOf("<HomeDealSchedule />");
    const b = src.indexOf("<HomeWeekCalendar />");
    const c = src.indexOf("cards.map(");
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });
});
