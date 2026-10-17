import { describe, it, expect } from "vitest";
import { parseLetterBody, LETTER_FIXED_TEXT } from "../letter-layout";

// 手紙の紙面(2026-10-17 発注者決定: 案A=緑・1枚・ロゴは下の中央)。
// 文面は外部AIが書く平文なので、段落の「形」から枠を決める。

const BODY = [
  "相続したご実家を売るなら、特例があり、使える期限が決まっています。",
  "売主様に寄り添い、ご相談をお受けしている不動産会社として、お便りいたしました。",
  "",
  "〇〇の不動産を相続された方へ、このお手紙をお送りしております。",
  "ご家族を亡くされ、まだお気持ちの整理がつかない中でのお便りとなりましたこと、どうかご容赦ください。",
  "",
  "相続された不動産について、このようなお困りごとはありませんか。",
  "・誰も住まなくなった実家に通うのが負担",
  "・固定資産税がかかり続けている",
  "",
  "【イラスト】",
  "",
  "弊社では、売却を前提にせず、まずはお話を伺うところから始めています。",
  "",
  "冒頭の特例を使える売却の期限は、相続の開始から3年です。税金が0円になる場合でも確定申告が必要です。",
  "",
  "このお手紙のQRコードから、無料査定のお申し込みページをご覧いただけます。",
  "",
  "このお手紙は、公開されている不動産登記の情報をもとにお送りしております。",
  "",
  "追伸　QRコードからのお申し込みは、お名前とお電話番号の入力だけで済みます。",
].join("\n");

describe("parseLetterBody(段落の形から枠を決める)", () => {
  it("最初の段落=見出し / ・の段落=困りごと / 【イラスト】=絵 / 特例+確定申告=ご参考 / 追伸 / 登記情報の一文=脚注", () => {
    const r = parseLetterBody(BODY);
    expect(r.blocks.map((b) => b.kind)).toEqual([
      "catch",
      "paragraph",
      "concerns",
      "illustration",
      "paragraph",
      "note",
      "paragraph",
      "ps",
    ]);
    expect(r.blocks[0]).toEqual({
      kind: "catch",
      lines: [
        "相続したご実家を売るなら、特例があり、使える期限が決まっています。",
        "売主様に寄り添い、ご相談をお受けしている不動産会社として、お便りいたしました。",
      ],
    });
    expect(r.blocks[2]).toEqual({
      kind: "concerns",
      heading: "相続された不動産について、このようなお困りごとはありませんか。",
      items: ["誰も住まなくなった実家に通うのが負担", "固定資産税がかかり続けている"],
    });
    expect(r.basis).toBe("このお手紙は、公開されている不動産登記の情報をもとにお送りしております。");
  });

  it("「なお、」で始まる段落もご参考", () => {
    const r = parseLetterBody("見出し\n\nなお、相続税を納めた方は特例があります。");
    expect(r.blocks[1]).toEqual({ kind: "note", lines: ["なお、相続税を納めた方は特例があります。"] });
  });

  it("・だけの段落は見出し無しの困りごと(• も同じ)", () => {
    const r = parseLetterBody("見出し\n\n・ひとつ\n• ふたつ");
    expect(r.blocks[1]).toEqual({ kind: "concerns", heading: null, items: ["ひとつ", "ふたつ"] });
  });

  it("・の行が混ざっているだけの段落(2行目以降が全部・ではない)は普通の段落", () => {
    const r = parseLetterBody("見出し\n\n説明\n・ひとつ\n続きの文");
    expect(r.blocks[1]).toEqual({ kind: "paragraph", lines: ["説明", "・ひとつ", "続きの文"] });
  });

  it("形に当てはまらない平文でも落ちず、見出し+段落として返す", () => {
    const r = parseLetterBody("一\n二\n\n三");
    expect(r.blocks).toEqual([
      { kind: "catch", lines: ["一", "二"] },
      { kind: "paragraph", lines: ["三"] },
    ]);
    expect(r.basis).toBeNull();
  });

  it("【イラスト】は最初の1つだけ絵になり、2つ目以降は消える。段落の途中にあっても段落を分ける", () => {
    const r = parseLetterBody("一\n【イラスト】\n二\n【イラスト】\n三");
    expect(r.blocks).toEqual([
      { kind: "catch", lines: ["一"] },
      { kind: "illustration" },
      { kind: "paragraph", lines: ["二"] },
      { kind: "paragraph", lines: ["三"] },
    ]);
    expect(r.hasMarker).toBe(true);
  });

  it("印が無ければ hasMarker=false で絵の枠は入らない", () => {
    const r = parseLetterBody("一\n\n二");
    expect(r.hasMarker).toBe(false);
    expect(r.blocks.some((b) => b.kind === "illustration")).toBe(false);
  });

  it("CRLF・全角空白だけの行・前後の空行があっても同じ", () => {
    const a = parseLetterBody("\r\n一\r\n\r\n　\r\n二\r\n\r\n");
    const b = parseLetterBody("一\n\n二");
    expect(a).toEqual(b);
  });

  it("登記情報の一文のすぐ下に空行なしで続く行は、脚注に巻き込まず普通の段落として残す", () => {
    const r = parseLetterBody("見出し\n\nこのお手紙は、公開されている情報をもとにお送りしております。\n追伸　お気軽に。");
    expect(r.basis).toBe("このお手紙は、公開されている情報をもとにお送りしております。");
    expect(r.blocks[1]).toEqual({ kind: "ps", lines: ["追伸　お気軽に。"] });
  });

  it("空の本文は枠ゼロ", () => {
    expect(parseLetterBody("")).toEqual({ blocks: [], basis: null, hasMarker: false });
  });

  it("紙面の決まり文句は1か所で持つ(AI査定の一文・無料の札・問い合わせ枠の見出し)", () => {
    expect(LETTER_FIXED_TEXT.aiLine).toContain("AI査定");
    expect(LETTER_FIXED_TEXT.badgeStrong).toBe("無料");
    expect(LETTER_FIXED_TEXT.contactHead).toContain("今の価値");
    expect(LETTER_FIXED_TEXT.tagline).not.toContain("城南");
  });
});
