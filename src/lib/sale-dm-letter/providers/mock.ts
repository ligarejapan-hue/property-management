import type { LetterProvider, BuiltPrompt } from "../types";

export class MockLetterProvider implements LetterProvider {
  readonly name = "mock";
  async generate(prompt: BuiltPrompt): Promise<{ body: string }> {
    const firstLine = prompt.user.split("\n")[0] ?? "";
    return {
      body: `（mock生成）${firstLine}\n平素より大変お世話になっております。当エリアでは不動産の需要が高まっております。無料査定を承っておりますのでお気軽にご連絡ください。`,
    };
  }
}
