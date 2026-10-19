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
  escapePrismaLikePattern,
  isOwnerPiiDocumentType,
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

const BATCH = 50;
type KeyRecords = {
  atts: { targetType: string; targetId: string; propertyId: string | null; type: string }[];
  photoPropertyIds: string[];
  other: boolean; // 棟の写真・巡回の写真
};

/**
 * 頼まれたファイルを指す全部の記録を、まとめて引く(ファイルの数によらず 4 表 × 50 件ごと・@codex 4巡目 P2)。
 * 同じファイル(正規化した key の完全一致)だけを数える。
 */
async function loadKeyRecords(keys: string[]): Promise<Map<string, KeyRecords>> {
  const out = new Map<string, KeyRecords>(keys.map((k) => [k, { atts: [], photoPropertyIds: [], other: false }]));
  const keyOf = (u: string | null | undefined) => {
    const k = resolveStoredFileUrlToKey(u);
    return k != null && out.has(k) ? k : null;
  };
  for (let i = 0; i < keys.length; i += BATCH) {
    const likes = keys.slice(i, i + BATCH).map((k) => ({ contains: escapePrismaLikePattern(k) }));
    const both = likes.flatMap((like) => [{ fileUrl: like }, { thumbnailUrl: like }]);
    const [atts, photos, buildingPhotos, pinPhotos] = await Promise.all([
      prisma.attachment.findMany({
        where: { OR: likes.map((like) => ({ fileUrl: like })) },
        select: { targetType: true, targetId: true, propertyId: true, fileUrl: true, type: true },
      }),
      prisma.propertyPhoto.findMany({ where: { OR: both }, select: { propertyId: true, fileUrl: true, thumbnailUrl: true } }),
      prisma.buildingPhoto.findMany({ where: { OR: both }, select: { fileUrl: true, thumbnailUrl: true } }),
      prisma.fieldSurveyPinPhoto.findMany({ where: { OR: both }, select: { fileUrl: true, thumbnailUrl: true } }),
    ]);
    for (const a of atts) {
      const k = keyOf(a.fileUrl);
      if (k) out.get(k)!.atts.push(a);
    }
    for (const p of photos) {
      for (const k of new Set([keyOf(p.fileUrl), keyOf(p.thumbnailUrl)])) if (k) out.get(k)!.photoPropertyIds.push(p.propertyId);
    }
    for (const p of [...buildingPhotos, ...pinPhotos]) {
      for (const k of [keyOf(p.fileUrl), keyOf(p.thumbnailUrl)]) if (k) out.get(k)!.other = true;
    }
  }
  return out;
}

/**
 * そのファイルを送ってよいか(記録だけで決める・DB は引かない)。
 * ⚠送る資料は物件に縛る(@codex P2・3巡目): 両方の物件を開ける人が別の物件のファイルをこの物件の添付として
 *   登録し直しても送らない。別の物件・所有者に付いた添付(削除済みも)・別の物件の写真・棟の写真・巡回の写真
 *   (サムネイルも)・受け取り箱の置き場所・別の物件の置き場所・写真の置き場所は送らない。
 * ⚠反響資料・査定報告書の記録(削除済みも)が同じファイルを指せば送らない。謄本の記録が指せば謄本として扱う。
 */
function decideMaterialFile(
  row: MaterialAttachmentRow,
  key: string,
  rec: KeyRecords,
  perms: PermissionEntry[],
): MaterialFileGuard {
  const propertyId = row.targetId;
  if (key.startsWith("report-inbox/")) return { ok: false };
  const place = /^properties\/([^/]+)\/([^/]+)\//.exec(key);
  if (place && (place[1] !== propertyId || place[2] === "photos")) return { ok: false };
  if (rec.other || rec.photoPropertyIds.some((id) => id !== propertyId)) return { ok: false };
  const onlyHere = rec.atts.every(
    (a) => a.targetType === "property" && a.targetId === propertyId && (a.propertyId == null || a.propertyId === propertyId),
  );
  if (!onlyHere || rec.atts.some((a) => isOwnerPiiDocumentType(a.type))) return { ok: false };
  const effectiveType = row.type === "registry" || rec.atts.some((a) => a.type === "registry") ? "registry" : "general";
  if (
    effectiveType === "registry" &&
    !(hasPermission(perms, "registry_pdf", "preview") && hasPermission(perms, "registry_pdf", "download"))
  ) {
    return { ok: false };
  }
  return { ok: true, key, effectiveType };
}

/**
 * 候補の一覧用: 記録をまとめて引いて決める(行ごとに DB を引かない・@codex 4巡目 P2)。
 * ⚠物件を開けることは呼ぶ側(loadMaterialInquiry)で確かめ済み。送る直前は guardMaterialFiles でさらに
 *   /uploads と同じ判定も通す。
 */
export async function screenMaterialFiles(
  rows: MaterialAttachmentRow[],
  perms: PermissionEntry[],
): Promise<Map<string, MaterialFileGuard>> {
  const keyed = rows.map((r) => ({ r, key: resolveStoredFileUrlToKey(r.fileUrl) }));
  const records = await loadKeyRecords([...new Set(keyed.flatMap((x) => (x.key ? [x.key] : [])))]);
  return new Map(
    keyed.map(({ r, key }): [string, MaterialFileGuard] => [r.id, key ? decideMaterialFile(r, key, records.get(key)!, perms) : { ok: false }]),
  );
}

/**
 * 送る直前の守り(最大 20 ファイル)。まとめての判定に加えて、/uploads で開くときと同じ守り
 * (authorizeUploadAccess をダウンロードの扱いで・resolveProtectedServeMeta)を1つずつ通す(最終レビュー C1)。
 * ⚠添付の記録は手で fileUrl を書いて登録できる(JSON の登録口)=記録の種類と物件だけでは足りない。
 */
export async function guardMaterialFiles(
  rows: MaterialAttachmentRow[],
  session: ApiSession,
  perms: PermissionEntry[],
): Promise<MaterialFileGuard[]> {
  const screened = await screenMaterialFiles(rows, perms);
  const out: MaterialFileGuard[] = [];
  for (const r of rows) {
    const g = screened.get(r.id)!;
    if (!g.ok) {
      out.push(g);
      continue;
    }
    if ((await authorizeUploadAccess({ key: g.key, session, permissions: perms, downloadIntent: true })) !== "ok") {
      out.push({ ok: false });
      continue;
    }
    const meta = await resolveProtectedServeMeta(g.key);
    if (meta !== null && meta.kind !== "registry") {
      out.push({ ok: false });
      continue;
    }
    if (meta?.kind === "registry" && g.effectiveType !== "registry") {
      out.push(
        hasPermission(perms, "registry_pdf", "preview") && hasPermission(perms, "registry_pdf", "download")
          ? { ok: true, key: g.key, effectiveType: "registry" }
          : { ok: false },
      );
      continue;
    }
    out.push(g);
  }
  return out;
}

/**
 * 送信済みでまだ反響へ反映していない記録を反映する(反響を done・宛先を最後に送った先に)(@codex 2巡目 P2)。
 * ⚠送信のあとの反響の更新が落ちても、押し直し・記録を開いたときにここを通って反映し直す。
 *   印(inquiryAppliedAt)を先に付けた人だけが反響を書く=二重に書かない。反映済みなら何もしない。
 *   ⚠反響の version は見ないが、**送った時点から手で変えられた欄は上書きしない**(状態を戻した・宛先を直した、
 *   を古い送信で戻さない)。メモ・担当など別の欄の変更では止めない(@codex 8巡目)。比べるのは
 *   最初の未反映の送信の時点(statusAtSend / contactEmailAtSend)。
 */
export async function applySentMaterialToInquiry(
  inquiryId: string,
  actorUserId: string,
): Promise<{ version: number; statusChanged: boolean; contactChanged: boolean; wrote: boolean } | null> {
  const pendingWhere = { inquiryId, result: "sent" as const, inquiryAppliedAt: null };
  if ((await prisma.agentInquiryMaterialSend.findMany({ where: pendingWhere, select: { id: true }, take: 1 })).length === 0) {
    return null;
  }
  return prisma.$transaction(async (tx) => {
    // 同じ反響の反映し直しは1つずつ(反響の行を押さえてから読む・@codex 9巡目 P2)。
    await tx.$queryRaw`SELECT id FROM agent_inquiries WHERE id = ${inquiryId}::uuid FOR UPDATE`;
    const pending = await tx.agentInquiryMaterialSend.findMany({
      where: pendingWhere,
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        toAddress: true,
        statusAtSend: true,
        contactEmailAtSend: true,
        statusEditSeqAtSend: true,
        contactEmailEditSeqAtSend: true,
        createdAt: true,
      },
    });
    if (pending.length === 0) return null;
    const claimed = await tx.agentInquiryMaterialSend.updateMany({
      where: { id: { in: pending.map((p) => p.id) }, inquiryAppliedAt: null },
      data: { inquiryAppliedAt: new Date() },
    });
    if (claimed.count === 0) return null;
    const cur = await tx.agentInquiry.findUnique({
      where: { id: inquiryId },
      select: { status: true, contactEmail: true, version: true, statusEditSeq: true, contactEmailEditSeq: true },
    });
    if (!cur) return null;
    const latest = pending[pending.length - 1];
    // 後から作った送信が先に反映済みなら、古い送信では宛先も状態も書かない(順番が入れ替わって終わった=
    // その後の手の変更を古い時点で戻さない・@codex 20・21巡目 P2)。
    const newerApplied = await tx.agentInquiryMaterialSend.findMany({
      where: {
        inquiryId,
        result: "sent",
        inquiryAppliedAt: { not: null },
        createdAt: { gt: latest.createdAt },
        id: { notIn: pending.map((p) => p.id) },
      },
      take: 1,
      select: { id: true },
    });
    // ⚠送った後に人が変えたかは、値の一致ではなく**人が変えた回数**で見る(@codex 22巡目 P2): 元の値に戻した・
    //   資料送付が書いた値(回数は増えない)・メモや担当だけの変更、をどれも取り違えない。比べるのは最新の未反映の送信の時点。
    const statusUntouched = cur.statusEditSeq === latest.statusEditSeqAtSend;
    const emailUntouched = cur.contactEmailEditSeq === latest.contactEmailEditSeqAtSend;
    const to = latest.toAddress;
    const setDone = statusUntouched && cur.status !== "done" && newerApplied.length === 0;
    const setEmail = emailUntouched && (cur.contactEmail ?? "") !== to && newerApplied.length === 0;
    if (!setDone && !setEmail) return { version: cur.version, statusChanged: false, contactChanged: false, wrote: false };
    const u = await tx.agentInquiry.update({
      where: { id: inquiryId },
      data: { ...(setDone ? { status: "done" as const } : {}), ...(setEmail ? { contactEmail: to } : {}), version: { increment: 1 } },
      select: { version: true },
    });
    // 反響を書いた監査は、反映済みの印・反響の書き込みと同じ取引で(監査だけ抜けない・@codex 12巡目 P2)。
    await tx.auditLog.create({
      data: {
        userId: actorUserId,
        action: "agent_inquiry_material_apply",
        targetTable: "agent_inquiries",
        targetId: inquiryId,
        detail: { statusChanged: setDone, contactChanged: setEmail },
      },
    });
    return { version: u.version, statusChanged: setDone, contactChanged: setEmail, wrote: true };
  });
}

/** 送れたのに反響へ反映できていない記録があるか(読むだけ=書き換えない)。 */
export async function hasUnappliedMaterialSend(inquiryId: string): Promise<boolean> {
  return (await prisma.agentInquiryMaterialSend.count({ where: { inquiryId, result: "sent", inquiryAppliedAt: null } })) > 0;
}

/**
 * 反映し直し(押し直し・反映し直しの口)。書き換えたときの監査は反映と同じ取引で書く。落ちても画面の操作は止めない。
 * ⚠呼ぶ側で agent_inquiry:write と物件を開けることを確かめてから呼ぶ。
 */
export async function reconcileMaterialSends(inquiryId: string, userId: string): Promise<boolean> {
  try {
    const a = await applySentMaterialToInquiry(inquiryId, userId);
    return a?.wrote === true;
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
