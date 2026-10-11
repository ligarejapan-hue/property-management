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
import { assertReportInboxAccess, SCRUB_ON_DISCARD, STALE_UPLOAD_MS } from "@/lib/report-inbox/access";
import { removeFileAndVerify } from "@/lib/report-inbox/remove-file";

// ---------- DELETE /api/report-inbox/:id ----------
// 受け取り箱から削除する(人が押したときだけ。自動では消さない=発注者決定 2026-10-10)。
// ⚠添付済みのものは消さない(物件の添付がそのファイルを指している)。

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    assertReportInboxAccess(session, perms);

    const item = await prisma.reportInboxItem.findUnique({ where: { id } });
    if (!item) throw new ApiError(404, "見つかりません", "NOT_FOUND");

    // ⚠消せたことを確かめてから「削除済み」にする(@codex PR#500)。消せないまま削除済みにすると、
    //   個人情報の入ったファイルが誰にも見えない場所に残り続け、やり直す手段も無い。
    //   1) 未処理(または前回の削除が途中で止まったもの)を「削除中」にする=この間は添付できない
    //   2) ファイルを消し、**もう読めないこと**を確かめる(このサーバーのディスク版は失敗を黙って
    //      飲み込むので、消したつもりで残っていないかを読み直して見る)
    //   3) 消せたら「削除済み」。消せなければ「削除中」のまま=一覧に出て、もう一度押せる
    //   ⚠失敗しても「未処理」には**戻さない**(@codex PR#500 2巡目)。2か所で同時に押され、片方が
    //     消し終えたあとにもう片方の失敗が「未処理」に戻すと、ファイルの無い報告書が添付できてしまう。
    //     ファイルの削除は「もう無いものを消しても成功」なので、何度押し直しても安全。
    // 取り込みが途中で止まったもの(uploading)も消せる(置き終える側は、削除されていたら自分のファイルを消す)。
    const claimed = await prisma.reportInboxItem.updateMany({
      where: {
        id,
        OR: [
          { status: { in: ["pending", "discarding"] } },
          // ⚠取り込み中は、止まっていると判断できる(STALE_UPLOAD_MS を過ぎた)ものだけ
          { status: "uploading", createdAt: { lt: new Date(Date.now() - STALE_UPLOAD_MS) } },
        ],
      },
      data: { status: "discarding" },
    });
    if (claimed.count !== 1) {
      throw new ApiError(409, "この報告書は、すでに添付または削除されています。一覧を読み直してください。", "CONFLICT");
    }

    const storage = getStorage();
    if (!(await removeFileAndVerify(storage, storage.keyFromUrl(item.fileUrl)))) {
      throw new ApiError(500, "報告書を削除できませんでした。少し待ってから、もう一度「削除」を押してください。", "DELETE_FAILED");
    }
    await prisma.reportInboxItem.updateMany({
      where: { id, status: "discarding" },
      // 消せたら、元のファイル名・読み取った所在地なども消す(@codex PR#500 8巡目)。
      data: { status: "discarded", resolvedBy: session.id, resolvedAt: new Date(), ...SCRUB_ON_DISCARD },
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
