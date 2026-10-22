import { describe, it, expect } from "vitest";
import { renderLpPage, LP_CTA_LABEL } from "../sale-dm-letter/lp-page";
import type { LpRenderInput } from "../sale-dm-letter/lp-render-input";
import { LP_BRAND } from "../sale-dm-letter/lp-brand";
import { INQUIRY_LIMITS } from "../sale-dm-letter/inquiry-input";

/** 広告用の公開ページ(設計 2026-10-20): 宛先を持たない・配信停止なし・電話タップの計測なし。 */
const publicInput = (over: Partial<LpRenderInput> = {}): LpRenderInput => ({
  mode: "public",
  headline: "相続した家、どうする? <b>",
  lead: "売る・貸す・持つ、まず整理 & 比較",
  intro: ["はじめに。"],
  sections: [
    { heading: "売却の進め方", paragraphs: ["流れの説明。", "二段落目。"], media: { kind: "figure", figureKind: "sale_flow" } },
    { heading: "費用について", paragraphs: ["費用の説明。"], media: null },
  ],
  faq: [{ q: "費用は？", a: "無料です。" }],
  hero: { publicId: "a".repeat(32), width: 1600, height: 900 },
  company: { name: "株式会社リガーレ", contact: "TEL 03-1234-5678", phone: "0312345678" },
  unsubscribeUrl: null,
  phoneTapToken: null,
  form: { action: "/lp/souzoku/inquiry", privacyText: "同意文", disabled: false },
  public: {
    adParams: { utmSource: "google", utmMedium: "cpc", utmCampaign: 'aki"<x>', utmTerm: null, utmContent: null, gclid: "G1.abc" },
    safeQuery: "?utm_source=google&utm_medium=cpc",
    google: null,
    og: { url: "https://app.example.com/lp/souzoku", imageUrl: `https://app.example.com/lp-assets/${"a".repeat(32)}` },
  },
  ...over,
});

describe("renderLpPage(public=広告用の公開ページ)", () => {
  const html = renderLpPage(publicInput());

  it("検索に載せない(noindex,nofollow)・見出し情報(OGP)を出す・動的な値は escape", () => {
    expect(html).toContain('name="robots" content="noindex,nofollow"');
    expect(html).not.toContain('content="index,follow"');
    expect(html).toContain('property="og:type" content="website"');
    expect(html).toContain('property="og:title" content="相続した家、どうする? &lt;b&gt;"');
    expect(html).toContain('property="og:description" content="売る・貸す・持つ、まず整理 &amp; 比較"');
    expect(html).toContain('property="og:url" content="https://app.example.com/lp/souzoku"');
    expect(html).toContain(`property="og:image" content="https://app.example.com/lp-assets/${"a".repeat(32)}"`);
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
  });
  it("リード文が無ければ本文の最初の段落を説明に使い(120字まで)、写真が無ければ og:image と twitter:card を出さない", () => {
    const h = renderLpPage(publicInput({ lead: null, intro: ["あ".repeat(200)], hero: null, public: { ...publicInput().public!, og: { url: "https://app.example.com/lp/souzoku", imageUrl: null } } }));
    expect(h).toContain(`property="og:description" content="${"あ".repeat(120)}"`);
    expect(h).not.toContain('property="og:image"');
    expect(h).not.toContain("twitter:card");
  });
  it("冒頭の小見出しは手紙向けではなく一般向け・プレビューの帯なし・配信停止の案内なし", () => {
    expect(html).toContain(`<p class="eyebrow">${LP_BRAND.publicEyebrow}</p>`);
    expect(html).not.toContain(LP_BRAND.heroEyebrow);
    expect(html).not.toContain("プレビュー");
    expect(html).not.toContain("配信停止");
  });
  it("申込フォームに「物件の所在地(任意)」の欄と、どの広告から来たかの隠し欄(escape 済み)がある", () => {
    expect(html).toMatch(new RegExp(`<label>物件の所在地<span class="opt">任意</span><input name="propertyAddress" type="text" maxlength="${INQUIRY_LIMITS.propertyAddress}"`));
    expect(html).toContain('<input type="hidden" name="utm_source" value="google" />');
    expect(html).toContain('<input type="hidden" name="utm_medium" value="cpc" />');
    expect(html).toContain('<input type="hidden" name="utm_campaign" value="aki&quot;&lt;x&gt;" />');
    expect(html).toContain('<input type="hidden" name="gclid" value="G1.abc" />');
    // 空の印の隠し欄は出さない
    expect(html).not.toContain('name="utm_term"');
    expect(html).not.toContain('name="utm_content"');
    // 送信先は公開ページの受け口
    expect(html).toContain('action="/lp/souzoku/inquiry"');
    expect(html).toContain(LP_CTA_LABEL);
  });
  it("DM 用(live)のページには所在地の欄も隠し欄も出ない", () => {
    const live = renderLpPage(publicInput({ mode: "live", public: undefined, form: { action: "/t/tok/inquiry", privacyText: "同意文", disabled: false } }));
    expect(live).not.toContain('name="propertyAddress"');
    expect(live).not.toContain('type="hidden" name="utm_');
    expect(live).toContain(LP_BRAND.heroEyebrow);
  });
  it("Google のタグが無いときは外部読み込みが一切なく、電話タップの計測もない(固定バー・送信・チェック札・動きの script)", () => {
    expect(html).not.toMatch(/<script[^>]*src=/);
    expect(html).not.toContain("googletagmanager");
    expect(html).not.toContain("sendBeacon(");
    // 固定バー・送信の守り・動き(+チェック札があるときはその分)
    expect((html.match(/<script/g) ?? []).length).toBe(3);
  });
  it("Google のタグがあるときだけ gtag.js を読み込み、申込完了の合図(lp:inquiry-done)でコンバージョンを送る", () => {
    const h = renderLpPage(publicInput({ public: { ...publicInput().public!, google: { tagId: "AW-12345ABC", convLabel: "AbCd-12_x" } } }));
    expect(h).toContain('<script async src="https://www.googletagmanager.com/gtag/js?id=AW-12345ABC"></script>');
    // page_location は素の URL ではなく、許可リストを通った印だけを付け直した URL(utm_campaign の 'aki"<x>' は落ちている・@codex #535 R4 P1)
    // "&" は <script> 内で安全な & に(jsString)
    expect(h).toContain('gtag(\'config\',\'AW-12345ABC\',{page_location:location.origin+location.pathname+"?utm_source=google\\u0026utm_medium=cpc"})');
    expect(h).not.toContain("document.location");
    expect(h).toContain("gtag('event','conversion',{send_to:'AW-12345ABC/AbCd-12_x'})");
    expect(h).toContain("gtag('event','generate_lead')");
    expect(h).toContain('document.addEventListener("lp:inquiry-done"');
    // ラベルが無ければ conversion は送らず generate_lead だけ
    const g2 = renderLpPage(publicInput({ public: { ...publicInput().public!, google: { tagId: "G-ABCD1234", convLabel: null } } }));
    expect(g2).not.toContain("'event','conversion'");
    expect(g2).toContain("gtag('event','generate_lead')");
    // G-/GT- の ID にラベルが残っていても conversion は送らない(Google広告の宛先は AW- だけ・@codex #535 R2)
    const g3 = renderLpPage(publicInput({ public: { ...publicInput().public!, google: { tagId: "G-ABCD1234", convLabel: "AbCd-12_x" } } }));
    expect(g3).not.toContain("'event','conversion'");
    expect(g3).toContain("gtag('config','G-ABCD1234',{page_location:");
  });
  it("送信スクリプトは申込完了(done)のときに document へ lp:inquiry-done を出す(値は含めない)。サーバーが silent(機械送信)と返したときは出さない", () => {
    expect(html).toContain('new CustomEvent("lp:inquiry-done")');
    const i = html.indexOf("function done(silent){");
    expect(i).toBeGreaterThan(-1);
    expect(html.slice(i, i + 400)).toContain('if(!silent){try{document.dispatchEvent(new CustomEvent("lp:inquiry-done"))}');
    expect(html).toContain('if(k==="done"){done(d.silent===true);return}');
  });
});
