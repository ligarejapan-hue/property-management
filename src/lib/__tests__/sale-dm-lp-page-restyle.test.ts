import { describe, it, expect } from "vitest";
import { renderLpPage, LP_CTA_LABEL } from "../sale-dm-letter/lp-page";
import type { LpRenderInput } from "../sale-dm-letter/lp-render-input";
import { LP_BRAND } from "../sale-dm-letter/lp-brand";

// 2026-10 の見本(発注者承認・https://claude.ai/artifact/QjhQmDuuT8Nd5EPs5za6ja)どおりの作り。
const FORM = { action: "/t/tok/inquiry", privacyText: "利用目的", disabled: false };
const input = (over: Partial<LpRenderInput> = {}): LpRenderInput => ({
  mode: "live",
  headline: "相続した家や土地のことで、お困りではありませんか？",
  lead: "まずはお話を伺います。",
  intro: [],
  sections: [
    { heading: "こんなお困りごとはありませんか", paragraphs: ["□実家に通うのが負担\n□費用がかかり続けている", "ひとつでも当てはまる方は、ご相談ください。"], media: null },
    { heading: "ご相談窓口より", paragraphs: ["決めるのはご家族です。"], media: { kind: "figure", figureKind: "consult_guide" } },
    { heading: "期限について", paragraphs: ["いくつかの期限があります。"], media: { kind: "figure", figureKind: "inheritance_deadlines" } },
    { heading: "荷物が残ったままでも", paragraphs: ["・家具\n・思い出の品"], media: { kind: "asset", image: { publicId: "b".repeat(32), width: 1456, height: 1088 } } },
  ],
  faq: [{ q: "費用は？", a: "無料です。" }],
  hero: { publicId: "a".repeat(32), width: 1680, height: 944 },
  company: { name: "株式会社リガーレジャパン", contact: "TEL 03-6823-2760", phone: "0368232760" },
  unsubscribeUrl: "https://lp.example.com/u/tok.sig",
  phoneTapToken: "tok",
  form: FORM,
  ...over,
});

describe("公開LPの新しい作り(2026-10 見本)", () => {
  const html = renderLpPage(input());

  it("ロゴは会社のホームページへ新しいタブで飛ぶ(元の比率の実寸つき)", () => {
    expect(html).toContain(`<a class="brand-link" href="${LP_BRAND.homepageUrl}" target="_blank" rel="noopener">`);
    expect(html).toContain(`src="${LP_BRAND.logo.src}" width="${LP_BRAND.logo.width}" height="${LP_BRAND.logo.height}"`);
  });

  it("上部に電話番号(区切りつき)と受付時間。押すと電話・計測の印つき", () => {
    expect(html).toMatch(/<div class="top-tel">お電話でのご相談\(平日 10:00〜19:00\)<a href="tel:0368232760" data-phone-tap="1">03-6823-2760<\/a><\/div>/);
  });

  it("電話番号が無ければ上部の電話は出さない", () => {
    const h = renderLpPage(input({ company: { name: "会社", contact: "info@example.com", phone: null } }));
    expect(h).not.toContain("top-tel\"");
    expect(h).not.toContain("tel:");
  });

  it("ヒーロー: 手紙を読んだ方への一言・3つの約束・申込ボタン", () => {
    expect(html).toContain(LP_BRAND.heroEyebrow);
    for (const p of LP_BRAND.promises) expect(html).toContain(`<li>${p}</li>`);
    expect(html).toContain(LP_CTA_LABEL);
  });

  it("画像は元の縦横比のまま(枠に合わせた切り落とし・引き伸ばしをしない)", () => {
    expect(html).not.toContain("object-fit:cover");
    expect(html).not.toContain("aspect-ratio");
    // ヒーローも節の写真も、実寸の width/height を持つ
    expect(html).toMatch(/<img class="hero"[^>]*width="1680" height="944"/);
    expect(html).toMatch(new RegExp(`<img class="fig" src="/lp-assets/${"b".repeat(32)}" width="1456" height="1088"`));
    // img の CSS はどれも height:auto
    for (const m of html.matchAll(/([^{}]*img[^{}]*)\{([^}]*)\}/g)) {
      if (/width:/.test(m[2])) expect(m[2], m[1]).toContain("height:auto");
    }
  });

  it("写真つきの節は写真と文章の2列(PC)", () => {
    expect(html).toMatch(/<div class="split"><div class="media"><img class="fig"/);
  });

  it("□ の行はタップで選べるチェック札、・の行は箇条書き", () => {
    expect((html.match(/<input type="checkbox" data-check="1"/g) ?? []).length).toBe(2);
    expect(html).toContain('value="実家に通うのが負担"');
    expect(html).toContain("<ul class=\"dots\"><li>家具</li><li>思い出の品</li></ul>");
    expect(html).not.toContain("□");
  });

  it("チェックの内容は申込欄(ご要望)に入る=スクリプトは live かつチェック札があるときだけ", () => {
    expect(html).toContain('querySelectorAll("input[data-check]")');
    expect(html).toContain('textarea[name=message]');
    const none = renderLpPage(input({ sections: [] }));
    expect(none).not.toContain("input[data-check]");
    const preview = renderLpPage(input({ mode: "preview", phoneTapToken: null, form: { ...FORM, action: "#", disabled: true } }));
    expect(preview).not.toContain("<script");
  });

  it("埋め込みスクリプトはすべて構文として正しい・innerHTML を使わない", () => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBe(3);
    for (const s of scripts) expect(() => new Function(s)).not.toThrow();
    expect(html).not.toContain("innerHTML");
  });

  it("案内役の節: イメージイラスト+名乗り+節の見出しと文章を並べる", () => {
    expect(html).toMatch(/<div class="guide"><figure class="guide-fig">[\s\S]*?イメージ<br \/>イラスト[\s\S]*?<p class="guide-name">リガーレジャパン ご相談窓口より<\/p><h2>ご相談窓口より<\/h2><p>決めるのはご家族です。<\/p><\/div><\/div>/);
  });

  it("期限の図は HTML の年表(事実確認済みの文言)", () => {
    expect(html).toContain('<div class="deadline"');
    expect(html).toContain("2027年12月31日までの売却が対象です");
  });

  it("会社案内: ロゴ・受付時間・ホームページへのリンク", () => {
    const company = html.slice(html.indexOf('id="contact"'));
    expect(company).toContain("受付時間 平日 10:00〜19:00");
    expect(company).toContain(`<a href="${LP_BRAND.homepageUrl}" target="_blank" rel="noopener">`);
    // ⚠ class="hp" は申込フォームの隠し欄(画面外へ飛ばす)。会社案内の行に使うと見えなくなる(提出前レビュー)
    expect(company).toContain('<p class="co-hp">ホームページ');
    expect(company).not.toContain('<p class="hp">');
  });

  it("札のクラスは申込フォームの「任意」の印(.opt)と衝突しない", () => {
    const h = renderLpPage(input({ sections: [{ heading: "x", paragraphs: ["y"], media: { kind: "figure", figureKind: "sell_rent_keep" } }] }));
    expect(h).toContain('<div class="opt-card">');
    // 素の .opt{...}(全体に効く規則)を置かない。フォーム側の「.inquiry .opt{」だけが残る
    expect(h).not.toMatch(/(^|\n|\})\.opt\{/);
  });

  it("チェック札が複数あっても、どの札の下の案内文も更新する", () => {
    expect(html).toContain('querySelectorAll("[data-check-msg]")');
    expect(html).not.toContain('querySelector("[data-check-msg]")');
  });

  it("よくある質問は Q/A の印つき", () => {
    expect(html).toContain('<summary><span class="q">Q</span><span>費用は？</span></summary><div class="a"><b>A</b><p>無料です。</p></div>');
  });

  it("所有者の氏名などを持ち込まない(固定文にも敬称を含めない)", () => {
    expect(html).not.toMatch(/山田|様/);
  });

  it("書体は外部から読み込まない(CSP default-src 'none' のまま・端末の明朝体)", () => {
    expect(html).not.toMatch(/<link\s|@import|fonts\.googleapis/);
    expect(html).toContain("Hiragino Mincho ProN");
  });
});

// 発注者要望(2026-10-07): 実例は「押すと広がる」形に。見出しが「ご相談の例」「実例」で始まる節が対象。
describe("ご相談の例(実例)は押すと広がる", () => {
  const caseInput = input({ sections: [
    { heading: "ご相談の例(世田谷区・戸建て・築35年)", paragraphs: ["権利書も見つからない状態から売却\n相続人であるお子様たちは…", "二段落目。"], media: null },
    { heading: "実例:東京都・マンション", paragraphs: ["一行だけの本文。"], media: null },
    { heading: "ふつうの節", paragraphs: ["x"], media: null },
  ] });
  const h = renderLpPage(caseInput);

  it("見出しの()の中が札、本文の1行目が題、残りは開くと読める", () => {
    expect(h).toContain('<section class="case"><details><summary><span class="case-tag">ご相談の例|世田谷区・戸建て・築35年</span><strong>権利書も見つからない状態から売却</strong><span class="case-more" aria-hidden="true">続きを読む</span></summary><div class="case-body"><p>相続人であるお子様たちは…</p><p>二段落目。</p></div></details></section>');
  });
  it("1行目しか無い本文は、見出しを題にして本文を中に入れる", () => {
    expect(h).toContain('<span class="case-tag">実例|東京都・マンション</span><strong>実例:東京都・マンション</strong>');
    expect(h).toContain('<div class="case-body"><p>一行だけの本文。</p></div>');
  });
  it("実例の節に付けた写真・図も、開いたときの本文に出す(@codex #488 R1 P2)", () => {
    const withMedia = renderLpPage(input({ sections: [
      { heading: "ご相談の例(A)", paragraphs: ["題\n本文"], media: { kind: "figure", figureKind: "sale_flow" } },
      { heading: "ご相談の例(B)", paragraphs: ["題\n本文"], media: { kind: "asset", image: { publicId: "c".repeat(32), width: 800, height: 600 } } },
    ] }));
    expect(withMedia).toContain('<p>本文</p><div class="figure"><div class="flow-box">');
    expect(withMedia).toMatch(new RegExp(`<div class="case-body"><div class="media"><img class="fig" src="/lp-assets/${"c".repeat(32)}"`));
  });
  it("題のあとに空行があっても、1行目を題にする(@codex #488 R2 P2)", () => {
    const sep = renderLpPage(input({ sections: [
      { heading: "ご相談の例(C)", paragraphs: ["空行の前の題", "本文の段落。"], media: null },
    ] }));
    expect(sep).toContain('<strong>空行の前の題</strong>');
    expect(sep).toContain('<div class="case-body"><p>本文の段落。</p></div>');
    expect(sep).not.toContain("<p>空行の前の題</p>");
  });
  it("ふつうの節は今までどおり", () => {
    expect(h).toContain("<section><h2>ふつうの節</h2><p>x</p></section>");
    expect((h.match(/<section class="case">/g) ?? []).length).toBe(2);
  });
  it("続く実例は1つの枠(.cases)にまとめる=PC では左右2列", () => {
    expect(h).toContain('<h2 class="cases-head">これまでのご相談から</h2><div class="cases"><section class="case">');
    expect(h).toContain('</details></section></div><section><h2>ふつうの節</h2>');
    expect(h).toMatch(/.cases{grid-template-columns:1fr 1fr/);
  });
  it("売る・貸す・持ち続けるの札はスマホでも横に3つ並ぶ", () => {
    expect(h).toContain(".options{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))");
  });
  it("続く実例の先頭にだけ「これまでのご相談から」の見出しを1つ置く", () => {
    expect(h.split('<h2 class="cases-head">これまでのご相談から</h2>').length - 1).toBe(1);
    expect(h.indexOf("cases-head")).toBeLessThan(h.indexOf("<section class=\"case\">"));
  });
});

// 発注者の実機(iPhone・2026-10-07): スクロールすると期限の年表の札(z-index:1)が画面下の固定ボタンより手前に出た。
describe("画面下の固定ボタンは、いつもいちばん手前", () => {
  it("固定バーの z-index は、ページ内のほかのどの z-index より大きい", () => {
    const html = renderLpPage(input());
    const bar = /\.bar\{[^}]*position:fixed[^}]*z-index:(\d+)/.exec(html);
    expect(bar, "固定バーに z-index が無い").not.toBeNull();
    const barZ = Number(bar![1]);
    // 規則1つ = 「セレクタ{中身}」。中身に { を含めない(@media の入れ子を1つの規則と見誤らない)。
    const others = [...html.matchAll(/([^{}]+)\{[^{}]*z-index:(\d+)/g)].filter((m) => !m[1].includes(".bar")).map((m) => Number(m[2]));
    expect(others.length).toBeGreaterThan(0); // 年表の札(z-index:1)を必ず拾っている
    for (const z of others) expect(z).toBeLessThan(barZ);
  });
});
