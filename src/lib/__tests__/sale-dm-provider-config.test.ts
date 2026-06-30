import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isSaleDmConfigured, resolveProvider, resolveLetterModel } from "../sale-dm-letter";
import { OpenAiLetterProvider } from "../sale-dm-letter/providers/openai";
import { ClaudeLetterProvider } from "../sale-dm-letter/providers/claude";
import { MockLetterProvider } from "../sale-dm-letter/providers/mock";
import { SaleDmError } from "../sale-dm-letter/types";

// SALE_DM_LETTER_PROVIDER による Claude/OpenAI/mock の切替を検証する(管理者がシステム設定で選ぶ方式)。
const ENV = process.env;
beforeEach(() => {
  process.env = { ...ENV };
  delete process.env.NEXT_PUBLIC_USE_MOCK;
  delete process.env.SALE_DM_LETTER_PROVIDER;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.SALE_DM_LETTER_MODEL;
});
afterEach(() => {
  process.env = ENV;
});

describe("provider 切替: openai(ChatGPT)", () => {
  it("provider=openai + OPENAI_API_KEY 設定で isSaleDmConfigured=true", () => {
    process.env.SALE_DM_LETTER_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    expect(isSaleDmConfigured()).toBe(true);
  });

  it("provider=openai でキー未設定は isSaleDmConfigured=false(fail-closed)", () => {
    process.env.SALE_DM_LETTER_PROVIDER = "openai";
    expect(isSaleDmConfigured()).toBe(false);
  });

  it("provider=openai + キーで resolveProvider が OpenAiLetterProvider(name=openai)", () => {
    process.env.SALE_DM_LETTER_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    const p = resolveProvider();
    expect(p).toBeInstanceOf(OpenAiLetterProvider);
    expect(p.name).toBe("openai");
  });

  it("provider=openai でキー未設定は resolveProvider が SaleDmError(NOT_CONFIGURED)", () => {
    process.env.SALE_DM_LETTER_PROVIDER = "openai";
    expect(() => resolveProvider()).toThrow(SaleDmError);
  });
});

describe("provider 切替: claude/mock の既存挙動は不変(回帰)", () => {
  it("provider=claude + ANTHROPIC_API_KEY で ClaudeLetterProvider", () => {
    process.env.SALE_DM_LETTER_PROVIDER = "claude";
    process.env.ANTHROPIC_API_KEY = "k";
    const p = resolveProvider();
    expect(p).toBeInstanceOf(ClaudeLetterProvider);
    expect(p.name).toBe("claude");
    expect(isSaleDmConfigured()).toBe(true);
  });

  it("provider=mock は常に有効", () => {
    process.env.SALE_DM_LETTER_PROVIDER = "mock";
    expect(isSaleDmConfigured()).toBe(true);
    expect(resolveProvider()).toBeInstanceOf(MockLetterProvider);
  });

  it("claude/openai/mock 以外の provider は NOT_CONFIGURED", () => {
    process.env.SALE_DM_LETTER_PROVIDER = "gemini";
    expect(isSaleDmConfigured()).toBe(false);
    expect(() => resolveProvider()).toThrow(SaleDmError);
  });
});

describe("resolveLetterModel: 永続化するモデル名は provider 既定に追従(生成と一致)", () => {
  it("provider=openai・上書き無しは gpt-4o(=実際に生成するモデルと一致)", () => {
    process.env.SALE_DM_LETTER_PROVIDER = "openai";
    expect(resolveLetterModel()).toBe("gpt-4o");
  });

  it("provider=claude・上書き無しは claude-sonnet-4-6", () => {
    process.env.SALE_DM_LETTER_PROVIDER = "claude";
    expect(resolveLetterModel()).toBe("claude-sonnet-4-6");
  });

  it("SALE_DM_LETTER_MODEL 上書きは provider に関わらず優先", () => {
    process.env.SALE_DM_LETTER_PROVIDER = "openai";
    process.env.SALE_DM_LETTER_MODEL = "gpt-4o-mini";
    expect(resolveLetterModel()).toBe("gpt-4o-mini");
  });

  it("provider 未指定(既定)は claude-sonnet-4-6", () => {
    expect(resolveLetterModel()).toBe("claude-sonnet-4-6");
  });
});
