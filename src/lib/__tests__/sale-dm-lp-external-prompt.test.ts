import { describe, it, expect } from "vitest";
import { buildLpExternalPrompt, buildExternalPrompt, promptDigest } from "../sale-dm-letter/external-prompt";

const OPT = { tone: "formal", length: "medium", appeal: "inheritance", strength: "low" };

describe("buildLpExternalPrompt", () => {
  it("4つの固定見出しと Q./A. の指示を含む", () => {
    const p = buildLpExternalPrompt(OPT);
    for (const h of ["【見出し】", "【リード文】", "【本文】", "【よくある質問】"]) expect(p).toContain(h);
    expect(p).toContain("Q.");
    expect(p).toContain("A.");
    expect(p).toContain("■");
  });
  it("文体4項目を日本語で反映する", () => {
    const p = buildLpExternalPrompt(OPT);
    expect(p).toContain("相続");
    expect(p).not.toContain("inheritance");
  });
  it("社名・連絡先・ボタン文言・宛名・特定情報を書かせない指示がある", () => {
    const p = buildLpExternalPrompt(OPT);
    expect(p).toContain("社名");
    expect(p).toContain("連絡先");
    expect(p).toContain("ボタン");
    expect(p).toContain("宛名");
    expect(p).toContain("{{物件所在}}");
    expect(p).toContain("{{物件種別}}");
    expect(p).toContain("入力しないでください");
  });
  it("DM用プロンプトと指紋が別(貼り違いを検出できる)", () => {
    expect(promptDigest(buildLpExternalPrompt(OPT))).not.toBe(promptDigest(buildExternalPrompt(OPT)));
  });
  it("引数は文体4項目だけ(宛先・物件・差出人を渡す口が無い)", () => {
    expect(buildLpExternalPrompt.length).toBe(1);
    const p = buildLpExternalPrompt({ ...OPT, senderName: "山田" } as never);
    expect(p).not.toContain("山田");
  });
});
