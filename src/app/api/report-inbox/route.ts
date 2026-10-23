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
import { getStorage, validateFile, ALLOWED_ATTACHMENT_MIMES } from "@/lib/storage";
import { UPLOADS_PREFIX } from "@/lib/storage/url-to-key";
import { MAX_FILE_SIZE } from "@/lib/storage/types";
import { assertImportMultipartBodySize } from "@/lib/import-body-size";
import { extractTextFromPdf, isPdfBuffer } from "@/lib/pdf-extract";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_PDF_UPLOAD_BYTES,
  isPdfByMimeOrName,
  pdfTooLargeToAcceptMessage,
} from "@/lib/pdf-compress/policy";
import { classifyDocument } from "@/lib/doc-classify/classify";
import { extractDocumentDate, fileExtension } from "@/lib/doc-classify/title";
import { findKnownBuildingName } from "@/lib/report-inbox/known-names";
import { fitPdfToLimit, reserveLargePdfSlot } from "@/lib/pdf-compress/fit";
import { runExclusive } from "@/lib/pdf-compress/run";
import {
  assertReportInboxAccess,
  propertyScopeWhere,
  reportInboxStorageKey,
  SCRUB_ON_DISCARD,
  STALE_UPLOAD_MS,
} from "@/lib/report-inbox/access";
import { extractReportClues } from "@/lib/report-inbox/extract";
import { removeFileAndVerify } from "@/lib/report-inbox/remove-file";
import {
  compactNameForDb,
  findExactNameIds,
  findReportCandidates,
  type CandidateDb,
} from "@/lib/report-inbox/candidates";
import { canAccessPropertyRecord } from "@/lib/property-access";

// ---------- 書類の受け取り箱(2026-10-10 査定報告書→2026-10-24 全書類) ----------
// GET  /api/report-inbox … 未処理の書類と、それぞれの添付先の候補
// POST /api/report-inbox … 書類を1つ受け取る(multipart: file)。PDF は本文を読んで手がかりと種類を当てる
//
// ⚠この口は大きいPDF(最大50MB)を受けるため proxy を通さない(src/proxy.ts)。
//   本文を読む前に、認証 → 権限 → Content-Length の確認 → 席の確保 の順に行う。
// ⚠使える人は今のまま(所有者情報をすべて見られる人・発注者決定 2026-10-24)。契約書・本人確認書類にも
//   氏名・住所が載るため。未処理の間のファイルは report-inbox/ の守りの中(添付のとき物件の置き場所へ写す)。

/** 一覧の1ページの件数(候補探しは1件ずつ DB を引くので、ページを小さく保つ・@codex PR#500)。 */
export const PAGE_SIZE = 20;

/** 候補探しを同時に行う件数(1件あたり最大6本の読み込みを同時に流す)。 */
const CANDIDATE_CONCURRENCY = 4;

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

    // ⚠呼び出した人が開ける物件だけを候補にする(担当外の住所・建物名を見せない・@codex PR#500)。
    // 1件ごとの候補探しは独立なので、CANDIDATE_CONCURRENCY 件ずつ同時に行う
    // (順に待つと往復が積み重なる・全部同時だと DB の接続を占める・16巡目)。
    // 名前の完全一致はページ分をまとめて1回で引く(報告書ごとに表を読み直さない・22巡目)。
    const exactNameIds = await findExactNameIds(
      prisma as unknown as CandidateDb,
      items
        .filter((i) => i.status === "pending")
        .map((i) => compactNameForDb(i.buildingName))
        .filter((k): k is string => k !== null),
    );
    const candidateLists: Awaited<ReturnType<typeof findReportCandidates>>[] = [];
    for (let i = 0; i < items.length; i += CANDIDATE_CONCURRENCY) {
      const chunk = items.slice(i, i + CANDIDATE_CONCURRENCY);
      candidateLists.push(
        ...(await Promise.all(
          chunk.map((item) =>
            item.status === "pending"
              ? findReportCandidates(prisma as unknown as CandidateDb, item, {
                  scopeWhere: propertyScopeWhere(session),
                  exactNameIds,
                  canAccess: (p) =>
                    canAccessPropertyRecord(session, { createdBy: p.createdBy ?? "", assignedTo: p.assignedTo ?? null }),
                })
              : Promise.resolve([]),
          ),
        )),
      );
    }
    const data = [];
    for (const [i, item] of items.entries()) {
      const candidates = candidateLists[i];
      data.push({
        id: item.id,
        fileName: item.fileName,
        fileSize: item.fileSize,
        originalSize: item.originalSize,
        mimeType: item.mimeType,
        source: item.source,
        docKind: item.docKind,
        docStage: item.docStage,
        docConfidence: item.docConfidence,
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
      throw new ApiError(422, "ファイルを選んでください", "VALIDATION_ERROR");
    }
    const fileName = ((file as File).name || "document").slice(0, 200);
    const isPdf = isPdfByMimeOrName(file.type, fileName);
    let mimeType = isPdf ? "application/pdf" : file.type || "application/octet-stream";
    if (isPdf) {
      if (file.size > MAX_PDF_UPLOAD_BYTES) {
        throw new ApiError(422, pdfTooLargeToAcceptMessage(), "VALIDATION_ERROR");
      }
    } else {
      // PDF 以外(画像・Excel・Word・CSV)は物件の添付と同じ種類・同じ上限(20MB)。縮めない。
      const invalid = validateFile(file.size, mimeType, ALLOWED_ATTACHMENT_MIMES, MAX_ATTACHMENT_BYTES);
      if (invalid) throw new ApiError(422, invalid, "VALIDATION_ERROR");
    }
    const original = Buffer.from(await file.arrayBuffer());
    if (isPdf && !isPdfBuffer(original)) {
      throw new ApiError(422, "PDFファイルではありません", "VALIDATION_ERROR");
    }
    mimeType = isPdf ? "application/pdf" : mimeType;

    // 手がかりは元のPDFから読む(縮めても文字は同じ)。大きいものは圧縮と同じ順番待ちで。
    // PDF 以外は文字が無い(種類は名前だけで当て、物件は手で探す)。
    let text = "";
    if (isPdf) {
      try {
        text =
          original.length > MAX_FILE_SIZE
            ? await runExclusive(() => extractTextFromPdf(original))
            : await extractTextFromPdf(original);
      } catch {
        // 文字が読めなくても受け取る(手で物件を選べる)。
        text = "";
      }
    }
    const clues = extractReportClues(text);
    // 見出しから名前が取れなければ、登録済みの物件名が本文に出ていないかを探す(契約書・管理規約など)。
    // ⚠呼び出した人が開ける物件の名前だけで探す(担当外の建物名を手がかりに出さない)。
    if (clues.buildingName === null && text !== "") {
      const known = await prisma.property.findMany({
        where: { isArchived: false, buildingName: { not: null }, ...propertyScopeWhere(session) },
        select: { buildingName: true },
        distinct: ["buildingName"],
      });
      const hit = findKnownBuildingName(
        text,
        known.map((p) => p.buildingName).filter((n): n is string => n !== null),
      );
      if (hit) {
        clues.buildingName = hit.buildingName;
        if (clues.roomNo === null) clues.roomNo = hit.roomNo;
      }
    }
    // 種類と段階(名前 → 本文の順)。当たらなければ null=その他。
    const classification = classifyDocument({ fileName, text });
    const docDate = extractDocumentDate(text);

    const fitted = isPdf ? await fitPdfToLimit(original) : { buffer: original, originalSize: null };
    const storage = getStorage();
    const key = reportInboxStorageKey(Date.now(), randomUUID(), fileExtension(fileName) ?? (isPdf ? "pdf" : "bin"));

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
        mimeType,
        source: clues.source,
        buildingName: clues.buildingName,
        roomNo: clues.roomNo,
        address: clues.address,
        docKind: classification?.kind ?? null,
        docStage: classification?.stage ?? null,
        docConfidence: classification?.confidence ?? null,
        docDate,
        status: "uploading",
        uploadedBy: session.id,
      },
    });

    try {
      // ⚠置き場所の名前にも元のファイル名を使わない(依頼者名・所有者名を含み得る)。
      await storage.upload(fitted.buffer, { key, mimeType, fileName: `document.${fileExtension(fileName) ?? "bin"}` });
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
        docKind: item.docKind,
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
        docKind: item.docKind,
        docStage: item.docStage,
        docConfidence: item.docConfidence,
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
