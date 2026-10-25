import prisma from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { extractTextFromPdf } from "@/lib/pdf-extract";
import { isFullCertificateText, summarizeRegistryRights } from "@/lib/registry-strike";
import type { DealRegistryState } from "./registry-rights";

/** 見る添付の数(全部事項を探して新しい順に)。 */
const CANDIDATES = 5;

async function readPdf(fileUrl: string): Promise<{ body: Buffer; text: string } | null> {
  try {
    // 保存場所の鍵が壊れている・読めないときも「読めない」扱い(例外の中身は出さない)。
    const storage = getStorage();
    const key = storage.keyFromUrl(fileUrl);
    const file = key ? await storage.read(key) : null;
    if (!file) return null;
    const text = await extractTextFromPdf(file.body);
    return text.trim() ? { body: file.body, text } : null;
  } catch {
    return null;
  }
}

/**
 * 取引の物件の謄本のうち、全部事項の最新の1件を読んで判定する(計画 段5c-2 の読み替え 1・2)。
 * 手で取り込んだ謄本は種別が空なので、本文で全部事項かを見分ける。所有者事項(owner)は見ない。
 * ⚠結果には氏名が入る。ログ・監査に出さない(例外の中身も出さない)。
 */
export async function loadDealRegistryRights(propertyId: string | null): Promise<DealRegistryState> {
  if (!propertyId) return { status: "none" };
  const rows = await prisma.attachment.findMany({
    where: {
      propertyId, type: "registry", isDeleted: false,
      OR: [{ registryCertificateType: null }, { registryCertificateType: { not: "owner" } }],
    },
    orderBy: { createdAt: "desc" },
    take: CANDIDATES,
    select: { id: true, fileUrl: true, registryCertificateType: true, createdAt: true },
  });
  for (const a of rows) {
    const pdf = await readPdf(a.fileUrl);
    if (!pdf) {
      // 全部事項と分かっている添付が読めなければ判定できない。種別が空なら次を見る。
      if (a.registryCertificateType === "all") return { status: "unreadable" };
      continue;
    }
    if (!isFullCertificateText(pdf.text)) continue;
    const summary = await summarizeRegistryRights({ pdf: pdf.body, text: pdf.text });
    return summary ? { status: "ok", attachmentCreatedAt: a.createdAt.toISOString(), summary } : { status: "unreadable" };
  }
  return { status: "none" };
}
