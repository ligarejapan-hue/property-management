/**
 * POST /api/properties/:id/attachments/split — まとめてある PDF を、人が確かめた分け方で書類ごとに保存する。
 *
 * 発注者の依頼(2026-10-28)「分ける仕組みまで作って」。分け方は split-analyze の案を人が直したもの。
 * 保存するもの:
 *   - 元の1冊 … 通常の添付(種類=まとめてあるPDF(元のファイル))。発注者決定「元のPDFも残す」。
 *   - 謄本の部分 … 謄本(type=registry)。縮めない・面積を読んで物件の空の欄に入れる(添付と同じ)。
 *   - ほかの部分 … 通常の添付。種類は人が決めたもの(manual)・名前はそろえる。8MB を超えたら縮める。
 * ⚠この口は proxy を通らない(大きいPDFのため・src/proxy.ts)=本文を読む前に認証と大きさを見る。
 * ⚠分ける・縮めるは同じ順番待ち。分けるのを先に済ませてから縮める(中で呼ぶと待ち合って止まる)。
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { fillBasicInfoFromRegistryPdfBestEffort } from "@/lib/registry-pdf/fill-areas";
import { registryFillNotice } from "@/lib/registry-basic-info";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { getApiSession, getUserPermissions, ApiError, handleApiError, apiResponse } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { getStorage, validateFile, ALLOWED_ATTACHMENT_MIMES } from "@/lib/storage";
import { assertImportMultipartBodySize } from "@/lib/import-body-size";
import { MAX_ATTACHMENT_BYTES, MAX_PDF_UPLOAD_BYTES, pdfTooLargeToAcceptMessage } from "@/lib/pdf-compress/policy";
import { fitPdfToLimit } from "@/lib/pdf-compress/fit";
import { isPdfBuffer } from "@/lib/pdf-extract";
import { docColumnsForKnownKind, type DocColumns } from "@/lib/doc-classify/assign";
import { splitPdfByRanges } from "@/lib/pdf-split/run";
import { parseScopeInput } from "@/lib/attachments/deal-scope";
import {
  BUNDLE_ORIGINAL_KIND,
  MAX_SPLIT_PAGES,
  REGISTRY_KIND,
  segmentFileName,
  validateSegments,
} from "@/lib/pdf-split/segments";
import { reserveSplitSlot } from "@/lib/pdf-split/slot";
import { autoMarkRegistryObtainedBestEffort } from "@/lib/registry-status-auto";
// 謄本が入っている1冊を保存するときの名前(元の名前は所有者名を含み得るので使わない)。画面の「分けずに保存」と同じ。
import { GENERIC_BUNDLE_NAME } from "@/lib/attachments/unified-drop";

const PDF_MIME = "application/pdf";

interface Prepared {
  type: "general" | "registry";
  kind: string | null;
  fileName: string;
  buffer: Buffer;
  originalSize: number | null;
  pages: { from: number; to: number } | null;
  fileUrl?: string;
}

function assertSavable(size: number) {
  const err = validateFile(size, PDF_MIME, ALLOWED_ATTACHMENT_MIMES, MAX_ATTACHMENT_BYTES);
  if (err) throw new ApiError(422, err, "VALIDATION_ERROR");
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let releaseSlot = () => {};
  try {
    const { id: propertyId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true, createdBy: true, assignedTo: true, buildingName: true, roomNo: true, address: true },
    });
    if (!property) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    if (!canAccessPropertyRecord(session, property)) {
      throw new ApiError(403, "この物件を編集する権限がありません", "FORBIDDEN");
    }

    assertImportMultipartBodySize(request, MAX_PDF_UPLOAD_BYTES);
    // 小さい PDF でも分ける・縮める列に並ぶので、大きさによらず席を取る(取れなければすぐ 503)。
    releaseSlot = reserveSplitSlot();
    const formData = await request.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof Blob)) {
      throw new ApiError(422, "ファイルが必要です", "VALIDATION_ERROR");
    }
    const originalName = (file as File).name || "まとめてある書類.pdf";
    if (file.size <= 0) throw new ApiError(422, "空ファイルはアップロードできません", "VALIDATION_ERROR");
    if (file.size > MAX_PDF_UPLOAD_BYTES) throw new ApiError(422, pdfTooLargeToAcceptMessage(), "VALIDATION_ERROR");

    let rawSegments: unknown;
    try {
      rawSegments = JSON.parse(String(formData.get("segments") ?? ""));
    } catch {
      throw new ApiError(422, "分け方の形が正しくありません", "VALIDATION_ERROR");
    }
    // ページ数はまだ分からないので、まず「並びが正しいか」だけ見る(最後のページ=ページ数として確かめ、
    // 本当のページ数とは分けたあとで突き合わせる)。
    const lastTo = Array.isArray(rawSegments)
      ? (rawSegments[rawSegments.length - 1] as { to?: unknown } | undefined)?.to
      : undefined;
    if (typeof lastTo === "number" && lastTo > MAX_SPLIT_PAGES) {
      throw new ApiError(422, `${MAX_SPLIT_PAGES}ページを超えるPDFは分けられません。分けずに保存してください`, "VALIDATION_ERROR");
    }
    const checked = validateSegments(rawSegments, typeof lastTo === "number" ? lastTo : 0);
    if (!checked.ok) throw new ApiError(422, checked.reason, "VALIDATION_ERROR");
    const segments = checked.segments;
    // ⚠謄本が入っている1冊は、ファイル名に所有者名が入り得る(謄本と同じ扱い)。保存する名前は決まった名前に
    //   し、監査にも名前を残さない(@提出前レビュー P2)。中身の謄本のページは元の1冊にも残る(発注者決定)。
    //   ⚠人が分け目を消して謄本のページを前の書類につなげた場合は分け方に謄本が無いので、画面が最初に
    //   読んだページの種類から付ける印(containsRegistry)でも見る(@codex #604 P1)。
    const hasRegistry = segments.some((s) => s.kind === REGISTRY_KIND) || formData.get("containsRegistry") === "1";
    const baseName = hasRegistry ? GENERIC_BUNDLE_NAME : originalName;
    // どの取引の書類か(添付の POST と同じ・2026-11-04)。謄本の部分には付けない(共通として扱う)。
    let dealScope: { dealId: string | null; dealCommon: boolean } | null = null;
    const rawScope = formData.get("dealScope");
    if (typeof rawScope === "string" && rawScope !== "") {
      const parsed = parseScopeInput(rawScope);
      if (!parsed) throw new ApiError(422, "取引の指定が読めません", "VALIDATION_ERROR");
      if (!hasPermission(perms, "deal", "read")) {
        throw new ApiError(403, "取引を見る権限がないため、取引を選んで入れられません", "FORBIDDEN");
      }
      dealScope = parsed;
      // ⚠保存する前にも確かめる(断ったときに保存先へファイルを残さない・@codex P2)。確定はロックの中でもう一度。
      if (parsed.dealId) {
        const deal = await prisma.deal.findFirst({ where: { id: parsed.dealId, propertyId }, select: { id: true } });
        if (!deal) throw new ApiError(422, "この物件の取引ではありません", "VALIDATION_ERROR");
      }
    }

    const original = Buffer.from(await file.arrayBuffer());
    if (!isPdfBuffer(original)) throw new ApiError(422, "PDFファイルではありません", "VALIDATION_ERROR");

    const split = await splitPdfByRanges(original, segments);
    if (!split.ok) {
      if (split.reason === "encrypted") {
        throw new ApiError(422, "鍵(パスワード)のかかったPDFは分けられません。分けずに保存してください", "VALIDATION_ERROR");
      }
      if (split.reason === "invalid_pdf" || split.reason === "bad_args") {
        throw new ApiError(422, "このPDFは分けられませんでした。分けずに保存してください", "VALIDATION_ERROR");
      }
      throw new ApiError(503, "いまは分けられません。しばらくしてからもう一度試すか、分けずに保存してください", "UNAVAILABLE");
    }
    if (split.pageCount !== segments[segments.length - 1].to) {
      throw new ApiError(422, "ページの範囲が最後まで届いていません", "VALIDATION_ERROR");
    }

    // 元の1冊 → 分けた書類の順に、保存する形にそろえる(謄本は縮めない・ほかは 8MB を超えたら縮める)。
    const prepared: Prepared[] = [];
    const fittedOriginal = await fitPdfToLimit(original);
    assertSavable(fittedOriginal.buffer.length);
    prepared.push({
      type: "general",
      kind: BUNDLE_ORIGINAL_KIND,
      fileName: baseName,
      buffer: fittedOriginal.buffer,
      originalSize: fittedOriginal.originalSize,
      pages: null,
    });
    for (const [i, seg] of segments.entries()) {
      const part = split.parts[i];
      const fileName = segmentFileName(baseName, seg);
      if (seg.kind === REGISTRY_KIND) {
        assertSavable(part.length);
        prepared.push({ type: "registry", kind: null, fileName, buffer: part, originalSize: null, pages: seg });
      } else {
        const fitted = await fitPdfToLimit(part);
        assertSavable(fitted.buffer.length);
        prepared.push({
          type: "general",
          kind: seg.kind,
          fileName,
          buffer: fitted.buffer,
          originalSize: fitted.originalSize,
          pages: seg,
        });
      }
    }

    const storage = getStorage();
    for (const p of prepared) {
      const subdir = p.type === "registry" ? "registry" : "attachments";
      const key = `properties/${propertyId}/${subdir}/${Date.now()}-${randomUUID()}.pdf`;
      const result = await storage.upload(p.buffer, { key, mimeType: PDF_MIME, fileName: p.fileName });
      p.fileUrl = result.url;
    }

    // ⚠親の物件行をロックしてから作る(添付の POST と同じ規約・謄本の二重課金ガードの前提)。
    //   ⚠ロックの中で既存の名前を読む=同時に入れても同じ名前にならない。
    const created = await prisma.$transaction(async (tx) => {
      await lockPropertyRow(tx, propertyId);
      if (dealScope?.dealId) {
        const deal = await tx.deal.findFirst({ where: { id: dealScope.dealId, propertyId }, select: { id: true } });
        if (!deal) throw new ApiError(422, "この物件の取引ではありません", "VALIDATION_ERROR");
      }
      const existing = await tx.attachment.findMany({
        where: { targetType: "property", targetId: propertyId, isDeleted: false, docTitle: { not: null } },
        select: { docTitle: true },
      });
      const taken = new Set(existing.map((e) => e.docTitle).filter((t): t is string => t !== null));
      const rows = [];
      for (const p of prepared) {
        let docColumns: DocColumns | Record<string, never> = {};
        if (p.type === "general") {
          docColumns = docColumnsForKnownKind(
            { kindCode: p.kind, confidence: "manual", fileName: p.fileName, dateStamp: null },
            {
              property: { buildingName: property.buildingName, roomNo: property.roomNo, address: property.address },
              takenTitles: taken,
            },
          );
          if ("docTitle" in docColumns && docColumns.docTitle) taken.add(docColumns.docTitle);
        }
        rows.push(
          await tx.attachment.create({
            data: {
              targetType: "property",
              targetId: propertyId,
              propertyId,
              type: p.type,
              fileName: p.fileName,
              fileUrl: p.fileUrl!,
              fileSize: p.buffer.length,
              originalSize: p.originalSize,
              mimeType: PDF_MIME,
              uploadedBy: session.id,
              ...docColumns,
              ...(p.type === "general" && dealScope ? dealScope : {}),
            },
            select: { id: true, type: true },
          }),
        );
      }
      return rows;
    });

    const originalId = created[0].id;
    // 記録の形は添付の POST と同じ(1件ずつ create)。
    for (const [i, row] of created.entries()) {
      const p = prepared[i];
      await writeAuditLog({
        userId: session.id,
        action: "create",
        targetTable: "attachments",
        targetId: row.id,
        // ⚠謄本が入っている1冊のファイル名は出さない(所有者名を含み得る)。
        detail: { propertyId, ...(hasRegistry ? {} : { fileName: p.fileName }) },
      });
    }

    // 謄本の部分があれば、未取得の登記状況を取得済に(2026-11-06・添付の POST と同じ)。
    if (prepared.some((p) => p.type === "registry")) await autoMarkRegistryObtainedBestEffort({ propertyId, changedBy: session.id });

    // 謄本の部分は、添付と同じく読んで物件の空の欄に入れる(読めなくても保存は成功のまま・読めないことは画面に出す)。
    const registryNotices = new Set<string>();
    for (const p of prepared) {
      if (p.type === "registry") {
        const notice = registryFillNotice(
          await fillBasicInfoFromRegistryPdfBestEffort({ propertyId, pdf: p.buffer, changedBy: session.id }),
        );
        if (notice) registryNotices.add(notice);
      }
    }

    return apiResponse(
      {
        originalId,
        parts: created.length - 1,
        registryParts: prepared.filter((p) => p.type === "registry").length,
        registryNotice: registryNotices.size > 0 ? [...registryNotices].join(" / ") : null,
      },
      201,
    );
  } catch (error) {
    return handleApiError(error);
  } finally {
    releaseSlot();
  }
}
