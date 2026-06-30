import OpenAI from "openai";
import type { LetterProvider, BuiltPrompt } from "../types";
import { SaleDmError } from "../types";

// テスト注入用: 実 SDK 呼び出しを差し替えられるようにする(claude.ts の createMessage 注入と同型)。
type ChatMessage = { role: "system" | "user"; content: string };
type CreateCompletion = (args: {
  model: string;
  messages: ChatMessage[];
  max_completion_tokens: number;
}) => Promise<{
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
}>;

export interface OpenAiProviderOptions {
  apiKey: string;
  model: string;
  createCompletion?: CreateCompletion;
}

export class OpenAiLetterProvider implements LetterProvider {
  readonly name = "openai";
  private readonly model: string;
  private readonly createCompletion: CreateCompletion;

  constructor(opts: OpenAiProviderOptions) {
    this.model = opts.model;
    if (opts.createCompletion) {
      this.createCompletion = opts.createCompletion;
    } else {
      const client = new OpenAI({ apiKey: opts.apiKey });
      this.createCompletion = (args) =>
        client.chat.completions.create(args) as unknown as ReturnType<CreateCompletion>;
    }
  }

  async generate(prompt: BuiltPrompt): Promise<{ body: string }> {
    let res;
    try {
      res = await this.createCompletion({
        model: this.model,
        max_completion_tokens: 1200,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
      });
    } catch {
      throw new SaleDmError("GENERATION_FAILED", "本文生成に失敗しました");
    }
    const choice = res.choices?.[0];
    // OpenAI は不適切要求などを content_filter で打ち切る(Claude の stop_reason=refusal 相当)。
    if (choice?.finish_reason === "content_filter") {
      throw new SaleDmError("GENERATION_FAILED", "本文生成が拒否されました");
    }
    const text = choice?.message?.content?.trim();
    if (!text) {
      throw new SaleDmError("GENERATION_FAILED", "本文が空でした");
    }
    return { body: text };
  }
}
