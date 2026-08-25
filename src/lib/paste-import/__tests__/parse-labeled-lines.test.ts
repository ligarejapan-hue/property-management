import { describe, it, expect } from "vitest";
import { parseLabeledLines, isBlankValue } from "../parse-labeled-lines";

describe("parseLabeledLines（見出しと中身に割る）", () => {
  it("全角コロン・半角コロン・タブを同じように扱う", () => {
    const r = parseLabeledLines("■物件種別　： 土地\n物件種別: 土地\n物件種別\t土地");
    expect(r.labeled.map((l) => l.label)).toEqual(["物件種別", "物件種別", "物件種別"]);
    expect(r.labeled.map((l) => l.value)).toEqual(["土地", "土地", "土地"]);
  });

  it("行頭の飾り文字を落とす", () => {
    expect(parseLabeledLines("■お名前：山田").labeled[0].label).toBe("お名前");
    expect(parseLabeledLines("●お名前：山田").labeled[0].label).toBe("お名前");
    expect(parseLabeledLines("・お名前：山田").labeled[0].label).toBe("お名前");
    expect(parseLabeledLines("【お名前】：山田").labeled[0].label).toBe("お名前");
  });

  it("ラベルと値の前後の空白（全角含む）を落とす", () => {
    const r = parseLabeledLines("■物件所在地　　　：　東京都世田谷区　");
    expect(r.labeled[0].label).toBe("物件所在地");
    expect(r.labeled[0].value).toBe("東京都世田谷区");
  });

  it("値の中のコロンは割らない（最初の区切りだけで割る）", () => {
    const r = parseLabeledLines("私道負担の有無\t私道（地番：552-11）持ち分あり");
    expect(r.labeled[0].label).toBe("私道負担の有無");
    expect(r.labeled[0].value).toBe("私道（地番：552-11）持ち分あり");
  });

  it("区切りの無い行は捨てずに unlabeled で持つ", () => {
    const r = parseLabeledLines("査定依頼のお知らせ\n■お名前：山田");
    expect(r.unlabeled).toEqual(["査定依頼のお知らせ"]);
    expect(r.labeled).toHaveLength(1);
  });

  it("行番号を1始まりで持つ（原文と突き合わせるため）", () => {
    const r = parseLabeledLines("見出し\n■お名前：山田");
    expect(r.labeled[0].lineNumber).toBe(2);
  });

  it("CRLF を LF に正規化してから割る", () => {
    const r = parseLabeledLines("■お名前：山田\r\n■年齢：71");
    expect(r.labeled).toHaveLength(2);
    expect(r.labeled[0].value).toBe("山田");
  });

  it("空行は unlabeled にも入れない", () => {
    const r = parseLabeledLines("■お名前：山田\n\n　\n■年齢：71");
    expect(r.unlabeled).toEqual([]);
    expect(r.labeled).toHaveLength(2);
  });

  it("ラベルが空の行は割らない（値だけの行を見出し扱いしない）", () => {
    const r = parseLabeledLines("：値だけ");
    expect(r.labeled).toHaveLength(0);
    expect(r.unlabeled).toEqual(["：値だけ"]);
  });
});

describe("isBlankValue（値なしの見分け）", () => {
  it("ハイフン類・空文字を値なしとする", () => {
    for (const v of ["-", "ー", "−", "―", "", "  ", "　"]) {
      expect(isBlankValue(v), `"${v}" は値なしのはず`).toBe(true);
    }
  });
  it("中身のある値は値なしとしない", () => {
    for (const v of ["0", "なし", "70 平米", "-1"]) {
      expect(isBlankValue(v), `"${v}" は値ありのはず`).toBe(false);
    }
  });
});
