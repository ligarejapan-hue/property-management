import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TimelineEvent, TimelineSummary } from "@/lib/history-timeline/events";

vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }));

import { TimelineRow, TimelineSummaryCard } from "../history-timeline";

const ev = (over: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id: "comment:1", at: "2026-11-01T01:00:00.000Z", dateOnly: false, source: "comment", category: "contact", actor: "担当A", title: "コメント",
  detail: null, href: "/properties/p?tab=comments", dealLabel: null, ...over,
});
const summary = (over: Partial<TimelineSummary> = {}): TimelineSummary => ({
  statuses: [{ label: "案件ステータス", value: "販売中" }], next: { label: "決済日の確定", due: "2026-11-05" }, lastContactAt: "2026-11-01T01:00:00.000Z", pendingDocs: 2, preIntroPending: 0, ...over,
});

describe("経緯の行", () => {
  it("誰が・何をしたかを出す", () => {
    const html = renderToStaticMarkup(<TimelineRow event={ev()} />);
    expect(html).toContain("担当A");
    expect(html).toContain("コメント");
    expect(html).toContain("元の画面を開く");
  });

  it("詳細があるときだけ開ける形にする", () => {
    expect(renderToStaticMarkup(<TimelineRow event={ev()} />)).not.toContain("<details");
    const html = renderToStaticMarkup(<TimelineRow event={ev({ detail: "本文です" })} />);
    expect(html).toContain("<details");
    expect(html).toContain("本文です");
  });

  it("誰かの記録が無ければ空のまま", () => {
    expect(renderToStaticMarkup(<TimelineRow event={ev({ actor: null })} />)).not.toContain("null");
  });

  it("日付だけの記録は時刻を出さない", () => {
    const html = renderToStaticMarkup(<TimelineRow event={ev({ dateOnly: true, at: "2026-10-01T00:00:00.000Z" })} />);
    expect(html).not.toMatch(/\d{2}:\d{2}/);
  });

  it("物件の経緯ではどの取引の行かを出す", () => {
    expect(renderToStaticMarkup(<TimelineRow event={ev({ dealLabel: "取引 2026-0001" })} />)).toContain("取引 2026-0001");
  });
});

describe("直近の状況", () => {
  it("状態・次の段取り・最後のやり取り・未受領の件数を出す", () => {
    const html = renderToStaticMarkup(<TimelineSummaryCard summary={summary()} />);
    for (const text of ["案件ステータス", "販売中", "2026-11-05 決済日の確定", "最後のやり取り", "未受領の書類", "2件"]) expect(html).toContain(text);
  });

  it("取引を見られない人には未受領の欄そのものを出さない", () => {
    expect(renderToStaticMarkup(<TimelineSummaryCard summary={summary({ pendingDocs: null })} />)).not.toContain("未受領");
  });

  it("次の段取りとやり取りが無ければなしと出す", () => {
    const html = renderToStaticMarkup(<TimelineSummaryCard summary={summary({ next: null, lastContactAt: null })} />);
    expect(html.match(/なし/g)).toHaveLength(2);
    expect(html).not.toContain("導入前");
  });

  it("次の段取りが無く導入前の未完了が残っていれば、なしに件数を添える", () => {
    const html = renderToStaticMarkup(<TimelineSummaryCard summary={summary({ next: null, preIntroPending: 2 })} />);
    expect(html).toContain("なし(導入前の未完了 2件)");
  });
});
