import { describe, it, expect } from "vitest";
import { renderLpPage } from "../sale-dm-letter/lp-page";
import { renderFigureHtml } from "../sale-dm-letter/lp-figures";
import type { LpRenderInput } from "../sale-dm-letter/lp-render-input";

/**
 * スマホ表示の崩れ6か所の直し(発注者 2026-10-21「携帯で開いたけど改行や文字列とイラストのバランスが取れていない」
 * 見本 https://claude.ai/artifact/7bW6pkSRsfM7q7x2YBhZPC)。
 * A 上部のロゴと電話の折り返し / B 見出しの1〜2文字落ち / C 絵つきの節の空白 / D 案内役の札 /
 * E 申込欄の電話番号が「03-」で改行 / F 公開ページの「お手紙の物件」。
 * PC(768px 以上)の並びは変えない。
 */
const input = (over: Partial<LpRenderInput> = {}): LpRenderInput => ({
  mode: "live",
  headline: "見出し",
  lead: "リード",
  intro: ["はじめに。"],
  sections: [
    { heading: "写真つきの節", paragraphs: ["一段落目。", "二段落目。"], media: { kind: "asset", image: { publicId: "b".repeat(32), width: 1456, height: 1088 } } },
    { heading: "案内役の節", paragraphs: ["案内の本文。"], media: { kind: "figure", figureKind: "consult_guide" } },
    { heading: "売却の進め方", paragraphs: ["流れの説明。"], media: { kind: "figure", figureKind: "sale_flow" } },
  ],
  faq: [],
  hero: null,
  company: { name: "株式会社リガーレ", contact: "TEL 03-6823-2760", phone: "0368232760" },
  unsubscribeUrl: null,
  phoneTapToken: null,
  form: { action: "/t/x/inquiry", privacyText: "同意文", disabled: false },
  ...over,
});

const cssOf = (html: string) => html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
/** スマホだけの CSS(`@media (max-width: 767px){` から次の `}` 行まで) */
const mobileCss = (html: string) => {
  const css = cssOf(html);
  const start = css.indexOf("@media (max-width: 767px){");
  const end = css.indexOf("\n}", start);
  return css.slice(start, end);
};
/** PC だけの CSS(`@media (min-width: 768px){` から次の `}` 行まで) */
const pcCss = (html: string) => {
  const css = cssOf(html);
  const start = css.indexOf("@media (min-width: 768px){");
  const end = css.indexOf("\n}", start);
  return css.slice(start, end);
};

describe("公開LP スマホ表示の直し(2026-10-21)", () => {
  const html = renderLpPage(input());

  it("A: 上部の受付時間は「お電話でのご相談」と時間の2行に分け、ロゴ側が縮んで電話側は折り返さない", () => {
    expect(html).toContain(
      '<div class="top-tel"><span class="hours">お電話でのご相談</span><span class="hours">平日 10:00〜19:00</span><a href="tel:0368232760" data-phone-tap="1">03-6823-2760</a></div>',
    );
    const css = cssOf(html);
    expect(css).toContain(".top-tel .hours{display:block}");
    expect(css).toMatch(/\.brand\{min-width:0;flex:1 1 auto\}/);
    // ロゴ下の一言は切らない(狭い端末では折り返す)
    expect(css).not.toMatch(/\.brand small\{[^}]*(nowrap|ellipsis)/);
    expect(css).toMatch(/\.top-tel\{[^}]*flex:none/);
  });

  it("B: 見出しは行の長さをそろえて折り返す(text-wrap:balance)", () => {
    expect(cssOf(html)).toContain("h1,h2{text-wrap:balance}");
  });

  it("C: 絵つきの節はスマホでは絵の横に見出し、本文は絵の下いっぱいに広げる。PC は今までどおり2列", () => {
    const m = mobileCss(html);
    expect(m).toContain(".split{align-items:center}");
    expect(m).toContain(".split .media{margin:0}");
    expect(m).toContain(".split .sec-body{display:contents}");
    expect(m).toContain(".split h2{margin:0}");
    // 本文は段落だけでなく箇条書き・ボタンも絵の下へ
    expect(m).toContain(".split .sec-body>:not(h2){grid-column:1/-1;margin:2px 0 0}");
    expect(pcCss(html)).toContain(".split{grid-template-columns:200px minmax(0,1fr);gap:20px;align-items:center}");
    expect(pcCss(html)).not.toContain("display:contents");
  });

  it("D: 案内役の札はスマホでは絵の横に名乗りと見出し、本文は絵の下いっぱいに広げる", () => {
    const m = mobileCss(html);
    expect(m).toContain(".guide{align-items:center;gap:10px 14px}");
    expect(m).toContain(".guide>div{display:contents}");
    expect(m).toContain(".guide-fig{grid-row:1/3;align-self:center}");
    expect(m).toContain(".guide .guide-name,.guide h2{grid-column:2;margin:0}");
    expect(m).toContain(".guide .guide-name{align-self:end}");
    expect(m).toContain(".guide h2{align-self:start}");
    expect(m).toContain(".guide>div>:not(.guide-name):not(h2){grid-column:1/-1;margin:4px 0 0}");
    expect(pcCss(html)).toContain(".guide{grid-template-columns:132px 1fr;padding:20px}");
  });

  it("E: 申込欄の電話番号は途中で改行しない", () => {
    expect(cssOf(html)).toContain(".inq-tel a{font-weight:700;color:#0e6b5c;text-decoration:none;font-size:17px;white-space:nowrap;display:inline-block}");
  });

  it("F: 流れの1段目は、手紙のページでは「お手紙の物件」、広告用の公開ページでは「ご相談の物件」", () => {
    expect(html).toContain("<span>お手紙の物件について、おおよその価格の目安をお伝えします</span>");
    expect(html).not.toContain("ご相談の物件について");
    const preview = renderLpPage(input({ mode: "preview" }));
    expect(preview).toContain("お手紙の物件について");
    const pub = renderLpPage(input({
      mode: "public",
      form: { action: "/lp/souzoku/inquiry", privacyText: "同意文", disabled: false },
      public: {
        adParams: { utmSource: null, utmMedium: null, utmCampaign: null, utmTerm: null, utmContent: null, gclid: null },
        safeQuery: "",
        google: null,
        og: { url: "https://app.example.com/lp/souzoku", imageUrl: null },
      },
    }));
    expect(pub).toContain("<span>ご相談の物件について、おおよその価格の目安をお伝えします</span>");
    expect(pub).not.toContain("お手紙の物件");
  });

  it("F: 図の部品は呼び出し側が公開ページかどうかを渡せる(既定は手紙向け)", () => {
    expect(renderFigureHtml("sale_flow")).toContain("お手紙の物件について");
    expect(renderFigureHtml("sale_flow", { audience: "public" })).toContain("ご相談の物件について");
    expect(renderFigureHtml("sale_flow", { audience: "public" })).not.toContain("お手紙の物件");
  });
});
