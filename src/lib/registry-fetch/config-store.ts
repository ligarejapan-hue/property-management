import prisma from "@/lib/prisma";
import { decryptRegistrySecret } from "@/lib/registry-fetch/secret-crypto";

export interface ResolvedRegistryCredentials {
  loginId: string | null;
  password: string | null;
  baseUrl: string | null;
}

const CONFIG_ID = "singleton";

function decOrNull(enc: string | null | undefined): string | null {
  if (!enc || enc.trim() === "") return null;
  try {
    return decryptRegistrySecret(enc);
  } catch {
    // 復号不能(鍵不一致/形式不正)→ null。呼び出し側で env フォールバックに委ねる。
    return null;
  }
}

function envOrNull(v: string | undefined): string | null {
  return v && v.trim() !== "" ? v : null;
}

/**
 * 謄本取得の資格情報を DB(復号)優先・env フォールバックで解決する(DB-over-env)。
 * - フェーズ2設定画面(/admin/registry-settings)で保存した暗号化資格情報を復号し、
 *   DB に値があれば優先、空なら env(REGISTRY_FETCH_*)にフォールバック。
 * - DB 障害・復号不能は throw せず env に委ねる(fail-safe = loadSaleDmConfig と同方針)。
 *   → capability を配る me/permissions が 500 化しない。
 * - server-side のみ(route から呼ぶ)。平文をログ・レスポンスに出さないこと。
 * - ⚠ 本関数は資格情報を「読める」ようにするだけ。実際の取得可否は getRegistryFetchProvider の
 *   readiness(browserFactory=セレクタ校正)に依存し、本番は未校正ゆえ 501 休眠のまま(挙動不変)。
 */
export async function loadRegistryFetchCredentials(): Promise<ResolvedRegistryCredentials> {
  let db:
    | { loginIdEnc: string | null; passwordEnc: string | null; baseUrl: string | null }
    | null = null;
  try {
    db = await prisma.registryFetchConfig.findUnique({
      where: { id: CONFIG_ID },
      select: { loginIdEnc: true, passwordEnc: true, baseUrl: true },
    });
  } catch {
    db = null;
  }
  return {
    loginId: decOrNull(db?.loginIdEnc) ?? envOrNull(process.env.REGISTRY_FETCH_LOGIN_ID),
    password: decOrNull(db?.passwordEnc) ?? envOrNull(process.env.REGISTRY_FETCH_PASSWORD),
    baseUrl: (db?.baseUrl?.trim() || null) ?? envOrNull(process.env.REGISTRY_FETCH_BASE_URL),
  };
}
