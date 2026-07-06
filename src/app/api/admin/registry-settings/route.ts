import { NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  apiResponse,
  handleApiError,
  parseJsonBody,
  ApiError,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import {
  isRegistrySecretCryptoConfigured,
  encryptRegistrySecret,
} from "@/lib/registry-fetch/secret-crypto";

// ============================================================
// GET/PUT /api/admin/registry-settings
// ============================================================
// 登記情報提供サービスの資格情報(利用者識別番号/パスワード/任意 baseUrl)を
// 管理者が保存する設定画面のバックエンド。
// - 認可 = user_management:write(APIキー同様の高リスク設定=管理者のみ。売却DM設定と同一)。
// - 資格情報は AES-256-GCM で暗号化して保存(平文列なし)。GET は「設定済/未設定」のみ返す。
// - 本フェーズは保存のみ(取得は起きない=provider 未配線)。フェーズ3で有効化。

const CONFIG_ID = "singleton";

async function requireAdmin() {
  const session = await getApiSession();
  const perms = await getUserPermissions(session.id);
  if (!hasPermission(perms, "user_management", "write")) {
    throw new ApiError(403, "資格情報を変更する権限がありません(管理者のみ)", "FORBIDDEN");
  }
  return session;
}

export async function GET() {
  try {
    await requireAdmin();
    const row = await prisma.registryFetchConfig.findUnique({ where: { id: CONFIG_ID } });
    return apiResponse({
      hasLoginId: !!row?.loginIdEnc,
      hasPassword: !!row?.passwordEnc,
      baseUrl: row?.baseUrl ?? null,
      encryptionConfigured: isRegistrySecretCryptoConfigured(),
      updatedAt: row?.updatedAt ?? null,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const putSchema = z.object({
  loginId: z.string().max(500).optional(),
  password: z.string().max(500).optional(),
  baseUrl: z.string().max(500).optional().nullable(),
});

export async function PUT(request: NextRequest) {
  try {
    const session = await requireAdmin();
    const body = putSchema.parse(await parseJsonBody(request));

    const data: Record<string, unknown> = {};
    const changed: string[] = [];
    // 秘匿値(loginId/password): 未指定=不変・空文字=クリア・値あり=暗号化保存。
    const applySecret = (
      raw: string | undefined,
      field: "loginIdEnc" | "passwordEnc",
      label: string,
    ) => {
      if (raw === undefined) return;
      if (raw.trim() === "") {
        data[field] = null;
        changed.push(`${label}(clear)`);
        return;
      }
      if (!isRegistrySecretCryptoConfigured()) {
        throw new ApiError(
          503,
          "暗号化キー(REGISTRY_SETTINGS_ENC_KEY)が未設定です。資格情報を保存できません",
          "ENCRYPTION_NOT_CONFIGURED",
        );
      }
      data[field] = encryptRegistrySecret(raw.trim());
      changed.push(label);
    };
    applySecret(body.loginId, "loginIdEnc", "loginId");
    applySecret(body.password, "passwordEnc", "password");
    if (body.baseUrl !== undefined) {
      data.baseUrl = body.baseUrl?.trim() || null;
      changed.push("baseUrl");
    }

    await prisma.registryFetchConfig.upsert({
      where: { id: CONFIG_ID },
      create: { id: CONFIG_ID, ...data, updatedById: session.id },
      update: { ...data, updatedById: session.id },
    });
    // 監査は変更フィールド名のみ(値=資格情報は絶対に出さない)。
    await writeAuditLog({
      userId: session.id,
      action: "update",
      targetTable: "registry_fetch_config",
      targetId: CONFIG_ID,
      detail: { changed },
    });
    return apiResponse({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
