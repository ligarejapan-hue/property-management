import prisma from "@/lib/prisma";
import { decryptSecret } from "./secret-crypto";
import {
  mergeSaleDmConfig,
  saleDmConfigFromEnv,
  saleDmLpUrlFromEnv,
  saleDmPublicPageConfigFromEnv,
  type SaleDmResolvedConfig,
} from "./config";
import { resolveLpUrl, resolveTrackingBaseUrl } from "./tracking";

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

// 公開トラッキング(/t/<token>)専用の既定LP解決。未認証・高頻度の公開経路で課金APIキーを
// 取得・復号しないよう、lpUrl 列だけを select する(暗号化キー列 anthropicApiKeyEnc/openaiApiKeyEnc は
// 読まない=decryptSecret も呼ばない)。loadSaleDmConfig(全設定+復号)とは意図的に分離。
// DB→env フォールバック・絶対http(s)検証は resolveLpUrl に委譲(print/t と同一規則)。
export async function loadSaleDmLpUrl(): Promise<string | undefined> {
  let dbLp: string | null = null;
  try {
    const row = await prisma.saleDmConfig.findUnique({
      where: { id: SALE_DM_CONFIG_ID },
      select: { lpUrl: true }, // ← LP URL 列のみ。秘匿(キー)列は取得しない。
    });
    dbLp = row?.lpUrl ?? null;
  } catch {
    dbLp = null; // DB未接続/テーブル無等は env フォールバック(fail-safe)。
  }
  // env も LP のみ読む(saleDmConfigFromEnv は使わない=APIキーを request-local に載せない)。
  const lpUrl = dbLp && dbLp.trim().length > 0 ? dbLp : saleDmLpUrlFromEnv();
  return resolveLpUrl({ lpUrl });
}

// /t/<token> のページ本体(LP型のご案内ページ)描画専用の設定解決。loadSaleDmLpUrl と同じ理由で
// 秘匿キー列は一切読まない(select に anthropicApiKeyEnc/openaiApiKeyEnc を含めない・decryptSecret も
// 呼ばない)。loadSaleDmConfig(全設定+復号)を公開・未認証・高頻度の /t ページ描画経路では使わない
// (それを使うと課金APIキーを毎回 request-local に materialize してしまう=避けたい不変条件)。
// DB→env フォールバック・絶対http(s)検証は resolveLpUrl/resolveTrackingBaseUrl に委譲(print/t と同一規則)。
export async function loadSaleDmPublicPageConfig(): Promise<{
  lpUrl: string | undefined;
  senderName: string | null;
  senderContact: string | null;
  trackingBaseUrl: string | undefined;
}> {
  let db: {
    lpUrl: string | null; senderName: string | null; senderContact: string | null; trackingBaseUrl: string | null;
  } | null = null;
  try {
    db = await prisma.saleDmConfig.findUnique({
      where: { id: SALE_DM_CONFIG_ID },
      // ← LP/送付元表示/追跡base列のみ。秘匿(キー)列は取得しない。
      select: { lpUrl: true, senderName: true, senderContact: true, trackingBaseUrl: true },
    });
  } catch {
    db = null; // DB未接続/テーブル無等は env フォールバック(fail-safe)。
  }
  const env = saleDmPublicPageConfigFromEnv();
  const pick = (dbv: string | null | undefined, envv: string | null): string | null =>
    dbv && dbv.trim().length > 0 ? dbv : envv;
  return {
    lpUrl: resolveLpUrl({ lpUrl: pick(db?.lpUrl, env.lpUrl) }),
    senderName: pick(db?.senderName, env.senderName),
    senderContact: pick(db?.senderContact, env.senderContact),
    trackingBaseUrl: resolveTrackingBaseUrl({ trackingBaseUrl: pick(db?.trackingBaseUrl, env.trackingBaseUrl) }),
  };
}
