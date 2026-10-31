import crypto from "crypto";
import prisma from "@/lib/prisma";
import { resolveCompanyProfile } from "@/lib/sales-sheet/company-profile-store";
import { getStorage } from "@/lib/storage";
import { DOC_FILES_PER_LINK, DOC_FILES_PER_REQUEST, DOC_REQUEST_STATUSES, isDocLinkOpen, type DocRequestStatus } from "./constants";
import type { PublicRequestView } from "./public-page";

/** ⚠お客様のページへ渡す値はこの select だけで決まる。取引から読むのは状態だけ(住所・氏名・金額を読まない)。 */
const LINK_SELECT = {
  id: true, dealId: true, partyRole: true, expiresAt: true, revokedAt: true,
  party: { select: { role: true, isSelf: true } }, deal: { select: { status: true } },
} as const;
const statusOf = (s: string): DocRequestStatus => ((DOC_REQUEST_STATUSES as readonly string[]).includes(s) ? (s as DocRequestStatus) : "pending");

export async function loadOpenLink(publicId: string, now: Date) {
  const link = await prisma.dealDocLink.findUnique({ where: { publicId }, select: LINK_SELECT });
  return link && isDocLinkOpen(link, now) ? link : null;
}

/** お客様のページの中身。使えないリンクは null。 */
export async function loadPublicPage(publicId: string, now: Date): Promise<{ companyName: string; requests: PublicRequestView[] } | null> {
  const link = await loadOpenLink(publicId, now);
  if (!link) return null;
  const [rows, companyRow] = await Promise.all([
    prisma.dealDocRequest.findMany({
      where: { linkId: link.id },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      select: { id: true, label: true, status: true, _count: { select: { files: { where: { reviewState: { not: "rejected" } } } } } },
    }),
    prisma.companyProfile.findUnique({ where: { id: "singleton" } }),
  ]);
  return {
    companyName: resolveCompanyProfile(companyRow).nameJa,
    requests: rows.map((r) => ({ id: r.id, label: r.label, status: statusOf(r.status), fileCount: r._count.files })),
  };
}

export type RecordResult =
  | { kind: "ok"; status: DocRequestStatus; count: number }
  | { kind: "closed" | "not_found" | "received" | "too_many" };

/**
 * ファイルを保存して記録する。ファイルを先に置き、取引の行を押さえた中で確かめ直してから行を作る
 * (確かめたあとに無効化や中止が入っても、提出を通さない)。行を作れなければファイルを消す。
 */
export async function recordSubmittedFile(
  args: { publicId: string; dealId: string; requestId: string; buffer: Buffer; mimeType: string; ext: string; now: Date },
): Promise<RecordResult> {
  const storage = getStorage();
  const fileId = crypto.randomUUID();
  const storageKey = `deals/${args.dealId}/submissions/${fileId}.${args.ext}`;
  await storage.upload(args.buffer, { key: storageKey, mimeType: args.mimeType, fileName: `submission.${args.ext}` });
  let result: RecordResult = { kind: "closed" };
  try {
    result = await prisma.$transaction(async (tx): Promise<RecordResult> => {
      await tx.$queryRaw`SELECT "id" FROM "deals" WHERE "id" = ${args.dealId}::uuid FOR UPDATE`;
      const link = await tx.dealDocLink.findUnique({ where: { publicId: args.publicId }, select: LINK_SELECT });
      if (!link || link.dealId !== args.dealId || !isDocLinkOpen(link, args.now)) return { kind: "closed" };
      const request = await tx.dealDocRequest.findFirst({ where: { id: args.requestId, linkId: link.id }, select: { id: true, status: true } });
      if (!request) return { kind: "not_found" };
      if (request.status === "received") return { kind: "received" };
      const [inRequest, inLink] = await Promise.all([
        tx.dealDocFile.count({ where: { requestId: request.id, reviewState: { not: "rejected" } } }),
        tx.dealDocFile.count({ where: { request: { linkId: link.id } } }),
      ]);
      if (inRequest >= DOC_FILES_PER_REQUEST || inLink >= DOC_FILES_PER_LINK) return { kind: "too_many" };
      await tx.dealDocFile.create({
        data: { id: fileId, requestId: request.id, storageKey, mimeType: args.mimeType, fileSize: args.buffer.length, reviewStateAt: args.now },
      });
      await tx.dealDocRequest.update({ where: { id: request.id }, data: { status: "submitted", rejectReason: null } });
      return { kind: "ok", status: "submitted", count: inRequest + 1 };
    });
  } finally {
    if (result.kind !== "ok") {
      await storage.delete(storageKey).catch(() => console.warn("deal_doc_submit_cleanup_failed"));
    }
  }
  return result;
}
