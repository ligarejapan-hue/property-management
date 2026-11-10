import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import HomeKpiSummary, { HomeKpiSummaryView, homeKpiTiles, type OverdueCounts } from "../home-kpi-summary";
import type { InquiryCounts } from "@/lib/api-client";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const inquiry: InquiryCounts = {
  open: 3, upcomingViewings: 1,
  openByKind: { viewing: 2, ad_permission: 0, material_request: 1 },
  viewingsToday: 1, viewingsTomorrow: 0,
};
const overdue: OverdueCounts = { total: 5, within3: 3, within7: 1, older: 1 };

describe("ホームの重要な数字(2026-11-10 案1)", () => {
  it("未対応の反響・期限切れの次回対応・今日明日の内見の順に3つ出す", () => {
    expect(homeKpiTiles(inquiry, overdue).map((t) => [t.key, t.label, t.count])).toEqual([
      ["open", "未対応の反響", 3],
      ["overdue", "期限切れの次回対応", 5],
      ["viewings", "今日・明日の内見", 1],
    ]);
  });
  it("内訳: 反響は種類別、期限切れは経過日数別、内見は今日・明日", () => {
    const [open, od, vw] = homeKpiTiles(inquiry, overdue);
    expect(open.breakdown).toEqual([
      { label: "内見", count: 2 },
      { label: "広告の許可", count: 0 },
      { label: "資料請求", count: 1 },
    ]);
    expect(od.breakdown).toEqual([
      { label: "3日以内", count: 3 },
      { label: "4〜7日", count: 1 },
      { label: "8日以上", count: 1 },
    ]);
    expect(vw.breakdown).toEqual([
      { label: "今日", count: 1 },
      { label: "明日", count: 0 },
    ]);
  });
  it("0件は静かな色、件数があれば目立つ色", () => {
    const tones = (i: InquiryCounts, o: OverdueCounts) => homeKpiTiles(i, o).map((t) => t.tone);
    expect(tones(inquiry, overdue)).toEqual(["alert", "warn", "info"]);
    const zero = { ...inquiry, open: 0, upcomingViewings: 0, openByKind: {}, viewingsToday: 0, viewingsTomorrow: 0 };
    expect(tones(zero, { total: 0, within3: 0, within7: 0, older: 0 })).toEqual(["quiet", "quiet", "quiet"]);
  });
  it("反響の権限が無い(読めない)人は期限切れだけ、次回対応が読めない人は反響の2つだけ", () => {
    expect(homeKpiTiles(null, overdue).map((t) => t.key)).toEqual(["overdue"]);
    expect(homeKpiTiles(inquiry, null).map((t) => t.key)).toEqual(["open", "viewings"]);
  });
  it("反響・内見は今どおり受付の窓(名前付きの窓)、期限切れは同じページの「自分の次回対応」へ", () => {
    const out = renderToStaticMarkup(<HomeKpiSummaryView inquiry={inquiry} overdue={overdue} />);
    expect((out.match(/<a href="\/inquiry-desk" target="pm-inquiry-desk"/g) ?? []).length).toBe(2);
    expect(out).toContain('href="#my-next-actions"');
    expect(out).not.toContain("noopener");
    expect(out).toMatch(/>5<span[^>]*>件<\/span>/);
  });
  it("どちらも読めない(権限が無い・失敗も含む)ときは何も出さない", () => {
    expect(renderToStaticMarkup(<HomeKpiSummaryView inquiry={null} overdue={null} />)).toBe("");
    expect(renderToStaticMarkup(<HomeKpiSummary />)).toBe("");
  });
  it("失敗したら消す(古い件数を残さない)", () => {
    const src = read("src/components/home/home-kpi-summary.tsx");
    expect(src).toMatch(/catch[\s\S]{0,120}setInquiry\(null\)/);
    expect(src).toMatch(/catch[\s\S]{0,120}setOverdue\(null\)/);
  });
  it("ホームの題名の下・自分の次回対応とカードの上に置く", () => {
    const src = read("src/components/home/HomeContent.tsx");
    const a = src.indexOf("<PageHeader");
    const b = src.indexOf("<HomeKpiSummary />");
    const c = src.indexOf("<HomeNextActions />");
    const d = src.indexOf("cards.map(");
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(c).toBeLessThan(d);
  });
});
