import { describe, it, expect } from "vitest";
import { buildLetterPrompt } from "../sale-dm-letter/prompt";
import type { LetterRecipient, LetterOptions } from "../sale-dm-letter/types";

const recipient: LetterRecipient = {
  representativeName: "田中 一郎",
  honorific: "様",
  coOwnerCount: 1,
  propertyAddress: "東京都〇〇区△△1-2-3",
  propertyTypeLabel: "土地",
  roomNo: null,
};
const options: LetterOptions = {
  designTemplate: "formal",
  tone: "formal",
  length: "medium",
  appeal: "price",
  strength: "low",
  senderName: "△△不動産",
  senderContact: "000-000-0000",
  extraInstruction: "地域の成約事例にも触れて",
};

describe("buildLetterPrompt", () => {
  it("宛名(氏名+敬称)を user プロンプトに含める", () => {
    const { user } = buildLetterPrompt(recipient, options);
    expect(user).toContain("田中 一郎");
    expect(user).toContain("様");
    expect(user).not.toContain("他共有者");
  });

  it("複数共有者のとき宛名に共有者数を反映する情報を含める", () => {
    const { user } = buildLetterPrompt({ ...recipient, coOwnerCount: 3 }, options);
    expect(user).toContain("他共有者");
  });

  it("差出人・物件情報・補足指示を user に含める", () => {
    const { user } = buildLetterPrompt(recipient, options);
    expect(user).toContain("△△不動産");
    expect(user).toContain("東京都〇〇区△△1-2-3");
    expect(user).toContain("地域の成約事例にも触れて");
  });

  it("system にコンプライアンス制約(誇大広告/断定価格)を含める", () => {
    const { system } = buildLetterPrompt(recipient, options);
    expect(system).toContain("誇大");
    expect(system).toContain("断定");
  });

  it("同一入力で system は決定的(キャッシュ前提・宛先非依存)", () => {
    const a = buildLetterPrompt(recipient, options);
    const b = buildLetterPrompt({ ...recipient, representativeName: "佐藤 花子" }, options);
    expect(a.system).toBe(b.system);
  });

  it("roomNo が指定されているとき user に含める", () => {
    const { user } = buildLetterPrompt({ ...recipient, roomNo: "101" }, options);
    expect(user).toContain("101");
  });

  it("roomNo が null のとき user に部屋番号を含めない", () => {
    const { user } = buildLetterPrompt(recipient, options);
    expect(user).not.toContain("部屋番号");
  });
});
