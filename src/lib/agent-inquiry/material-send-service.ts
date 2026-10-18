import prisma from "@/lib/prisma";
import { ApiError, type ApiSession, type PermissionEntry } from "@/lib/api-helpers";
import { assertPropertyReadable } from "@/lib/agent-inquiry/property-access";
import { MAIL_CONFIG_ID } from "@/lib/mail/mail-config";
import {
  DEFAULT_MATERIAL_BODY,
  DEFAULT_MATERIAL_SUBJECT,
  fillMaterialTemplate,
  propertyDisplayName,
  type MaterialAttachmentRow,
} from "./material-send";
import { DESK_PROPERTY_SELECT, toDeskProperty } from "./desk-property";
import { hasPermission } from "@/lib/permissions";
import {
  authorizeUploadAccess,
  resolveProtectedServeMeta,
  resolveStoredFileUrlToKey,
} from "@/lib/uploads-authorization";

export const MATERIAL_ATTACHMENT_SELECT = {
  id: true, targetType: true, targetId: true, type: true, isDeleted: true,
  fileName: true, fileSize: true, fileUrl: true, mimeType: true, createdAt: true,
} as const;

/** 反響を読み、資料請求か・物件を開けるかを確かめる(候補・記録・送信で共通)。 */
export async function loadMaterialInquiry(id: string, session: ApiSession, perms: PermissionEntry[]) {
  const q = await prisma.agentInquiry.findUnique({
    where: { id },
    select: {
      id: true, kind: true, status: true, version: true, propertyId: true, contactName: true, contactEmail: true,
      agent: { select: { companyName: true } },
      // 物件名は受付の窓と同じ作り(棟の名前→建物名→町名まで=番地は出さない)。
      property: { select: DESK_PROPERTY_SELECT },
    },
  });
  if (!q) throw new ApiError(404, "反響が見つかりません", "NOT_FOUND");
  if (q.kind !== "material_request") throw new ApiError(400, "資料請求の反響だけ資料を送れます", "NOT_MATERIAL_REQUEST");
  await assertPropertyReadable(q.propertyId, session, perms);
  return q;
}

/** 物件の添付(削除済みも含めて読む=判定は純関数に任せる)。 */
export async function loadPropertyAttachments(propertyId: string, ids?: string[]): Promise<MaterialAttachmentRow[]> {
  return prisma.attachment.findMany({
    where: { targetType: "property", targetId: propertyId, ...(ids ? { id: { in: ids } } : {}) },
    orderBy: { createdAt: "desc" },
    select: MATERIAL_ATTACHMENT_SELECT,
  });
}

export type MaterialFileGuard = { ok: true; key: string; effectiveType: "general" | "registry" } | { ok: false };

/**
 * 1つのファイルを外へ送ってよいか(/uploads で開くときと同じ守り・最終レビュー C1)。
 * ⚠添付の記録は手で fileUrl を書いて登録できる(JSON の登録口)=記録の種類と物件だけでは足りない。
 *   同じファイルを指す全部の記録(削除済み・別の物件・受け取り箱の置き場所)を見る authorizeUploadAccess を
 *   ダウンロードの扱いで通し、反響資料・査定報告書と同じファイルは送らない・謄本と同じファイルは謄本として扱う。
 */
export async function guardMaterialFile(
  row: MaterialAttachmentRow,
  session: ApiSession,
  perms: PermissionEntry[],
): Promise<MaterialFileGuard> {
  const key = resolveStoredFileUrlToKey(row.fileUrl);
  if (!key) return { ok: false };
  if ((await authorizeUploadAccess({ key, session, permissions: perms, downloadIntent: true })) !== "ok") return { ok: false };
  const meta = await resolveProtectedServeMeta(key);
  if (meta !== null && meta.kind !== "registry") return { ok: false };
  const effectiveType = meta?.kind === "registry" || row.type === "registry" ? "registry" : "general";
  if (
    effectiveType === "registry" &&
    !(hasPermission(perms, "registry_pdf", "preview") && hasPermission(perms, "registry_pdf", "download"))
  ) {
    return { ok: false };
  }
  return { ok: true, key, effectiveType };
}

/** ひな形(未登録なら既定)に差し込んだ件名・本文。 */
export async function initialMaterialText(
  q: Awaited<ReturnType<typeof loadMaterialInquiry>>,
  senderName: string,
): Promise<{ subject: string; body: string }> {
  const row = await prisma.mailConfig.findUnique({
    where: { id: MAIL_CONFIG_ID },
    select: { materialSendSubject: true, materialSendBody: true },
  });
  const v = {
    propertyName: propertyDisplayName(toDeskProperty(q.property)),
    companyName: q.agent.companyName,
    contactName: q.contactName,
    senderName,
  };
  return {
    subject: fillMaterialTemplate(row?.materialSendSubject || DEFAULT_MATERIAL_SUBJECT, v),
    body: fillMaterialTemplate(row?.materialSendBody || DEFAULT_MATERIAL_BODY, v),
  };
}
