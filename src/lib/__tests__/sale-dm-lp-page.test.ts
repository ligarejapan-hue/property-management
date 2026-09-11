import { describe, it, expect } from "vitest";
import { renderLpPage, LP_CTA_LABEL } from "../sale-dm-letter/lp-page";
import type { LpRenderInput } from "../sale-dm-letter/lp-render-input";

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
});
