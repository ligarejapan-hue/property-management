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
import { MAIL_CONFIG_ID, isMailConfigComplete } from "@/lib/mail/mail-config";

// 設定は管理者(user_management:write)のみ。SMTPパスワードを含む高リスク設定のため admin 限定。
async function requireMailAdmin() {
  const session = await getApiSession();
  const perms = await getUserPermissions(session.id);
  if (!hasPermission(perms, "user_management", "write")) {
    throw new ApiError(403, "メール送信設定を変更する権限がありません(管理者のみ)", "FORBIDDEN");
  }
  return session;
}

const noStore = { headers: { "Cache-Control": "no-store" } };

// 社内から開くアプリの絶対URL(通知メールのリンク用)。http/javascript 等は拒否(https の絶対URLのみ)。空文字はクリア。
const httpsUrlOrEmpty = z
  .string()
  .trim()
  .max(2000)
  .refine(
    (u) => {
      if (u === "") return true;
      try {
        const x = new URL(u);
        return x.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "https の絶対URLを指定してください" },
  );

// 差出人アドレス。空文字はクリアとして許可する(未指定はキー自体を送らない=維持)。
const emailOrEmpty = z
  .string()
  .trim()
  .max(254)
  .refine((v) => v === "" || z.string().email().safeParse(v).success, {
    message: "メールアドレスの形式が正しくありません",
  });

const putSchema = z.object({
  smtpHost: z.string().trim().max(255).optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpSecure: z.boolean().optional(),
  smtpUser: z.string().trim().max(254).optional(),
  // 指定時は暗号化して保存・空文字は「クリア」・未指定(undefined)は現状維持(=画面には値を返さない)。
  smtpPassword: z.string().max(500).optional(),
  fromAddress: emailOrEmpty.optional(),
  appBaseUrl: httpsUrlOrEmpty.optional(),
  inquiryMailDetail: z.enum(["minimal", "full"]).optional(),
});

type MailConfigRow = {
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  smtpUser: string | null;
  smtpPassEnc: string | null;
  fromAddress: string | null;
  appBaseUrl: string | null;
  inquiryMailDetail: string;
} | null;

// 応答形式(GET/PUT共通)。パスワードそのものは絶対に返さず hasPassword(真偽値)だけ返す。
async function buildResponseData(row: MailConfigRow) {
  const notifyRecipientCount = await prisma.user.count({
    where: { isActive: true, inquiryNotifyEnabled: true },
  });
  return {
    smtpHost: row?.smtpHost ?? null,
    smtpPort: row?.smtpPort ?? null,
    smtpSecure: row?.smtpSecure ?? true,
    smtpUser: row?.smtpUser ?? null,
    hasPassword: !!row?.smtpPassEnc,
    fromAddress: row?.fromAddress ?? null,
    appBaseUrl: row?.appBaseUrl ?? null,
    inquiryMailDetail: row?.inquiryMailDetail === "full" ? "full" : "minimal",
    complete: isMailConfigComplete(row),
    cryptoConfigured: isSecretCryptoConfigured(),
    notifyRecipientCount,
  };
}

// GET: 設定状況(秘匿でないもの + パスワードは設定済/未設定のみ)。パスワード値は決して返さない。
export async function GET() {
  try {
    await requireMailAdmin();
    const row = await prisma.mailConfig.findUnique({ where: { id: MAIL_CONFIG_ID } });
    return NextResponse.json({ data: await buildResponseData(row) }, noStore);
  } catch (e) {
    return handleApiError(e);
  }
}

// PUT: 設定更新。非秘匿は平文、パスワードは暗号化して保存。未指定の項目は触らない(部分更新)。
export async function PUT(request: NextRequest) {
  try {
    const session = await requireMailAdmin();
    const body = putSchema.parse(await parseJsonBody(request));

    const norm = (v: string | undefined) => (v === undefined ? undefined : v.trim() === "" ? null : v.trim());

    const data: Prisma.MailConfigUncheckedCreateInput = {};
    // 監査の detail に残すのはフィールド「名」だけ(値は残さない=ホスト名・アドレス等も含めPIIになり得るため)。
    const fields: string[] = [];

    if (body.smtpHost !== undefined) { data.smtpHost = norm(body.smtpHost) ?? null; fields.push("smtpHost"); }
    if (body.smtpPort !== undefined) { data.smtpPort = body.smtpPort; fields.push("smtpPort"); }
    if (body.smtpSecure !== undefined) { data.smtpSecure = body.smtpSecure; fields.push("smtpSecure"); }
    if (body.smtpUser !== undefined) { data.smtpUser = norm(body.smtpUser) ?? null; fields.push("smtpUser"); }
    if (body.fromAddress !== undefined) { data.fromAddress = norm(body.fromAddress) ?? null; fields.push("fromAddress"); }
    if (body.appBaseUrl !== undefined) { data.appBaseUrl = norm(body.appBaseUrl) ?? null; fields.push("appBaseUrl"); }
    if (body.inquiryMailDetail !== undefined) { data.inquiryMailDetail = body.inquiryMailDetail; fields.push("inquiryMailDetail"); }

    // パスワード: 値があれば暗号化して保存(マスターキー必須)。空文字はクリア(null)。未指定は触らない。
    if (body.smtpPassword !== undefined) {
      fields.push("smtpPassword");
      if (body.smtpPassword.trim() === "") {
        data.smtpPassEnc = null;
      } else {
        if (!isSecretCryptoConfigured()) {
          throw new ApiError(
            422,
            "暗号化キー(SALE_DM_SETTINGS_ENC_KEY)が未設定です。パスワードを保存できません",
            "ENC_KEY_MISSING",
          );
        }
        data.smtpPassEnc = encryptSecret(body.smtpPassword);
      }
    }

    const row = await prisma.mailConfig.upsert({
      where: { id: MAIL_CONFIG_ID },
      create: { id: MAIL_CONFIG_ID, ...data, updatedById: session.id },
      update: { ...data, updatedById: session.id },
    });

    // 監査は非PIIメタのみ: 変更フィールド名。ホスト名・アドレス・パスワード値は残さない。
    await writeAuditLog({
      userId: session.id,
      action: "mail_settings_update",
      targetTable: "mail_config",
      detail: { fields },
    });

    return NextResponse.json({ data: await buildResponseData(row) }, noStore);
  } catch (e) {
    return handleApiError(e);
  }
}
