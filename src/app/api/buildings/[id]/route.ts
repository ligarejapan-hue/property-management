import { NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { buildingIdentityKeys } from "@/lib/building-link/apply";
import { recordChanges, BUILDING_TRACKED_FIELDS } from "@/lib/change-log";
import { isPropertyScopedRole } from "@/lib/property-access";
import { lockBuildingRowNoKeyUpdate } from "@/lib/edit-lock/row-locks";
import {
  isBuildingRename,
  countEditLockedUnits,
  propagateBuildingName,
  lockBuildingUnits,
  unitsOutsideScope,
} from "@/lib/building-link/rename";

const updateBuildingSchema = z.object({
  name: z.string().min(1, "棟名は必須です").optional(),
  address: z.string().min(1, "住所は必須です").optional(),
  postalCode: z.string().nullable().optional(),
  lotNumber: z.string().nullable().optional(),
  realEstateNumber: z.string().nullable().optional(),
  totalFloors: z.number().int().positive().nullable().optional(),
  totalUnits: z.number().int().positive().nullable().optional(),
  builtYear: z.number().int().nullable().optional(),
  structureType: z.string().nullable().optional(),
  managementCompany: z.string().nullable().optional(),
  // F3 Task8: 築月(1〜12)・地下階(0階以上)。
  builtMonth: z.number().int().min(1).max(12).nullable().optional(),
  basementFloors: z.number().int().min(0).max(20).nullable().optional(),
  note: z.string().nullable().optional(),
  gpsLat: z.number().nullable().optional(),
  gpsLng: z.number().nullable().optional(),
  // @codex P1: 版番号は必須。省略を許すと、下の updateMany の条件に付けるものが無くなり
  // 「読んだときの版のまま書く」保証が作れない(画面は元から送っている)。
  version: z.number().int(),
});

// ---------- GET /api/buildings/:id ----------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const building = await prisma.building.findUnique({
      where: { id },
      include: {
        creator: { select: { id: true, name: true } },
        _count: { select: { properties: true } },
      },
    });

    if (!building) {
      throw new ApiError(404, "棟が見つかりません", "NOT_FOUND");
    }

    return apiResponse(building);
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- PATCH /api/buildings/:id ----------

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const existing = await prisma.building.findUnique({
      where: { id },
      select: {
        id: true,
        version: true,
        name: true,
        address: true,
        postalCode: true,
        lotNumber: true,
        realEstateNumber: true,
        totalFloors: true,
        totalUnits: true,
        builtYear: true,
        structureType: true,
        managementCompany: true,
        // F3 Task8: 変更履歴の「変更前」に使う(選ばないと oldValue が常に undefined になる)。
        builtMonth: true,
        basementFloors: true,
        gpsLat: true,
        gpsLng: true,
        note: true,
      },
    });

    if (!existing) {
      throw new ApiError(404, "棟が見つかりません", "NOT_FOUND");
    }

    const body = await request.json();
    const data = updateBuildingSchema.parse(body);

    // Optimistic locking（早めに気づかせるための事前判定。本当の保証は下の updateMany）
    if (data.version !== existing.version) {
      throw new ApiError(
        409,
        "データが他のユーザーにより更新されています。画面をリロードしてください。",
        "CONFLICT",
      );
    }

    const { version, ...updateFields } = data;
    const updateData: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(updateFields)) {
      if (val !== undefined) updateData[key] = val;
    }
    // 名前を直すときは前後の空白を落とす(棟にも全部屋にも同じ文字列を書く)。
    // ⚠名前が送られたら、変更の有無にかかわらず trim して書く(空白だけの違いで余白つきの名前を残さない)。
    const renaming = isBuildingRename(existing.name, updateFields.name);
    if (updateFields.name !== undefined) updateData.name = updateFields.name.trim();
    // 名前か住所が変わったら、比べる形と町丁目を入れ直す(設計 §7)。
    if (updateData.name !== undefined || updateData.address !== undefined) {
      Object.assign(
        updateData,
        buildingIdentityKeys(
          String(updateData.name ?? existing.name),
          String(updateData.address ?? existing.address),
        ),
      );
    }
    updateData.version = { increment: 1 };

    // @codex P1: **条件は書き込み自体に付ける**。上の事前判定だけでは、判定と書き込みの
    // 間に別の更新(販売図面からの書き戻しなど。あちらは行ロックを取って書く)が入ったとき、
    // ロック解放後に古いフォームの値をそのまま上書きしてしまう。棟の編集フォームは
    // 築月・地下階も毎回送るため、無関係な項目だけ直したつもりの保存でも、図面から
    // 書き戻したばかりの値を黙って消し得る。version を条件にして、0件なら競合として返す。
    // 棟の名前を直すときは、同じトランザクションで全部屋の物件名へ反映する(段3・設計 §6.3)。
    // ⚠ロック順は **部屋の行 → 棟の行**(販売図面の書き戻し=sales-sheets/new と同じ向き。逆だと
    //   待ちの輪になる)。部屋の行を id 順に FOR UPDATE で読んでから、棟の行を FOR NO KEY UPDATE。
    // ⚠編集中の鍵が1件でもあれば 409 で投げ、棟の更新ごと巻き戻す(誰が編集中かは返さない)。
    // ⚠鍵の数え直しと反映の間に新しく鍵を取られても、反映が各部屋の version を進めるので
    //   その人の保存は 409 になる(受け入れ済み)。
    const { count, propagated } = await prisma.$transaction(async (tx) => {
      // 名前を直すときだけ、先に部屋の行をロックして読み(以降の確認と反映はこの行だけが対象)、
      // 次に棟の行をロックする。ロックのあとにこの棟へつながった部屋は反映の対象外で、
      // 次にその部屋を保存するまで古い名前のまま(許容。権限の穴ではない)。
      const units = renaming ? await lockBuildingUnits(tx, id) : [];
      if (renaming) await lockBuildingRowNoKeyUpdate(tx, id);
      const updated = await tx.building.updateMany({
        where: { id, version },
        data: updateData,
      });
      if (updated.count === 0 || !renaming) return { count: updated.count, propagated: null };
      // ⚠担当だけ見られる役割は、担当外の部屋の物件名を書き換えられない(物件の編集 API と同じ規則)。
      if (isPropertyScopedRole(session.role) && unitsOutsideScope(units, session).length > 0) {
        throw new ApiError(
          403,
          "この棟には担当外の部屋があるため、棟の名前は変えられません。事務の方に依頼してください",
          "FORBIDDEN",
        );
      }
      const locked = await countEditLockedUnits(tx, id);
      if (locked > 0) {
        throw new ApiError(
          409,
          `この棟の部屋${locked}件が編集中のため、名前を全部屋に反映できません。編集が終わってから保存してください`,
          "UNITS_EDIT_LOCKED",
        );
      }
      const result = await propagateBuildingName(tx, {
        units,
        newName: updateData.name as string,
        userId: session.id,
      });
      if (result.changeLogs.length > 0) await tx.changeLog.createMany({ data: result.changeLogs });
      return { count: updated.count, propagated: result };
    });
    if (count === 0) {
      throw new ApiError(
        409,
        "データが他のユーザーにより更新されています。画面をリロードしてください。",
        "CONFLICT",
      );
    }
    const building = await prisma.building.findUnique({
      where: { id },
      include: {
        creator: { select: { id: true, name: true } },
        _count: { select: { properties: true } },
      },
    });

    // Record field-level changes
    const oldValues: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(existing)) {
      if (key === "id" || key === "version") continue;
      oldValues[key] =
        val !== null && typeof val === "object" && "toNumber" in val
          ? (val as { toNumber(): number }).toNumber()
          : val;
    }
    await recordChanges({
      targetTable: "buildings",
      targetId: id,
      changedBy: session.id,
      oldValues,
      newValues: updateFields,
      trackedFields: BUILDING_TRACKED_FIELDS,
      source: "manual",
    });

    await writeAuditLog({
      userId: session.id,
      action: "update",
      targetTable: "buildings",
      targetId: id,
      detail: { updatedFields: Object.keys(updateFields) },
    });
    if (propagated) {
      // 件数だけ(物件名・住所は入れない)。
      await writeAuditLog({
        userId: session.id,
        action: "building.rename_propagate",
        targetTable: "buildings",
        targetId: id,
        detail: { updatedUnits: propagated.updated },
      });
    }

    return apiResponse(building);
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- DELETE /api/buildings/:id ----------
// 棟を物理削除する。Property→Building は onDelete 未指定（Restrict）なので、
// 紐づく物件が1件でも残っているとDB側で失敗する。事前に件数チェックして
// 409 で安全に失敗させる（DBエラーをそのまま 500 にしないため）。
// BuildingPhoto は onDelete: Cascade なので自動削除される。

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    // 物件 DELETE と同じく delete アクションを要求する
    // (棟削除も物理削除 = BuildingPhoto が cascade で消える)。
    if (!hasPermission(perms, "property", "delete")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const building = await prisma.building.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        _count: { select: { properties: true } },
      },
    });

    if (!building) {
      throw new ApiError(404, "棟が見つかりません", "NOT_FOUND");
    }

    if (building._count.properties > 0) {
      throw new ApiError(
        409,
        `この棟には ${building._count.properties} 件の物件が紐づいているため削除できません。先に物件を削除または別棟へ移動してください。`,
        "BUILDING_HAS_PROPERTIES",
      );
    }

    await prisma.building.delete({ where: { id } });

    await writeAuditLog({
      userId: session.id,
      action: "delete",
      targetTable: "buildings",
      targetId: id,
      detail: { name: building.name },
    });

    return apiResponse({ id, deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
