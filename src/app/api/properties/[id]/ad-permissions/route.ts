import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, getApiSession, getUserPermissions, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { assertPropertyWritable } from "@/lib/agent-inquiry/property-access";
import { adPermissionsPutSchema } from "@/lib/agent-inquiry/validators";
import { VERSION_CONFLICT_MESSAGE } from "@/lib/agent-inquiry/guard";
import { lockPropertyRecordForWrite } from "@/lib/property-record-guard";

type Ctx = { params: Promise<{ id: string }> };

/** 広告の可否の変更(物件の編集権限・設計 §2.3)。value=null は未設定に戻す(行を消す)。 */
export async function PUT(request: Request, ctx: Ctx) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    const id = z.string().uuid().parse((await ctx.params).id);
    await assertPropertyWritable(id, session, perms);
    const { items } = adPermissionsPutSchema.parse(await parseJsonBody(request));
    const adPermissions = await prisma.$transaction(async (tx) => {
      // 同時に保存されたとき、比べてから書くまでの間に割り込まれないよう物件の行をロックする。
      // 担当範囲つきのロック=ロックの時点で現地スタッフの担当外なら 403(先の確認の後に担当が
      // 付け替えられていても書かない・@codex #454 R9)。
      await lockPropertyRecordForWrite(tx, id, session);
      const current = await tx.propertyAdPermission.findMany({
        where: { propertyId: id },
        select: { medium: true, value: true },
      });
      const now = new Map(current.map((c) => [c.medium, c.value]));
      // 画面に出ていた値と今の値が違う=誰かが先に変えた。黙って上書きしない(@codex #454 R5)。
      if (items.some((it) => (now.get(it.medium) ?? null) !== it.from)) {
        throw new ApiError(409, VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
      }
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
        if (it.value === null) now.delete(it.medium);
        else now.set(it.medium, it.value);
      }
      // 変更後の値はロック中に組み立てる(ロックを外した後に読み直すと、直後の他人の変更を
      // この人の操作として記録してしまう・@codex #454 R6)。
      return Object.fromEntries(now);
    });
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
