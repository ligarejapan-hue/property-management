import { describe, it, expect } from "vitest";
import { splitLpTemplate, lpSplitIssueMessage, lpBodyHeadings, LP_LIMITS } from "../sale-dm-letter/lp-template";

const OK = [
  "【見出し】売却をご検討の方へ",
  "【リード文】",
  "ご所有の{{物件種別}}について、いまの相場と進め方をご案内します。",
  "【本文】",
  "■ 売却の進め方",
  "査定から引渡しまでの流れをご説明します。",
  "",
  "■ 費用について",
  "仲介手数料などの費用の目安です。",
  "【よくある質問】",
  "Q. 査定は無料ですか",
  "A. はい、無料です。",
  "Q. 住みながら売れますか",
  "A. 可能です。",
].join("\n");

describe("splitLpTemplate: 正常系", () => {
  it("4部位に切り分ける", () => {
    const r = splitLpTemplate(OK);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parts.headline).toBe("売却をご検討の方へ");
    expect(r.parts.lead).toContain("{{物件種別}}");
    expect(r.parts.body.startsWith("■ 売却の進め方")).toBe(true);
    expect(r.parts.faq).toEqual([
      { q: "査定は無料ですか", a: "はい、無料です。" },
      { q: "住みながら売れますか", a: "可能です。" },
    ]);
  });
  it("見出しと本文だけでも通る(リード・FAQ は任意 → null)", () => {
    const r = splitLpTemplate("【見出し】\nタイトル\n【本文】\n本文です");
    expect(r).toEqual({ ok: true, parts: { headline: "タイトル", lead: null, body: "本文です", faq: null } });
  });
  it("CRLF でも LF と同じ結果", () => {
    expect(splitLpTemplate(OK.replace(/\n/g, "\r\n"))).toEqual(splitLpTemplate(OK));
  });
  it("Q./A. の全角ピリオド・コロンも受け付け、複数行の回答は結合する", () => {
    const r = splitLpTemplate("【見出し】t\n【本文】b\n【よくある質問】\nQ．質問\nA：回答1行目\n回答2行目");
    expect(r.ok && r.parts.faq).toEqual([{ q: "質問", a: "回答1行目\n回答2行目" }]);
  });
  it("lpBodyHeadings は行頭 ■ の小見出しを順に返す", () => {
    expect(lpBodyHeadings("■ A\nx\n■B\ny")).toEqual(["A", "B"]);
  });
});

describe("splitLpTemplate: 異常系(どこが問題かを返す)", () => {
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ["見出しが無い", "【本文】b", { code: "MISSING_SECTION", section: "見出し" }],
    ["本文が無い", "【見出し】t", { code: "MISSING_SECTION", section: "本文" }],
    ["同じ見出しが2回", "【見出し】t\n【本文】b\n【本文】c", { code: "DUPLICATE_SECTION", section: "本文" }],
    ["順番違い", "【本文】b\n【見出し】t", { code: "ORDER_MISMATCH", section: "見出し" }],
    ["知らない見出し", "【見出し】t\n【おまけ】x\n【本文】b", { code: "UNKNOWN_SECTION", section: "おまけ" }],
    ["見出しが空", "【見出し】\n【本文】b", { code: "EMPTY_SECTION", section: "見出し" }],
    ["見出しが複数行", "【見出し】\n1行目\n2行目\n【本文】b", { code: "HEADLINE_MULTILINE", section: "見出し" }],
    ["FAQ の対が崩れている", "【見出し】t\n【本文】b\n【よくある質問】\nQ. a\nQ. b", { code: "FAQ_PAIR_MISMATCH" }],
    ["FAQ が A から始まる", "【見出し】t\n【本文】b\n【よくある質問】\nA. x", { code: "FAQ_PAIR_MISMATCH" }],
    ["FAQ 見出しだけで中身が無い", "【見出し】t\n【本文】b\n【よくある質問】\n", { code: "EMPTY_SECTION", section: "よくある質問" }],
    ["FAQ の Q/A が空白だけ", "【見出し】t\n【本文】b\n【よくある質問】\nQ.   \nA.   ", { code: "FAQ_EMPTY_ITEM" }],
    ["FAQ の A が空", "【見出し】t\n【本文】b\n【よくある質問】\nQ. x\nA.", { code: "FAQ_EMPTY_ITEM" }],
    ["FAQ の Q が空", "【見出し】t\n【本文】b\n【よくある質問】\nQ.\nA. y", { code: "FAQ_EMPTY_ITEM" }],
    ["未知の差し込み記号", "【見出し】t\n【本文】{{氏名}}様", { code: "UNKNOWN_TAG", section: "本文" }],
    ["波かっこの書き損じ", "【見出し】t\n【本文】{{物件所在}}}", { code: "UNKNOWN_TAG", section: "本文" }],
    ["見出し以外の行が最初にある", "前置き\n【見出し】t\n【本文】b", { code: "UNKNOWN_SECTION", section: "(見出しの前)" }],
  ];
  for (const [name, raw, issue] of cases) {
    it(name, () => {
      const r = splitLpTemplate(raw);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.issue).toMatchObject(issue);
      expect(lpSplitIssueMessage(r.issue).length).toBeGreaterThan(0);
    });
  }
  it("上限超え: 見出し60/リード300/本文4000/Q&A各300/FAQ 6組", () => {
    const long = (n: number) => "あ".repeat(n);
    expect(splitLpTemplate(`【見出し】${long(61)}\n【本文】b`)).toMatchObject({ ok: false, issue: { code: "TOO_LONG", section: "見出し", limit: 60 } });
    expect(splitLpTemplate(`【見出し】t\n【リード文】${long(301)}\n【本文】b`)).toMatchObject({ ok: false, issue: { code: "TOO_LONG", section: "リード文", limit: 300 } });
    expect(splitLpTemplate(`【見出し】t\n【本文】${long(4001)}`)).toMatchObject({ ok: false, issue: { code: "TOO_LONG", section: "本文", limit: 4000 } });
    expect(splitLpTemplate(`【見出し】t\n【本文】b\n【よくある質問】\nQ. ${long(301)}\nA. x`)).toMatchObject({ ok: false, issue: { code: "TOO_LONG", section: "よくある質問", limit: 300 } });
    const seven = Array.from({ length: 7 }, (_, i) => `Q. q${i}\nA. a${i}`).join("\n");
    expect(splitLpTemplate(`【見出し】t\n【本文】b\n【よくある質問】\n${seven}`)).toMatchObject({ ok: false, issue: { code: "FAQ_TOO_MANY", limit: LP_LIMITS.faqCount } });
    expect(splitLpTemplate(`【見出し】${long(60)}\n【本文】${long(4000)}`).ok).toBe(true);
  });

  it("本文の■小見出し: 61字は HEADING_TOO_LONG", () => {
    const long = (n: number) => "あ".repeat(n);
    const r = splitLpTemplate(`【見出し】t\n【本文】\n■ ${long(61)}\nx`);
    expect(r).toMatchObject({ ok: false, issue: { code: "HEADING_TOO_LONG", section: "本文", limit: LP_LIMITS.heading } });
    if (r.ok) return;
    expect(lpSplitIssueMessage(r.issue)).toContain("60");
  });

  it("本文の■小見出し: 60字ちょうどは通る", () => {
    const long = (n: number) => "あ".repeat(n);
    const r = splitLpTemplate(`【見出し】t\n【本文】\n■ ${long(60)}\nx`);
    expect(r.ok).toBe(true);
  });

  it("本文の■小見出し: 異なる31種は TOO_MANY_HEADINGS", () => {
    const body = Array.from({ length: 31 }, (_, i) => `■ 見出し${i}\nx`).join("\n");
    const r = splitLpTemplate(`【見出し】t\n【本文】\n${body}`);
    expect(r).toMatchObject({ ok: false, issue: { code: "TOO_MANY_HEADINGS", section: "本文", limit: LP_LIMITS.headingCount } });
    if (r.ok) return;
    expect(lpSplitIssueMessage(r.issue)).toContain("30");
  });

  it("本文の■小見出し: ちょうど30種は通る", () => {
    const body = Array.from({ length: 30 }, (_, i) => `■ 見出し${i}\nx`).join("\n");
    const r = splitLpTemplate(`【見出し】t\n【本文】\n${body}`);
    expect(r.ok).toBe(true);
  });

  it("本文の■小見出し: 31個でも重複を除くと30種以下なら通る(media route と同じ重複除去)", () => {
    const distinct = Array.from({ length: 30 }, (_, i) => `■ 見出し${i}\nx`).join("\n");
    const body = `${distinct}\n■ 見出し0\nx`; // 31個目は既存見出しの重複 → 重複除去後は30種
    const r = splitLpTemplate(`【見出し】t\n【本文】\n${body}`);
    expect(r.ok).toBe(true);
  });
});
