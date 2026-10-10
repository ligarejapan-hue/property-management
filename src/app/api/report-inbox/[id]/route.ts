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

    // ⚠消せたことを確かめてから「削除済み」にする(@codex PR#500)。消せないまま削除済みにすると、
    //   個人情報の入ったファイルが誰にも見えない場所に残り続け、やり直す手段も無い。
    //   1) 未処理(または前回の削除が途中で止まったもの)を「削除中」にする=この間は添付できない
    //   2) ファイルを消す
    //   3) 消せたら「削除済み」。消せなければ「未処理」に戻して、もう一度押してもらう
    const claimed = await prisma.reportInboxItem.updateMany({
      where: { id, status: { in: ["pending", "discarding"] } },
      data: { status: "discarding" },
    });
    if (claimed.count !== 1) {
      throw new ApiError(409, "この報告書は、すでに添付または削除されています。一覧を読み直してください。", "CONFLICT");
    }

    const storage = getStorage();
    const key = storage.keyFromUrl(item.fileUrl);
    try {
      if (key) await storage.delete(key);
    } catch (e) {
      console.error("[report-inbox] delete failed", (e as { code?: unknown })?.code ?? "");
      await prisma.reportInboxItem.updateMany({
        where: { id, status: "discarding" },
        data: { status: "pending" },
      });
      throw new ApiError(500, "報告書を削除できませんでした。少し待ってから、もう一度「削除」を押してください。", "DELETE_FAILED");
    }
    await prisma.reportInboxItem.updateMany({
      where: { id, status: "discarding" },
      data: { status: "discarded", resolvedBy: session.id, resolvedAt: new Date() },
    });

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
