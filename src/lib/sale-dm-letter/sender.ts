import { saleDmConfigFromEnv, type SaleDmResolvedConfig } from "./config";

export interface SaleDmSender { senderName: string; senderContact: string }

// cfg は DB→env 解決済み。no-arg は env のみ(後方互換)。
export function resolveSender(cfg: SaleDmResolvedConfig = saleDmConfigFromEnv()): SaleDmSender {
  return {
    senderName: cfg.senderName ?? "(差出人名 未設定)",
    senderContact: cfg.senderContact ?? "",
  };
}

// 差出人(差出人名・連絡先)が設定済みか。未設定だと resolveSender が "(差出人名 未設定)"/空 を返し、
// 使えない手紙を有料生成してしまうため、生成前の fail-closed 判定に使う。空白のみも未設定として扱う。
export function isSenderConfigured(cfg: SaleDmResolvedConfig = saleDmConfigFromEnv()): boolean {
  return !!cfg.senderName?.trim() && !!cfg.senderContact?.trim();
}
