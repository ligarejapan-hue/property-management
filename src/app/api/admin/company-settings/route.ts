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
import { resolveCompanyProfile } from "@/lib/sales-sheet/company-profile-store";

const COMPANY_PROFILE_ID = "singleton";

// 会社情報(会社帯)の設定は管理者(user_management:write)のみ編集可。
async function requireCompanyAdmin() {
  const session = await getApiSession();
  const perms = await getUserPermissions(session.id);
  if (!hasPermission(perms, "user_management", "write")) {
    throw new ApiError(403, "会社情報を変更する権限がありません(管理者のみ)", "FORBIDDEN");
  }
  return session;
}

const noStore = { headers: { "Cache-Control": "no-store" } };

// 会社情報 7項目。全て非秘匿・平文。空文字=クリア(→既定 COMPANY_INFO へフォールバック)、
// 未指定(undefined)=触らない(部分更新)。
const putSchema = z.object({
  nameJa: z.string().trim().max(200).optional(),
  license: z.string().trim().max(200).optional(),
  tel: z.string().trim().max(50).optional(),
  fax: z.string().trim().max(50).optional(),
  email: z.string().trim().max(200).optional(),
  hp: z.string().trim().max(2000).optional(),
  address: z.string().trim().max(300).optional(),
});

// GET: 現在の会社情報(DB→既定フォールバックで解決した実効値) + updatedAt。非秘匿ゆえ実値を返す。
export async function GET() {
  try {
    await requireCompanyAdmin();
    const row = await prisma.companyProfile.findUnique({ where: { id: COMPANY_PROFILE_ID } });
    const p = resolveCompanyProfile(row);
    return NextResponse.json({ data: { ...p, updatedAt: row?.updatedAt ?? null } }, noStore);
  } catch (e) {
    return handleApiError(e);
  }
}

// PUT: 部分更新。空文字→null(=既定へフォールバック)、未指定は触らない。
export async function PUT(request: NextRequest) {
  try {
    const session = await requireCompanyAdmin();
    const body = putSchema.parse(await parseJsonBody(request));

    // 指定された項目のみ設定(空文字→null=クリア)。create/update 両用の直値のみ。
    const data: Prisma.CompanyProfileUncheckedCreateInput = {};
    const changed: string[] = [];
    if (body.nameJa !== undefined) { data.nameJa = body.nameJa === "" ? null : body.nameJa; changed.push("nameJa"); }
    if (body.license !== undefined) { data.license = body.license === "" ? null : body.license; changed.push("license"); }
    if (body.tel !== undefined) { data.tel = body.tel === "" ? null : body.tel; changed.push("tel"); }
    if (body.fax !== undefined) { data.fax = body.fax === "" ? null : body.fax; changed.push("fax"); }
    if (body.email !== undefined) { data.email = body.email === "" ? null : body.email; changed.push("email"); }
    if (body.hp !== undefined) { data.hp = body.hp === "" ? null : body.hp; changed.push("hp"); }
    if (body.address !== undefined) { data.address = body.address === "" ? null : body.address; changed.push("address"); }

    const row = await prisma.companyProfile.upsert({
      where: { id: COMPANY_PROFILE_ID },
      create: { id: COMPANY_PROFILE_ID, ...data, updatedById: session.id },
      update: { ...data, updatedById: session.id },
    });

    // 監査は非PIIメタのみ: 変更フィールド名(値ではない)・対象識別子・更新時刻。会社情報の値は残さない。
    // targetId は UUID 列(@db.Uuid)。singleton は UUID でないため付けない(付けると Postgres が
    // 弾き writeAuditLog が握って設定変更の監査が無記録になる)。対象は targetTable + detail.target で表す。
    await writeAuditLog({
      userId: session.id,
      action: "company_profile_update",
      targetTable: "company_profile",
      detail: { target: COMPANY_PROFILE_ID, fields: changed, updatedAt: new Date().toISOString() },
    });

    const p = resolveCompanyProfile(row);
    return NextResponse.json({ data: { ...p, updatedAt: row.updatedAt } }, noStore);
  } catch (e) {
    return handleApiError(e);
  }
}
