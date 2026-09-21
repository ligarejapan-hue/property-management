/**
 * 公開LPの査定申込の結果画面(設計 §2.5)。純関数・固定文のみ。
 * ⚠お客様が見る画面。入力された氏名・電話などは一切表示しない(送り返さない)。
 */
import { escapeHtml } from "./templates/index";
import { renderPublicCardPage } from "./unsubscribe-page";

export function renderInquiryDonePage(): string {
  return renderPublicCardPage("お申し込みを受け付けました", [
    "<h1>お申し込みを受け付けました</h1>",
    "<p>無料査定のお申し込みをいただき、ありがとうございます。</p>",
    "<p>内容を確認のうえ、担当者からご連絡いたします。</p>",
    '<p class="note">数日たっても連絡がない場合は、お手数ですがお手紙に記載の連絡先までお電話ください。</p>',
  ].join(""));
}

export function renderInquiryInvalidPage(messages: readonly string[], backHref: string): string {
  const items = messages.map((m) => `<li>${escapeHtml(m)}</li>`).join("");
  return renderPublicCardPage("入力内容をご確認ください", [
    "<h1>入力内容をご確認ください</h1>",
    items ? `<ul>${items}</ul>` : "",
    `<a class="back" href="${escapeHtml(backHref)}">入力画面に戻る</a>`,
  ].join(""));
}

export function renderInquiryPreviewPage(): string {
  return renderPublicCardPage("まだお申し込みを受け付けていません", [
    "<h1>まだお申し込みを受け付けていません</h1>",
    "<p>このページは送付前の確認用です。お申し込みは受け付けておりません。</p>",
    "<p>お急ぎの場合は、お手紙に記載の連絡先までお電話ください。</p>",
  ].join(""));
}

export function renderInquiryUnavailablePage(): string {
  return renderPublicCardPage("お申し込みを受け付けられませんでした", [
    "<h1>お申し込みを受け付けられませんでした</h1>",
    "<p>お手数ですが、お手紙に記載の連絡先までお電話ください。</p>",
  ].join(""));
}

export function renderInquiryBusyPage(): string {
  return renderPublicCardPage("ただいま混み合っています", [
    "<h1>ただいま混み合っています</h1>",
    "<p>お申し込みを完了できませんでした。少し時間をおいて、もう一度お試しください。</p>",
    "<p>お急ぎの場合は、お手紙に記載の連絡先までお電話ください。</p>",
  ].join(""));
}

export function renderInquiryThrottledPage(): string {
  return renderPublicCardPage("アクセスが集中しています", [
    "<h1>アクセスが集中しています</h1>",
    "<p>しばらく時間をおいてから、もう一度お試しください。</p>",
    "<p>お急ぎの場合は、お手紙に記載の連絡先までお電話ください。</p>",
  ].join(""));
}
