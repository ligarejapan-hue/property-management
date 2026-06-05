import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission, maskValue } from "@/lib/permissions";
import type { Prisma } from "@/generated/prisma";

// ---------- GET /api/owners/search?q=keyword ----------
// Lightweight search for linking import rows to existing owners.
//
// PII-S1a guard:
//  - 検索対象は「ユーザーが非マスクで閲覧できる項目」に限定する。masked/partial/
//    hidden の項目で contains 検索を許すと、ヒット有無から閲覧権限のない PII を
//    推測できる検索オラクルになるため where.OR から除外する。
//  - externalLinkKey は固有の権限項目を持たないため、全 owner 項目が非マスクの
//    ユーザー（=実質フル可視）にのみ検索・返却する。
//  - 応答値は display config に従ってマスクする（GET /api/owners と同方針）。
//  - AuditLog には検索語や PII を残さず、件数と検索可能フィールドの boolean のみ記録。

// 非マスク（=真値が見える）レベル。これらのみ検索オラクルにならず検索を許可する。
const UNMASKED_LEVELS = new Set(["full", "read", "edit"]);
const isUnmasked = (level: string): boolean => UNMASKED_LEVELS.has(level);

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
    if (q.length < 1) {
      return apiResponse({ data: [] });
    }

    const displayConfig = await getOwnerDisplayConfig(session.id, perms);

    // externalLinkKey は固有の権限を持たないため、全項目が非マスクの場合のみ
    // 検索・返却を許可する（部分権限ユーザーには出さない）。
    const allUnmasked = (
      [
        "name",
        "nameKana",
        "phone",
        "zip",
        "address",
        "note",
        "email",
        "corporateNumber",
      ] as const
    ).every((field) => isUnmasked(displayConfig[field]));

    // 検索可能フィールド = 非マスクで閲覧できる項目のみ（検索オラクル封じ）。
    const searchableFields = {
      name: isUnmasked(displayConfig.name),
      nameKana: isUnmasked(displayConfig.nameKana),
      phone: isUnmasked(displayConfig.phone),
      address: isUnmasked(displayConfig.address),
      externalLinkKey: allUnmasked,
    };

    const orClauses: Prisma.OwnerWhereInput[] = [];
    if (searchableFields.name)
      orClauses.push({ name: { contains: q, mode: "insensitive" } });
    if (searchableFields.nameKana)
      orClauses.push({ nameKana: { contains: q, mode: "insensitive" } });
    if (searchableFields.phone)
      orClauses.push({ phone: { contains: q, mode: "insensitive" } });
    if (searchableFields.address)
      orClauses.push({ address: { contains: q, mode: "insensitive" } });
    if (searchableFields.externalLinkKey)
      orClauses.push({ externalLinkKey: { contains: q, mode: "insensitive" } });

    // 検索可能フィールドが無ければ DB を引かず空配列（オラクル封じ・無駄クエリ回避）。
    if (orClauses.length === 0) {
      return apiResponse({ data: [] });
    }

    const owners = await prisma.owner.findMany({
      where: {
        isArchived: false,
        OR: orClauses,
      },
      select: {
        id: true,
        name: true,
        nameKana: true,
        phone: true,
        address: true,
        externalLinkKey: true,
      },
      take: 10,
      orderBy: { updatedAt: "desc" },
    });

    // 応答値も display config でマスク。externalLinkKey は全項目非マスク時のみ返す。
    const data = owners.map((owner) => ({
      id: owner.id,
      name: maskValue(owner.name, displayConfig.name),
      nameKana: maskValue(owner.nameKana, displayConfig.nameKana),
      phone: maskValue(owner.phone, displayConfig.phone),
      address: maskValue(owner.address, displayConfig.address),
      externalLinkKey: allUnmasked ? owner.externalLinkKey : null,
    }));

    // AuditLog: 検索語・PII は残さず、件数と検索可能フィールドの boolean のみ。
    await writeAuditLog({
      userId: session.id,
      action: "owner_search",
      targetTable: undefined,
      targetId: undefined,
      detail: { resultCount: owners.length, searchableFields },
    });

    return apiResponse({ data });
  } catch (error) {
    return handleApiError(error);
  }
}
