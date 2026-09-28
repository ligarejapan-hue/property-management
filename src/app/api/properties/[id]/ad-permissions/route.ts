import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { assertPropertyWritable } from "@/lib/agent-inquiry/property-access";
import { adPermissionsPutSchema } from "@/lib/agent-inquiry/validators";

type Ctx = { params: Promise<{ id: string }> };

/** 広告の可否の変更(物件の編集権限・設計 §2.3)。value=null は未設定に戻す(行を消す)。 */
export async function PUT(request: Request, ctx: Ctx) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    const id = z.string().uuid().parse((await ctx.params).id);
    await assertPropertyWritable(id, session, perms);
    const { items } = adPermissionsPutSchema.parse(await parseJsonBody(request));
    await prisma.$transaction(async (tx) => {
      for (const it of items) {
        if (it.value === null) {
          await tx.propertyAdPermission.deleteMany({ where: { propertyId: id, medium: it.medium } });
        } else {
          await tx.propertyAdPermission.upsert({
            where: { propertyId_medium: { propertyId: id, medium: it.medium } },
            create: { propertyId: id, medium: it.medium, value: it.value, updatedById: session.id },
            update: { value: it.value, updatedById: session.id },
          });
        }
      }
    });
    const ads = await prisma.propertyAdPermission.findMany({
      where: { propertyId: id },
      select: { medium: true, value: true },
    });
    const adPermissions = Object.fromEntries(ads.map((a) => [a.medium, a.value]));
    // 監査の values は媒体→ok/ng/ask の列挙値だけ(個人情報を含まない)。
    await writeAuditLog({
      userId: session.id,
      action: "property_ad_permissions_update",
      targetTable: "properties",
      targetId: id,
      detail: { changed: ["adPermissions"], media: items.map((i) => i.medium).sort(), values: adPermissions },
    });
    return NextResponse.json({ adPermissions }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
