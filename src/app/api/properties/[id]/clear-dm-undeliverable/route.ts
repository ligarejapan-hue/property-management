import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
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
    const { session, permissions } = await requireSaleDmAccess();
    // この route は物件(properties)の宛先不明フラグ/DM判断を書き換えるため property:write 必須。
    // read 系の DM アクセス権だけで物件状態を書き換えさせない(他の物件APIと同じ write ゲート)。
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
