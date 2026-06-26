import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { createAndLinkOwnerSchema } from "@/lib/validators";
import { hasPermission } from "@/lib/permissions";
import {
  findMissingOwnerFieldWritePerm,
  findDuplicateOwnerId,
} from "@/lib/owner-create";

// ---------- POST /api/properties/[id]/owners/create-and-link ----------
// Codex P1 対応: 新規所有者の作成と物件への紐付けを 1 つの DB transaction で atomic に行う。
// フロントの createOwner → linkOwnerToProperty 逐次実行（link 失敗で orphan owner が残る）を置き換える。
// 権限・validation・重複判定は既存 /api/owners POST と /api/properties/[id]/owners POST を踏襲
// （owner-create.ts の純関数を共有して「同等」を担保）。

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: propertyId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    // owner:write は作成・紐付け双方の前提（/api/owners POST・/api/properties/[id]/owners POST と同一）。
    if (!hasPermission(perms, "owner", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const body = await request.json();
    const { relationship, isPrimary, ...ownerData } =
      createAndLinkOwnerSchema.parse(body);

    // field-level write 権限チェック（/api/owners POST と同方針・owner-create で共有）。
    // 拒否は DB アクセス・AuditLog 生成の前なので生値はログに残らない。
    const missing = findMissingOwnerFieldWritePerm(perms, ownerData);
    if (missing) {
      throw new ApiError(
        403,
        `${missing.label} を書き込む権限がありません`,
        "FORBIDDEN",
      );
    }

    // 物件存在確認（transaction の前）。
    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true },
    });
    if (!property) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }

    // 重複判定（/api/owners POST と同等・address がある時のみ）。transaction の前。
    if (ownerData.address) {
      const candidates = await prisma.owner.findMany({
        where: { address: { not: null }, isArchived: false },
        select: { id: true, name: true, address: true },
      });
      const dupId = findDuplicateOwnerId(ownerData, candidates);
      if (dupId) {
        throw new ApiError(
          409,
          `同じ氏名・住所の所有者が既に存在します (ID: ${dupId})`,
          "DUPLICATE_OWNER",
        );
      }
    }

    // owner 作成 + PropertyOwner link 作成を atomic に。
    // どちらかが失敗すれば transaction 全体が rollback され、owner だけが残る orphan を防ぐ。
    const { owner, propertyOwner } = await prisma.$transaction(async (tx) => {
      const owner = await tx.owner.create({
        data: {
          name: ownerData.name,
          nameKana: ownerData.nameKana,
          phone: ownerData.phone,
          zip: ownerData.zip,
          address: ownerData.address,
          note: ownerData.note,
          email: ownerData.email,
          externalLinkKey: ownerData.externalLinkKey,
          // corporateNumber は createOwnerSchema で 13桁正規化済 or null（生値はログに残さない）。
          corporateNumber: ownerData.corporateNumber ?? null,
          // companyRegistryNumber(12桁) も /api/owners POST と同様に保存する（取りこぼし防止）。
          companyRegistryNumber: ownerData.companyRegistryNumber ?? null,
        },
      });
      // isPrimary なら既存の主所有者を解除してから link（/api/properties/[id]/owners POST と同方針）。
      if (isPrimary) {
        await tx.propertyOwner.updateMany({
          where: { propertyId, isPrimary: true },
          data: { isPrimary: false },
        });
      }
      const propertyOwner = await tx.propertyOwner.create({
        data: {
          propertyId,
          ownerId: owner.id,
          relationship: relationship ?? null,
          isPrimary,
        },
      });
      return { owner, propertyOwner };
    });

    // AuditLog: 生の owner PII（氏名 / 住所 / 電話 / email / 法人番号 等）は detail に含めない。
    // owner field display 権限を持たない監査ログ閲覧者にも detail は見えるため、非PII の
    // 識別子・件数・状態のみ記録する（owner / PropertyOwner は targetId の UUID で一意特定できる）。
    const ownerFieldCount = Object.values(ownerData).filter(
      (v) => v != null,
    ).length;
    await writeAuditLog({
      userId: session.id,
      action: "create",
      targetTable: "owners",
      targetId: owner.id,
      detail: {
        createdOwner: true,
        linkedProperty: true,
        propertyId,
        source: "property_detail_create_and_link",
        fieldCount: ownerFieldCount,
      },
    });
    await writeAuditLog({
      userId: session.id,
      action: "create",
      targetTable: "property_owners",
      targetId: propertyOwner.id,
      detail: {
        propertyId,
        ownerId: owner.id,
        source: "property_detail_create_and_link",
      },
    });

    return apiResponse({ owner, propertyOwner }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
