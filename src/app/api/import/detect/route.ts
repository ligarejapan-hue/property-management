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
import {
  assertImportJsonBodySize,
  assertImportMultipartBodySize,
  MAX_IMPORT_JSON_BODY_BYTES,
} from "@/lib/import-body-size";
import { MAX_PDF_UPLOAD_BYTES, pdfTooLargeToAcceptMessage } from "@/lib/pdf-compress/policy";
import { reserveLargePdfSlot } from "@/lib/pdf-compress/fit";
import { extractHeadTextFromPdf, isPdfBuffer } from "@/lib/pdf-extract";
import {
  detectFileFormat,
  MAX_IMPORT_DECODED_BYTES,
  MAX_XLSX_EXPANDED_BYTES,
  parseSheet,
  SheetParseError,
} from "@/lib/sheet-parser";
import { assertZipExpandsWithin } from "@/lib/xlsx-zip-guard";
import { readXlsx } from "@/lib/xlsx-astral-refs";
import { detectImportFileTypeFromContent } from "@/lib/import-content-detect";
import { detectImportFileType, type ImportFileType } from "@/lib/import-file-type";
import { readLeadSheet } from "@/lib/paste-import/lead-sheet";
import { pdfTarget, sheetTarget, type DropTarget } from "@/lib/import-drop/detect";

/**
 * 顧客管理表かどうかを見るのに読む行。Excel まとめ取込(/api/import/paste/excel)と同じ範囲
 * (1シート5,000行+見出し)まで読む=取り込める表は必ず見分ける(見出しの上に空行が続く表も・@codex #607 P2)。
 * ⚠メモリは、読む前の「展開後の大きさ」の守りで抑える(行数で抑えるのではない)。
 */
const LEAD_SCAN_ROWS = 5_001;
/** Excel まとめ取込が受け付けるシートの大きさ(これを超えるシートは取り込めない=見分けない)。 */
const LEAD_SHEET_MAX_ROWS = 5_000;
const LEAD_SHEET_MAX_COLS = 200;

/**
 * 表(JSON)の本文の上限は、取り込みの口と同じ MAX_IMPORT_JSON_BODY_BYTES(64MB)。
 * ⚠16MB に絞ると、引用符の多い 10MB 近い CSV が JSON にしたときの膨らみ(" → \")で上限を超え、
 *   取り込みでは受け付ける表がここで断られる(CSV を直接入れる枠はもう無い・@codex #607 P2)。
 *   本文を読んだあとは parseSheet が中身の大きさ(10MB)・Excel の展開後の大きさで抑える。
 */
export const MAX_DETECT_JSON_BODY_BYTES = MAX_IMPORT_JSON_BODY_BYTES;

/** 受付帳/所有者を見分けるのに読む行(見出し+50行。列の並び・見出しなしの受付帳の裏付けに足りる)。 */
const RECEPTION_SCAN_ROWS = 51;

/** シートの大きさ(行・列)。配列にする前に見る。 */
function sheetDims(ws: XLSX.WorkSheet | undefined): { rows: number; cols: number } | null {
  const ref = ws?.["!fullref"] ?? ws?.["!ref"];
  if (!ref) return null;
  const range = XLSX.utils.decode_range(ref);
  return { rows: range.e.r + 1, cols: range.e.c + 1 };
}

/** シートの先頭 `maxRows` 行を文字の2次元配列にする(範囲を区切って作る=宣言だけ広いシートでも膨らまない)。 */
function sheetHead(ws: XLSX.WorkSheet, maxRows: number, blankrows: boolean): string[][] {
  const ref = ws["!ref"];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  range.e.r = Math.min(range.e.r, range.s.r + maxRows - 1);
  return XLSX.utils
    .sheet_to_json<unknown[]>(ws, { header: 1, defval: "", blankrows, raw: false, range })
    .map((r) => (r ?? []).map((c) => (c == null ? "" : String(c))));
}

/**
 * Excel を見分ける(受付帳/所有者・顧客管理表)。**見分けるのに要る先頭の行だけ**を、大きさを確かめてから読む。
 * ⚠取り込みの読み方(parseSheet)はシート全体を配列にするので、宣言だけ広いシート(A1:XFD1048576 など)で
 *   大きさの守りの前に重くなる。ここでは使わない(@codex #607 P1・セキュリティ確認)。
 *   守り: 本文の大きさ → 展開後の大きさ → シートの大きさ(Excel まとめ取込と同じ 5,000行・200列)→ 読む行の数。
 */
function inspectXlsx(xlsxBase64: string): { contentType: ImportFileType | null; leadRows: number } {
  if (Math.floor((xlsxBase64.length * 3) / 4) > MAX_IMPORT_DECODED_BYTES) {
    throw new ApiError(422, "ファイルが大きすぎます", "VALIDATION_ERROR");
  }
  const buf = Buffer.from(xlsxBase64, "base64");
  let wb: XLSX.WorkBook;
  try {
    assertZipExpandsWithin(buf, MAX_XLSX_EXPANDED_BYTES);
    wb = readXlsx(buf, { type: "buffer", sheetRows: LEAD_SCAN_ROWS });
  } catch {
    throw new ApiError(422, "Excelファイルの中身が大きすぎるか、壊れています", "VALIDATION_ERROR");
  }

  // 受付帳/所有者: 取り込みと同じく1枚目のシートの見出しと行で見る(列が多すぎるシートは見分けない)。
  let contentType: ImportFileType | null = null;
  const first = wb.Sheets[wb.SheetNames[0] ?? ""];
  const firstDims = sheetDims(first);
  if (first && firstDims && firstDims.cols <= LEAD_SHEET_MAX_COLS) {
    const aoa = sheetHead(first, RECEPTION_SCAN_ROWS, false);
    if (aoa.length > 0) {
      contentType = detectImportFileTypeFromContent(aoa[0], aoa.slice(1)).type;
    }
  }

  // 顧客管理表: 全シートを見る(1枚目が空でも後ろのシートにあることがある・@codex #607 P2)。
  //   取り込みが断る大きさのシートは、顧客管理表ではないとして飛ばす。
  let leadRows = 0;
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const dims = sheetDims(ws);
    if (!ws || !dims || dims.rows > LEAD_SHEET_MAX_ROWS || dims.cols > LEAD_SHEET_MAX_COLS) continue;
    leadRows += readLeadSheet(name, sheetHead(ws, LEAD_SCAN_ROWS, true)).rows.length;
    if (leadRows > 0) break;
  }
  return { contentType, leadRows };
}

/** CSV を見分ける(取り込みと同じ読み方=文字は 10MB まで)。 */
function inspectCsv(fileName: string, csvText: string | undefined): ImportFileType | null {
  try {
    const sheet = parseSheet({ fileName, csvText });
    // 取り込みの口と同じ入力(列の並びの行)で判定する。
    const positional = sheet.rows.map((r) => sheet.headers.map((h) => r[h] ?? ""));
    return detectImportFileTypeFromContent(sheet.headers, positional).type;
  } catch (e) {
    if (!(e instanceof SheetParseError)) throw e;
    // 大きすぎる表は、ここで断る(受け取り箱にも取り込みにも回さない)。
    if (e.code === "INPUT_TOO_LARGE") throw new ApiError(422, e.message, "VALIDATION_ERROR");
    // ほかの読めない表は、取り込みには回さない(人が選ぶ)。
    return null;
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
  let contentType: ImportFileType | null;
  let leadRows = 0;
  if (isXlsx) {
    if (!xlsxBase64) return sheetTarget({ contentType: null, leadRows: 0, isXlsx });
    ({ contentType, leadRows } = inspectXlsx(xlsxBase64));
  } else {
    contentType = inspectCsv(b.fileName, csvText);
  }
  // 中身で決まらなければファイル名(「受付帳」「所有者」)で補う(取り込みの口と同じ順)。
  if (contentType === null || contentType === "unknown" || contentType === "ambiguous") {
    const byName = detectImportFileType(b.fileName).type;
    if (byName === "reception" || byName === "owner") contentType = byName;
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

    assertImportJsonBodySize(request, MAX_DETECT_JSON_BODY_BYTES);
    const body = await request.json();
    return apiResponse({ target: detectSheet(body) });
  } catch (error) {
    return handleApiError(error);
  } finally {
    releaseSlot();
  }
}
