import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireDealAdmin, DEAL_VERSION_CONFLICT_MESSAGE } from "@/lib/deals/guard";
import { dealSettingsUpdateSchema } from "@/lib/deals/schemas";
import { DEAL_SETTINGS_ID, resolveDealSettings } from "@/lib/deals/settings";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    await requireDealAdmin();
    const row = await prisma.dealSettings.findUnique({ where: { id: DEAL_SETTINGS_ID } });
    return NextResponse.json({ settings: resolveDealSettings(row) }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}

/** 部分更新。version 0 = 行がまだ無い(初めての保存)。同時の初回保存は一意の鍵で 409。 */
export async function PUT(request: Request) {
  try {
    const session = await requireDealAdmin();
    const { version, ...patch } = dealSettingsUpdateSchema.parse(await parseJsonBody(request));
    if (version === 0) {
      try {
        await prisma.dealSettings.create({ data: { id: DEAL_SETTINGS_ID, ...patch, updatedById: session.id } });
      } catch (e) {
        if ((e as { code?: string } | null)?.code === "P2002") throw new ApiError(409, DEAL_VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
        throw e;
      }
    } else {
      const res = await prisma.dealSettings.updateMany({
        where: { id: DEAL_SETTINGS_ID, version },
        data: { ...patch, updatedById: session.id, version: { increment: 1 } },
      });
      if (res.count === 0) throw new ApiError(409, DEAL_VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
    }
    // targetId は UUID 列。singleton は UUID でないため付けない(会社情報の設定と同じ)。
    await writeAuditLog({
      userId: session.id, action: "deal_settings_update", targetTable: "deal_settings",
      detail: { fields: Object.keys(patch).sort() },
    });
    const row = await prisma.dealSettings.findUnique({ where: { id: DEAL_SETTINGS_ID } });
    return NextResponse.json({ settings: resolveDealSettings(row) }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
