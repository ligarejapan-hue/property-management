import { describe, it, expect } from "vitest";
import { placeIllustration, letterIllustrationFromAsset, isSafeIllustrationSrc } from "../letter-illustration";
import { renderLetterHtml, renderLetterSheetHtml } from "../templates";

const PID = "0123456789abcdef0123456789abcdef";
const ILL = { src: `/lp-assets/${PID}`, width: 1200, height: 400 };
const base = {
  designTemplate: "formal",
  addresseeName: "山田 太郎",
  honorific: "様",
  recipientZip: "1560054",
  recipientAddress: "東京都世田谷区桜丘",
  senderName: "テスト不動産",
  senderContact: "03-0000-0000",
  trackingToken: "t1",
};

describe("placeIllustration(【イラスト】の行で分ける)", () => {
  it("印の行で前後に分け、印の行は消す", () => {
    expect(placeIllustration("一\n【イラスト】\n二\n三")).toEqual({ before: "一", after: "二\n三", stripped: "一\n二\n三", hasMarker: true });
  });
  it("印が無ければ before は空・after は本文そのまま", () => {
    expect(placeIllustration("一\n二")).toEqual({ before: "", after: "一\n二", stripped: "一\n二", hasMarker: false });
  });
  it("2つ目以降の印の行も消す", () => {
    expect(placeIllustration("一\n【イラスト】\n二\n【イラスト】\n三")).toEqual({ before: "一", after: "二\n三", stripped: "一\n二\n三", hasMarker: true });
  });
  it("前後の半角・全角空白は印として扱う", () => {
    expect(placeIllustration("一\n　 【イラスト】 　\n二").hasMarker).toBe(true);
  });
  it("同じ行に文字がある【イラスト】は印ではない(文字のまま残す)", () => {
    expect(placeIllustration("一\n【イラスト】ここに入れる\n二")).toEqual({ before: "", after: "一\n【イラスト】ここに入れる\n二", stripped: "一\n【イラスト】ここに入れる\n二", hasMarker: false });
  });
  it("CRLF / CR でも同じ結果", () => {
    expect(placeIllustration("一\r\n【イラスト】\r\n二")).toEqual(placeIllustration("一\n【イラスト】\n二"));
    expect(placeIllustration("一\r【イラスト】\r二")).toEqual(placeIllustration("一\n【イラスト】\n二"));
  });
  it("先頭行が印なら before は空", () => {
    expect(placeIllustration("【イラスト】\n一")).toEqual({ before: "", after: "一", stripped: "一", hasMarker: true });
  });
});

describe("letterIllustrationFromAsset", () => {
  it("削除されていない写真から src を作る", () => {
    expect(letterIllustrationFromAsset({ publicId: PID, width: 1200, height: 400, deletedAt: null })).toEqual(ILL);
  });
  it("未設定・削除済み・publicId が不正なら null", () => {
    expect(letterIllustrationFromAsset(null)).toBeNull();
    expect(letterIllustrationFromAsset(undefined)).toBeNull();
    expect(letterIllustrationFromAsset({ publicId: PID, width: 1, height: 1, deletedAt: new Date() })).toBeNull();
    expect(letterIllustrationFromAsset({ publicId: "../x", width: 1, height: 1, deletedAt: null })).toBeNull();
    expect(letterIllustrationFromAsset({ publicId: PID.toUpperCase(), width: 1, height: 1, deletedAt: null })).toBeNull();
  });
  it("isSafeIllustrationSrc は /lp-assets/<32桁16進> だけ", () => {
    expect(isSafeIllustrationSrc(`/lp-assets/${PID}`)).toBe(true);
    expect(isSafeIllustrationSrc(`https://evil/lp-assets/${PID}`)).toBe(false);
    expect(isSafeIllustrationSrc(`/lp-assets/${PID}" onerror="x`)).toBe(false);
  });
});

describe("renderLetterHtml とイラスト", () => {
  const count = (s: string, sub: string) => s.split(sub).length - 1;

  it("印の位置に img が1つだけ入り、【イラスト】の文字は出ない", () => {
    const html = renderLetterHtml({ ...base, body: "書き出し\n【イラスト】\n続き\n【イラスト】\n結び", illustration: ILL });
    expect(count(html, "<img")).toBe(1);
    expect(html).not.toContain("【イラスト】");
    const i = html.indexOf("書き出し"), j = html.indexOf("<img"), k = html.indexOf("続き"), l = html.indexOf("結び");
    expect(i).toBeGreaterThan(-1);
    expect(i < j && j < k && k < l).toBe(true);
    expect(html).toContain(`src="/lp-assets/${PID}"`);
    expect(html).toContain('width="1200"');
    expect(html).toContain('height="400"');
    expect(html).toContain("max-height: 55mm");
  });

  it("印が無ければ本文の上に入る", () => {
    const html = renderLetterHtml({ ...base, body: "書き出し\n続き", illustration: ILL });
    expect(html.indexOf("<img")).toBeLessThan(html.indexOf("書き出し"));
    expect(html.indexOf("<img")).toBeGreaterThan(html.indexOf('class="letter-body"'));
  });

  it("イラスト無しなら img を出さず、印の行だけ消す", () => {
    const html = renderLetterHtml({ ...base, body: "書き出し\n【イラスト】\n続き" });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("【イラスト】");
    expect(html).toContain("書き出し<br />\n続き");
  });

  it("src が安全でなければ描かない(印の行は消す)", () => {
    const html = renderLetterHtml({ ...base, body: "一\n【イラスト】\n二", illustration: { src: "javascript:alert(1)", width: 1, height: 1 } });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("【イラスト】");
  });

  it("本文は今までどおりエスケープされる(前後どちらも)", () => {
    const html = renderLetterHtml({ ...base, body: "<b>前</b>\n【イラスト】\n<i>後</i>", illustration: ILL });
    expect(html).toContain("&lt;b&gt;前&lt;/b&gt;");
    expect(html).toContain("&lt;i&gt;後&lt;/i&gt;");
  });

  it("イラストも印も無い本文は今までと同じ HTML", () => {
    const a = renderLetterHtml({ ...base, body: "一\n二" });
    const b = renderLetterHtml({ ...base, body: "一\n二", illustration: null });
    expect(a).toBe(b);
    expect(a).toContain('<div class="letter-body">一<br />\n二</div>');
  });

  it("まとめ印刷でも通ごとに入る", () => {
    const html = renderLetterSheetHtml("t", [{ ...base, body: "一", illustration: ILL }, { ...base, body: "二" }]);
    expect(count(html, "<img")).toBe(1);
  });
});
