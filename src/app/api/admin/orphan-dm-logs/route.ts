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
import { hasPermission, maskValue } from "@/lib/permissions";
import { isPlainOwnerLevel } from "@/lib/dm-export";
import { jstCalendarDay } from "@/lib/dm-reaction/core";
import { writeAuditLog } from "@/lib/audit";

// ---------- GET /api/admin/orphan-dm-logs ----------
//
// 物件削除で孤児化した送付記録(propertyId=null)の検索・一覧(設計§2.4・R51 P2)。
// 反響の更新・取消は /api/properties/[id]/... 配下のため、孤児行に誤った拒否/宛先不明が
// 残ると辿る手段が無く、その所有者の全物件が永久に再送候補から消える。訂正経路として
// admin 専用のこの一覧+[logId] の PATCH/DELETE を用意する。
//   - ゲート: user_management:read(admin データ補正ツールの慣例)+ owner:read(所有者名を返す)。
//   - 所有者名・note は表示レベルで server-side マスク(既存 dm-logs GET と同方針)。
//   - 監査 property_dm_log_view+detail orphan:true(名前本文は載せない)。

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "user_management", "read")) {
      throw new ApiError(403, "管理者権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(permissions, "owner", "read")) {
      throw new ApiError(403, "所有者情報の閲覧権限がありません", "FORBIDDEN");
    }

    const { searchParams } = new URL(request.url);
    const q = (searchParams.get("q") ?? "").trim();
    const page = Math.max(1, Number(searchParams.get("page")) || 1);
    const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit")) || 50));

    const ownerDisplayConfig = await getOwnerDisplayConfig(session.id, permissions);

    // 氏名検索は生値表示レベル(edit/full/read)のみ(S1a・#366 R7): partial/masked/hidden の
    // ユーザーが q を変えながらヒット件数を観察すると、マスク越しに名前当てのオラクルになる
    // (物件サジェスト検索と同じ基準)。
    if (q && !isPlainOwnerLevel(ownerDisplayConfig.name)) {
      throw new ApiError(
        403,
        "所有者名で検索するには氏名の生値表示権限が必要です",
        "FORBIDDEN",
      );
    }

    // 対象は孤児行(propertyId=null)のみ。所有者名検索は代表(owner)と共有者連関
    // (logOwners)の両経路(R29: 拒否の記録は共有者側にも紐づく)。
    const where = {
      propertyId: null,
      ...(q
        ? {
            OR: [
              { owner: { name: { contains: q } } },
              { logOwners: { some: { owner: { name: { contains: q } } } } },
            ],
          }
        : {}),
    };

    const [logs, total] = await Promise.all([
      prisma.propertyDmLog.findMany({
        where,
        select: {
          id: true,
          sentAt: true,
          method: true,
          batchId: true,
          draftId: true,
          note: true,
          reactionStatus: true,
          reactedAt: true,
          reactionNote: true,
          reactionSource: true,
          createdAt: true,
          owner: { select: { id: true, name: true } },
          logOwners: { select: { owner: { select: { id: true, name: true } } } },
        },
        orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.propertyDmLog.count({ where }),
    ]);

    const data = logs.map((log) => ({
      id: log.id,
      sentAt: log.sentAt.toISOString().slice(0, 10),
      method: log.method,
      batchId: log.batchId,
      draftId: log.draftId,
      note: maskValue(log.note, ownerDisplayConfig.note),
      reactionStatus: log.reactionStatus,
      // 同期由来の実時刻を UTC のまま切ると JST 0-9時が前日表示になる(#366 R8)
      reactedAt: log.reactedAt ? jstCalendarDay(log.reactedAt) : null,
      reactionNote: maskValue(log.reactionNote, ownerDisplayConfig.note),
      reactionSource: log.reactionSource,
      createdAt: log.createdAt,
      owner: log.owner
        ? { id: log.owner.id, name: maskValue(log.owner.name, ownerDisplayConfig.name) }
        : null,
      coOwners: log.logOwners.map((lo) => ({
        id: lo.owner.id,
        name: maskValue(lo.owner.name, ownerDisplayConfig.name),
      })),
    }));

    await writeAuditLog({
      userId: session.id,
      action: "property_dm_log_view",
      targetTable: "property_dm_logs",
      detail: {
        count: data.length,
        total,
        page,
        orphan: true,
        viewedAt: new Date().toISOString(),
      },
    });

    return apiResponse({
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
