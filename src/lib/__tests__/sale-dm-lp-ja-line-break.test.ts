import { describe, it, expect } from "vitest";
import { jaChunks, jaWrapHtml, jaHeadingHtml } from "../sale-dm-letter/ja-line-break";
import { renderLpPage } from "../sale-dm-letter/lp-page";
import type { LpRenderInput } from "../sale-dm-letter/lp-render-input";
import { EMPTY_AD_PARAMS } from "../sale-dm-letter/lp-public";

/**
 * 公開LPの見出しの折り返し(発注者 2026-10-21「やっぱり変だよ」= 「ま/とめて」「建/てられた」「ご依/頼」のように
 * 言葉の途中で折れる)。文節(意味のまとまり)の切れ目にだけ折り返しの余地(<wbr>)を入れ、CSS で字の途中では折らない。
 * 切れ目の決まり: 読点・句点・閉じ括弧・中黒の後 / 開き括弧の前 / ひらがな→漢字・カタカナ・英数の境目
 * (ただし「ご」「お」+漢字は敬語の頭なので、その前で切る)。
 */
describe("jaChunks(文節の切れ目)", () => {
  it("ひらがなから漢字・カタカナ・英数へ移る所と、読点の後で切る", () => {
    expect(jaChunks("売るときに使えるかもしれない、税金の特例")).toEqual(["売るときに", "使えるかもしれない、", "税金の", "特例"]);
    // 「古い家」は漢字+ひらがな1字+漢字(送り仮名)なので1語扱い=切らない
    expect(jaChunks("古い家でも、売り方はいくつかあります")).toEqual(["古い家でも、", "売り方はいくつかあります"]);
    expect(jaChunks("リースバックで住み続けながら資金を用意し、数年後にご自宅を買い戻し")).toEqual([
      "リースバックで", "住み続けながら", "資金を", "用意し、", "数年後に", "ご自宅を", "買い戻し",
    ]);
  });
  it("「ご」「お」+漢字は敬語の頭として前で切り、その間では切らない", () => {
    expect(jaChunks("修繕や耐震工事を始める前に、ご相談ください")).toEqual(["修繕や", "耐震工事を", "始める", "前に、", "ご相談ください"]);
    expect(jaChunks("住み替えの段取りも、まとめてご相談ください")).toEqual(["住み替えの", "段取りも、", "まとめて", "ご相談ください"]);
    expect(jaChunks("築年数を重ねたお住まいのことで、お困りではありませんか？")).toEqual([
      "築年数を", "重ねた", "お住まいのことで、", "お困りではありませんか？",
    ]);
  });
  it("数字と漢字・カタカナと漢字の間では切らない。開き括弧の前・閉じ括弧の後で切る", () => {
    expect(jaChunks("1981年5月より前に建てられたお住まいの方へ")).toEqual(["1981年5月より", "前に", "建てられた", "お住まいの", "方へ"]);
    expect(jaChunks("駐車場とアパートを2件まとめて売却し、資産の目減りを防いだ(成年後見人の弁護士からのご依頼)")).toEqual([
      "駐車場と", "アパートを", "2件まとめて", "売却し、", "資産の", "目減りを", "防いだ", "(成年後見人の", "弁護士からの", "ご依頼)",
    ]);
    expect(jaChunks("「まだ何も決めていない」段階のご相談がいちばん多いです")).toEqual([
      "「まだ", "何も", "決めていない」", "段階の", "ご相談がいちばん", "多いです",
    ]);
    // 送り仮名(漢字+ひらがな1字+漢字)は1語なので切らない。助詞1字(の・を・に…)なら切る
    expect(jaChunks("売り方と買い戻しと住み替えの段取り")).toEqual(["売り方と", "買い戻しと", "住み替えの", "段取り"]);
    expect(jaChunks("持ち続ける家の価格")).toEqual(["持ち続ける", "家の", "価格"]);
  });
  it("中黒・空白の後でも切る。空文字・1語はそのまま", () => {
    expect(jaChunks("ご相談の例 目黒区・アパートと駐車場・築50年超")).toEqual(["ご相談の", "例 ", "目黒区・", "アパートと", "駐車場・", "築50年超"]);
    expect(jaChunks("")).toEqual([]);
    expect(jaChunks("特例")).toEqual(["特例"]);
    expect(jaChunks("abc def")).toEqual(["abc ", "def"]);
  });
});

describe("jaWrapHtml", () => {
  it("切れ目に <wbr> を入れ、動的な値は escape する", () => {
    expect(jaWrapHtml("古い家でも、売り方はいくつかあります")).toBe("古い家でも、<wbr>売り方はいくつかあります");
    expect(jaWrapHtml("相続した家、どうする? <b>")).toBe("相続した<wbr>家、<wbr>どうする? <wbr>&lt;b&gt;");
  });
});

describe("jaHeadingHtml(見出し用: 読点を表示から抜く)", () => {
  it("読点「、」「，」を抜き、あった場所は折り返しの余地(<wbr>)として残す。句点・疑問符・括弧はそのまま", () => {
    expect(jaHeadingHtml("古くなった家でも、売り方はいくつかあります")).toBe("古くなった<wbr>家でも<wbr>売り方はいくつかあります");
    expect(jaHeadingHtml("築年数を重ねたお住まいのことで、お困りではありませんか？")).toBe("築年数を<wbr>重ねた<wbr>お住まいのことで<wbr>お困りではありませんか？");
    expect(jaHeadingHtml("売る・貸す・持ち続ける。それぞれの見通し")).toBe("売る・<wbr>貸す・<wbr>持ち続ける。<wbr>それぞれの<wbr>見通し");
    expect(jaHeadingHtml("防いだ(成年後見人の弁護士からのご依頼)")).toBe("防いだ<wbr>(成年後見人の<wbr>弁護士からの<wbr>ご依頼)");
    expect(jaHeadingHtml("a，b <i>")).toBe("a<wbr>b <wbr>&lt;i&gt;");
    // 読点だけの文節は消えて、余分な <wbr> も残らない
    expect(jaHeadingHtml("、")).toBe("");
    expect(jaHeadingHtml("")).toBe("");
  });
});

const input = (over: Partial<LpRenderInput> = {}): LpRenderInput => ({
  mode: "live",
  headline: "築年数を重ねたお住まいのことで、お困りではありませんか？",
  lead: "リード",
  intro: ["はじめに。"],
  sections: [
    { heading: "古くなった家でも、売り方はいくつかあります", paragraphs: ["本文。"], media: null },
    { heading: "修繕や耐震工事を始める前に、ご相談ください", paragraphs: ["本文。"], media: { kind: "asset", image: { publicId: "b".repeat(32), width: 1456, height: 1088 } } },
    { heading: "ご相談の例(目黒区・アパートと駐車場・築50年超)", paragraphs: ["駐車場とアパートを2件まとめて売却し、資産の目減りを防いだ(成年後見人の弁護士からのご依頼)\n本文です。"], media: null },
  ],
  faq: [{ q: "古くて傷んでいる家でも売れますか？", a: "はい。" }],
  hero: null,
  company: { name: "株式会社リガーレ", contact: "TEL 03-6823-2760", phone: "0368232760" },
  unsubscribeUrl: null,
  phoneTapToken: null,
  form: { action: "/t/x/inquiry", privacyText: "同意文", disabled: false },
  ...over,
});

describe("renderLpPage: 見出し・実例の題・札・よくある質問に文節の切れ目を入れ、字の途中では折らない。見出しは読点を抜く", () => {
  const html = renderLpPage(input());
  it("h1・h2・実例の題と札は読点なし+<wbr>、質問は読点を残して <wbr>(title・OGP・写真の alt はそのまま)", () => {
    expect(html).toContain("<h1>築年数を<wbr>重ねた<wbr>お住まいのことで<wbr>お困りではありませんか？</h1>");
    expect(html).toContain("<h2>古くなった<wbr>家でも<wbr>売り方はいくつかあります</h2>");
    expect(html).toContain("<h2>修繕や<wbr>耐震工事を<wbr>始める<wbr>前に<wbr>ご相談ください</h2>");
    expect(html).toContain('<span class="case-tag">ご相談の<wbr>例 <wbr>目黒区・<wbr>アパートと<wbr>駐車場・<wbr>築50年超</span>');
    expect(html).toContain("<strong>駐車場と<wbr>アパートを<wbr>2件まとめて<wbr>売却し<wbr>資産の<wbr>目減りを<wbr>防いだ<wbr>(成年後見人の<wbr>弁護士からの<wbr>ご依頼)</strong>");
    expect(html).toContain('<span class="q">Q</span><span class="qt">古くて<wbr>傷んでいる<wbr>家でも<wbr>売れますか？</span>');
    expect(html).toContain("<title>築年数を重ねたお住まいのことで、お困りではありませんか？</title>");
    expect(html).toContain('alt="修繕や耐震工事を始める前に、ご相談ください"');
    const pub = renderLpPage(input({ mode: "public", public: { adParams: EMPTY_AD_PARAMS, safeQuery: "", google: null, og: { url: "https://example.test/lp/x", imageUrl: null } } }));
    expect(pub).toContain('<meta property="og:title" content="築年数を重ねたお住まいのことで、お困りではありませんか？" />');
    expect(pub).toContain("<h1>築年数を<wbr>重ねた<wbr>お住まいのことで<wbr>お困りではありませんか？</h1>");
  });
  it("見出しと同じ文を本文や問い合わせ欄で使う所には影響しない(本文の読点はそのまま)", () => {
    const h = renderLpPage(input({ intro: ["古くなった家でも、売り方はいくつかあります。"] }));
    expect(h).toContain("古くなった家でも、売り方はいくつかあります。");
  });
  it("CSS: その要素は字の途中で折らず(keep-all)、1語が長すぎるときだけ字の途中で折る(anywhere)", () => {
    expect(html).toContain("h1,h2,.case summary strong,.case-tag,.faq .qt{word-break:keep-all;overflow-wrap:anywhere}");
  });
});
