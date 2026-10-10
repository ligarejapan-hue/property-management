import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
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
import { UPLOADS_PREFIX } from "@/lib/storage/url-to-key";
import { MAX_FILE_SIZE } from "@/lib/storage/types";
import { assertImportMultipartBodySize } from "@/lib/import-body-size";
import { extractTextFromPdf, isPdfBuffer } from "@/lib/pdf-extract";
import {
  MAX_PDF_UPLOAD_BYTES,
  isPdfByMimeOrName,
  pdfTooLargeToAcceptMessage,
} from "@/lib/pdf-compress/policy";
import { fitPdfToLimit, reserveLargePdfSlot } from "@/lib/pdf-compress/fit";
import { runExclusive } from "@/lib/pdf-compress/run";
import {
  assertReportInboxAccess,
  propertyScopeWhere,
  reportInboxStorageKey,
  SCRUB_ON_DISCARD,
} from "@/lib/report-inbox/access";
import { extractReportClues } from "@/lib/report-inbox/extract";
import { removeFileAndVerify } from "@/lib/report-inbox/remove-file";
import { findReportCandidates, type CandidateDb } from "@/lib/report-inbox/candidates";
import { canAccessPropertyRecord } from "@/lib/property-access";

// ---------- 査定報告書の受け取り箱(2026-10-10) ----------
// GET  /api/report-inbox … 未処理の報告書と、それぞれの添付先の候補
// POST /api/report-inbox … 報告書PDFを1つ受け取る(multipart: file)
//
// ⚠この口は大きいPDF(最大50MB)を受けるため proxy を通さない(src/proxy.ts)。
//   本文を読む前に、認証 → 権限 → Content-Length の確認 → 席の確保 の順に行う。

/** 一覧の1ページの件数(候補探しは1件ずつ DB を引くので、ページを小さく保つ・@codex PR#500)。 */
export const PAGE_SIZE = 20;
/**
 * 取り込みが途中で止まった(記録は作ったがファイルを置き終えていない)とみなすまでの時間。
 * これより新しい「取り込み中」は、いま取り込んでいる最中なので一覧に出さない。
 */
const STALE_UPLOAD_MS = 10 * 60 * 1000;

/**
 * 一覧に出す行: 未処理・削除が途中で止まったもの・取り込みが途中で止まったもの。
 * ⚠どれも人が「削除」を押せるように出す(個人情報の入ったファイルを置き去りにしない)。
 */
function listWhere(now: number) {
  return {
    OR: [
      { status: { in: ["pending", "discarding"] } },
      { status: "uploading", createdAt: { lt: new Date(now - STALE_UPLOAD_MS) } },
    ],
  };
}

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    assertReportInboxAccess(session, perms);

    // ⚠件数で打ち切らず、ページ送りで**全件にたどり着ける**ようにする(@codex PR#500 3巡目)。
    const pageRaw = Number(request.nextUrl.searchParams.get("page") ?? "1");
    const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
    const where = listWhere(Date.now());
    const [total, items] = await Promise.all([
      prisma.reportInboxItem.count({ where }),
      prisma.reportInboxItem.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ]);
    const uploaderIds = [...new Set(items.map((i) => i.uploadedBy))];
    const users = uploaderIds.length
      ? await prisma.user.findMany({ where: { id: { in: uploaderIds } }, select: { id: true, name: true } })
      : [];
    const nameOf = new Map(users.map((u) => [u.id, u.name]));

    const data = [];
    for (const item of items) {
      // ⚠呼び出した人が開ける物件だけを候補にする(担当外の住所・建物名を見せない・@codex PR#500)。
      const candidates =
        item.status === "pending"
          ? await findReportCandidates(prisma as unknown as CandidateDb, item, {
              scopeWhere: propertyScopeWhere(session),
              canAccess: (p) =>
                canAccessPropertyRecord(session, { createdBy: p.createdBy ?? "", assignedTo: p.assignedTo ?? null }),
            })
          : [];
      data.push({
        id: item.id,
        fileName: item.fileName,
        fileSize: item.fileSize,
        originalSize: item.originalSize,
        source: item.source,
        status: item.status,
        buildingName: item.buildingName,
        roomNo: item.roomNo,
        address: item.address,
        createdAt: item.createdAt,
        uploaderName: nameOf.get(item.uploadedBy) ?? null,
        candidates,
      });
    }
    return apiResponse({ data, total, page, pageSize: PAGE_SIZE });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  let releaseSlot = () => {};
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    assertReportInboxAccess(session, perms);

    assertImportMultipartBodySize(request, MAX_PDF_UPLOAD_BYTES);
    // 8MB を超える送信は、本文を読む前に圧縮・読み取りの席を取る(埋まっていれば 503)。
    releaseSlot = reserveLargePdfSlot(request);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof Blob) || file.size <= 0) {
      throw new ApiError(422, "PDFファイルを選んでください", "VALIDATION_ERROR");
    }
    const fileName = ((file as File).name || "report.pdf").slice(0, 200);
    if (!isPdfByMimeOrName(file.type, fileName)) {
      throw new ApiError(422, "PDFファイルだけを受け付けます", "VALIDATION_ERROR");
    }
    if (file.size > MAX_PDF_UPLOAD_BYTES) {
      throw new ApiError(422, pdfTooLargeToAcceptMessage(), "VALIDATION_ERROR");
    }
    const original = Buffer.from(await file.arrayBuffer());
    if (!isPdfBuffer(original)) {
      throw new ApiError(422, "PDFファイルではありません", "VALIDATION_ERROR");
    }

    // 手がかりは元のPDFから読む(縮めても文字は同じ)。大きいものは圧縮と同じ順番待ちで。
    let text = "";
    try {
      text =
        original.length > MAX_FILE_SIZE
          ? await runExclusive(() => extractTextFromPdf(original))
          : await extractTextFromPdf(original);
    } catch {
      // 文字が読めなくても受け取る(手で物件を選べる)。
      text = "";
    }
    const clues = extractReportClues(text);

    const fitted = await fitPdfToLimit(original);
    const storage = getStorage();
    const key = reportInboxStorageKey(Date.now(), randomUUID());

    // ⚠**記録を先に作ってからファイルを置く**(@codex PR#500 3巡目)。ファイルを先に置くと、
    //   記録の作成と後片付けが両方失敗したとき、個人情報の入ったファイルが誰にも見えない場所に
    //   残り続ける。先に「取り込み中」の記録があれば、途中で止まっても一覧に出て削除できる。
    const item = await prisma.reportInboxItem.create({
      data: {
        fileName,
        // ⚠保存方式にかかわらず、**アプリの守りを通る /uploads/{key}** を記録する(@codex PR#500 7巡目)。
        //   server 方式の getUrl() は保存サーバーを直接指す URL を返すことがあり、それが添付に写ると
        //   依頼者名入りの報告書が所有者の守り(canOpenReferralDocument)を通らずに開けてしまう。
        //   /uploads/{key} はどの保存方式の keyFromUrl でも key に戻せる。
        fileUrl: `${UPLOADS_PREFIX}${key}`,
        fileSize: fitted.buffer.length,
        originalSize: fitted.originalSize,
        source: clues.source,
        buildingName: clues.buildingName,
        roomNo: clues.roomNo,
        address: clues.address,
        status: "uploading",
        uploadedBy: session.id,
      },
    });

    try {
      await storage.upload(fitted.buffer, { key, mimeType: "application/pdf", fileName: "report.pdf" });
    } catch (e) {
      // 途中まで書けているかもしれないので消す。消せたら記録も「削除済み」に。
      // 消せなければ「取り込み中」のまま残る=一覧に出て、人が削除できる。
      if (await removeFileAndVerify(storage, key)) {
        await prisma.reportInboxItem.updateMany({
          where: { id: item.id, status: "uploading" },
          data: { status: "discarded", resolvedAt: new Date(), ...SCRUB_ON_DISCARD },
        });
      }
      throw e;
    }

    const ready = await prisma.reportInboxItem.updateMany({
      where: { id: item.id, status: "uploading" },
      data: { status: "pending" },
    });
    if (ready.count !== 1) {
      // 置き終える前に誰かが削除した。置いたファイルを残さない。
      // ⚠消せたと確かめられなければ、記録を「削除中」に戻して一覧から押し直せるようにする
      //   (削除した側は、まだファイルが無い時点で「削除済み」にしている・@codex PR#500 5巡目)。
      if (!(await removeFileAndVerify(storage, key))) {
        await prisma.reportInboxItem.updateMany({
          where: { id: item.id, status: { in: ["discarded", "discarding"] } },
          data: { status: "discarding" },
        });
      }
      throw new ApiError(409, "受け取りの途中で削除されました。必要ならもう一度入れてください。", "CONFLICT");
    }

    await writeAuditLog({
      userId: session.id,
      action: "create",
      targetTable: "report_inbox_items",
      targetId: item.id,
      // ⚠元のファイル名は記録しない(依頼者名を含み得る)。
      detail: {
        source: clues.source,
        ...(fitted.originalSize !== null
          ? { compressedFrom: fitted.originalSize, compressedTo: fitted.buffer.length }
          : {}),
      },
    });

    return apiResponse(
      {
        id: item.id,
        source: item.source,
        buildingName: item.buildingName,
        roomNo: item.roomNo,
        address: item.address,
        compressed: fitted.originalSize !== null,
      },
      201,
    );
  } catch (error) {
    return handleApiError(error);
  } finally {
    releaseSlot();
  }
}
