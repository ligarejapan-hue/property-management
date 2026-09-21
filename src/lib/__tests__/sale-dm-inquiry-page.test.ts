import { describe, it, expect } from "vitest";
import {
  renderInquiryDonePage, renderInquiryInvalidPage, renderInquiryPreviewPage,
  renderInquiryUnavailablePage, renderInquiryBusyPage, renderInquiryThrottledPage,
} from "@/lib/sale-dm-letter/inquiry-page";
import { DEFAULT_PRIVACY_TEXT } from "@/lib/sale-dm-letter/privacy-text";
import { renderUnsubscribeDonePage } from "@/lib/sale-dm-letter/unsubscribe-page";

describe("申込まわりの公開ページ", () => {
  it("完了: 担当者から連絡する旨。自動返信メールは送らない設計なので「メールを送りました」と言わない", () => {
    const html = renderInquiryDonePage();
    expect(html).toContain("受け付けました");
    expect(html).toContain("担当者");
    expect(html).not.toMatch(/メールを(お)?送り/);
  });
  it("入力不備: 文言は escape され、戻り先リンクが出る", () => {
    const html = renderInquiryInvalidPage(["<b>お名前</b>をご入力ください。"], "/t/abc#inquiry");
    expect(html).toContain("&lt;b&gt;お名前&lt;/b&gt;");
    expect(html).toContain('href="/t/abc#inquiry"');
  });
  it("入力不備: 戻り先の引用符も escape", () => {
    expect(renderInquiryInvalidPage([], '/t/a"onmouseover="x')).not.toContain('"onmouseover="');
  });
  it("プレビュー中・受付不可・混雑・回数超過は、それぞれ電話での受付へ誘導する", () => {
    for (const html of [renderInquiryPreviewPage(), renderInquiryUnavailablePage(), renderInquiryBusyPage(), renderInquiryThrottledPage()]) {
      expect(html).toMatch(/お電話/);
      expect(html).toContain('<meta name="robots" content="noindex,nofollow" />');
    }
  });
  it("配信停止ページは共通化後も同じ見た目(回帰)", () => {
    expect(renderUnsubscribeDonePage()).toContain("配信停止を受け付けました");
  });
  it("同意文のひな形: 利用目的と第三者提供に触れている", () => {
    expect(DEFAULT_PRIVACY_TEXT).toMatch(/利用/);
    expect(DEFAULT_PRIVACY_TEXT).toMatch(/第三者/);
  });
});
