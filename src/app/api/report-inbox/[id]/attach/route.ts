import { NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { assertReportInboxAccess, SCRUB_ON_DISCARD } from "@/lib/report-inbox/access";
import { REPORT_ATTACHMENT_TYPE, reportDisplayName } from "@/lib/attachments/report-display-name";

// ---------- POST /api/report-inbox/:id/attach  { propertyId } ----------
// 受け取り箱の報告書を、人が選んだ物件に「査定報告書」として添付する。
// ⚠ファイルは写さない(受け取り箱と同じ保存場所を添付から指す)。
// ⚠同じ報告書を2人が同時に添付しても1件にしかならない(未処理→添付済み の切り替えで判定)。

const bodySchema = z.object({ propertyId: z.string().uuid("物件を選んでください") });

class AlreadyResolved extends Error {}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    assertReportInboxAccess(session, perms);

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new ApiError(422, parsed.error.issues[0]?.message ?? "物件を選んでください", "VALIDATION_ERROR");
    }
    const { propertyId } = parsed.data;

    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true, createdBy: true, assignedTo: true, isArchived: true },
    });
    if (!property) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    // 候補・検索はしまってある物件を出さない。古い画面や直接の呼び出しでも付けない。
    if (property.isArchived) {
      throw new ApiError(422, "しまってある物件には添付できません。物件を戻してから添付してください。", "VALIDATION_ERROR");
    }
    if (!canAccessPropertyRecord(session, property)) {
      throw new ApiError(403, "この物件を編集する権限がありません", "FORBIDDEN");
    }

    const item = await prisma.reportInboxItem.findUnique({ where: { id } });
    if (!item) throw new ApiError(404, "見つかりません", "NOT_FOUND");

    let attachmentId: string;
    try {
      attachmentId = await prisma.$transaction(async (tx) => {
        // 物件配下を書き換える tx は親を先にロック(書き込み規約・attachment-create-parent-lock)。
        await lockPropertyRow(tx, propertyId);
        // ⚠ロックを取ってから**もう一度**確かめる(@codex PR#500)。上の確認からロックまでの間に
        //   担当が替わった・しまわれた場合、古い判断のまま書き込まない。
        const locked = await tx.property.findUnique({
          where: { id: propertyId },
          select: { createdBy: true, assignedTo: true, isArchived: true },
        });
        if (!locked) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
        if (locked.isArchived) {
          throw new ApiError(422, "しまってある物件には添付できません。物件を戻してから添付してください。", "VALIDATION_ERROR");
        }
        if (!canAccessPropertyRecord(session, locked)) {
          throw new ApiError(403, "この物件を編集する権限がありません", "FORBIDDEN");
        }
        const claimed = await tx.reportInboxItem.updateMany({
          where: { id, status: "pending" },
          // 元のファイル名(依頼者名を含み得る)は添付にも使わないので、ここで消す(@codex PR#500 8巡目)。
          data: {
            status: "attached",
            propertyId,
            resolvedBy: session.id,
            resolvedAt: new Date(),
            // 読み取った手がかりも、物件と添付が決まった時点で要らない(@codex PR#500 10巡目)。
            ...SCRUB_ON_DISCARD,
          },
        });
        if (claimed.count !== 1) throw new AlreadyResolved();
        const now = new Date();
        const attachment = await tx.attachment.create({
          data: {
            targetType: "property",
            targetId: propertyId,
            propertyId,
            type: REPORT_ATTACHMENT_TYPE,
            // ⚠元のファイル名(依頼者名を含み得る)は使わない。
            fileName: reportDisplayName(now),
            fileUrl: item.fileUrl,
            fileSize: item.fileSize,
            originalSize: item.originalSize,
            mimeType: "application/pdf",
            uploadedBy: session.id,
          },
          select: { id: true },
        });
        await tx.reportInboxItem.update({ where: { id }, data: { attachmentId: attachment.id } });
        return attachment.id;
      });
    } catch (e) {
      if (e instanceof AlreadyResolved) {
        throw new ApiError(409, "この報告書は、すでに添付または削除されています。一覧を読み直してください。", "CONFLICT");
      }
      throw e;
    }

    await writeAuditLog({
      userId: session.id,
      action: "create",
      targetTable: "attachments",
      targetId: attachmentId,
      detail: { propertyId, reportInboxItemId: id, type: REPORT_ATTACHMENT_TYPE },
    });

    return apiResponse({ attachmentId, propertyId });
  } catch (error) {
    return handleApiError(error);
  }
}
