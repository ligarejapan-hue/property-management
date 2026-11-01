import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DealDocLinksView, type DocLinkActions } from "../deal-doc-links";
import type { DocLinksResponse } from "@/lib/deals/doc-links/staff-store";

const actions: DocLinkActions = { busy: false, onIssue: vi.fn(async () => true), onRevoke: vi.fn(), onReview: vi.fn(), onCopy: vi.fn() };
const data = (over: Partial<DocLinksResponse> = {}): DocLinksResponse => ({
  links: [{
    id: "l1", partyId: "p1", partyRole: "seller", partyName: "試験 太郎", state: "active", expiresOn: "2026-11-15",
    url: "https://x/submit/t", guidance: "文面", missingText: "・住民票",
    requests: [
      { id: "r1", checklistItemId: "a", label: "本人確認書類", status: "submitted", rejectReason: null, fileCount: 1, files: [{ id: "f1", mimeType: "image/jpeg", fileSize: 10, reviewState: "unreviewed", createdAt: "2026-11-01T00:00:00Z" }] },
      { id: "r2", checklistItemId: "b", label: "住民票", status: "rejected", rejectReason: "文字が読めません", fileCount: 0, files: [] },
    ],
  }],
  parties: [{ id: "p1", role: "seller", name: "試験 太郎" }],
  options: [{ id: "a", label: "本人確認書類" }],
  canManage: true, canReview: true, available: true, dealOpen: true,
  ...over,
});
const render = (d: DocLinksResponse) => renderToStaticMarkup(<DealDocLinksView dealId="d1" data={d} actions={actions} notice={null} />);

describe("お客様の書類提出の枠", () => {
  it("確認待ちの件数を出して開く", () => {
    const html = render(data());
    expect(html).toContain("確認待ち 1件");
    expect(html).toMatch(/<details[^>]* open/);
  });
  it("受領・差し戻し・ダウンロード・コピー・無効化を出す", () => {
    const html = render(data());
    for (const t of ["受領", "差し戻し", "ファイル1をダウンロード", "案内の文面をコピー", "足りない書類をコピー", "無効にする", "理由:文字が読めません"]) expect(html).toContain(t);
    expect(html).toContain('href="/api/deals/d1/doc-links/files/f1"');
  });
  it("URL そのものは画面に出さない(コピーで渡す)", () => {
    expect(render(data())).not.toContain("https://x/submit/t");
  });
  it("中身の権限がなければ受領とダウンロードを出さない", () => {
    const html = render(data({ canReview: false, links: data().links.map((l) => ({ ...l, requests: l.requests.map((r) => ({ ...r, files: [] })) })) }));
    expect(html).not.toContain("ダウンロード");
    expect(html).not.toContain(">受領</button>");
  });
  it("編集権限がなければ発行とコピーを出さない", () => {
    const html = render(data({ canManage: false, canReview: false }));
    expect(html).not.toContain("提出用リンクを発行");
    expect(html).not.toContain("コピー");
    expect(html).not.toContain("無効にする");
  });
  it("設定が済んでいなければ、その旨を出して発行させない", () => {
    const html = render(data({ available: false }));
    expect(html).toContain("設定が済んでいないため");
    expect(html).not.toContain("提出用リンクを発行");
  });
  it("発行の初期値は14日", () => {
    expect(render(data({ links: [] }))).toMatch(/value="14"/);
  });
});
