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
import {
  detectFileFormat,
  MAX_IMPORT_DECODED_BYTES,
  MAX_XLSX_EXPANDED_BYTES,
  parseSheet,
  SheetParseError,
} from "@/lib/sheet-parser";
import { assertZipExpandsWithin } from "@/lib/xlsx-zip-guard";
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
 * 表(JSON)の本文の上限。⚠この口は大きい PDF のために proxy を通らない(proxy の 10MB の先読みが効かない)
 * ので、表の取り込みの中身の上限(10MB・base64 で約 13.4MB)に合わせて、ここで本文を読む前に抑える。
 */
export const MAX_DETECT_JSON_BODY_BYTES = 16 * 1024 * 1024;

/**
 * Excel に顧客管理表の行があるか(先頭の行だけ読む)。読めなければ 0。
 * ⚠XLSX.read は中身を丸ごと展開してから行数で切るので、先に**展開後の大きさ**を抑える
 *   (Excel まとめ取込と同じ守り・小さく圧縮された巨大ファイルでメモリを食わない)。
 */
function countLeadRows(xlsxBase64: string): number {
  if (Math.floor((xlsxBase64.length * 3) / 4) > MAX_IMPORT_DECODED_BYTES) return 0;
  try {
    const buf = Buffer.from(xlsxBase64, "base64");
    assertZipExpandsWithin(buf, MAX_XLSX_EXPANDED_BYTES);
    const wb = XLSX.read(buf, { type: "buffer", sheetRows: LEAD_SCAN_ROWS });
    let n = 0;
    for (const name of wb.SheetNames) {
      // ⚠Excel まとめ取込と同じく、シートの大きさ(行・列)を**配列にする前に**見る。遠くのセル1つで
      //   範囲が広がったシートを配列にすると、空のセルで埋めた巨大な表ができてメモリを食う(セキュリティ確認)。
      //   取り込みが断る大きさのシートは、顧客管理表ではないとして飛ばす。
      const ws = wb.Sheets[name];
      const ref = ws?.["!fullref"] ?? ws?.["!ref"];
      if (!ref) continue;
      const range = XLSX.utils.decode_range(ref);
      if (range.e.r + 1 > LEAD_SHEET_MAX_ROWS || range.e.c + 1 > LEAD_SHEET_MAX_COLS) continue;
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
  let contentType: ImportFileType | null = null;
  try {
    // 先に取り込みと同じ読み方で読む(大きさ・展開後の大きさの守りもここで効く)。
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
    if (!(e instanceof SheetParseError)) throw e;
    // 大きすぎる表は、ここで断る(受け取り箱にも取り込みにも回さない)。
    if (e.code === "INPUT_TOO_LARGE") throw new ApiError(422, e.message, "VALIDATION_ERROR");
    // ほかの読めない表は、取り込みには回さない(Excel は書類・CSV は人が選ぶ)。
  }
  // 顧客管理表は Excel だけ。全シートを見る(1枚目が空でも後ろのシートにあることがある・@codex #607 P2)。
  //   大きすぎるものは上で断った。countLeadRows も自分で大きさ・展開後の大きさを確かめてから読む。
  const leadRows = isXlsx && xlsxBase64 ? countLeadRows(xlsxBase64) : 0;
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
