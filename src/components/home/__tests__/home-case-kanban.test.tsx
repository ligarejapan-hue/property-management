import { vi, describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));

import HomeCaseKanban, { HomeCaseKanbanView } from "../home-case-kanban";
import { KANBAN_STATUSES, kanbanLabel, kanbanListHref, type KanbanResponse } from "@/lib/home/case-kanban";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const U = "11111111-1111-4111-8111-111111111111";
const data = (mine = false): KanbanResponse => ({
  mine,
  selfId: U,
  columns: KANBAN_STATUSES.map((status) => ({
    status, label: kanbanLabel(status), count: status === "contact_attempting" ? 12 : 0,
    cards: status === "contact_attempting"
      ? [{ id: "p1", address: "東京都中野区1丁目", assigneeName: "山田", updatedAt: "2026-11-08T03:00:00.000Z" }]
      : [],
  })),
});

describe("ホームの案件の進み具合(案2)", () => {
  it("列の名前・件数・カード(所在・担当・更新日)を出す", () => {
    const out = renderToStaticMarkup(<HomeCaseKanbanView data={data()} />);
    for (const l of ["コンタクト中", "所有者とやりとり中", "査定中", "商談中", "媒介取得", "販売中", "契約予定"]) expect(out).toContain(l);
    expect(out).toContain("東京都中野区1丁目");
    expect(out).toContain("山田");
    expect(out).toContain("11/8");
    expect(out).toContain('href="/properties/p1"');
    expect(out).toContain("なし");
  });
  it("「ほか N 件」は物件一覧をそのステータスで絞って開く(自分だけのときは担当者も)", () => {
    expect(renderToStaticMarkup(<HomeCaseKanbanView data={data()} />)).toContain("ほか11件");
    expect(kanbanListHref("appraisal", null)).toBe("/properties?caseStatus=appraisal");
    expect(kanbanListHref("appraisal", U)).toBe(`/properties?caseStatus=appraisal&assignedTo=${U}`);
    const mine = renderToStaticMarkup(<HomeCaseKanbanView data={data(true)} />);
    expect(mine).toContain(`/properties?caseStatus=contact_attempting&amp;assignedTo=${U}`);
    expect(mine).toMatch(/type="checkbox"[^>]*checked/);
  });
  it("ドラッグ・ステータス変更の操作は無い(見るだけ)", () => {
    const src = read("src/components/home/home-case-kanban.tsx");
    expect(src).not.toMatch(/draggable|onDrag|onDrop|method:\s*"(PATCH|POST|PUT|DELETE)"/);
  });
  it("読めるまで(権限が無い・失敗も含む)は何も出さない。失敗したら消す", () => {
    expect(renderToStaticMarkup(<HomeCaseKanban />)).toBe("");
    expect(read("src/components/home/home-case-kanban.tsx")).toMatch(/catch[\s\S]{0,120}setData\(null\)/);
  });
  it("ホームでは今週の予定の下・カードの上に置く", () => {
    const src = read("src/components/home/HomeContent.tsx");
    const a = src.indexOf("<HomeWeekCalendar />");
    const b = src.indexOf("<HomeCaseKanban />");
    const c = src.indexOf("cards.map(");
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });
});
