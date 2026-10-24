/**
 * ドライブの見回り(第2段b)の DB と保存場所の読み書き。手順は sync-link.ts。
 * ⚠取り込んだファイルは今の添付・受け取り箱・写真の登録と同じ守りを通す:
 *   添付=物件の置き場所+親の物件行ロック+種類の自動判別(本人確認書類なら 1c の守り)
 *   受け取り箱=report-inbox/ の下(所有者情報の書類として守られる)
 *   写真=位置情報(EXIF)を消してから置く
 * ⚠監査ログ・journal にファイル名・フォルダ名を書かない(所有者名を含み得る)。
 */
import { randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getStorage } from "@/lib/storage";
import { UPLOADS_PREFIX } from "@/lib/storage/url-to-key";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { extractHeadTextFromPdf, isPdfBuffer } from "@/lib/pdf-extract";
import {
  docColumnsForKnownKind,
  docColumnsForNewAttachment,
  type DocColumns,
} from "@/lib/doc-classify/assign";
import { classifyDocument, type DocStageCode } from "@/lib/doc-classify/classify";
import { extractDocumentDate, fileExtension } from "@/lib/doc-classify/title";
import { reportInboxStorageKey, SCRUB_ON_DISCARD } from "@/lib/report-inbox/access";
import { removeFileAndVerify } from "@/lib/report-inbox/remove-file";
import { stripFieldSurveyPhotoMetadata } from "@/lib/field-survey/exif-strip";
import type { DriveItem } from "./client";
import type { LedgerRow, LedgerWrite, LinkInfo, OutCandidate, SyncRepo } from "./sync-link";

const IDENTITY_DOC_KIND = "identity_document";

function safeExt(name: string, mimeType: string): string {
  const e = fileExtension(name);
  if (e && /^[a-z0-9]{1,8}$/.test(e)) return e;
  return mimeType === "application/pdf" ? "pdf" : "bin";
}

async function headText(body: Buffer, mimeType: string): Promise<string | null> {
  if (mimeType !== "application/pdf" || !isPdfBuffer(body)) return null;
  try {
    return await extractHeadTextFromPdf(body);
  } catch {
    return null;
  }
}

function assertPdfLooksRight(item: DriveItem, body: Buffer): void {
  if (item.mimeType === "application/pdf" && !isPdfBuffer(body)) throw new Error("not_pdf");
}

const OUT_SELECT = {
  id: true,
  type: true,
  docKind: true,
  docStage: true,
  docTitle: true,
  fileName: true,
  fileUrl: true,
  fileSize: true,
  mimeType: true,
  isDeleted: true,
  driveFileId: true,
} as const;

/** 写しを置く・取り込むときに使う人(接続した管理者)。 */
export function createSyncRepo(uploaderId: string): SyncRepo {
  const storage = getStorage();

  return {
    async ledger(linkId, driveFileIds): Promise<LedgerRow[]> {
      return prisma.driveSyncFile.findMany({
        // ほかの物件の行でも、いま見えるファイルの行なら読む(扱い済みのファイルを二度取り込まない・行を奪い合わない)
        where: { OR: [{ folderLinkId: linkId }, { driveFileId: { in: driveFileIds } }] },
        select: {
          driveFileId: true,
          md5: true,
          direction: true,
          status: true,
          name: true,
          attachmentId: true,
          modifiedTime: true,
        },
      });
    },

    async attachmentsForLink(
      propertyId,
    ): Promise<{ toCopy: OutCandidate[]; copied: OutCandidate[] }> {
      const [toCopy, copied] = await Promise.all([
        prisma.attachment.findMany({
          // 本人確認書類は複製しない=候補にも入れない(溜まって他の書類の番が来なくならないように)
          where: {
            targetType: "property",
            targetId: propertyId,
            type: "general",
            isDeleted: false,
            driveFileId: null,
            OR: [{ docKind: null }, { docKind: { not: IDENTITY_DOC_KIND } }],
          },
          select: OUT_SELECT,
          orderBy: { createdAt: "asc" },
          take: 200,
        }),
        prisma.attachment.findMany({
          where: {
            targetType: "property",
            targetId: propertyId,
            type: "general",
            isDeleted: false,
            driveFileId: { not: null },
          },
          select: OUT_SELECT,
          // ⚠上限を付けない=名前合わせ・本人確認に直した写しの片付けから漏れる添付を作らない(@codex #580 R3)
        }),
      ]);
      return { toCopy, copied };
    },

    async readAttachment(fileUrl) {
      const key = storage.keyFromUrl(fileUrl);
      if (!key) return null;
      const r = await storage.read(key);
      return r ? r.body : null;
    },

    async markCopied(attachmentId, w) {
      return prisma.$transaction(async (tx) => {
        // ⚠同じ添付に写しが付いていれば何もしない(見回りが重なっても写しは1つ)
        const set = await tx.attachment.updateMany({
          where: { id: attachmentId, driveFileId: null, isDeleted: false },
          data: { driveFileId: w.item.id },
        });
        if (set.count !== 1) return false;
        await upsertLedger(tx, w);
        return true;
      });
    },

    async linkExisting(attachmentId, driveFileId) {
      const set = await prisma.attachment.updateMany({
        where: { id: attachmentId, driveFileId: null, isDeleted: false },
        data: { driveFileId },
      });
      return set.count === 1;
    },

    async markWithdrawn(driveFileId) {
      await prisma.driveSyncFile.updateMany({ where: { driveFileId }, data: { status: "withdrawn" } });
    },

    async renameLedger(driveFileId, name) {
      await prisma.driveSyncFile.updateMany({ where: { driveFileId }, data: { name } });
    },

    async record(w) {
      await upsertLedger(prisma, w);
    },

    async importAttachment(
      link: LinkInfo,
      item: DriveItem,
      body: Buffer,
      stageHint: DocStageCode | null,
      ledger: LedgerWrite,
    ) {
      assertPdfLooksRight(item, body);
      const property = await prisma.property.findUnique({
        where: { id: link.propertyId },
        select: { buildingName: true, roomNo: true, address: true },
      });
      if (!property) throw new Error("property_missing");
      const text = await headText(body, item.mimeType);
      const key = `properties/${link.propertyId}/attachments/${Date.now()}-${randomUUID()}.${safeExt(item.name, item.mimeType)}`;
      const uploaded = await storage.upload(body, {
        key,
        mimeType: item.mimeType,
        fileName: item.name,
      });
      try {
        const att = await prisma.$transaction(async (tx) => {
          await lockPropertyRow(tx, link.propertyId);
          const existing = await tx.attachment.findMany({
            where: {
              targetType: "property",
              targetId: link.propertyId,
              isDeleted: false,
              docTitle: { not: null },
            },
            select: { docTitle: true },
          });
          const ctx = {
            property,
            takenTitles: new Set(
              existing.map((e) => e.docTitle).filter((t): t is string => t !== null),
            ),
          };
          let doc: DocColumns;
          if (stageHint === "identity") {
            // 本人確認書類のフォルダに置かれたもの=本人確認書類として守る(開ける人を絞る)
            doc = docColumnsForKnownKind(
              {
                kindCode: IDENTITY_DOC_KIND,
                confidence: "low",
                fileName: item.name,
                dateStamp: extractDocumentDate(text),
              },
              ctx,
            );
          } else {
            doc = docColumnsForNewAttachment({ fileName: item.name, text }, ctx);
            // 種類が当たらなければ、置かれたフォルダの段階に入れる(種類は「種類を確認」で人が決める)
            if (doc.docKind === null && stageHint) doc = { ...doc, docStage: stageHint };
          }
          const created = await tx.attachment.create({
            data: {
              targetType: "property",
              targetId: link.propertyId,
              propertyId: link.propertyId,
              type: "general",
              fileName: item.name,
              fileUrl: uploaded.url,
              fileSize: body.length,
              mimeType: item.mimeType,
              uploadedBy: uploaderId,
              // ⚠取り込んだもの=ドライブに原本がある。ドライブへ複製し直さない(往復しない)
              driveFileId: item.id,
              ...doc,
            },
            select: { id: true, docKind: true },
          });
          // 台帳も同じ tx で(取り込めたのに台帳が無い=次の見回りでもう一度、を作らない)
          await upsertLedger(tx, { ...ledger, attachmentId: created.id });
          return created;
        });
        await writeAuditLog({
          userId: uploaderId,
          action: "create",
          targetTable: "attachments",
          targetId: att.id,
          detail: { propertyId: link.propertyId, source: "drive_sync", docKind: att.docKind },
        });
        return att.id;
      } catch (e) {
        await storage.delete(uploaded.key).catch(() => undefined);
        throw e;
      }
    },

    async importInbox(link: LinkInfo, item: DriveItem, body: Buffer, ledger: LedgerWrite) {
      assertPdfLooksRight(item, body);
      const property = await prisma.property.findUnique({
        where: { id: link.propertyId },
        select: { buildingName: true, roomNo: true, address: true },
      });
      const text = await headText(body, item.mimeType);
      const classification = classifyDocument({ fileName: item.name, text });
      const ext = safeExt(item.name, item.mimeType);
      const key = reportInboxStorageKey(Date.now(), randomUUID(), ext);
      // 記録を先に作ってから置く(受け取り箱と同じ順・途中で止まっても一覧から消せる)。台帳も同じ tx で
      const row = await prisma.$transaction(async (tx) => {
        const created = await tx.reportInboxItem.create({
          data: {
            fileName: item.name,
            fileUrl: `${UPLOADS_PREFIX}${key}`,
            fileSize: body.length,
            mimeType: item.mimeType,
            source: "unknown",
            // 候補=紐づけた物件(フォルダ一致)。受け取り箱の候補探しはこの3つで物件を引く
            buildingName: property?.buildingName ?? null,
            roomNo: property?.roomNo ?? null,
            address: property?.address ?? null,
            docKind: classification?.kind ?? null,
            docStage: classification?.stage ?? null,
            docConfidence: classification?.confidence ?? null,
            docDate: extractDocumentDate(text),
            status: "uploading",
            uploadedBy: uploaderId,
          },
          select: { id: true, docKind: true },
        });
        await upsertLedger(tx, ledger);
        return created;
      });
      try {
        await storage.upload(body, { key, mimeType: item.mimeType, fileName: `document.${ext}` });
      } catch (e) {
        // 受け取り箱の口と同じ後片付け: 消せたら記録を「削除済み」にして名前・建物名・住所を消す。
        // 消せなければ「取り込み中」のまま残る=一覧に出て人が削除できる。台帳は呼び出し側が failed にする
        if (await removeFileAndVerify(storage, key)) {
          await prisma.reportInboxItem.updateMany({
            where: { id: row.id, status: "uploading" },
            data: { status: "discarded", resolvedAt: new Date(), ...SCRUB_ON_DISCARD },
          });
        }
        throw e;
      }
      const ready = await prisma.reportInboxItem.updateMany({
        where: { id: row.id, status: "uploading" },
        data: { status: "pending" },
      });
      if (ready.count !== 1) {
        // 置き終える前に誰かが削除した=置いたファイルを残さない(台帳は inbox のまま=取り込み直さない)
        await removeFileAndVerify(storage, key);
        return;
      }
      await writeAuditLog({
        userId: uploaderId,
        action: "create",
        targetTable: "report_inbox_items",
        targetId: row.id,
        detail: { source: "drive_sync", docKind: row.docKind },
      });
    },

    async importPhoto(link: LinkInfo, item: DriveItem, body: Buffer, ledger: LedgerWrite) {
      const stripped = stripFieldSurveyPhotoMetadata(body, item.mimeType);
      if (!stripped.ok) throw new Error(`photo_${stripped.reason}`);
      const key = `properties/${link.propertyId}/photos/${Date.now()}-${randomUUID()}.${safeExt(item.name, item.mimeType)}`;
      const uploaded = await storage.upload(stripped.buffer, {
        key,
        mimeType: item.mimeType,
        fileName: item.name,
      });
      let photo: { id: string };
      try {
        photo = await prisma.$transaction(async (tx) => {
          const maxSort = await tx.propertyPhoto.aggregate({
            where: { propertyId: link.propertyId },
            _max: { sortOrder: true },
          });
          const created = await tx.propertyPhoto.create({
            data: {
              propertyId: link.propertyId,
              fileUrl: uploaded.url,
              thumbnailUrl: uploaded.thumbnailUrl ?? null,
              fileName: item.name,
              fileSize: stripped.buffer.length,
              mimeType: item.mimeType,
              takenBy: uploaderId,
              sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
            },
            select: { id: true },
          });
          // 台帳も同じ tx で
          await upsertLedger(tx, ledger);
          return created;
        });
      } catch (e) {
        await storage.delete(uploaded.key).catch(() => undefined);
        throw e;
      }
      await writeAuditLog({
        userId: uploaderId,
        action: "photo_upload",
        targetTable: "property_photos",
        targetId: photo.id,
        detail: { propertyId: link.propertyId, source: "drive_sync" },
      });
    },
  };
}

type LedgerDb = Pick<typeof prisma, "driveSyncFile">;

async function upsertLedger(db: LedgerDb, w: LedgerWrite): Promise<void> {
  const modifiedTime = w.item.modifiedTime ? new Date(w.item.modifiedTime) : null;
  const data = {
    folderLinkId: w.linkId,
    md5: w.item.md5,
    name: w.item.name,
    mimeType: w.item.mimeType,
    size: w.item.size,
    modifiedTime: modifiedTime && !Number.isNaN(modifiedTime.getTime()) ? modifiedTime : null,
    direction: w.direction,
    attachmentId: w.attachmentId ?? null,
    status: w.status,
    error: w.error ?? null,
  };
  await db.driveSyncFile.upsert({
    where: { driveFileId: w.item.id },
    create: { driveFileId: w.item.id, ...data },
    update: data,
  });
}
