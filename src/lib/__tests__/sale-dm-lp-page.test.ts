import { describe, it, expect } from "vitest";
import { renderLpPage, LP_CTA_LABEL, LP_PAGE_HEADERS } from "../sale-dm-letter/lp-page";
import type { LpRenderInput } from "../sale-dm-letter/lp-render-input";
import { HONEYPOT_FIELD } from "../sale-dm-letter/inquiry-input";

const input = (over: Partial<LpRenderInput> = {}): LpRenderInput => ({
  mode: "live",
  headline: "ご所有の戸建のご売却について <b>",
  lead: "世田谷区経堂周辺で & 売却をご検討の方へ",
  intro: ["はじめに。"],
  sections: [
    { heading: "売却の進め方", paragraphs: ["流れの説明。", "二段落目。"], media: { kind: "figure", figureKind: "sale_flow" } },
    { heading: "費用について", paragraphs: ["費用の説明。"], media: { kind: "asset", image: { publicId: "b".repeat(32), width: 1200, height: 900 } } },
    { heading: "枠なし", paragraphs: ["x"], media: null },
  ],
  faq: [{ q: "費用は？", a: "無料です。" }],
  hero: { publicId: "a".repeat(32), width: 1600, height: 900 },
  company: { name: "株式会社リガーレ", contact: "TEL 03-1234-5678", phone: "0312345678" },
  unsubscribeUrl: "https://lp.example.com/u/tok.sig",
  phoneTapToken: "tok",
  form: null,
  ...over,
});

describe("renderLpPage", () => {
  const html = renderLpPage(input());
  it("完結した HTML・viewport・noindex・外部読み込みなし", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('name="viewport" content="width=device-width,initial-scale=1"');
    expect(html).toContain('name="robots" content="noindex,nofollow"');
    expect(html).not.toMatch(/<link\s|src="http|url\(http|@import/);
  });
  it("段の順番: ヒーロー→見出し→リード→申込ボタン→本文→よくある質問→会社案内+電話→配信停止", () => {
    const idx = (s: string) => { const i = html.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
    const order = [idx(`/lp-assets/${"a".repeat(32)}`), idx("<h1"), idx("売却をご検討の方へ"), idx(LP_CTA_LABEL), idx("売却の進め方"), idx("<details"), idx("株式会社リガーレ"), idx("tel:0312345678"), idx("/u/tok.sig")];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("動的文字列は escape される", () => {
    expect(html).toContain("ご所有の戸建のご売却について &lt;b&gt;");
    expect(html).toContain("&amp; 売却");
    expect(html).not.toContain("<b>");
  });
  it("写真は公開口の URL・寸法付き、図は inline SVG、枠なしの節には画像が無い", () => {
    expect(html).toMatch(new RegExp(`<img[^>]*src="/lp-assets/${"b".repeat(32)}"[^>]*width="1200"[^>]*height="900"`));
    expect(html).toContain('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"');
    expect(html).not.toContain("/uploads/");
  });
  it("live ではプレビュー帯が無く、電話タップの script が token 付きで1本だけ", () => {
    expect(html).not.toContain("プレビュー");
    expect((html.match(/<script/g) ?? []).length).toBe(1);
    expect(html).toContain('sendBeacon("/t/tok/phone-tap")');
  });
  it("preview ではプレビュー帯が出て、script が無く、tel は押せるが計測されない", () => {
    const p = renderLpPage(input({ mode: "preview", phoneTapToken: null }));
    expect(p).toContain("プレビュー");
    expect(p).not.toContain("<script");
    expect(p).toContain("tel:0312345678");
  });
  it("PC/スマホの両方の CSS がある(固定バーはスマホだけ・PC は中央 760px)", () => {
    expect(html).toContain("@media (max-width: 767px)");
    expect(html).toContain("@media (min-width: 768px)");
    expect(html).toContain("max-width:760px");
    expect(html).toContain("position:fixed;bottom:0");
    expect(html).toContain("prefers-reduced-motion");
  });
  it("電話番号が無い会社案内では tel ボタンを出さず連絡先を文字で出す", () => {
    const h = renderLpPage(input({ company: { name: "会社", contact: "info@example.com", phone: null } }));
    expect(h).not.toContain("tel:");
    expect(h).toContain("info@example.com");
  });
  it("ヒーロー無し・FAQ無し・配信停止無しでも壊れない", () => {
    const h = renderLpPage(input({ hero: null, faq: [], unsubscribeUrl: null }));
    expect(h).not.toContain("<details");
    expect(h).not.toContain("/u/");
    expect(h).toContain("<h1");
  });
  it("入力に無い文字列(氏名など)が出ない=入力の全値以外の文字を持ち込まない", () => {
    expect(html).not.toMatch(/山田|様/);
  });
  it("ヒーローは eager+fetchpriority=high、節の写真は lazy のまま", () => {
    expect(html).toMatch(new RegExp(`<img class="hero"[^>]*loading="eager" fetchpriority="high"`));
    expect(html).not.toMatch(new RegExp(`<img class="hero"[^>]*loading="lazy"`));
    expect(html).toMatch(new RegExp(`<img class=""[^>]*src="/lp-assets/${"b".repeat(32)}"[^>]*loading="lazy"`));
  });
  it("phoneTapToken に </script> が含まれても script タグを閉じない(</script>-safe な埋め込み)", () => {
    const h = renderLpPage(input({ phoneTapToken: "</script><img>" }));
    expect((h.match(/<script/g) ?? []).length).toBe(1);
    expect(h).not.toContain("</script><img>");
    expect(h).toContain("sendBeacon(");
  });
  it("節見出しの \" と < は alt 属性の中でエスケープされる(属性を壊さない)", () => {
    const h = renderLpPage(input({ sections: [
      { heading: `危険"な<見出し`, paragraphs: ["x"], media: { kind: "asset", image: { publicId: "c".repeat(32), width: 100, height: 100 } } },
    ] }));
    expect(h).toContain(`alt="危険&quot;な&lt;見出し"`);
    expect(h).not.toMatch(/alt="危険"な/);
  });
});

describe("LP_PAGE_HEADERS", () => {
  it("CSP を持ち、no-store も維持する", () => {
    expect(LP_PAGE_HEADERS["Content-Security-Policy"]).toContain("default-src 'none'");
    expect(LP_PAGE_HEADERS["Cache-Control"]).toBe("no-store");
  });

  it("電話タップの送信を CSP が塞がない(connect-src 'self')・base-uri も塞ぐ", () => {
    const csp = LP_PAGE_HEADERS["Content-Security-Policy"] ?? "";
    // connect-src が無いと default-src 'none' に落ちて sendBeacon/fetch ごと遮断される(電話タップが永久に届かない)。
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe("申込フォーム(PR4)", () => {
  const FORM = { action: "/t/tok_live/inquiry", privacyText: "利用目的は査定のご連絡です。\n<script>x</script>", disabled: false };

  it("フォームあり: 送信先・必須欄・上限・隠し欄・同意・固定文言のボタン", () => {
    const html = renderLpPage(input({ mode: "live", form: FORM }));
    expect(html).toContain('<form method="post" action="/t/tok_live/inquiry"');
    expect(html).toMatch(/name="name"[^>]*required[^>]*maxlength="50"/);
    expect(html).toMatch(/name="phone"[^>]*type="tel"[^>]*required[^>]*maxlength="20"/);
    expect(html).toMatch(/name="email"[^>]*type="email"[^>]*maxlength="254"/);
    expect(html).toMatch(/name="contactTime"[^>]*maxlength="60"/);
    expect(html).toMatch(/<textarea[^>]*name="message"[^>]*maxlength="1000"/);
    expect(html).toMatch(new RegExp(`<div class="hp" aria-hidden="true"><label>この欄は空のままにしてください<input name="${HONEYPOT_FIELD}"[^>]*tabindex="-1"[^>]*autocomplete="off"`));
    // 自動入力(連絡先の AutoFill 等)が埋めやすい名前・ラベルを使わない=本物の申込を bot 扱いで捨てない
    expect(html).not.toMatch(/name="website"|ウェブサイト/);
    // エラー後に戻る(bfcache 復帰)と送信ボタンが押せないままにならない
    expect(html).toContain('window.addEventListener("pageshow"');
    expect(html).toMatch(/type="checkbox" name="consent" value="yes" required/);
    expect(html).toContain(`>${LP_CTA_LABEL}</button>`);
  });

  it("同意文は escape し、改行だけ <br />", () => {
    const html = renderLpPage(input({ mode: "live", form: FORM }));
    expect(html).toContain("利用目的は査定のご連絡です。<br />&lt;script&gt;x&lt;/script&gt;");
  });

  it("CTA(本文中・固定バー)はフォームへ飛ぶ。フォームが無ければ従来どおり会社案内へ", () => {
    expect(renderLpPage(input({ mode: "live", form: FORM }))).toContain('href="#inquiry"');
    const without = renderLpPage(input({ mode: "live", form: null }));
    expect(without).toContain('href="#contact"');
    expect(without).not.toContain("<form");
  });

  it("送付前(disabled): fieldset disabled で送信不可", () => {
    const html = renderLpPage(input({ mode: "preview", form: { ...FORM, action: "#", disabled: true } }));
    expect(html).toContain("<fieldset disabled>");
    // 送信用のスクリプト(fetch)も出さない
    expect(html).not.toContain("fetch(f.action");
    expect(html).not.toContain("preventDefault");
  });

  it("JS あり: 画面を離れずに送信し、サーバーの指摘は送信ボタンの上に出す(入力は残る)", () => {
    const html = renderLpPage(input({ mode: "live", form: FORM }));
    // 状態表示の場所は送信ボタンの直前
    expect(html).toContain('<div class="inq-msg" role="alert" aria-live="assertive" hidden></div><button type="submit"');
    expect(html).toContain("preventDefault");
    expect(html).toContain('"accept":"application/json"');
    expect(html).toContain('"content-type":"application/x-www-form-urlencoded;charset=UTF-8"');
    expect(html).toContain('credentials:"same-origin"');
    // fetch / URLSearchParams が無いブラウザは通常の送信に任せる
    expect(html).toMatch(/if\(!window\.fetch\|\|!window\.URLSearchParams\|\|!window\.FormData\)/);
    expect(html).toContain("お申し込みを受け付けました。内容を確認のうえ、担当者からご連絡いたします。");
    expect(html).toContain("まだお申し込みを受け付けていません。お急ぎの場合はお電話ください。");
    expect(html).toContain("アクセスが集中しています。しばらく時間をおいてもう一度お試しください。");
    expect(html).toContain("お申し込みを完了できませんでした。少し時間をおいてもう一度お試しいただくか、お電話ください。");
    // DOM は textContent/createElement だけで組む
    expect(html).not.toContain("innerHTML");
    expect(html).toContain('window.addEventListener("pageshow"');
    expect(html).toMatch(/\.inq-msg\{[^}]*color:#a8481a/);
    expect(html).toMatch(/\.inq-done\{/);
  });

  it("入力欄の文字は16px以上(iOS の自動拡大を起こさない)", () => {
    const html = renderLpPage(input({ mode: "live", form: FORM }));
    expect(html).toMatch(/\.inquiry input,\.inquiry textarea\{[^}]*font-size:16px/);
  });

  it("参照元方針は same-origin(no-referrer だとフォーム送信の Origin が null になる)", () => {
    const html = renderLpPage(input({ mode: "live", form: FORM }));
    expect(html).toContain('<meta name="referrer" content="same-origin" />');
    expect(html).not.toContain("no-referrer");
  });
});
