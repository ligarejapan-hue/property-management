import prisma from "@/lib/prisma";
import { ApiError, type ApiSession, type PermissionEntry } from "@/lib/api-helpers";
import { assertPropertyReadable } from "@/lib/agent-inquiry/property-access";
import { MAIL_CONFIG_ID } from "@/lib/mail/mail-config";
import { writeAuditLog } from "@/lib/audit";
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
  escapePrismaLikePattern,
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
  if (!(await keyBelongsOnlyTo(key, row.targetId))) return { ok: false };
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

/**
 * そのファイルを指す記録が、すべてこの物件のものか(@codex P2)。
 * ⚠authorizeUploadAccess は「その人が開けるか」しか見ない=両方の物件を開ける人は、別の物件のファイルを
 *   この物件の添付として登録し直して、この物件の反響から送れてしまう。送る資料は物件に縛る:
 *   別の物件・所有者に付いた添付(削除済みも)・別の物件の写真・棟の写真・巡回の写真(サムネイルも)・
 *   受け取り箱の置き場所・別の物件の置き場所・写真の置き場所は送らない。
 */
async function keyBelongsOnlyTo(key: string, propertyId: string): Promise<boolean> {
  if (key.startsWith("report-inbox/")) return false;
  // 置き場所(properties/<物件>/<種類>/…)が別の物件・写真なら、記録が無くても送らない(@codex 3巡目)。
  const place = /^properties\/([^/]+)\/([^/]+)\//.exec(key);
  if (place && (place[1] !== propertyId || place[2] === "photos")) return false;
  const like = { contains: escapePrismaLikePattern(key) };
  const same = (u: string | null | undefined) => resolveStoredFileUrlToKey(u) === key;
  const [atts, photos, buildingPhotos, pinPhotos] = await Promise.all([
    prisma.attachment.findMany({ where: { fileUrl: like }, select: { targetType: true, targetId: true, propertyId: true, fileUrl: true } }),
    prisma.propertyPhoto.findMany({
      where: { OR: [{ fileUrl: like }, { thumbnailUrl: like }] },
      select: { propertyId: true, fileUrl: true, thumbnailUrl: true },
    }),
    prisma.buildingPhoto.findMany({
      where: { OR: [{ fileUrl: like }, { thumbnailUrl: like }] },
      select: { fileUrl: true, thumbnailUrl: true },
    }),
    prisma.fieldSurveyPinPhoto.findMany({
      where: { OR: [{ fileUrl: like }, { thumbnailUrl: like }] },
      select: { fileUrl: true, thumbnailUrl: true },
    }),
  ]);
  const attachmentsOk = atts
    .filter((a) => same(a.fileUrl))
    .every((a) => a.targetType === "property" && a.targetId === propertyId && (a.propertyId == null || a.propertyId === propertyId));
  return (
    attachmentsOk &&
    photos.filter((p) => same(p.fileUrl) || same(p.thumbnailUrl)).every((p) => p.propertyId === propertyId) &&
    !buildingPhotos.some((b) => same(b.fileUrl) || same(b.thumbnailUrl)) &&
    !pinPhotos.some((p) => same(p.fileUrl) || same(p.thumbnailUrl))
  );
}

/**
 * 送信済みでまだ反響へ反映していない記録を反映する(反響を done・宛先を最後に送った先に)(@codex 2巡目 P2)。
 * ⚠送信のあとの反響の更新が落ちても、押し直し・記録を開いたときにここを通って反映し直す。
 *   印(inquiryAppliedAt)を先に付けた人だけが反響を書く=二重に書かない。反映済みなら何もしない。
 *   ⚠反響の version は見ないが、**送った後に反響が書き換えられていれば上書きしない**(手で開き直した・
 *   宛先を直した、を古い送信で戻さない)=印だけ付けて終える。
 */
export async function applySentMaterialToInquiry(
  inquiryId: string,
): Promise<{ version: number; statusChanged: boolean; wrote: boolean } | null> {
  const pending = await prisma.agentInquiryMaterialSend.findMany({
    where: { inquiryId, result: "sent", inquiryAppliedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, toAddress: true, finishedAt: true },
  });
  if (pending.length === 0) return null;
  const last = pending[pending.length - 1];
  const to = last.toAddress;
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.agentInquiryMaterialSend.updateMany({
      where: { id: { in: pending.map((p) => p.id) }, inquiryAppliedAt: null },
      data: { inquiryAppliedAt: new Date() },
    });
    if (claimed.count === 0) return null;
    const cur = await tx.agentInquiry.findUnique({
      where: { id: inquiryId },
      select: { status: true, contactEmail: true, version: true, updatedAt: true },
    });
    if (!cur) return null;
    const touchedAfterSend = cur.updatedAt != null && last.finishedAt != null && cur.updatedAt > last.finishedAt;
    const changeEmail = (cur.contactEmail ?? "") !== to;
    if (touchedAfterSend || (cur.status === "done" && !changeEmail)) {
      return { version: cur.version, statusChanged: false, wrote: false };
    }
    const u = await tx.agentInquiry.update({
      where: { id: inquiryId },
      data: { status: "done", ...(changeEmail ? { contactEmail: to } : {}), version: { increment: 1 } },
      select: { version: true },
    });
    return { version: u.version, statusChanged: cur.status !== "done", wrote: true };
  });
}

/** 送れたのに反響へ反映できていない記録があるか(読むだけ=書き換えない)。 */
export async function hasUnappliedMaterialSend(inquiryId: string): Promise<boolean> {
  return (await prisma.agentInquiryMaterialSend.count({ where: { inquiryId, result: "sent", inquiryAppliedAt: null } })) > 0;
}

/**
 * 反映し直し(押し直し・反映し直しの口)。書き換えたときは監査に残す。落ちても画面の操作は止めない。
 * ⚠呼ぶ側で agent_inquiry:write と物件を開けることを確かめてから呼ぶ。
 */
export async function reconcileMaterialSends(inquiryId: string, userId: string): Promise<boolean> {
  try {
    const a = await applySentMaterialToInquiry(inquiryId);
    if (!a?.wrote) return false;
    await writeAuditLog({
      userId,
      action: "agent_inquiry_material_apply",
      targetTable: "agent_inquiries",
      targetId: inquiryId,
      detail: { statusChanged: a.statusChanged },
    });
    return true;
  } catch (e) {
    console.error("[material-send] inquiry reconcile failed", { name: e instanceof Error ? e.name : "Unknown" });
    return false;
  }
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
