import { describe, it, expect } from "vitest";
import { buildExternalPrompt, promptDigest } from "../external-prompt";
import { LETTER_TAGS } from "../tags";

const OPTS = {
  tone: "formal",
  length: "medium",
  appeal: "price",
  strength: "medium",
};

describe("buildExternalPrompt", () => {
  const p = buildExternalPrompt(OPTS);

  it("差込タグの使い方を説明に含む", () => {
    for (const tag of LETTER_TAGS) expect(p).toContain(`{{${tag}}}`);
  });

  it("宛名を本文に書かせない指示を含む(宛名はシステムが差し込む)", () => {
    expect(p).toMatch(/宛名/);
  });

  it("署名・社名・連絡先を本文に書かせない指示を含む(印刷側が付与するため)", () => {
    expect(p).toMatch(/署名|社名|連絡先/);
  });

  it("外部AIへ個人情報を入力しない注意書きを含む", () => {
    expect(p).toMatch(/氏名/);
    expect(p).toMatch(/入力しない/);
  });

  it("選んだ文体の方針が日本語で入る", () => {
    expect(p).toContain("フォーマルで丁寧");
    expect(buildExternalPrompt({ ...OPTS, tone: "soft" })).toContain(
      "やわらかく親しみやすい",
    );
  });

  it("同じ設定なら同じ文字列(digest が安定する)", () => {
    expect(buildExternalPrompt(OPTS)).toBe(p);
  });

  it("設定が違えば文字列も違う(digest で版ずれを検出できる)", () => {
    expect(buildExternalPrompt({ ...OPTS, appeal: "vacant" })).not.toBe(p);
  });

  // ⚠構造的な保証: 引数に宛先・物件・差出人・追加指示が**無い**ので載せられない(設計§2.2)。
  it("個人情報や個別物件の事実が入り込む余地がない", () => {
    expect(p).not.toMatch(/様|御中/);
    expect(p).not.toMatch(/[0-9]-[0-9]/); // 番地のような文字列
  });
});

describe("promptDigest", () => {
  it("同じ文字列は同じ digest・違えば違う", () => {
    expect(promptDigest("a")).toBe(promptDigest("a"));
    expect(promptDigest("a")).not.toBe(promptDigest("b"));
  });

  it("sha256 の16進64桁", () => {
    expect(promptDigest("a")).toMatch(/^[0-9a-f]{64}$/);
  });
});
