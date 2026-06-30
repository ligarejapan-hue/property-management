import prisma from "@/lib/prisma";
import { decryptSecret } from "./secret-crypto";
import {
  mergeSaleDmConfig,
  saleDmConfigFromEnv,
  type SaleDmResolvedConfig,
} from "./config";

// 設定は1行のみ(singleton)。管理画面の GET/PUT もこの id を使う。
export const SALE_DM_CONFIG_ID = "singleton";

// DB 設定(あれば)を env にマージして解決する。
//  - DB 行が無い / DB 取得失敗(未接続・テーブル無 等)→ env のみ(既存挙動を壊さない=fail-safe)。
//  - 秘匿キーは復号して返す。復号失敗(マスターキー不一致等)は null → env キーへフォールバック。
export async function loadSaleDmConfig(): Promise<SaleDmResolvedConfig> {
  let db: {
    provider: string | null; model: string | null; trackingBaseUrl: string | null;
    lpUrl: string | null; senderName: string | null; senderContact: string | null;
    anthropicApiKeyEnc: string | null; openaiApiKeyEnc: string | null;
  } | null = null;
  try {
    db = await prisma.saleDmConfig.findUnique({ where: { id: SALE_DM_CONFIG_ID } });
  } catch {
    db = null;
  }
  if (!db) return saleDmConfigFromEnv();
  const dec = (enc: string | null): string | null => {
    if (!enc || enc.trim() === "") return null;
    try {
      return decryptSecret(enc);
    } catch {
      return null; // 復号不能(鍵不一致/形式不正)→ env フォールバックに委ねる。
    }
  };
  return mergeSaleDmConfig(db, dec(db.anthropicApiKeyEnc), dec(db.openaiApiKeyEnc));
}
