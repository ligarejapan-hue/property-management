import { randomUUID } from "node:crypto";
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
import { getStorage } from "@/lib/storage";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { assertReportInboxAccess, SCRUB_ON_DISCARD } from "@/lib/report-inbox/access";
import { removeFileAndVerify } from "@/lib/report-inbox/remove-file";
import { REPORT_ATTACHMENT_TYPE, reportDisplayName } from "@/lib/attachments/report-display-name";
import { autoAdvanceCaseStatus } from "@/lib/case-status-auto";
import { docKindByCode, docStageOfKind, type DocConfidence } from "@/lib/doc-classify/classify";
import { fileExtension } from "@/lib/doc-classify/title";
import { docColumnsForKnownKind } from "@/lib/doc-classify/assign";

// ---------- POST /api/report-inbox/:id/attach  { propertyId, docKind? } ----------
// 受け取り箱の書類を、人が選んだ物件に添付する(2026-10-24 全書類へ)。
//   - 査定報告書(SRE の書式、または種類が「査定書・査定報告書」)= 今までどおり「査定報告書」(report)として
//     添付。ファイルは写さない(受け取り箱と同じ守りの場所を添付から指す)。開けるのは所有者情報を見られる人だけ。
//   - それ以外 = 通常の添付(general)。種類・段階・そろえた名前を付け、**ファイルを物件の置き場所へ写す**
//     (report-inbox/ の下は所有者情報の守りがかかるため、通常の書類をそこに置いたままにしない)。
// ⚠同じ書類を2人が同時に添付しても1件にしかならない(未処理→添付済み の切り替えで判定)。
// ⚠人が受け取り箱で種類を選び直せる(docKind)。null=その他。

const bodySchema = z.object({
  propertyId: z.string().uuid("物件を選んでください"),
  docKind: z.string().min(1).max(64).nullable().optional(),
});

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
    if (parsed.data.docKind != null && !docKindByCode(parsed.data.docKind)) {
      throw new ApiError(422, "知らない種類です", "VALIDATION_ERROR");
    }

    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true, createdBy: true, assignedTo: true, isArchived: true, buildingName: true, roomNo: true, address: true },
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
    if (item.status !== "pending") {
      throw new ApiError(409, "この書類は、すでに添付または削除されています。一覧を読み直してください。", "CONFLICT");
    }

    // 種類: 人が選び直していればそれ(manual)、なければ受け取ったときの判別。
    const kindOverridden = parsed.data.docKind !== undefined && parsed.data.docKind !== item.docKind;
    const kind = parsed.data.docKind !== undefined ? parsed.data.docKind : item.docKind;
    const confidence: DocConfidence = kindOverridden ? "manual" : ((item.docConfidence as DocConfidence | null) ?? "high");
    // 「査定報告書」(report)として付けるのは PDF だけ(report の配信・定型名は PDF 前提)。
    // 画像や Word の「査定書」は通常の添付(種類は査定書のまま・①調査資料等に出る)。
    const isPdf = (item.mimeType ?? "application/pdf") === "application/pdf";
    const asReport = isPdf && (item.source === "sre" || kind === "appraisal_report");

    const storage = getStorage();
    // 通常の書類は、記録を切り替える前にファイルを物件の置き場所へ写しておく(失敗したら何も変えない)。
    let copiedKey: string | null = null;
    let copiedUrl: string | null = null;
    if (!asReport) {
      const srcKey = storage.keyFromUrl(item.fileUrl);
      const file = srcKey ? await storage.read(srcKey) : null;
      if (!file) throw new ApiError(404, "ファイルが見つかりません", "NOT_FOUND");
      const ext = fileExtension(item.fileName) ?? fileExtension(srcKey ?? "") ?? "bin";
      copiedKey = `properties/${propertyId}/attachments/${Date.now()}-${randomUUID()}.${ext}`;
      try {
        const uploaded = await storage.upload(Buffer.from(file.body as Uint8Array), {
          key: copiedKey,
          mimeType: item.mimeType ?? "application/pdf",
          fileName: item.fileName,
        });
        copiedUrl = uploaded.url;
      } catch (e) {
        // 途中まで書けているかもしれない(置けたのに応答だけ失った等)。どの記録も指さない写しを残さない
        // (@codex #565 P2)。消せなくても受け取り箱の記録は未処理のままなので、押し直し・削除で回収できる。
        await removeFileAndVerify(storage, copiedKey);
        throw e;
      }
    }

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
          // 元のファイル名(依頼者名を含み得る)は報告書の添付には使わないので、ここで消す(@codex PR#500 8巡目)。
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
        let attachment: { id: string };
        if (asReport) {
          attachment = await tx.attachment.create({
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
              // 段階のフォルダ(①調査資料等)に出すための種類。名前は定型のまま(docTitle は付けない)。
              docKind: "appraisal_report",
              docStage: docStageOfKind("appraisal_report"),
              docConfidence: confidence,
            },
            select: { id: true },
          });
        } else {
          const existing = await tx.attachment.findMany({
            where: { targetType: "property", targetId: propertyId, isDeleted: false, docTitle: { not: null } },
            select: { docTitle: true },
          });
          const columns = docColumnsForKnownKind(
            { kindCode: kind, confidence, fileName: item.fileName, dateStamp: item.docDate, now },
            {
              property: { buildingName: property.buildingName, roomNo: property.roomNo, address: property.address },
              takenTitles: new Set(existing.map((e) => e.docTitle).filter((t): t is string => t !== null)),
            },
          );
          attachment = await tx.attachment.create({
            data: {
              targetType: "property",
              targetId: propertyId,
              propertyId,
              type: "general",
              fileName: item.fileName,
              fileUrl: copiedUrl as string,
              fileSize: item.fileSize,
              originalSize: item.originalSize,
              mimeType: item.mimeType ?? "application/pdf",
              uploadedBy: session.id,
              ...columns,
            },
            select: { id: true },
          });
        }
        await tx.reportInboxItem.update({ where: { id }, data: { attachmentId: attachment.id } });
        if (asReport) {
          // 査定報告書が付いた=査定に入った。未着手・所有者とやりとり中のときだけ「査定中」へ(発注者決定 2026-10-20)。
          await autoAdvanceCaseStatus(tx, { propertyId, to: "appraisal", changedBy: session.id });
        }
        return attachment.id;
      });
    } catch (e) {
      // 記録を切り替えられなかったときは、写したファイルを残さない(消せなくても害はない=誰も指していない)。
      if (copiedKey) await removeFileAndVerify(storage, copiedKey);
      if (e instanceof AlreadyResolved) {
        throw new ApiError(409, "この書類は、すでに添付または削除されています。一覧を読み直してください。", "CONFLICT");
      }
      throw e;
    }

    // 通常の書類は受け取り箱の側のファイルを消す(写し終えて添付が指すのは物件の置き場所)。
    // ⚠消せたと確かめられなければ「削除中」に戻す(@codex #565 2巡目)。添付は成立しているが、
    //   受け取り箱の一覧に残って「削除」を押し直せる=個人情報の入ったファイルを置き去りにしない。
    if (!asReport) {
      const removed = await removeFileAndVerify(storage, storage.keyFromUrl(item.fileUrl));
      if (!removed) {
        await prisma.reportInboxItem.updateMany({ where: { id, status: "attached" }, data: { status: "discarding" } });
      }
    }

    await writeAuditLog({
      userId: session.id,
      action: "create",
      targetTable: "attachments",
      targetId: attachmentId,
      detail: { propertyId, reportInboxItemId: id, type: asReport ? REPORT_ATTACHMENT_TYPE : "general", docKind: kind },
    });

    return apiResponse({ attachmentId, propertyId });
  } catch (error) {
    return handleApiError(error);
  }
}
