import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderLpPage } from "../sale-dm-letter/lp-page";
import { renderFigureHtml } from "../sale-dm-letter/lp-figures";
import type { LpRenderInput } from "../sale-dm-letter/lp-render-input";

// 発注者承認(2026-10-19・見本 https://claude.ai/artifact/YTmY1YHuDREnwJzk5kZmp7):
// 固定ボタンをPCにも・冒頭と申込欄が見えている間は引っ込める / 節は残して見せ方を圧縮 / 申込欄の頭に安心の一言。
const FORM = { action: "/t/tok/inquiry", privacyText: "利用目的\n第三者提供なし", disabled: false };
const LONG = "相続した空き家の3,000万円特別控除は、1981年5月31日以前に建てられ、亡くなった方がおひとりで住んでいた戸建てなどを相続して売ったとき、売却益から1人最大3,000万円を差し引けます。家と土地を相続した方が3人以上なら、1人最大2,000万円です。相続税の取得費加算は、相続税を納めた方が相続の開始から3年10か月以内に売ると、納めた相続税の一部を購入代金に上乗せできます。同じ売却では、この2つはどちらか一方を選びます。どれも細かい条件があり、ご家族への売却では使えないものもあります。";
const input = (over: Partial<LpRenderInput> = {}): LpRenderInput => ({
  mode: "live",
  headline: "相続した家や土地のことで、お困りではありませんか？",
  lead: "まずはお話を伺います。",
  intro: [],
  sections: [
    { heading: "こんなお困りごとはありませんか", paragraphs: ["□実家に通うのが負担になっている\n□固定資産税や草木の手入れの費用がかかり続けている\n□兄弟・ご親族の間でこの先どうするかを決めきれていない\n□遠くに住んでいてなかなか現地に行けない\n□家の中の荷物をどう片付ければよいか分からない\n□売ったらいくらになるのか見当がつかない"], media: null },
    { heading: "期限について", paragraphs: ["いくつかの期限があります。"], media: { kind: "figure", figureKind: "inheritance_deadlines" } },
    { heading: "売るときに使えるかもしれない、税金の特例", paragraphs: [LONG], media: null },
    { heading: "短い節", paragraphs: ["短い文章です。"], media: null },
    { heading: "荷物が残ったままでも", paragraphs: [LONG], media: { kind: "asset", image: { publicId: "b".repeat(32), width: 1456, height: 1088 } } },
  ],
  faq: [],
  hero: { publicId: "a".repeat(32), width: 1680, height: 944 },
  company: { name: "株式会社リガーレジャパン", contact: "TEL 03-6823-2760", phone: "0368232760" },
  unsubscribeUrl: "https://lp.example.com/u/tok.sig",
  phoneTapToken: "tok",
  form: FORM,
  ...over,
});
const base = (html: string) => html.slice(0, html.indexOf("@media (max-width: 767px)"));

describe("固定ボタン(申込・電話)は PC にも出て、冒頭と申込欄が見えている間は引っ込む", () => {
  const html = renderLpPage(input());

  it("固定バーはスマホ限定でなく、ふだんの CSS で fixed(いちばん手前)", () => {
    expect(base(html)).toMatch(/\.bar\{[^}]*position:fixed[^}]*z-index:50/);
    expect(html).not.toMatch(/@media \(max-width: 767px\)\{[^@]*\.bar\{display:grid/);
  });

  it("バーの中に「無料・売却を前提にしない」の一言と、申込・電話のボタン", () => {
    expect(html).toMatch(/<div class="bar"><div class="bar-in"><p class="bar-note">[^<]*<b>査定・ご相談は無料<\/b>[^<]*売却を前提にしません<\/p><a class="cta" href="#inquiry">無料査定を申し込む<\/a><a class="cta secondary" href="tel:0368232760" data-phone-tap="1">電話<\/a><\/div><\/div>/);
  });

  it("冒頭のボタン(.wrap>.cta-row)と申込欄(#inquiry)が見えていない間だけ .show を付ける。動きを減らす設定でも出す", () => {
    const i = html.indexOf('data-lp-bar="1"');
    expect(i, "固定バーのスクリプトが無い").toBeGreaterThan(-1);
    const script = html.slice(i, html.indexOf("</script>", i));
    expect(script).toContain('querySelector(".wrap>.cta-row")');
    expect(script).toContain('querySelector("#inquiry")');
    expect(script).toContain('classList.toggle("show"');
    expect(script).not.toContain("prefers-reduced-motion");
    expect(html).toContain(".bar.show{transform:none;visibility:visible");
    // 隠れている間は visibility も切る(Tab や読み上げが見えないボタンに届かない・内部レビュー)
    expect(html).toMatch(/\.bar\{[^}]*visibility:hidden/);
  });

  // 固定バーのスクリプトを、偽の document / IntersectionObserver で実際に走らせて出し入れを確かめる(内部レビュー)
  function runBar(hasObserver: boolean) {
    const i = html.indexOf('data-lp-bar="1">');
    const script = html.slice(i + 'data-lp-bar="1">'.length, html.indexOf("</script>", i));
    const classes = new Set<string>();
    const bar = { classList: { add: (c: string) => classes.add(c), toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) } };
    const hero = { id: "hero" }, inq = { id: "inq" };
    const document = { querySelector: (sel: string) => (sel === ".bar" ? bar : sel === ".wrap>.cta-row" ? hero : sel === "#inquiry" ? inq : null) };
    let cb: ((es: Array<{ target: unknown; isIntersecting: boolean }>) => void) | null = null;
    const observed: unknown[] = [];
    class FakeIO { constructor(f: typeof cb) { cb = f; } observe(t: unknown) { observed.push(t); } }
    const win = hasObserver ? { IntersectionObserver: FakeIO } : {};
    new Function("window", "document", "IntersectionObserver", script)(win, document, hasObserver ? FakeIO : undefined);
    return { shown: () => classes.has("show"), fire: (hv: boolean, iv: boolean) => cb!([{ target: hero, isIntersecting: hv }, { target: inq, isIntersecting: iv }]), observed, hero, inq };
  }

  it("冒頭のボタンか申込欄が見えている間は出さず、どちらも見えなくなったら出す(戻れば隠す)", () => {
    const b = runBar(true);
    expect(b.observed).toEqual([b.hero, b.inq]);
    expect(b.shown()).toBe(false); // 読み込み直後=冒頭が見えている前提
    b.fire(true, false); expect(b.shown()).toBe(false);
    b.fire(false, false); expect(b.shown()).toBe(true);
    b.fire(false, true); expect(b.shown()).toBe(false);
    b.fire(false, false); expect(b.shown()).toBe(true);
    b.fire(true, false); expect(b.shown()).toBe(false);
  });

  it("IntersectionObserver が無い端末では最初から出す", () => {
    expect(runBar(false).shown()).toBe(true);
  });

  it("固定バーのスクリプトは構文エラーなく解釈できる(壊れるとボタンが一生出ない)", () => {
    const i = html.indexOf('data-lp-bar="1">');
    const script = html.slice(i + 'data-lp-bar="1">'.length, html.indexOf("</script>", i));
    expect(() => new Function(script)).not.toThrow();
  });

  it("隠れている間は画面の外(transform)。IntersectionObserver が無い端末では最初から出す", () => {
    expect(html).toMatch(/\.bar\{[^}]*transform:translateY\(110%\)/);
    const i = html.indexOf('data-lp-bar="1"');
    const script = html.slice(i, html.indexOf("</script>", i));
    expect(script).toMatch(/if\(!window\.IntersectionObserver\)\{[^}]*classList\.add\("show"\)/);
  });
});

describe("見せ方の圧縮(節は全部残す)", () => {
  const html = renderLpPage(input());

  it("売る・貸す・持つ: 絵を左に小さく、1行ずつの一覧(スマホ)。絵は2行ぶんにまたがる", () => {
    expect(base(html)).toMatch(/\.opt-card\{display:grid;grid-template-columns:64px 1fr;grid-template-rows:auto auto/);
    expect(base(html)).toMatch(/\.opt-img\{grid-row:1\/3;width:64px;max-width:64px;margin:0/);
  });

  it("写真つきの節: スマホでも写真を左に小さく置く", () => {
    expect(base(html)).toMatch(/\.split\{display:grid;grid-template-columns:104px minmax\(0,1fr\)/);
  });

  it("文章だけの長い節は、見出しを残して中身を「くわしく読む」に畳む", () => {
    expect(html).toContain('<section><h2>売るときに<wbr>使えるかもしれない<wbr>税金の<wbr>特例</h2><details class="more"><summary>くわしく読む</summary><div class="more-body"><p>');
  });

  it("短い節・写真や図のある節・チェック札の節は畳まない", () => {
    expect(html).toContain("<section><h2>短い節</h2><p>短い文章です。</p></section>");
    expect(html).toMatch(/<div class="sec-body"><h2>荷物が<wbr>残ったままでも<\/h2><p>/);
    expect(html).toMatch(/<h2>こんな<wbr>お困りごとはありませんか<\/h2><ul class="checks">/);
    expect(html.split("くわしく読む").length - 1).toBe(1);
  });

  it("期限の年表: 2つ目以降の補足と※書きは「くわしく」に畳み、売却期限の行は畳まない", () => {
    const dl = renderFigureHtml("inheritance_deadlines");
    const items = dl.split('<li class="dl-item').slice(1).map((x) => x.slice(0, x.indexOf("</li>")));
    for (const it of items) {
      const spans = it.split("<span>").length - 1;
      if (it.startsWith(" key")) {
        expect(it).not.toContain("<details");
        expect(spans).toBeGreaterThan(1);
      } else if (spans > 1) {
        expect(it).toMatch(/<\/span><details class="more"><summary>くわしく<\/summary><div class="more-body"><span>/);
      } else {
        expect(it).not.toContain("<details");
      }
    }
    expect(dl).toMatch(/<\/ol><details class="more"><summary>特例の条件について<\/summary><div class="more-body"><p class="small-note">/);
  });

  it("畳みの見た目: 「＋」の丸い印・開くと「－」", () => {
    expect(html).toContain('details.more summary::before{content:"＋"');
    expect(html).toContain('details.more[open] summary::before{content:"－"}');
  });

  it("行間と余白を少し詰める(本文 1.75・節の間 30px)", () => {
    expect(html).toMatch(/body\{[^}]*line-height:1\.75/);
    expect(html).toContain("section{margin:30px 0}");
  });
});

describe("申込欄の頭に安心の一言と電話。同意文は畳む(同意のチェックはそのまま)", () => {
  it("「お名前と電話番号だけ」の一言と、電話番号つきの案内", () => {
    const html = renderLpPage(input());
    expect(html).toContain('<h2>無料査定を申し込む</h2><p class="inq-lead"><b>お名前と電話番号だけ</b>でお送りいただけます(ほかは任意)。査定・ご相談は無料で、売却を前提にしません。</p>');
    expect(html).toContain('<p class="inq-tel">お電話でも承ります(平日 10:00〜19:00) <a href="tel:0368232760" data-phone-tap="1">03-6823-2760</a></p>');
  });

  it("電話番号が無ければ電話の案内は出さない(一言は出す)", () => {
    const html = renderLpPage(input({ company: { name: "会社", contact: "info@example.com", phone: null } }));
    expect(html).toContain('class="inq-lead"');
    expect(html).not.toContain('class="inq-tel"');
  });

  it("同意文は「個人情報の取り扱いについて」に畳み、同意のチェックと送信ボタンはその下にそのまま", () => {
    const html = renderLpPage(input());
    expect(html).toContain('<details class="more privacy-more"><summary>個人情報の取り扱いについて</summary><div class="privacy">利用目的<br />第三者提供なし</div></details>');
    expect(html).toMatch(/<\/details><label class="consent"><input type="checkbox" name="consent" value="yes" required \/>個人情報の取り扱いに同意する<\/label>/);
  });
});

describe("走査: 使い方ガイド・マニュアルの説明が新しい作りに合っている", () => {
  const docs = ["public/docs/guide.html", "public/docs/manual.html"].map((p) => readFileSync(path.join(process.cwd(), p), "utf8"));
  it("「スマホでは固定・PCでは固定なし」の古い説明を残さない", () => {
    for (const d of docs) {
      expect(d).toContain("画面の下に「無料査定を申し込む」「電話」のボタンが固定");
      expect(d).not.toMatch(/申込・電話ボタンが固定表示、PC/);
    }
  });
});
