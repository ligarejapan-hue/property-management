/**
 * AI クライアントの上限（総点検P3）。
 *
 * SDK 既定（1試行タイムアウト10分×最大3試行）のままだと 50 通生成の worst-case
 * が数時間に達し、campaigns route の idempotency 孤児判定(STALE_MS)が生成中の
 * ライブなクレームを孤児と誤判定して削除→同キーで再生成＝AI 課金が二重になる。
 * provider が timeout / maxRetries を**明示して**構築することを固定する
 * （STALE_MS は route 側で limits.ts の定数から導出される）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const anthropicCtor = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: vi.fn() };
    constructor(opts: unknown) {
      anthropicCtor(opts);
    }
  },
}));
const openaiCtor = vi.fn();
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: vi.fn() } };
    constructor(opts: unknown) {
      openaiCtor(opts);
    }
  },
}));

import { ClaudeLetterProvider } from "../sale-dm-letter/providers/claude";
import { OpenAiLetterProvider } from "../sale-dm-letter/providers/openai";
import { AI_CALL_TIMEOUT_MS, AI_MAX_RETRIES } from "../sale-dm-letter/limits";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AI クライアントの構築オプション（総点検P3）", () => {
  it("Claude: timeout / maxRetries を明示して構築する（SDK 既定に依存しない）", () => {
    new ClaudeLetterProvider({ apiKey: "k", model: "m" });
    expect(anthropicCtor).toHaveBeenCalledWith({
      apiKey: "k",
      timeout: AI_CALL_TIMEOUT_MS,
      maxRetries: AI_MAX_RETRIES,
    });
  });

  it("OpenAI: timeout / maxRetries を明示して構築する（SDK 既定に依存しない）", () => {
    new OpenAiLetterProvider({ apiKey: "k", model: "m" });
    expect(openaiCtor).toHaveBeenCalledWith({
      apiKey: "k",
      timeout: AI_CALL_TIMEOUT_MS,
      maxRetries: AI_MAX_RETRIES,
    });
  });

  it("テスト注入(createMessage/createCompletion)経路では SDK を構築しない", () => {
    new ClaudeLetterProvider({ apiKey: "k", model: "m", createMessage: vi.fn() });
    new OpenAiLetterProvider({ apiKey: "k", model: "m", createCompletion: vi.fn() });
    expect(anthropicCtor).not.toHaveBeenCalled();
    expect(openaiCtor).not.toHaveBeenCalled();
  });
});
