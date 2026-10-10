import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { getStorage } from "@/lib/storage";
import { assertReportInboxAccess } from "@/lib/report-inbox/access";

// ---------- DELETE /api/report-inbox/:id ----------
// 受け取り箱から削除する(人が押したときだけ。自動では消さない=発注者決定 2026-10-10)。
// ⚠添付済みのものは消さない(物件の添付がそのファイルを指している)。

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    assertReportInboxAccess(perms);

    const item = await prisma.reportInboxItem.findUnique({ where: { id } });
    if (!item) throw new ApiError(404, "見つかりません", "NOT_FOUND");

    const claimed = await prisma.reportInboxItem.updateMany({
      where: { id, status: "pending" },
      data: { status: "discarded", resolvedBy: session.id, resolvedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new ApiError(409, "この報告書は、すでに添付または削除されています。一覧を読み直してください。", "CONFLICT");
    }

    // ファイルは削除の記録のあとで消す(消せなくても記録は残る=二度と画面に出ない)。
    const storage = getStorage();
    const key = storage.keyFromUrl(item.fileUrl);
    if (key) {
      await storage.delete(key).catch((e: unknown) => {
        console.error("[report-inbox] delete failed", (e as { code?: unknown })?.code ?? "");
      });
    }

    await writeAuditLog({
      userId: session.id,
      action: "delete",
      targetTable: "report_inbox_items",
      targetId: id,
    });
    return apiResponse({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
