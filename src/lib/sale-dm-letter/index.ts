import type {
  LetterProvider, LetterRecipient, LetterOptions, SaleDmErrorCode,
} from "./types";
import { SaleDmError } from "./types";
import { buildLetterPrompt } from "./prompt";
import { MockLetterProvider } from "./providers/mock";
import { ClaudeLetterProvider } from "./providers/claude";
import { OpenAiLetterProvider } from "./providers/openai";
import { saleDmConfigFromEnv, type SaleDmResolvedConfig } from "./config";

export const MAX_GENERATE_ITEMS = 50;
const DEFAULT_CONCURRENCY = 5;
// provider 別の既定モデル(SALE_DM_LETTER_MODEL / 設定画面で上書き可)。
export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const DEFAULT_OPENAI_MODEL = "gpt-4o";

// 各 reader は解決済み設定 cfg(DB→env)を受け取る。no-arg は env のみ=従来挙動(後方互換)。
// DB 設定を効かせる route は loadSaleDmConfig() の結果を渡す。

// 生成・永続化で使うモデル名を一元解決する(provider 別の既定・上書き優先)。
// resolveProvider(生成側)と campaign 作成(draft.model 保存側)が同じ値を使うことで、保存した
// model と実際に生成したモデルがズレない(OpenAI 生成なのに claude を記録、を防ぐ)。
export function resolveLetterModel(cfg: SaleDmResolvedConfig = saleDmConfigFromEnv()): string {
  if (cfg.model) return cfg.model;
  return cfg.provider === "openai" ? DEFAULT_OPENAI_MODEL : DEFAULT_MODEL;
}

export function isSaleDmConfigured(cfg: SaleDmResolvedConfig = saleDmConfigFromEnv()): boolean {
  // 管理者が明示的に「停止(off)」を選んだら、env/useMock より優先で確実に止める(fail-closed)。
  if (cfg.provider === "off") return false;
  if (cfg.useMock) return true;
  if (cfg.provider === "mock") return true;
  if (cfg.provider === "claude") return Boolean(cfg.anthropicApiKey);
  if (cfg.provider === "openai") return Boolean(cfg.openaiApiKey);
  return false;
}

export function resolveProvider(cfg: SaleDmResolvedConfig = saleDmConfigFromEnv()): LetterProvider {
  // 明示的な停止(off)は env/useMock より優先(生成側でも確実に止める)。
  if (cfg.provider === "off") {
    throw new SaleDmError("NOT_CONFIGURED", "売却DM生成は停止に設定されています");
  }
  if (cfg.useMock) return new MockLetterProvider();
  if (cfg.provider === "mock") return new MockLetterProvider();
  if (cfg.provider === "claude") {
    if (!cfg.anthropicApiKey) {
      throw new SaleDmError("NOT_CONFIGURED", "Anthropic(Claude) APIキーが未設定です");
    }
    return new ClaudeLetterProvider({ apiKey: cfg.anthropicApiKey, model: resolveLetterModel(cfg) });
  }
  if (cfg.provider === "openai") {
    if (!cfg.openaiApiKey) {
      throw new SaleDmError("NOT_CONFIGURED", "OpenAI(ChatGPT) APIキーが未設定です");
    }
    return new OpenAiLetterProvider({ apiKey: cfg.openaiApiKey, model: resolveLetterModel(cfg) });
  }
  throw new SaleDmError("NOT_CONFIGURED", "売却DM生成が未設定です(プロバイダ未選択)");
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
  // 既定は無制限(50件上限は撤廃)。呼び出し側が明示的に max を渡したときだけ切り詰める。
  const max = opts?.max ?? Number.POSITIVE_INFINITY;
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
