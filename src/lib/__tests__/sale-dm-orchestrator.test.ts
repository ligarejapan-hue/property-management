import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateLetters, isSaleDmConfigured, resolveProvider, MAX_GENERATE_ITEMS } from "../sale-dm-letter";
import { MockLetterProvider } from "../sale-dm-letter/providers/mock";
import { SaleDmError } from "../sale-dm-letter/types";
import type { LetterRecipient, LetterOptions, LetterProvider } from "../sale-dm-letter/types";

const recipient: LetterRecipient = {
  representativeName: "田中 一郎", honorific: "様", coOwnerCount: 1,
  propertyAddress: "東京都〇〇区", propertyTypeLabel: "土地", roomNo: null,
};
const options: LetterOptions = {
  designTemplate: "formal", tone: "formal", length: "medium", appeal: "price",
  strength: "low", senderName: "△△不動産", senderContact: "000",
};
const items = (n: number) => Array.from({ length: n }, () => ({ recipient, options }));

const ENV_KEYS = ["NEXT_PUBLIC_USE_MOCK", "SALE_DM_LETTER_PROVIDER", "ANTHROPIC_API_KEY", "SALE_DM_LETTER_MODEL"];
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = {}; for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("env gate", () => {
  it("未設定なら isSaleDmConfigured=false / resolveProvider が NOT_CONFIGURED throw", () => {
    expect(isSaleDmConfigured()).toBe(false);
    try { resolveProvider(); expect.unreachable(); }
    catch (e) { expect(e).toBeInstanceOf(SaleDmError); expect((e as SaleDmError).code).toBe("NOT_CONFIGURED"); }
  });
  it("NEXT_PUBLIC_USE_MOCK=true なら mock provider", () => {
    process.env.NEXT_PUBLIC_USE_MOCK = "true";
    expect(isSaleDmConfigured()).toBe(true);
    expect(resolveProvider().name).toBe("mock");
  });
  it("provider=claude + APIキーで claude provider", () => {
    process.env.SALE_DM_LETTER_PROVIDER = "claude";
    process.env.ANTHROPIC_API_KEY = "k";
    expect(resolveProvider().name).toBe("claude");
  });
});

describe("generateLetters", () => {
  it("各 item の本文を生成して返す", async () => {
    const { drafts, truncated } = await generateLetters(items(3), { provider: new MockLetterProvider() });
    expect(truncated).toBe(false);
    expect(drafts).toHaveLength(3);
    expect(drafts.every((d) => d.body && d.error === null)).toBe(true);
  });

  it("MAX 超過は先頭 N 件 + truncated=true", async () => {
    const { drafts, truncated } = await generateLetters(items(MAX_GENERATE_ITEMS + 5), { provider: new MockLetterProvider() });
    expect(truncated).toBe(true);
    expect(drafts).toHaveLength(MAX_GENERATE_ITEMS);
  });

  it("一部失敗しても全体は止めず該当のみ error", async () => {
    let n = 0;
    const flaky: LetterProvider = {
      name: "flaky",
      async generate() { n += 1; if (n === 2) throw new SaleDmError("GENERATION_FAILED", "x"); return { body: "ok" }; },
    };
    const { drafts } = await generateLetters(items(3), { provider: flaky });
    expect(drafts.filter((d) => d.error).length).toBe(1);
    expect(drafts.filter((d) => d.body).length).toBe(2);
  });
});
