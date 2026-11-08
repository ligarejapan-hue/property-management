import { describe, it, expect } from "vitest";
import { renderLpPage } from "../sale-dm-letter/lp-page";
import type { LpRenderInput } from "../sale-dm-letter/lp-render-input";
import { LP_BRAND } from "../sale-dm-letter/lp-brand";

// 2026-10-29 LP点検(web-ui-patterns の品質チェック)で見つかった点の直し。
const input = (over: Partial<LpRenderInput> = {}): LpRenderInput => ({
  mode: "live",
  headline: "相続した家のことで、お困りではありませんか？",
  lead: "まずはお話を伺います。",
  intro: [],
  sections: [{ heading: "期限について", paragraphs: ["いくつかの期限があります。"], media: null }],
  faq: [],
  hero: null,
  company: { name: "株式会社リガーレジャパン", contact: "TEL 03-6823-2760", phone: "0368232760" },
  tagline: "相続・不動産のご相談窓口",
  unsubscribeUrl: "https://lp.example.com/u/tok.sig",
  phoneTapToken: "tok",
  form: { action: "/t/tok/inquiry", privacyText: "利用目的", disabled: false },
  ...over,
});
const css = (h: string) => /<style>([\s\S]*?)<\/style>/.exec(h)![1];
const scripts = (h: string) => [...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");

describe("動きで中身が白く抜けない(印刷・スクロールしない閲覧)", () => {
  const h = renderLpPage(input());
  it("印刷する前に動きをやめて全部見せる(数え上げも最後の数字に)", () => {
    const js = scripts(h);
    expect(js).toContain('window.addEventListener("beforeprint",showAll)');
    // 印刷の合図が来ない道具(印刷用の表示に切り替えるだけ)でも効く
    expect(js).toContain('window.matchMedia("print")');
    // 古い Safari(MediaQueryList に addEventListener が無い)は addListener で
    expect(js).toContain("pm.addListener");
    expect(js).toMatch(/function showAll\(\)\{root\.classList\.remove\("anim"\)/);
  });
  it("はじめから印刷用の表示で開かれたら、動きを付けない(全部見えたまま)", () => {
    expect(scripts(h)).toContain('window.matchMedia("(prefers-reduced-motion: reduce)").matches||window.matchMedia("print").matches)return;');
  });
  it("印刷の見た目では動きの途中の状態を使わない", () => {
    expect(css(h)).toContain("@media print{*,*::before,*::after{transition:none!important;animation:none!important}}");
  });
  it("8秒のあいだ一度もスクロール・操作が無ければ(審査の巡回や撮影)全部を出す。操作した人には今までどおり位置で出す", () => {
    const js = scripts(h);
    expect(js).toContain("setTimeout(function(){if(!acted)revealAll()},8000)");
    for (const ev of ["scroll", "pointerdown", "keydown", "wheel", "touchstart"]) {
      expect(js).toContain(`"${ev}"`);
    }
  });
  it("スクリプトは文法として正しい", () => {
    for (const m of h.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new Function(m[1])).not.toThrow();
  });
});

describe("流れの図は札をはじめから見せ、番号と線だけを3秒台で順に灯す", () => {
  const c = css(renderLpPage(input()));
  it("札そのものは透明にしない", () => {
    expect(c).not.toMatch(/\.anim \.flow li\{opacity:0/);
  });
  it("一番遅い動き(期間の帯)も4秒以内に終わる", () => {
    const flowRules = c.split("\n").filter((r) => r.includes(".flow"));
    const delays = flowRules.flatMap((r) => [...r.matchAll(/transition-delay:([\d.]+)s/g)].map((m) => Number(m[1])));
    expect(delays.length).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(3);
  });
});

describe("相続（マンション）に「マイホームの3,000万円特別控除」の大きな札を出さない", () => {
  const taxSec = (paragraph: string) =>
    renderLpPage(input({ sections: [{ heading: "税金の特例", paragraphs: [paragraph + "x".repeat(200)], media: null }] }));
  it("相続人がそこに住んでいた場合だけの特例なので、札は出さず本文(くわしく読む)だけ", () => {
    expect(taxSec("・マイホームを売ったときの3,000万円特別控除:相続人が住んでいた場合")).not.toContain('class="tax-card"');
  });
  it("空き家の特例・ご自宅の特例は今までどおり札を出す", () => {
    expect(taxSec("・相続した空き家の3,000万円特別控除:x")).toContain('class="tax-card"');
    expect(taxSec("・ご自宅を売るときの3,000万円特別控除:x")).toContain('class="tax-card"');
  });
});

describe("会社案内・個人情報・配信停止", () => {
  const h = renderLpPage(input());
  it("会社案内に所在地と宅建業の免許番号を出す", () => {
    expect(LP_BRAND.address).toBe("〒154-0011 東京都世田谷区上馬4-36-15");
    expect(LP_BRAND.license).toBe("宅地建物取引業 東京都知事(1)第108344号");
    const company = /<section class="company"[\s\S]*?<\/section>/.exec(h)![0];
    expect(company).toContain(`<p class="co-addr">${LP_BRAND.address}</p>`);
    expect(company).toContain(`<p class="co-lic">${LP_BRAND.license}</p>`);
  });
  it("個人情報の取り扱いに、会社のプライバシーポリシーへのリンク(新しいタブ)", () => {
    expect(LP_BRAND.privacyPolicyUrl).toBe("https://ligarejapan.com/privacypolicy/");
    expect(h).toMatch(/<details class="more privacy-more">[\s\S]*?<a href="https:\/\/ligarejapan\.com\/privacypolicy\/" target="_blank" rel="noopener">プライバシーポリシー<\/a>/);
  });
  it("配信停止のリンクは読みやすい濃さ(AA)で、押せる高さ44px", () => {
    const c = css(h);
    expect(c).toContain(".unsub a{color:#5d594f;display:inline-block;min-height:44px;line-height:44px}");
  });
});
