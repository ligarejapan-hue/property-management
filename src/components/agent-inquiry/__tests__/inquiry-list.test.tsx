import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UpcomingViewingsView } from "../upcoming-viewings";
import { InquiryListView } from "../inquiry-list";
import { InquiryDetailView } from "../inquiry-detail";

const property = {
  id: "p1", name: "サンライズ中野", roomNo: "305", town: "東京都中野区中野2丁目", propertyType: "apartment_unit", adPermissions: {},
};
const inquiry = {
  id: "i1", kind: "viewing" as const, status: "open" as const, channel: "phone" as const,
  receivedAt: "2026-09-30T07:20:00.000Z", version: 1,
  contactName: "田中", contactMobile: "090-1234-5678", contactEmail: null, note: null,
  assignee: { id: "u1", name: "佐藤" }, agent: { id: "a1", companyName: "○○不動産", branchName: null, phone: "03-1" },
  viewings: [
    { id: "v1", scheduledAt: "2026-10-02T05:00:00.000Z", viewingType: "guided" as const, canceledAt: null, resultNote: null, version: 1,
      attendant: { id: "u1", name: "佐藤" } },
    { id: "v2", scheduledAt: null, viewingType: "preview" as const, canceledAt: "2026-09-30T00:00:00.000Z", resultNote: "見送り", version: 2,
      attendant: null },
  ],
  property,
};
const noop = vi.fn();

describe("今日・明日の内見", () => {
  it("時刻・案内/下見・物件・業者・立ち会い", () => {
    const html = renderToStaticMarkup(
      <UpcomingViewingsView
        viewings={[{
          id: "v1", scheduledAt: "2026-10-02T05:00:00.000Z", viewingType: "guided", version: 1,
          attendant: { id: "u1", name: "佐藤" },
          inquiry: { id: "i1", contactName: "田中", agent: { companyName: "○○不動産" }, property },
        }]}
      />,
    );
    for (const t of ["今日・明日の内見", "10/2(金) 14:00", "案内", "サンライズ中野 305", "○○不動産", "立会 佐藤"]) {
      expect(html).toContain(t);
    }
  });
  it("0件なら「ありません」", () => {
    expect(renderToStaticMarkup(<UpcomingViewingsView viewings={[]} />)).toContain("ありません");
  });
});

describe("一覧", () => {
  it("3つのタブ(未対応に件数)・自分の担当だけ・1件の中身", () => {
    const html = renderToStaticMarkup(
      <InquiryListView tab="open" onTab={noop} mine={false} onMine={noop} items={[inquiry]} openCount={3}
        onOpen={noop} hasMore={false} onMore={noop} />,
    );
    for (const t of ["未対応 3", "対応中", "対応済み", "自分の担当だけ", "サンライズ中野 305", "○○不動産", "田中様", "内見", "担当:佐藤", "電話"]) {
      expect(html).toContain(t);
    }
    expect(html).toContain('aria-selected="true"');
  });
  it("続きがあれば「もっと見る」", () => {
    expect(
      renderToStaticMarkup(
        <InquiryListView tab="done" onTab={noop} mine onMine={noop} items={[]} openCount={0} onOpen={noop} hasMore onMore={noop} />,
      ),
    ).toContain("もっと見る");
  });
});

describe("詳細", () => {
  type P = Parameters<typeof InquiryDetailView>[0];
  const view = (over: Partial<P> = {}) =>
    renderToStaticMarkup(
      <InquiryDetailView inquiry={inquiry} canOpenProperty={false} users={[{ id: "u1", name: "佐藤" }]} busy={false} error={null}
        onStatus={noop} onAssignee={noop} onSaveNote={noop} onAddViewing={noop} onSaveViewing={noop} onClose={noop} {...over} />,
    );
  it("物件を開く権限が無ければ「メイン画面で物件を開く」を出さない", () => {
    expect(view()).not.toContain("メイン画面で物件を開く");
    const html = view({ canOpenProperty: true });
    expect(html).toContain("メイン画面で物件を開く");
    expect(html).toMatch(/href="\/properties\/p1"[^>]*target="pm-main"|target="pm-main"[^>]*href="\/properties\/p1"/);
  });
  it("状態・担当・メモ・内見(取り消し済みは印・結果・内見を足す)", () => {
    const html = view();
    for (const t of ["未対応", "対応中", "対応済み", "担当", "メモ", "10/2(金) 14:00", "日程調整中", "取り消し済み", "見送り", "内見を足す"]) {
      expect(html).toContain(t);
    }
  });
  it("409 などの文言を出し、入力を残したまま「読み直す」を選べる", () => {
    const html = view({ error: "他の人が先に更新しました。開き直してください。", onReload: noop });
    expect(html).toContain("他の人が先に更新しました");
    expect(html).toContain("読み直す");
  });
  it("問い合わせ者の携帯を出す(折り返し用)", () => {
    expect(view()).toContain("090-1234-5678");
  });
});
