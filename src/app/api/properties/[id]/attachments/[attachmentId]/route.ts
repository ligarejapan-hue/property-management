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
import { hasPermission } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { lockPropertyRecordForWrite } from "@/lib/property-record-guard";
import { normalizeFileUrlsInRecord } from "@/lib/url-normalize";
import { assertImportJsonBodySize } from "@/lib/import-body-size";
import { docKindByCode } from "@/lib/doc-classify/classify";
import { canOpenReferralDocument } from "@/lib/uploads-authorization";
import { IDENTITY_DOC_KIND } from "@/lib/attachments/identity-display-name";
import { docColumnsForManualKind } from "@/lib/doc-classify/assign";

// ---------- DELETE /api/properties/:id/attachments/:attachmentId ----------
// Soft-delete (sets isDeleted = true)

export async function DELETE(
  _request: NextRequest,
  {
    params,
  }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  try {
    const { id: propertyId, attachmentId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const attachment = await prisma.attachment.findUnique({
      where: { id: attachmentId },
      include: {
        property: { select: { createdBy: true, assignedTo: true } },
      },
    });
    if (
      !attachment ||
      attachment.targetType !== "property" ||
      attachment.targetId !== propertyId ||
      attachment.isDeleted
    ) {
      throw new ApiError(404, "添付ファイルが見つかりません", "NOT_FOUND");
    }

    // field_staff スコープ: 担当外の物件の添付ファイルは削除不可（物件詳細 API と同一判定を共有）。
    // property relation が null（=owner/comment 添付等）は parity 上 403 とする。
    if (
      !attachment.property ||
      !canAccessPropertyRecord(session, attachment.property)
    ) {
      throw new ApiError(403, "この添付ファイルを削除する権限がありません", "FORBIDDEN");
    }

    await prisma.attachment.update({
      where: { id: attachmentId },
      data: { isDeleted: true, deletedAt: new Date() },
    });

    await writeAuditLog({
      userId: session.id,
      action: "delete",
      targetTable: "attachments",
      targetId: attachmentId,
      detail: { propertyId, fileName: attachment.fileName },
    });

    return apiResponse({ message: "削除しました" });
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- PATCH /api/properties/:id/attachments/:attachmentId ----------
// 書類の種類を人が決め直す(2026-10-23 書類の自動整理)。段階と名前も種類から作り直す。
// body: { docKind: string | null }  null = その他(段階・種類・そろえた名前を外す)

const patchSchema = z.object({
  docKind: z.string().min(1).max(64).nullable(),
});

export async function PATCH(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  try {
    const { id: propertyId, attachmentId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const attachment = await prisma.attachment.findUnique({
      where: { id: attachmentId },
      include: {
        property: { select: { createdBy: true, assignedTo: true, buildingName: true, roomNo: true, address: true } },
      },
    });
    if (
      !attachment ||
      attachment.targetType !== "property" ||
      attachment.targetId !== propertyId ||
      attachment.isDeleted
    ) {
      throw new ApiError(404, "添付ファイルが見つかりません", "NOT_FOUND");
    }
    if (!attachment.property || !canAccessPropertyRecord(session, attachment.property)) {
      throw new ApiError(403, "この添付ファイルを変更する権限がありません", "FORBIDDEN");
    }
    // 謄本は今の枠のまま(段階・種類を付けない)。反響資料・査定報告書も配信の守りを変えないので対象外。
    if (attachment.type !== "general") {
      throw new ApiError(422, "この添付には種類を付けられません", "VALIDATION_ERROR");
    }

    assertImportJsonBodySize(request, 4 * 1024);
    const body = patchSchema.parse(await request.json());
    if (body.docKind !== null && !docKindByCode(body.docKind)) {
      throw new ApiError(422, "知らない種類です", "VALIDATION_ERROR");
    }
    // 本人確認書類(開ける人を絞る種類・2026-10-24)への変更・からの変更は、その書類を開ける人だけ。
    //   物件を編集できるだけの人が「種類をその他に直す」で守りを外せないように。
    //   ⚠ここは読んだ時点の判定(早い段階で断る)。確定はロックの中で読み直した行で行う(下)。
    const identityGuard = (currentKind: string | null) => {
      if ((currentKind === IDENTITY_DOC_KIND || body.docKind === IDENTITY_DOC_KIND) && !canOpenReferralDocument(perms)) {
        throw new ApiError(403, "本人確認書類の種類は、所有者情報をすべて見られる方だけが変えられます", "FORBIDDEN");
      }
    };
    identityGuard(attachment.docKind);

    const property = attachment.property;
    const updated = await prisma.$transaction(async (tx) => {
      // 物件配下の書き換えは親を先にロック。⚠担当の範囲はロックを取った物件行で**もう一度**確かめる
      //   (上の canAccessPropertyRecord は読んだ時点の判定。読んでからロックまでの間に担当が
      //   外れた field_staff が書き換えられないように・@codex #556 P2)。同じ名前の連番もロックの中で決める。
      await lockPropertyRecordForWrite(tx, propertyId, session);
      // ⚠種類もロックの中で読み直す: 読んでからロックまでの間に、権限のある人が本人確認書類に変えて
      //   いたら、物件を編集できるだけの人の古い判定で上書きして守りを外せてしまう(内部レビュー P2)。
      const fresh = await tx.attachment.findUnique({
        where: { id: attachmentId },
        select: { docKind: true, isDeleted: true, type: true },
      });
      if (!fresh || fresh.isDeleted) throw new ApiError(404, "添付ファイルが見つかりません", "NOT_FOUND");
      if (fresh.type !== "general") throw new ApiError(422, "この添付には種類を付けられません", "VALIDATION_ERROR");
      identityGuard(fresh.docKind);
      const others = await tx.attachment.findMany({
        where: {
          targetType: "property",
          targetId: propertyId,
          isDeleted: false,
          docTitle: { not: null },
          id: { not: attachmentId },
        },
        select: { docTitle: true },
      });
      const columns = docColumnsForManualKind(
        {
          kindCode: body.docKind,
          fileName: attachment.fileName,
          currentTitle: attachment.docTitle,
          createdAt: attachment.createdAt,
        },
        {
          property: { buildingName: property.buildingName, roomNo: property.roomNo, address: property.address },
          takenTitles: new Set(others.map((o) => o.docTitle).filter((t): t is string => t !== null)),
        },
      );
      return tx.attachment.update({
        where: { id: attachmentId },
        data: columns,
        include: { uploader: { select: { id: true, name: true } } },
      });
    });

    // ⚠監査にはファイル名を出さない(種類の code と物件 ID だけ)。
    await writeAuditLog({
      userId: session.id,
      action: "update",
      targetTable: "attachments",
      targetId: attachmentId,
      detail: { propertyId, docKind: body.docKind },
    });

    return apiResponse(normalizeFileUrlsInRecord(updated));
  } catch (error) {
    return handleApiError(error);
  }
}
