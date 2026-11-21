/**
 * 受領したお客様の書類を、取引の物件の「添付」へ写す(2026-11-21 発注者依頼)。
 *
 * - 写すのは受領したファイルだけ。元のファイル(提出の記録)はそのまま残す=写し。
 *   ⚠添付を消すと置き場所のファイルも消える仕組みなので、元のファイルを添付から指さない(提出ファイルは消さない決定)。
 * - 置き場所は書類のファイルごとに決まった名前(`deal-doc-<ファイルid>`)。同じファイルを二度入れない
 *   (受領のときと、前の分を入れる一回きりのスクリプトが重なっても1件)。人が添付を消したものも入れ直さない。
 * - 種類: 身分証明書・印鑑証明書・住民票・納税証明書=「本人確認書類」(開けるのは所有者情報をすべて見られる人だけ
 *   =発注者決定 2026-11-21)。物件の書類はそれぞれ合う種類。
 *   ⚠分からない書類(前の書類確認書の項目=登記識別情報など)も「本人確認書類」で守る(見せすぎより守りすぎ・内部レビュー)。
 * - 取引の書類として付ける(dealId)。取引が物件につながっていない・物件がしまってある → 入れない(理由を返す)。
 * - 名前は書類名だけ(お客様の名前・元のファイル名は使わない)。
 */
import { randomUUID } from "node:crypto";
import type { StorageAdapter } from "@/lib/storage/types";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { removeFileAndVerify } from "@/lib/report-inbox/remove-file";
import { docColumnsForKnownKind } from "@/lib/doc-classify/assign";
import { IDENTITY_DOC_KIND } from "@/lib/attachments/identity-display-name";

/** 提出書類の id → 添付の種類(src/lib/doc-classify/classify.ts の code)。無い id は本人確認書類(守る側)。 */
export const ATTACH_KIND_BY_ITEM: Readonly<Record<string, string>> = {
  s_bring_id: IDENTITY_DOC_KIND,
  s_bring_seal: IDENTITY_DOC_KIND,
  s_bring_resident: IDENTITY_DOC_KIND,
  doc_tax_certificate: IDENTITY_DOC_KIND,
  doc_property_tax_notice: "tax_certificate",
  doc_hoa_minutes: "assembly_minutes",
  doc_purchase_brochure: "brochure",
  s_recv_survey: "drawings",
  s_recv_leases: "lease_contract",
};

/** 受領・差し戻しの履歴(DealDocReviewEvent.action)に足す値=物件の添付へ入れ終えた印。 */
export const ATTACHED_EVENT = "attached";

export const attachKindFor =(checklistItemId: string): string => ATTACH_KIND_BY_ITEM[checklistItemId] ?? IDENTITY_DOC_KIND;

const EXT_BY_MIME: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
export const extOfMime = (mimeType: string): string => EXT_BY_MIME[mimeType] ?? "bin";

/**
 * 添付の置き場所。書類のファイル id に、写すたびの印(attempt)を足す
 * =写しは毎回別の名前 → 記録を作れなかった写しは自分で消せる(誰も指していない・セキュリティレビュー)。
 */
export const receivedAttachmentKey = (propertyId: string, fileId: string, mimeType: string, attempt: string): string =>
  `properties/${propertyId}/attachments/deal-doc-${fileId}-${attempt}.${extOfMime(mimeType)}`;

/** 置き場所の名前に含まれる印(すでに入れたかを探す)。ファイル id は長さが決まった uuid なので前方一致の取り違えはない。 */
export const receivedAttachmentMarker = (fileId: string): string => `/deal-doc-${fileId}`;

/** 添付の名前=書類名(+複数枚なら番号)。ファイル名に使えない文字は除く。 */
export function receivedAttachmentFileName(label: string, mimeType: string, index: number, total: number): string {
  const base = label.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim().slice(0, 80) || "提出書類";
  const n = total > 1 ? `_${index + 1}` : "";
  return `${base}${n}.${extOfMime(mimeType)}`;
}

export type AttachSkip = "no_property" | "archived" | "no_permission" | null;
export interface AttachOutcome {
  /** 今回入れた数 */
  attached: number;
  /** すでに入っていた(または人が消した)ので入れなかった数 */
  existing: number;
  /** 元のファイルが読めない・保存に失敗した数 */
  failed: number;
  /** 取引ごと入れなかった理由 */
  skipped: AttachSkip;
  /** 入れた添付の id(監査用) */
  attachmentIds: string[];
}

type Fn = (...args: never[]) => Promise<unknown>;
/** 使う prisma の形(テストで差し替える)。 */
export interface AttachDb {
  dealDocRequest: { findFirst: Fn };
  property: { findUnique: Fn };
  attachment: { findFirst: Fn; findMany: Fn; create: Fn };
  dealDocReviewEvent: { create: Fn };
  $transaction: <T>(fn: (tx: never) => Promise<T>) => Promise<T>;
}

type RequestRow = {
  checklistItemId: string;
  label: string;
  link: { deal: { propertyId: string | null } };
  files: { id: string; storageKey: string; mimeType: string; fileSize: number }[];
  reviewEvents: { id: string }[];
};
type PropertyRow = {
  id: string; isArchived: boolean; buildingName: string | null; roomNo: string | null; address: string;
  createdBy: string; assignedTo: string | null;
};

class AlreadyAttached extends Error {}
class Skip extends Error { constructor(readonly reason: Exclude<AttachSkip, null>) { super(reason); } }

/** 押した人がこの物件の添付を増やせるか(しまってある・担当外は入れない)。押した人がいない(スクリプト)ときは確かめない。 */
function skipReason(p: { isArchived: boolean; createdBy: string; assignedTo: string | null }, actor?: { id: string; role: string }): AttachSkip {
  if (p.isArchived) return "archived";
  if (actor && !canAccessPropertyRecord(actor, p)) return "no_permission";
  return null;
}

/**
 * 受領した書類1つ分のファイルを添付へ写す。何度呼んでも同じファイルは1件だけ。
 * ⚠受領そのものは先に確定している(ここが失敗しても受領は戻さない)。
 */
export async function attachReceivedDocFiles(args: {
  db: AttachDb;
  storage: StorageAdapter;
  dealId: string;
  requestId: string;
  userId: string;
  now?: Date;
  /** true=数えるだけ(写さない・書き込まない)。attached は「入れる予定の数」。 */
  dryRun?: boolean;
  /** 押した人。物件の担当の範囲を確かめる(受け取り箱から添付するときと同じ)。 */
  actor?: { id: string; role: string };
  /** 写すたびの印(テスト用) */
  newAttempt?: () => string;
}): Promise<AttachOutcome> {
  const { db, storage, dealId, requestId, userId } = args;
  const out: AttachOutcome = { attached: 0, existing: 0, failed: 0, skipped: null, attachmentIds: [] };
  const req = (await db.dealDocRequest.findFirst({
    where: { id: requestId, status: "received", link: { dealId } },
    select: {
      checklistItemId: true,
      label: true,
      link: { select: { deal: { select: { propertyId: true } } } },
      files: { where: { reviewState: "received" }, orderBy: { createdAt: "asc" }, select: { id: true, storageKey: true, mimeType: true, fileSize: true } },
      reviewEvents: { where: { action: ATTACHED_EVENT }, select: { id: true }, take: 1 },
    },
  } as never)) as RequestRow | null;
  if (!req || req.files.length === 0) return out;
  // 一度入れ終えた書類は二度と入れない(人が消した添付が90日後に記録ごと消えても・@codex P2)
  if (req.reviewEvents.length > 0) return { ...out, existing: req.files.length };
  const propertyId = req.link.deal.propertyId;
  if (!propertyId) return { ...out, skipped: "no_property" };
  const property = (await db.property.findUnique({
    where: { id: propertyId },
    select: { id: true, isArchived: true, buildingName: true, roomNo: true, address: true, createdBy: true, assignedTo: true },
  } as never)) as PropertyRow | null;
  if (!property) return { ...out, skipped: "no_property" };
  const first = skipReason(property, args.actor);
  if (first) return { ...out, skipped: first };

  const kind = attachKindFor(req.checklistItemId);
  for (const [i, file] of req.files.entries()) {
    const marker = receivedAttachmentMarker(file.id);
    // 人が消した添付(isDeleted)も含めて探す=消したものを入れ直さない
    if (await db.attachment.findFirst({ where: { propertyId, fileUrl: { contains: marker } }, select: { id: true } } as never)) {
      out.existing++;
      continue;
    }
    if (args.dryRun) { out.attached++; continue; }
    const key = receivedAttachmentKey(propertyId, file.id, file.mimeType, (args.newAttempt ?? randomUUID)());
    const fileName = receivedAttachmentFileName(req.label, file.mimeType, i, req.files.length);
    let url: string;
    try {
      const src = await storage.read(file.storageKey);
      if (!src) { out.failed++; continue; }
      url = (await storage.upload(Buffer.from(src.body as Uint8Array), { key, mimeType: file.mimeType, fileName })).url;
    } catch (e) {
      console.error("[deal-doc-attach] copy failed", (e as { code?: unknown })?.code ?? "");
      out.failed++;
      continue;
    }
    try {
      const id = await db.$transaction(async (tx: never) => {
        const t = tx as unknown as AttachDb & { $queryRaw: Fn };
        // 物件配下を書き換える tx は親を先にロック(書き込み規約)
        await lockPropertyRow(t as never, propertyId);
        // ⚠ロックを取ってからもう一度確かめる(その間にしまわれた・担当が替わった)
        const locked = (await t.property.findUnique({
          where: { id: propertyId }, select: { isArchived: true, createdBy: true, assignedTo: true },
        } as never)) as Pick<PropertyRow, "isArchived" | "createdBy" | "assignedTo"> | null;
        if (!locked) throw new Skip("no_property");
        const again = skipReason(locked, args.actor);
        if (again) throw new Skip(again);
        if (await t.attachment.findFirst({ where: { propertyId, fileUrl: { contains: marker } }, select: { id: true } } as never)) {
          throw new AlreadyAttached();
        }
        const taken = (await t.attachment.findMany({
          where: { targetType: "property", targetId: propertyId, isDeleted: false, docTitle: { not: null } },
          select: { docTitle: true },
        } as never)) as { docTitle: string | null }[];
        const columns = docColumnsForKnownKind(
          { kindCode: kind, confidence: "high", fileName, dateStamp: null, now: args.now },
          {
            property: { buildingName: property.buildingName, roomNo: property.roomNo, address: property.address },
            takenTitles: new Set(taken.map((r) => r.docTitle).filter((v): v is string => v !== null)),
          },
        );
        const created = (await t.attachment.create({
          data: {
            targetType: "property",
            targetId: propertyId,
            propertyId,
            type: "general",
            fileName,
            fileUrl: url,
            fileSize: file.fileSize,
            mimeType: file.mimeType,
            uploadedBy: userId,
            dealId,
            ...columns,
          },
          select: { id: true },
        } as never)) as { id: string };
        return created.id;
      });
      out.attached++;
      out.attachmentIds.push(id);
    } catch (e) {
      // 記録を作らなかった写しは消す(写すたびに別の名前=ほかの添付は指していない)。個人情報の入った写しを残さない。
      await removeFileAndVerify(storage, key);
      if (e instanceof AlreadyAttached) { out.existing++; continue; }
      if (e instanceof Skip) { out.skipped = e.reason; return out; }
      console.error("[deal-doc-attach] create failed", (e as { code?: unknown })?.code ?? "");
      out.failed++;
    }
  }
  // 全部入れ終えたら(入っていた分も含めて)、受領・差し戻しの履歴に「添付に入れた」を残す=消えない印。
  // 失敗が1つでもあれば残さない(次に流したときに入れ直せるように)。
  if (!args.dryRun && out.failed === 0 && out.skipped === null && out.attached + out.existing > 0) {
    await db.dealDocReviewEvent.create({
      data: { requestId, action: ATTACHED_EVENT, reason: null, reviewedById: userId, createdAt: args.now ?? new Date() },
    } as never);
  }
  return out;
}

export interface BackfillDb extends AttachDb {
  dealDocRequest: { findFirst: Fn; findMany: Fn };
}
export interface BackfillResult { requests: number; attached: number; existing: number; failed: number; noProperty: number; archived: number }

/**
 * 前に受領した書類を、まとめて添付へ入れる(一回きり・何度流しても同じ)。apply=false は数えるだけ。
 * 入れた人(uploadedBy)は受領した人。その人の記録が無ければリンクを発行した人。
 */
export async function backfillReceivedDocAttachments(args: { db: BackfillDb; storage: StorageAdapter; apply: boolean }): Promise<BackfillResult> {
  const rows = (await args.db.dealDocRequest.findMany({
    where: { status: "received", files: { some: { reviewState: "received" } } },
    orderBy: { reviewedAt: "asc" },
    select: { id: true, reviewedById: true, link: { select: { dealId: true, createdById: true } } },
  } as never)) as { id: string; reviewedById: string | null; link: { dealId: string; createdById: string } }[];
  const r: BackfillResult = { requests: rows.length, attached: 0, existing: 0, failed: 0, noProperty: 0, archived: 0 };
  for (const row of rows) {
    const o = await attachReceivedDocFiles({
      db: args.db, storage: args.storage, dealId: row.link.dealId, requestId: row.id,
      userId: row.reviewedById ?? row.link.createdById, dryRun: !args.apply,
    });
    r.attached += o.attached; r.existing += o.existing; r.failed += o.failed;
    if (o.skipped === "no_property") r.noProperty++;
    if (o.skipped === "archived") r.archived++;
  }
  return r;
}

/** 受領の応答に添える一言(画面に出す)。 */
export function attachNotice(o: AttachOutcome): { notice: string | null; warning: string | null } {
  if (o.skipped === "no_property") return { notice: "受領しました。この取引は物件につながっていないので、添付には入れていません。", warning: null };
  if (o.skipped === "archived") return { notice: "受領しました。物件がしまってあるので、添付には入れていません。", warning: null };
  if (o.skipped === "no_permission") return { notice: "受領しました。この物件の担当ではないので、添付には入れていません。", warning: null };
  const warning = o.failed > 0
    ? `${o.failed}件のファイルを物件の添付に入れられませんでした。この画面からダウンロードして、物件の添付に入れてください。`
    : null;
  const notice = o.attached > 0 ? `受領しました。物件の添付に${o.attached}件入れました。` : "受領しました。";
  return { notice, warning };
}
