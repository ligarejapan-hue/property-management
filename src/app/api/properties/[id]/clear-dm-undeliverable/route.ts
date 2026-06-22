import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
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
    const { session } = await requireSaleDmAccess();
    const { id } = await params;
    const { restoreDmStatus } = clearSchema.parse(await request.json());

    const property = await prisma.property.findUnique({
      where: { id },
      select: { id: true, dmUndeliverableAt: true, dmStatus: true },
    });
    if (!property) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");

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
