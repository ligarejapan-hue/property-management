import { NextResponse } from "next/server";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { requireDriveAdmin } from "@/lib/drive/admin-access";

/** DELETE: 紐づけを外す。ドライブ側もアプリ側もファイルは消さない(台帳は残る=folder_link_id が null になる。同じ物件に付け直したとき取り込み直さないため)。 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireDriveAdmin();
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(422, "指定が正しくありません", "VALIDATION_ERROR");
    const row = await prisma.propertyDriveFolder.findUnique({ where: { id }, select: { id: true, propertyId: true } });
    if (!row) throw new ApiError(404, "紐づけが見つかりません", "NOT_FOUND");
    await prisma.propertyDriveFolder.delete({ where: { id } });
    await writeAuditLog({
      userId: session.id,
      action: "drive_folder_unlink",
      targetTable: "property_drive_folders",
      targetId: id,
      detail: { propertyId: row.propertyId },
    });
    return NextResponse.json({ data: { ok: true } }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return handleApiError(e);
  }
}
