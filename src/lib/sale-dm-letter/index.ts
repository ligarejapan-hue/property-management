import type {
  LetterProvider, LetterRecipient, LetterOptions, SaleDmErrorCode,
} from "./types";
import { SaleDmError } from "./types";
import { buildLetterPrompt } from "./prompt";
import { MockLetterProvider } from "./providers/mock";
import { ClaudeLetterProvider } from "./providers/claude";
import { OpenAiLetterProvider } from "./providers/openai";

export const MAX_GENERATE_ITEMS = 50;
const DEFAULT_CONCURRENCY = 5;
// provider 別の既定モデル(SALE_DM_LETTER_MODEL で上書き可)。
export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const DEFAULT_OPENAI_MODEL = "gpt-4o";

// 生成・永続化で使うモデル名を一元解決する(provider 別の既定・SALE_DM_LETTER_MODEL で上書き)。
// resolveProvider(生成側)と campaign 作成(draft.model 保存側)が同じ値を使うことで、保存した
// model と実際に生成したモデルがズレない(OpenAI 生成なのに claude を記録、を防ぐ)。
export function resolveLetterModel(): string {
  const override = process.env.SALE_DM_LETTER_MODEL;
  if (override) return override;
  return process.env.SALE_DM_LETTER_PROVIDER === "openai" ? DEFAULT_OPENAI_MODEL : DEFAULT_MODEL;
}

export function isSaleDmConfigured(): boolean {
  if (process.env.NEXT_PUBLIC_USE_MOCK === "true") return true;
  const provider = process.env.SALE_DM_LETTER_PROVIDER;
  if (provider === "mock") return true;
  if (provider === "claude") return Boolean(process.env.ANTHROPIC_API_KEY);
  if (provider === "openai") return Boolean(process.env.OPENAI_API_KEY);
  return false;
}

export function resolveProvider(): LetterProvider {
  if (process.env.NEXT_PUBLIC_USE_MOCK === "true") return new MockLetterProvider();
  const provider = process.env.SALE_DM_LETTER_PROVIDER;
  if (provider === "mock") return new MockLetterProvider();
  if (provider === "claude") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new SaleDmError("NOT_CONFIGURED", "ANTHROPIC_API_KEY が未設定です");
    }
    return new ClaudeLetterProvider({ apiKey, model: resolveLetterModel() });
  }
  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new SaleDmError("NOT_CONFIGURED", "OPENAI_API_KEY が未設定です");
    }
    return new OpenAiLetterProvider({ apiKey, model: resolveLetterModel() });
  }
  throw new SaleDmError("NOT_CONFIGURED", "売却DM生成が未設定です(SALE_DM_LETTER_PROVIDER)");
}

export interface GeneratedDraft {
  recipientIndex: number;
  body: string | null;
  error: SaleDmErrorCode | null;
}

async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

export async function generateLetters(
  items: { recipient: LetterRecipient; options: LetterOptions }[],
  opts?: { provider?: LetterProvider; concurrency?: number; max?: number },
): Promise<{ drafts: GeneratedDraft[]; truncated: boolean }> {
  const max = opts?.max ?? MAX_GENERATE_ITEMS;
  const truncated = items.length > max;
  const sliced = truncated ? items.slice(0, max) : items;
  const provider = opts?.provider ?? resolveProvider();

  const tasks = sliced.map((item, i) => async (): Promise<GeneratedDraft> => {
    try {
      const prompt = buildLetterPrompt(item.recipient, item.options);
      const { body } = await provider.generate(prompt);
      return { recipientIndex: i, body, error: null };
    } catch (e) {
      const code = e instanceof SaleDmError ? e.code : "GENERATION_FAILED";
      return { recipientIndex: i, body: null, error: code };
    }
  });

  const drafts = await runWithConcurrency(tasks, opts?.concurrency ?? DEFAULT_CONCURRENCY);
  return { drafts, truncated };
}
