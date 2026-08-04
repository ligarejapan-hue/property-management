import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
  handleApiError,
  apiResponse,
  ApiError,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { updatePropertySchema } from "@/lib/validators";
import {
  normalizeBuildingName,
  supportsBuildingName,
} from "@/lib/property-building-name";
import { applyDisplayToOwner } from "@/lib/display-level";
import { getStorage } from "@/lib/storage";
import { extractStorageKeyFromUrl } from "@/lib/storage/url-to-key";

// ---------- GET /api/properties/[id] ----------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件閲覧の権限がありません", "FORBIDDEN");
    }

    const property = await prisma.property.findUnique({
      where: { id },
      include: {
        assignee: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        // id/name に加えて、売マンション作成ダイアログの自動反映プレビュー
        // （構造/地上階/総戸数/管理会社/築年）が読む列を追加する（@codex P2 fix）。
        // 図面自体は new/route.ts が building から直接同じ列を fetch して生成しており
        // 内容は変わらない＝ここは「ダイアログのプレビューが見えるようにする」ための
        // 追加のみ（既存の id/name 消費者に対しては後方互換）。
        building: {
          select: {
            id: true,
            name: true,
            structureType: true,
            totalFloors: true,
            totalUnits: true,
            managementCompany: true,
            builtYear: true,
          },
        },
        propertyOwners: {
          include: {
            owner: {
              select: {
                id: true,
                name: true,
                nameKana: true,
                phone: true,
                zip: true,
                address: true,
                note: true,
                email: true,
                corporateNumber: true,
                companyRegistryNumber: true,
                version: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        photos: {
          where: { propertyId: id },
          orderBy: { sortOrder: "asc" },
        },
        nextActions: {
          where: { isCompleted: false },
          include: {
            assignee: { select: { id: true, name: true } },
          },
          orderBy: { scheduledAt: "asc" },
          take: 5,
        },
      },
    });

    if (!property) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }

    // field_staff can only see their own assigned/created properties
    if (
      session.role === "field_staff" &&
      property.createdBy !== session.id &&
      property.assignedTo !== session.id
    ) {
      throw new ApiError(403, "この物件を閲覧する権限がありません", "FORBIDDEN");
    }

    await writeAuditLog({
      userId: session.id,
      action: "property_view",
      targetTable: "properties",
      targetId: property.id,
    });

    // 最初の取込行を取得して取込元情報を付与する
    const importRow = await prisma.importJobRow.findFirst({
      where: { createdId: id, status: "success" },
      select: {
        rowNumber: true,
        rawData: true,
        job: { select: { fileName: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    const importSource = importRow
      ? ((importRow.rawData as Record<string, string>)?.__sourceRef ??
          `${importRow.job.fileName}:${importRow.rowNumber}行`)
      : null;

    // owner:read がない場合は owner PII を返さない。
    // owner_email:full など field-level 権限が残っていても owner:read denied が優先する。
    // owner:read がある場合のみ getOwnerDisplayConfig で field-level マスキングを適用する。
    const canReadOwner = hasPermission(permissions, "owner", "read");
    const ownerDisplayConfig = canReadOwner ? await getOwnerDisplayConfig(session.id, permissions) : null;
    const maskedPropertyOwners = property.propertyOwners.map((po) => ({
      ...po,
      owner: canReadOwner && ownerDisplayConfig
        ? applyDisplayToOwner(po.owner, ownerDisplayConfig)
        : { id: po.owner.id },
    }));

    return apiResponse({ ...property, propertyOwners: maskedPropertyOwners, importSource });
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- PATCH /api/properties/[id] ----------

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "物件編集の権限がありません", "FORBIDDEN");
    }

    const body = await request.json();
    const data = updatePropertySchema.parse(body);
    const { version, ...updateFields } = data;

    // Optimistic locking: only update if version matches
    const current = await prisma.property.findUnique({
      where: { id },
      select: {
        id: true,
        version: true,
        createdBy: true,
        assignedTo: true,
        propertyType: true,
        address: true,
        postalCode: true,
        lotNumber: true,
        buildingNumber: true,
        // ⚠変更履歴の「変更前」に使う。選ばないと、物件名を書き換えても
        // 履歴が「空 → 〇〇」になり、元の名前が残らない (@codex #354 P2)。
        buildingName: true,
        realEstateNumber: true,
        registryStatus: true,
        dmStatus: true,
        caseStatus: true,
        introductionRoute: true,
        gpsLat: true,
        gpsLng: true,
        zoningDistrict: true,
        buildingCoverageRatio: true,
        floorAreaRatio: true,
        heightDistrict: true,
        firePreventionZone: true,
        scenicRestriction: true,
        roadType: true,
        roadWidth: true,
        frontageWidth: true,
        frontageDirection: true,
        setbackRequired: true,
        rosenkaValue: true,
        rosenkaYear: true,
        rebuildPermission: true,
        architectureNote: true,
        note: true,
      },
    });

    if (!current) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }

    if (current.version !== version) {
      throw new ApiError(
        409,
        "他のユーザーが先に更新しています。画面を再読み込みしてください。",
        "VERSION_CONFLICT",
      );
    }

    // field_staff scope check
    if (
      session.role === "field_staff" &&
      current.createdBy !== session.id &&
      current.assignedTo !== session.id
    ) {
      throw new ApiError(403, "この物件を編集する権限がありません", "FORBIDDEN");
    }

    // 物件名は「更新後の種別」で判定する。
    // ⚠**種別だけを対象外へ変えた更新**(buildingName を送ってこない)でも、
    // 残っている物件名を消す。消さないと画面から入力欄が消えたのに値だけ DB に
    // 残り、誰も直せないまま CSV 出力や DM 差込で表に出る。
    const effectiveType = updateFields.propertyType ?? current.propertyType;
    const buildingNamePatch: { buildingName?: string | null } =
      updateFields.buildingName !== undefined
        ? {
            buildingName: normalizeBuildingName(
              effectiveType,
              updateFields.buildingName,
            ),
          }
        : updateFields.propertyType !== undefined &&
            !supportsBuildingName(effectiveType)
          ? { buildingName: null }
          : {};

    // ⚠**実際に保存する値**で履歴を作る (@codex #354 P2)。updateFields だけで
    // 作ると次の3つが履歴に残らない/嘘になる:
    //   - 種別だけ変えて物件名が消えたとき → 消えた事実が記録されない
    //   - 物件名を書き換えたとき → 変更前が常に「空」になる (上の select で是正)
    //   - 正規化(空白除去・上限切り詰め・対象外なら null)後の値でなく生の入力が残る
    const persistedFields = { ...updateFields, ...buildingNamePatch };

    // Build change log entries
    const changeLogs: Array<{
      targetTable: string;
      targetId: string;
      fieldName: string;
      oldValue: string | null;
      newValue: string | null;
      source: "manual";
      changedBy: string;
    }> = [];

    for (const [key, newVal] of Object.entries(persistedFields)) {
      if (newVal === undefined) continue;
      const oldVal = (current as Record<string, unknown>)[key];
      const oldStr = oldVal != null ? String(oldVal) : null;
      const newStr = newVal != null ? String(newVal) : null;
      if (oldStr !== newStr) {
        changeLogs.push({
          targetTable: "properties",
          targetId: id,
          fieldName: key,
          oldValue: oldStr,
          newValue: newStr,
          source: "manual",
          changedBy: session.id,
        });
      }
    }

    // Update property with version increment
    // ⚠保存する値は履歴と同じ persistedFields を使う (二重に組み立てない)。
    const updated = await prisma.property.update({
      where: { id },
      data: {
        ...persistedFields,
        version: { increment: 1 },
      },
      include: {
        assignee: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        propertyOwners: {
          include: {
            owner: {
              select: {
                id: true,
                name: true,
                nameKana: true,
                phone: true,
                zip: true,
                address: true,
                note: true,
                email: true,
                corporateNumber: true,
                companyRegistryNumber: true,
                version: true,
              },
            },
          },
        },
        photos: { orderBy: { sortOrder: "asc" } },
        nextActions: {
          where: { isCompleted: false },
          include: { assignee: { select: { id: true, name: true } } },
          orderBy: { scheduledAt: "asc" },
          take: 5,
        },
      },
    });

    // Write change logs
    if (changeLogs.length > 0) {
      await prisma.changeLog.createMany({ data: changeLogs });
    }

    // Write audit log
    await writeAuditLog({
      userId: session.id,
      action: "update",
      targetTable: "properties",
      targetId: id,
      detail: { updatedFields: changeLogs.map((c) => c.fieldName) },
    });

    // owner:read gate — GET と同方針（owner:read なしでは owner PII を返さない）
    const canReadOwner = hasPermission(permissions, "owner", "read");
    const ownerDisplayConfig = canReadOwner ? await getOwnerDisplayConfig(session.id, permissions) : null;
    const maskedUpdatedPropertyOwners = updated.propertyOwners.map((po) => ({
      ...po,
      owner: canReadOwner && ownerDisplayConfig
        ? applyDisplayToOwner(po.owner, ownerDisplayConfig)
        : { id: po.owner.id },
    }));

    return apiResponse({ ...updated, propertyOwners: maskedUpdatedPropertyOwners });
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- DELETE /api/properties/[id] ----------
// 物件を物理削除する。子レコード（PropertyOwner / PropertyPhoto / Comment 等）は
// schema 側の onDelete: Cascade により自動で消える。ChangeLog / AuditLog は
// targetTable+targetId の弱参照なのでそのまま残る（監査履歴を保持するため）。

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    // 物理削除 + cascade は取り消せないため write ではなく delete を要求する。
    // 権限テンプレートの「削除」トグル (admin/users/[id]/permissions) を実効化する。
    if (!hasPermission(permissions, "property", "delete")) {
      throw new ApiError(403, "物件削除の権限がありません", "FORBIDDEN");
    }

    const property = await prisma.property.findUnique({
      where: { id },
      select: { id: true, address: true, createdBy: true, assignedTo: true },
    });

    if (!property) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }

    if (
      session.role === "field_staff" &&
      property.createdBy !== session.id &&
      property.assignedTo !== session.id
    ) {
      throw new ApiError(403, "この物件を削除する権限がありません", "FORBIDDEN");
    }

    // 子 PropertyPhoto は schema 側 onDelete: Cascade で消えるため、
    // cascade 前に fileUrl を捕捉しないと storage 側だけ orphan になる。
    // 取得と Property 削除は同一 transaction で atomic に行う。
    const photoFileUrls: string[] = [];
    await prisma.$transaction(async (tx) => {
      const photos = await tx.propertyPhoto.findMany({
        where: { propertyId: id },
        select: { fileUrl: true },
      });
      for (const p of photos) {
        if (typeof p.fileUrl === "string" && p.fileUrl.length > 0) {
          photoFileUrls.push(p.fileUrl);
        }
      }
      // 添付(Attachment)は FK が SET NULL のため cascade で消えず、そのままだと
      // isDeleted=false の孤児になる。孤児は日次お掃除(isDeleted=true のみ対象)にも
      // 手動ゴミ箱投入(property relation が null だと 403)にも乗らず、DB 行と
      // storage 実体(謄本PDF=PII を含む)が永久に残る。同一 tx でゴミ箱入りさせ、
      // 既存の 90 日 purge ライフサイクルに乗せる。ここで即時 storage.delete
      // しないのは、fileUrl の key が共有され得るため参照チェック持ちの purge job
      // に委ねる既存の層分け(attachment-cleanup.ts)に従うもの。
      // ⚠isDeleted:false ガード=ゴミ箱済み行の 90 日時計をリセットしない。
      //   propertyId(SET NULL 前なので当たる)と弱参照 targetId の OR で冪等に拾う。
      await tx.attachment.updateMany({
        where: {
          OR: [{ propertyId: id }, { targetType: "property", targetId: id }],
          isDeleted: false,
        },
        data: { isDeleted: true, deletedAt: new Date() },
      });
      await tx.property.delete({ where: { id } });
    });

    // best-effort: transaction 外で実体ファイル削除。失敗は orphan を残すだけで
    // 既存成功レスポンスは維持する（DB が source of truth）。
    let storageDeleteAttempted = 0;
    let storageDeleteFailed = 0;
    for (const fileUrl of photoFileUrls) {
      const key = extractStorageKeyFromUrl(fileUrl);
      if (key == null) continue;
      storageDeleteAttempted++;
      try {
        await getStorage().delete(key);
      } catch (err) {
        storageDeleteFailed++;
        console.error("[property_delete] photo storage.delete failed", {
          route: "DELETE /api/properties/[id]",
          propertyId: id,
          errorName: err instanceof Error ? err.name : "Unknown",
        });
      }
    }
    if (storageDeleteFailed > 0) {
      console.error("[property_delete] photo storage cleanup partial failure", {
        route: "DELETE /api/properties/[id]",
        propertyId: id,
        attempted: storageDeleteAttempted,
        failed: storageDeleteFailed,
      });
    }

    await writeAuditLog({
      userId: session.id,
      action: "delete",
      targetTable: "properties",
      targetId: id,
      detail: { address: property.address },
    });

    return apiResponse({ id, deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
