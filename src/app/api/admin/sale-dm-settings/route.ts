import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  parseJsonBody,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { encryptSecret, isSecretCryptoConfigured } from "@/lib/sale-dm-letter/secret-crypto";
import { SALE_DM_CONFIG_ID } from "@/lib/sale-dm-letter/config-store";

// 設定は管理者(user_management:write)のみ。APIキー(課金)を含む高リスク設定のため admin 限定。
async function requireSaleDmAdmin() {
  const session = await getApiSession();
  const perms = await getUserPermissions(session.id);
  if (!hasPermission(perms, "user_management", "write")) {
    throw new ApiError(403, "売却DM設定を変更する権限がありません(管理者のみ)", "FORBIDDEN");
  }
  return session;
}

const noStore = { headers: { "Cache-Control": "no-store" } };

// 絶対 http(s) URL or 空文字(=クリア)。相対/非httpは弾く(郵送QRの遷移先に使えないため)。
const absUrlOrEmpty = z
  .string()
  .trim()
  .max(2000)
  .refine(
    (u) => {
      if (u === "") return true;
      try {
        const x = new URL(u);
        return x.protocol === "http:" || x.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "http(s) の絶対URLを指定してください" },
  );

const putSchema = z.object({
  // off=明示的な停止(env/useMockより優先で確実に止める)。null/未指定=サーバー既定(env)にフォールバック。
  provider: z.enum(["claude", "openai", "mock", "off"]).nullable().optional(),
  model: z.string().trim().max(100).optional(),
  trackingBaseUrl: absUrlOrEmpty.optional(),
  lpUrl: absUrlOrEmpty.optional(),
  senderName: z.string().trim().max(100).optional(),
  senderContact: z.string().trim().max(200).optional(),
  // APIキー: 指定時は暗号化して保存・空文字は「クリア」・未指定(undefined)は現状維持(=画面では値を返さない)。
  anthropicApiKey: z.string().trim().max(500).optional(),
  openaiApiKey: z.string().trim().max(500).optional(),
});

// GET: 設定状況(秘匿でない値 + キーは設定済/未設定のみ)。APIキー値は決して返さない。
export async function GET() {
  try {
    await requireSaleDmAdmin();
    const row = await prisma.saleDmConfig.findUnique({ where: { id: SALE_DM_CONFIG_ID } });
    return NextResponse.json(
      {
        data: {
          provider: row?.provider ?? null,
          model: row?.model ?? null,
          trackingBaseUrl: row?.trackingBaseUrl ?? null,
          lpUrl: row?.lpUrl ?? null,
          senderName: row?.senderName ?? null,
          senderContact: row?.senderContact ?? null,
          // 値は返さず「設定済/未設定」だけ返す(キーを画面・レスポンスに出さない)。
          hasAnthropicKey: !!row?.anthropicApiKeyEnc,
          hasOpenaiKey: !!row?.openaiApiKeyEnc,
          // マスターキー(SALE_DM_SETTINGS_ENC_KEY)が設定済みか。未設定だと APIキーを保存できない。
          encryptionConfigured: isSecretCryptoConfigured(),
          updatedAt: row?.updatedAt ?? null,
        },
      },
      noStore,
    );
  } catch (e) {
    return handleApiError(e);
  }
}

// PUT: 設定更新。非秘匿は平文、APIキーは暗号化して保存。未指定の項目は触らない(部分更新)。
export async function PUT(request: NextRequest) {
  try {
    const session = await requireSaleDmAdmin();
    const body = putSchema.parse(await parseJsonBody(request));

    const norm = (v: string | undefined) => (v === undefined ? undefined : v.trim() === "" ? null : v.trim());

    // 非秘匿項目: 指定時のみ設定(空文字→null=クリア)。create にも update にも使える形(直値のみ)。
    const data: Prisma.SaleDmConfigUncheckedCreateInput = {};
    const changed: string[] = [];
    if (body.provider !== undefined) { data.provider = body.provider; changed.push("provider"); }
    if (body.model !== undefined) { data.model = norm(body.model) ?? null; changed.push("model"); }
    if (body.trackingBaseUrl !== undefined) { data.trackingBaseUrl = norm(body.trackingBaseUrl) ?? null; changed.push("trackingBaseUrl"); }
    if (body.lpUrl !== undefined) { data.lpUrl = norm(body.lpUrl) ?? null; changed.push("lpUrl"); }
    if (body.senderName !== undefined) { data.senderName = norm(body.senderName) ?? null; changed.push("senderName"); }
    if (body.senderContact !== undefined) { data.senderContact = norm(body.senderContact) ?? null; changed.push("senderContact"); }

    // APIキー: 値があれば暗号化して保存(マスターキー必須)。空文字はクリア(null)。未指定は触らない。
    const applyKey = (raw: string | undefined, field: "anthropicApiKeyEnc" | "openaiApiKeyEnc", label: string) => {
      if (raw === undefined) return;
      if (raw.trim() === "") { data[field] = null; changed.push(`${label}(clear)`); return; }
      if (!isSecretCryptoConfigured()) {
        throw new ApiError(503, "暗号化キー(SALE_DM_SETTINGS_ENC_KEY)が未設定です。APIキーを保存できません", "ENCRYPTION_NOT_CONFIGURED");
      }
      data[field] = encryptSecret(raw.trim());
      changed.push(label);
    };
    applyKey(body.anthropicApiKey, "anthropicApiKeyEnc", "anthropicApiKey");
    applyKey(body.openaiApiKey, "openaiApiKeyEnc", "openaiApiKey");

    const row = await prisma.saleDmConfig.upsert({
      where: { id: SALE_DM_CONFIG_ID },
      create: { id: SALE_DM_CONFIG_ID, ...data, updatedById: session.id },
      update: { ...data, updatedById: session.id },
    });

    // 監査は非PIIメタのみ: 変更フィールド名・provider・更新時刻。キー値・URL値・差出人値は残さない。
    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_settings_update",
      targetTable: "sale_dm_config",
      targetId: SALE_DM_CONFIG_ID,
      detail: { fields: changed, provider: row.provider, updatedAt: new Date().toISOString() },
    });

    // 応答も GET と同じく秘匿値は返さない(設定済/未設定のみ)。
    return NextResponse.json(
      {
        data: {
          provider: row.provider, model: row.model, trackingBaseUrl: row.trackingBaseUrl,
          lpUrl: row.lpUrl, senderName: row.senderName, senderContact: row.senderContact,
          hasAnthropicKey: !!row.anthropicApiKeyEnc, hasOpenaiKey: !!row.openaiApiKeyEnc,
          encryptionConfigured: isSecretCryptoConfigured(), updatedAt: row.updatedAt,
        },
      },
      noStore,
    );
  } catch (e) {
    return handleApiError(e);
  }
}
