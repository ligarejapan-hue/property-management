import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import HomeNextActions, { HomeNextActionsView } from "../home-next-actions";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("ホームの「自分の次回対応」(通知 段階2の行き先)", () => {
  it("今日・期限切れを出し、1件ずつ物件の画面へ", () => {
    const out = renderToStaticMarkup(
      <HomeNextActionsView
        hasMore={false}
        items={[
          { id: "a1", propertyId: "p1", scheduledAt: "2026-09-30", actionType: "電話", overdue: true, address: "東京都○○区1-2-3" },
          { id: "a2", propertyId: "p2", scheduledAt: "2026-10-02", actionType: null, overdue: false, address: "東京都△△区4-5-6" },
        ]}
      />,
    );
    expect(out).toContain('id="my-next-actions"');
    expect(out).toContain("期限切れ 9/30");
    expect(out).toContain("今日");
    expect(out).toContain('href="/properties/p1"');
    expect(out).toContain('href="/properties/p2"');
    expect(out).toContain("電話");
  });
  it("0件なら何も出さない・読めるまで(権限なし・失敗)も何も出さない", () => {
    expect(renderToStaticMarkup(<HomeNextActionsView items={[]} hasMore={false} />)).toBe("");
    expect(renderToStaticMarkup(<HomeNextActions />)).toBe("");
  });
  it("失敗したら消す(古い一覧を残さない)", () => {
    expect(read("src/components/home/home-next-actions.tsx")).toMatch(/catch[\s\S]{0,120}setData\(null\)/);
  });
  it("ホームの題名の下・カードの上に置く", () => {
    const src = read("src/components/home/HomeContent.tsx");
    const a = src.indexOf("<PageHeader");
    const b = src.indexOf("<HomeNextActions />");
    const c = src.indexOf("cards.map(");
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });
});
