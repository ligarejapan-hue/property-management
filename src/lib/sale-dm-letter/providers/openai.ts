import OpenAI from "openai";
import type { LetterProvider, BuiltPrompt } from "../types";
import { SaleDmError } from "../types";
import { AI_CALL_TIMEOUT_MS, AI_MAX_RETRIES } from "../limits";

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
      // ⚠SDK 既定(timeout 10分×3試行)のままだと worst-case が数時間に達する
      // （claude.ts と同じ理由・総点検P3・limits.ts 参照）。
      const client = new OpenAI({
        apiKey: opts.apiKey,
        timeout: AI_CALL_TIMEOUT_MS,
        maxRetries: AI_MAX_RETRIES,
      });
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
    // content_filter=不適切要求で打ち切り / length=トークン上限で途中切れ。どちらも不完全な手紙ゆえ、
    // 本文が非空でも生成失敗扱いにし、途中切れの DM を下書き保存・送付しない(Claude の refusal/max_tokens と対称)。
    if (choice?.finish_reason === "content_filter") {
      throw new SaleDmError("GENERATION_FAILED", "本文生成が拒否されました");
    }
    if (choice?.finish_reason === "length") {
      throw new SaleDmError("GENERATION_FAILED", "本文が長さ上限で途中切れしました");
    }
    const text = choice?.message?.content?.trim();
    if (!text) {
      throw new SaleDmError("GENERATION_FAILED", "本文が空でした");
    }
    return { body: text };
  }
}
