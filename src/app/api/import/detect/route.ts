/**
 * POST /api/import/detect — 「ファイルを入れる」の行き先を決める(2026-10-28 第2段)。**保存しない**。
 *
 * - 表(CSV・Excel): 画面が読んだ中身を JSON で受ける(取り込みの口と同じ形 {fileName, csvText|xlsxBase64})。
 *   受付帳/所有者は列の名前、査定サイトの顧客管理表は「姓名」の列で見分ける(今の取り込みと同じ判定)。
 * - PDF: multipart の file。先頭2ページの文字で、謄本・反響・書類を見分ける。
 * 返すのは行き先だけ。中身・ファイル名・読んだ文字は返さない・残さない(謄本・名簿には氏名が入る)。
 * ⚠この口は proxy を通らない(大きいPDFのため・src/proxy.ts)=本文を読む前に認証と大きさを見る。
 */
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { getApiSession, getUserPermissions, ApiError, handleApiError, apiResponse } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { assertImportJsonBodySize, assertImportMultipartBodySize } from "@/lib/import-body-size";
import { MAX_PDF_UPLOAD_BYTES, pdfTooLargeToAcceptMessage } from "@/lib/pdf-compress/policy";
import { reserveLargePdfSlot } from "@/lib/pdf-compress/fit";
import { extractHeadTextFromPdf, isPdfBuffer } from "@/lib/pdf-extract";
import { detectFileFormat, parseSheet, SheetParseError } from "@/lib/sheet-parser";
import { detectImportFileTypeFromContent } from "@/lib/import-content-detect";
import { detectImportFileType, type ImportFileType } from "@/lib/import-file-type";
import { readLeadSheet } from "@/lib/paste-import/lead-sheet";
import { pdfTarget, sheetTarget, type DropTarget } from "@/lib/import-drop/detect";

/** 顧客管理表かどうかを見るのに読む行(見出しは先頭の数行にある)。 */
const LEAD_SCAN_ROWS = 40;

/** Excel に顧客管理表の行があるか(先頭の行だけ読む)。読めなければ 0。 */
function countLeadRows(xlsxBase64: string): number {
  try {
    const wb = XLSX.read(Buffer.from(xlsxBase64, "base64"), { type: "buffer", sheetRows: LEAD_SCAN_ROWS });
    let n = 0;
    for (const name of wb.SheetNames) {
      const aoa = XLSX.utils
        .sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: "", blankrows: true, raw: false })
        .map((r) => (r ?? []).map((c) => (c == null ? "" : String(c))));
      n += readLeadSheet(name, aoa).rows.length;
      if (n > 0) break;
    }
    return n;
  } catch {
    return 0;
  }
}

function detectSheet(body: unknown): DropTarget {
  const b = (body ?? {}) as { fileName?: unknown; csvText?: unknown; xlsxBase64?: unknown };
  if (typeof b.fileName !== "string" || b.fileName === "") {
    throw new ApiError(422, "ファイル名が必要です", "VALIDATION_ERROR");
  }
  const csvText = typeof b.csvText === "string" ? b.csvText : undefined;
  const xlsxBase64 = typeof b.xlsxBase64 === "string" ? b.xlsxBase64 : undefined;
  const isXlsx = detectFileFormat(b.fileName) === "xlsx";
  const leadRows = isXlsx && xlsxBase64 ? countLeadRows(xlsxBase64) : 0;
  let contentType: ImportFileType | null = null;
  try {
    const sheet = parseSheet({ fileName: b.fileName, csvText, xlsxBase64 });
    // 取り込みの口と同じ入力(列の並びの行)で判定する。
    const positional = sheet.rows.map((r) => sheet.headers.map((h) => r[h] ?? ""));
    contentType = detectImportFileTypeFromContent(sheet.headers, positional).type;
    // 中身で決まらなければファイル名(「受付帳」「所有者」)で補う(取り込みの口と同じ順)。
    if (contentType === "unknown" || contentType === "ambiguous") {
      const byName = detectImportFileType(b.fileName).type;
      if (byName === "reception" || byName === "owner") contentType = byName;
    }
  } catch (e) {
    // 読めない表は、取り込みには回さない(Excel は書類・CSV は人が選ぶ)。
    if (!(e instanceof SheetParseError)) throw e;
  }
  return sheetTarget({ contentType, leadRows, isXlsx });
}

export async function POST(request: NextRequest) {
  let releaseSlot = () => {};
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      assertImportMultipartBodySize(request, MAX_PDF_UPLOAD_BYTES);
      // 大きい PDF の読み取りは圧縮と同じ席を取る(8MB を超えるときだけ・添付の口と同じ)。
      releaseSlot = reserveLargePdfSlot(request);
      const formData = await request.formData();
      const file = formData.get("file");
      if (!file || !(file instanceof Blob)) {
        throw new ApiError(422, "ファイルが必要です", "VALIDATION_ERROR");
      }
      if (file.size > MAX_PDF_UPLOAD_BYTES) throw new ApiError(422, pdfTooLargeToAcceptMessage(), "VALIDATION_ERROR");
      const buffer = Buffer.from(await file.arrayBuffer());
      if (!isPdfBuffer(buffer)) return apiResponse({ target: "document" satisfies DropTarget });
      let text: string | null = null;
      try {
        text = await extractHeadTextFromPdf(buffer);
      } catch {
        text = null;
      }
      return apiResponse({ target: pdfTarget(text) });
    }

    assertImportJsonBodySize(request);
    const body = await request.json();
    return apiResponse({ target: detectSheet(body) });
  } catch (error) {
    return handleApiError(error);
  } finally {
    releaseSlot();
  }
}
