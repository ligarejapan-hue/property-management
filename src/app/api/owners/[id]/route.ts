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
import { recordChanges, OWNER_TRACKED_FIELDS } from "@/lib/change-log";
import { updateOwnerSchema } from "@/lib/validators";
import { resolveCurrentAddressWrite } from "@/lib/owner-current-address-write";
import { hasPermission, hasExplicitWritePerm } from "@/lib/permissions";
import { applyDisplayToOwner } from "@/lib/display-level";
import { canAccessPropertyRecord } from "@/lib/property-access";

/**
 * 所有者に紐づく物件を、物件一覧/詳細と同じ record スコープに絞る。
 *
 * GET と PATCH の両方の応答で使う。片方だけに適用すると、更新レスポンス経由で
 * 担当外物件の住所 (PII) が漏れる（src/lib/property-access.ts の規約）。
 * 判定に使う createdBy/assignedTo は応答に載せない。
 */
function scopeOwnerProperties<
  T extends {
    propertyOwners: Array<{
      property: {
        id: string;
        address: string;
        propertyType: string;
        caseStatus: string;
        createdBy: string;
        assignedTo: string | null;
      };
    }>;
  },
>(session: { id: string; role: string }, owner: T) {
  return {
    ...owner,
    propertyOwners: owner.propertyOwners
      .filter((po) => canAccessPropertyRecord(session, po.property))
      .map((po) => ({
        ...po,
        property: {
          id: po.property.id,
          address: po.property.address,
          propertyType: po.property.propertyType,
          caseStatus: po.property.caseStatus,
        },
      })),
  };
}

/** GET/PATCH で共有する propertyOwners の include（スコープ判定列を含む）。 */
const OWNER_PROPERTIES_INCLUDE = {
  propertyOwners: {
    include: {
      property: {
        // createdBy/assignedTo は担当スコープ判定用（応答には載せない）。
        select: {
          id: true,
          address: true,
          propertyType: true,
          caseStatus: true,
          createdBy: true,
          assignedTo: true,
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// GET /api/owners/:id
// ---------------------------------------------------------------------------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const owner = await prisma.owner.findUnique({
      where: { id },
      include: OWNER_PROPERTIES_INCLUDE,
    });

    if (!owner) {
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }

    const scopedOwner = scopeOwnerProperties(session, owner);

    const displayConfig = await getOwnerDisplayConfig(session.id, perms);
    const filtered = applyDisplayToOwner(scopedOwner, displayConfig);

    await writeAuditLog({
      userId: session.id,
      action: "owner_view",
      targetTable: "owners",
      targetId: id,
    });

    return apiResponse(filtered);
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/owners/:id
// ---------------------------------------------------------------------------

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "owner", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const body = await request.json();
    const { version, ...parsedFields } = updateOwnerSchema.parse(body);

    // ⚠現住所は「住所と郵便番号を必ずペアで扱う」規則を先に通す（設計 §6.1）。
    //  - 住所だけ来たら郵便番号を null にする（古い番号を残すと、新しい住所に古い番号を刷る）
    //  - 郵便番号だけの更新は 400 で拒否する（対になる住所が無い）
    const pair = resolveCurrentAddressWrite(parsedFields);
    if (!pair.ok) {
      throw new ApiError(
        400,
        "現住所の郵便番号だけを更新することはできません（住所と一緒に指定してください）",
        "CURRENT_ZIP_WITHOUT_ADDRESS",
      );
    }
    const updateFields = { ...parsedFields, ...pair.fields };

    // Field-level write permission check: 各フィールドごとに明示的な full/edit 権限を要求する。
    // getOwnerDisplayConfig の owner_email fallback（表示用）は使わない。
    // 拒否時は recordChanges / writeAuditLog に到達しないため生値はログに残らない。
    const fieldWriteChecks: Array<{ requestKey: string; resource: string }> = [
      { requestKey: "name", resource: "owner_name" },
      { requestKey: "nameKana", resource: "owner_name_kana" },
      { requestKey: "phone", resource: "owner_phone" },
      { requestKey: "zip", resource: "owner_zip" },
      { requestKey: "address", resource: "owner_address" },
      // ⚠現住所は登記上の住所と同じ機微度＝同じ field-level 権限で扱う。
      { requestKey: "currentZip", resource: "owner_zip" },
      { requestKey: "currentAddress", resource: "owner_address" },
      { requestKey: "email", resource: "owner_email" },
      { requestKey: "note", resource: "owner_note" },
      { requestKey: "corporateNumber", resource: "owner_corporate_number" },
      // 会社法人等番号(12桁)は法人番号(13桁)と同じ field-level 権限で扱う。
      { requestKey: "companyRegistryNumber", resource: "owner_corporate_number" },
    ];
    for (const { requestKey, resource } of fieldWriteChecks) {
      if (requestKey in updateFields && !hasExplicitWritePerm(perms, resource)) {
        throw new ApiError(403, `${requestKey} を更新する権限がありません`, "FORBIDDEN");
      }
    }

    // ⚠「住所だけ送られたので郵便番号を空にする」も**郵便番号への書き込み**なので、
    //  owner_zip の書込権限を要求する（設計 §6.1.1）。権限が無いときにクリアだけ省略すると、
    //  住所が変わって古い郵便番号が残る＝この規則が防ぎたい状態そのものになるため、
    //  **住所の更新ごと 403 で拒否する**。
    if (pair.impliesZipWrite && !hasExplicitWritePerm(perms, "owner_zip")) {
      throw new ApiError(
        403,
        "現住所を変更すると郵便番号を空にする必要があるため、郵便番号の編集権限が必要です",
        "FORBIDDEN",
      );
    }

    // Get current owner for change tracking
    const currentOwner = await prisma.owner.findUnique({ where: { id } });
    if (!currentOwner) {
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }

    // Optimistic lock update
    const result = await prisma.owner.updateMany({
      where: { id, version },
      data: {
        ...updateFields,
        version: { increment: 1 },
      },
    });

    if (result.count === 0) {
      throw new ApiError(409, "他のユーザーが先に更新しました", "CONFLICT");
    }

    // Record change logs
    await recordChanges({
      targetTable: "owners",
      targetId: id,
      changedBy: session.id,
      oldValues: currentOwner as unknown as Record<string, unknown>,
      newValues: updateFields as Record<string, unknown>,
      trackedFields: OWNER_TRACKED_FIELDS,
    });

    await writeAuditLog({
      userId: session.id,
      action: "update",
      targetTable: "owners",
      targetId: id,
      detail: { updatedFields: Object.keys(updateFields) },
    });

    // Fetch updated owner
    const updatedOwner = await prisma.owner.findUniqueOrThrow({
      where: { id },
      include: OWNER_PROPERTIES_INCLUDE,
    });

    // Response owner:read gate:
    // owner:write はあるが owner:read がない構成では、更新自体は許可するが、
    // レスポンスから PII を返さない（/api/properties/[id] と同方針）。
    // owner_email:full 等の field-level 権限が残っていても owner:read denied が優先する。
    if (!hasPermission(perms, "owner", "read")) {
      return apiResponse({ id: updatedOwner.id });
    }

    // displayConfig は表示用。owner_email fallback を含む（書込判定には使っていない）。
    const displayConfig = await getOwnerDisplayConfig(session.id, perms);
    // GET と同じ record スコープを更新レスポンスにも適用する
    // （片方だけだと PATCH 経由で担当外物件の住所が漏れる）。
    const filtered = applyDisplayToOwner(
      scopeOwnerProperties(session, updatedOwner),
      displayConfig,
    );

    return apiResponse(filtered);
  } catch (error) {
    return handleApiError(error);
  }
}
