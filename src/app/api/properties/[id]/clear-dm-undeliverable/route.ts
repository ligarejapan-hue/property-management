import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody, getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";

// 宛先不明フラグ(dmUndeliverableAt)の手動解除。dmStatus は人の判断で戻すため、
// restoreDmStatus が指定された時のみ send/hold に戻す(no_send のまま据え置きも可)。
const clearSchema = z.object({
  restoreDmStatus: z.enum(["send", "hold"]).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // 宛先不明フラグの解除は物件(properties)の書き換えで、PII は返さない。よって DM の CSV/owner 読取権限を
    // 要求する requireSaleDmAccess ではなく、他の物件変更 API(PATCH /properties/[id])と同じ property:write
    // ゲートのみを使う。UI も property:write で「解除」ボタンを出すため権限セットを一致させる(Codex R31 P2)。
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "物件を更新する権限(write)がありません", "FORBIDDEN");
    }
    const { id } = await params;
    // 既定の「解除のみ」呼び出しは空ボディで来る。request.json() は空ボディで例外(→500)に
    // なるため parseJsonBody を使う(空→{}・不正JSON→400)。restoreDmStatus は任意。
    const { restoreDmStatus } = clearSchema.parse(await parseJsonBody(request));

    const property = await prisma.property.findUnique({
      where: { id },
      select: { id: true, dmUndeliverableAt: true, dmStatus: true, createdBy: true, assignedTo: true },
    });
    if (!property) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");

    // field_staff は作成 or 担当の物件のみ操作可(既存 PATCH /properties/[id] と同じ可視範囲)。
    if (
      session.role === "field_staff" &&
      property.createdBy !== session.id &&
      property.assignedTo !== session.id
    ) {
      throw new ApiError(403, "この物件を操作する権限がありません", "FORBIDDEN");
    }

    const data: { dmUndeliverableAt: null; dmStatus?: "send" | "hold" } = {
      dmUndeliverableAt: null,
    };
    if (restoreDmStatus !== undefined) {
      data.dmStatus = restoreDmStatus;
    }

    await prisma.property.update({ where: { id }, data });

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_undeliverable_clear",
      targetTable: "properties",
      targetId: id,
      detail: {
        restoredDmStatus: restoreDmStatus ?? null,
        clearedAt: new Date().toISOString(),
      },
    });

    return NextResponse.json(
      { id, dmStatus: restoreDmStatus ?? property.dmStatus },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
