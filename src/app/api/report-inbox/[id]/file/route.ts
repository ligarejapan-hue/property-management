import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, ApiError, handleApiError } from "@/lib/api-helpers";
import { getStorage } from "@/lib/storage";
import { assertReportInboxAccess } from "@/lib/report-inbox/access";
import { REPORT_ASCII_FALLBACK_NAME } from "@/lib/attachments/report-display-name";

// ---------- GET /api/report-inbox/:id/file ----------
// 受け取り箱の報告書(まだどの物件にも付いていない)を画面で開く。
// ⚠/uploads は「添付の記録」で権限を見るので、受け取り箱のファイルはここからだけ出す。
//   使える人は受け取り箱と同じ(所有者情報をすべて見られる人)。キャッシュさせない。

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    assertReportInboxAccess(perms);

    const item = await prisma.reportInboxItem.findUnique({ where: { id } });
    if (!item || item.status !== "pending") {
      throw new ApiError(404, "見つかりません(添付済み・削除済みの可能性があります)", "NOT_FOUND");
    }
    const storage = getStorage();
    const key = storage.keyFromUrl(item.fileUrl);
    const file = key ? await storage.read(key) : null;
    if (!file) throw new ApiError(404, "ファイルが見つかりません", "NOT_FOUND");

    return new Response(file.body as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(file.size),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        // ⚠元のファイル名(依頼者名を含み得る)を手元に落ちる名前に使わない。
        "Content-Disposition": `inline; filename="${REPORT_ASCII_FALLBACK_NAME}"`,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
