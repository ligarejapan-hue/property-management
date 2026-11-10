/**
 * 査定報告書(Attachment type=report)から「査定のご報告」の下書きを作る(2026-11-10)。
 *
 * - 受け取り箱から物件に添付した直後に、応答のあとで呼ぶ(schedule.ts)。失敗しても添付は止めない。
 * - 物件ページの「査定書から作り直す」からも呼ぶ(replace=true)。確認済みの資料は上書きしない。
 * ⚠PDF本文・依頼者の氏名は保存しない(parseAppraisalReport の結果だけを保存する)。
 * ⚠console / AuditLog に数字・所在地・ファイルの場所を出さない(id と件数・結果だけ)。
 */
import prisma from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { extractTextFromPdf, isPdfBuffer } from "@/lib/pdf-extract";
import { runExclusive } from "@/lib/pdf-compress/run";
import { appraisalSourceWhere } from "./source";
import { writeAuditLog } from "@/lib/audit";
import { parseAppraisalReport, APPRAISAL_PARSER_VERSION } from "./parse";

/** 大きい査定報告書(実物 50 ページ・13MB)でも読み切れる上限。超えたら作らない(作り直しで再挑戦)。 */
export const APPRAISAL_PDF_TIMEOUT_MS = 60_000;

export type AppraisalDraftResult =
  | { ok: true; deckId: string; created: boolean }
  | {
      ok: false;
      reason: "attachment_not_found" | "file_not_found" | "not_pdf" | "read_failed" | "not_sre" | "already_confirmed" | "busy";
    };

/**
 * 同時に待てる読み取りの数(@codex #692)。順番待ちの間は PDF を読み込まない(ファイルは自分の番が来てから
 * 読む)うえで、待ちの数そのものにも上限を置く。超えたら busy(作り直しで再挑戦)。
 */
export const MAX_PENDING_APPRAISAL_READS = 4;
let pendingReads = 0;

export async function buildAppraisalDraft(input: {
  attachmentId: string;
  propertyId: string;
  userId: string;
  /** 既にある下書き(draft)を読み直した結果で置き換えるか。false なら既にあれば何もしない。 */
  replace?: boolean;
}): Promise<AppraisalDraftResult> {
  const { attachmentId, propertyId, userId } = input;
  const attachment = await prisma.attachment.findFirst({
    where: { id: attachmentId, targetType: "property", targetId: propertyId, isDeleted: false, ...appraisalSourceWhere },
    select: { id: true, fileUrl: true },
  });
  if (!attachment) return { ok: false, reason: "attachment_not_found" };

  const existing = await prisma.appraisalDeck.findUnique({
    where: { sourceAttachmentId: attachmentId },
    select: { id: true, status: true, propertyId: true },
  });
  if (existing && existing.propertyId !== propertyId) return { ok: false, reason: "attachment_not_found" };
  if (existing && !input.replace) return { ok: true, deckId: existing.id, created: false };
  if (existing?.status === "confirmed") return { ok: false, reason: "already_confirmed" };

  if (pendingReads >= MAX_PENDING_APPRAISAL_READS) return { ok: false, reason: "busy" };
  pendingReads++;
  let read: { text: string } | { fail: "file_not_found" | "not_pdf" | "read_failed" };
  try {
    // 重い PDF の読み取りは同時に1本だけ(受け取り箱の圧縮・読み取りと同じ順番待ち)。
    // ⚠ファイルは順番が来てから読む(待っている間に大きい PDF をメモリに抱えない・@codex #692)。
    read = await runExclusive(async () => {
      const storage = getStorage();
      const key = storage.keyFromUrl(attachment.fileUrl);
      const file = key ? await storage.read(key) : null;
      if (!file) return { fail: "file_not_found" as const };
      const buffer = Buffer.from(file.body as Uint8Array);
      if (!isPdfBuffer(buffer)) return { fail: "not_pdf" as const };
      try {
        return { text: await extractTextFromPdf(buffer, { timeoutMs: APPRAISAL_PDF_TIMEOUT_MS }) };
      } catch {
        return { fail: "read_failed" as const };
      }
    });
  } finally {
    pendingReads--;
  }
  if ("fail" in read) return { ok: false, reason: read.fail };
  const text = read.text;
  const extracted = parseAppraisalReport(text);
  if (extracted.source !== "sre") return { ok: false, reason: "not_sre" };

  const data = {
    parserVersion: APPRAISAL_PARSER_VERSION,
    extracted: extracted as unknown as object,
    updatedBy: userId,
  };
  let deckId: string;
  let created: boolean;
  if (existing) {
    // 確認済みになっていないことを更新の条件にする(読んでいる間に確認された資料を上書きしない)。
    const updated = await prisma.appraisalDeck.updateMany({
      where: { id: existing.id, status: "draft" },
      data,
    });
    if (updated.count !== 1) return { ok: false, reason: "already_confirmed" };
    deckId = existing.id;
    created = false;
  } else {
    try {
      const row = await prisma.appraisalDeck.create({
        data: { ...data, propertyId, sourceAttachmentId: attachmentId, status: "draft", createdBy: userId },
        select: { id: true },
      });
      deckId = row.id;
      created = true;
    } catch (e) {
      // 同じ報告書から同時に作った(unique 違反)=先にできた方を使う
      const again = await prisma.appraisalDeck.findUnique({ where: { sourceAttachmentId: attachmentId }, select: { id: true } });
      if (!again) throw e;
      return { ok: true, deckId: again.id, created: false };
    }
  }

  await writeAuditLog({
    userId,
    action: created ? "create" : "update",
    targetTable: "appraisal_decks",
    targetId: deckId,
    detail: {
      propertyId,
      sourceAttachmentId: attachmentId,
      parserVersion: APPRAISAL_PARSER_VERSION,
      warnings: extracted.warnings.length,
      reread: !created,
    },
  });
  return { ok: true, deckId, created };
}
