/**
 * @codex(635e952) follow-on P2: 印刷物の差出人二重化を防ぐ。
 *
 * prompt は AI に「差出人を本文末尾に明示」させていたが、印刷テンプレ(templates/index.ts)も
 * 別途 env 由来の `.letter-sender` ブロックを末尾に付与する→通常の生成＋印刷で差出人が二重表示、
 * かつ生成後に env 差出人が変わると本文側 footer と食い違う。
 * 差出人は印刷側(env)を唯一の出所にし、AI には書かせない/渡さない。
 */
import { describe, it, expect } from "vitest";
import { buildLetterPrompt } from "../sale-dm-letter/prompt";
import type { LetterRecipient, LetterOptions } from "../sale-dm-letter/types";

const recipient: LetterRecipient = {
  representativeName: "田中 一郎",
  honorific: "様",
  coOwnerCount: 1,
  propertyAddress: "東京都〇〇区1-2-3",
  propertyTypeLabel: "土地",
  roomNo: null,
};
const options: LetterOptions = {
  designTemplate: "formal",
  tone: "formal",
  length: "medium",
  appeal: "price",
  strength: "low",
  senderName: "△△不動産株式会社",
  senderContact: "03-1234-5678",
};

describe("売却DM prompt: 差出人の二重化・不一致を防ぐ", () => {
  const { system, user } = buildLetterPrompt(recipient, options);

  it("system は「差出人を本文末尾に明示」する指示を含まない(印刷側で付与=重複防止)", () => {
    expect(system).not.toContain("本文末尾");
    expect(system).not.toMatch(/差出人.*明示する/);
  });

  it("system は差出人の署名・連絡先を本文に書かない旨を明示する", () => {
    expect(system).toMatch(/差出人.*本文に.*(含めない|書かない)|印刷側で付与/);
  });

  it("user は差出人名・連絡先を AI に渡さない(env 変更時に本文と footer が食い違わない)", () => {
    expect(user).not.toContain("△△不動産株式会社");
    expect(user).not.toContain("03-1234-5678");
  });

  it("宛名・物件情報は従来どおり渡す(本文生成に必要)", () => {
    expect(user).toContain("田中 一郎");
    expect(user).toContain("東京都〇〇区1-2-3");
    expect(user).toContain("土地");
  });
});
