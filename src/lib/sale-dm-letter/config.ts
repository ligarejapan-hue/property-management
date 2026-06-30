// 売却促進DM の「解決済み設定」(DB→env でマージ後の値)。各 reader はこの型を受け取る純関数にする。
// 既存の reader 呼び出し(no-arg)は saleDmConfigFromEnv() を既定に使い、従来どおり env ベースで動く
// (後方互換)。DB 設定を効かせたい route は loadSaleDmConfig() を渡す。
export interface SaleDmResolvedConfig {
  provider: string | null; // "claude" | "openai" | "mock" | null
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
  model: string | null; // SALE_DM_LETTER_MODEL 相当の上書き
  trackingBaseUrl: string | null;
  lpUrl: string | null;
  senderName: string | null;
  senderContact: string | null;
  useMock: boolean; // NEXT_PUBLIC_USE_MOCK
}

const trimOrNull = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t && t.length > 0 ? t : null;
};

// env のみから設定を解決(DB 未使用)。reader の既定値=従来どおりの env ベース挙動。
export function saleDmConfigFromEnv(): SaleDmResolvedConfig {
  return {
    provider: trimOrNull(process.env.SALE_DM_LETTER_PROVIDER),
    anthropicApiKey: trimOrNull(process.env.ANTHROPIC_API_KEY),
    openaiApiKey: trimOrNull(process.env.OPENAI_API_KEY),
    model: trimOrNull(process.env.SALE_DM_LETTER_MODEL),
    trackingBaseUrl: trimOrNull(process.env.SALE_DM_TRACKING_BASE_URL),
    lpUrl: trimOrNull(process.env.SALE_DM_LP_URL),
    senderName: trimOrNull(process.env.SALE_DM_SENDER_NAME),
    senderContact: trimOrNull(process.env.SALE_DM_SENDER_CONTACT),
    useMock: process.env.NEXT_PUBLIC_USE_MOCK === "true",
  };
}

// DB 行(非秘匿項目)+ 復号済みキー + env をマージ。DB 値(非null/非空)が優先・無ければ env。
// 復号はこの関数の外(config-store)で行い、ここには復号済み(or null)を渡す純関数に保つ。
export function mergeSaleDmConfig(
  db: {
    provider: string | null;
    model: string | null;
    trackingBaseUrl: string | null;
    lpUrl: string | null;
    senderName: string | null;
    senderContact: string | null;
  } | null,
  decryptedAnthropicKey: string | null,
  decryptedOpenaiKey: string | null,
  env: SaleDmResolvedConfig = saleDmConfigFromEnv(),
): SaleDmResolvedConfig {
  if (!db) return env;
  const pick = (dbv: string | null, envv: string | null) => trimOrNull(dbv) ?? envv;
  return {
    provider: pick(db.provider, env.provider),
    anthropicApiKey: decryptedAnthropicKey ?? env.anthropicApiKey,
    openaiApiKey: decryptedOpenaiKey ?? env.openaiApiKey,
    model: pick(db.model, env.model),
    trackingBaseUrl: pick(db.trackingBaseUrl, env.trackingBaseUrl),
    lpUrl: pick(db.lpUrl, env.lpUrl),
    senderName: pick(db.senderName, env.senderName),
    senderContact: pick(db.senderContact, env.senderContact),
    useMock: env.useMock,
  };
}
