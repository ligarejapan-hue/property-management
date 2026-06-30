import Anthropic from "@anthropic-ai/sdk";
import type { LetterProvider, BuiltPrompt } from "../types";
import { SaleDmError } from "../types";

// テスト注入用: 実 SDK 呼び出しを差し替えられるようにする(address-lookup の fetchFn 注入と同型)。
type CreateMessage = (args: {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: "user"; content: string }[];
}) => Promise<{ content?: Array<{ type: string; text?: string }>; stop_reason?: string }>;

export interface ClaudeProviderOptions {
  apiKey: string;
  model: string;
  createMessage?: CreateMessage;
}

export class ClaudeLetterProvider implements LetterProvider {
  readonly name = "claude";
  private readonly model: string;
  private readonly createMessage: CreateMessage;

  constructor(opts: ClaudeProviderOptions) {
    this.model = opts.model;
    if (opts.createMessage) {
      this.createMessage = opts.createMessage;
    } else {
      const client = new Anthropic({ apiKey: opts.apiKey });
      this.createMessage = (args) => client.messages.create(args) as unknown as ReturnType<CreateMessage>;
    }
  }

  async generate(prompt: BuiltPrompt): Promise<{ body: string }> {
    let res;
    try {
      res = await this.createMessage({
        model: this.model,
        max_tokens: 1200,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
      });
    } catch (e) {
      throw new SaleDmError("GENERATION_FAILED", "本文生成に失敗しました");
    }
    if (res.stop_reason === "refusal") {
      throw new SaleDmError("GENERATION_FAILED", "本文生成が拒否されました");
    }
    const text = (res.content ?? []).find((b) => b.type === "text")?.text;
    if (!text) {
      throw new SaleDmError("GENERATION_FAILED", "本文が空でした");
    }
    return { body: text };
  }
}
