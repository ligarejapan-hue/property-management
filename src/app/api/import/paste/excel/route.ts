import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { buildPasteDraft } from "@/lib/paste-import/build-draft";
import {
  readLeadSheet,
  withFallbackLinkKey,
  composeLeadOwnerNote,
  leadRowStatus,
  type LeadRow,
} from "@/lib/paste-import/lead-sheet";
import { lookupPasteDuplicates } from "@/lib/paste-import-duplicates";
import { assertImportJsonBodySize } from "@/lib/import-body-size";
import { detectFileFormat, MAX_IMPORT_DECODED_BYTES } from "@/lib/sheet-parser";

// ---------- POST /api/import/paste/excel ----------
// 査定サイトの反響を書き溜めた顧客管理表(Excel)を読み、行ごとに
// 「貼り付けて物件化」と同じ下書きを作って返す。**まだ何も保存しない**。
// 登録は画面が1行ずつ /api/import/paste/commit を呼ぶ(二重登録の止め・
// 項目ごとの権限・監査は、貼り付けと同じ1本の経路を通る)。
//
// リクエスト: application/json { fileName, xlsxBase64 }

/** 1回に読む行の上限。発注者の実物は3シート計240行。 */
const MAX_ROWS = 1000;

/**
 * JSON body の上限。Excel 本体(デコード後10MBまで・取込共通の上限)を
 * base64 にすると約4/3倍になるので、その分と JSON の構造分を見込む。
 */
const MAX_EXCEL_JSON_BODY_BYTES = Math.ceil((MAX_IMPORT_DECODED_BYTES * 4) / 3) + 64 * 1024;

/**
 * 反響番号の無い行の鍵。依頼日・氏名・物件の住所から作る**ハッシュ**
 * (個人情報そのものを物件の欄に残さない)。取り込み直しても同じ鍵になる。
 */
function fallbackLinkKey(row: LeadRow): string {
  return `xlsx-${createHash("sha256").update(row.keySeed).digest("hex").slice(0, 16)}`;
}

/**
 * シートを「セルの文字列の2次元配列」にする(表示どおりの文字=日付・先頭0も見たまま)。
 * ⚠**配列の添字 = Excel の行番号 - 1** に揃える(行番号は人が元の表と突き合わせる
 *   ために画面と所有者の備考に出る)。
 *   ・空行を落とさない(blankrows: true)。落とすと、その後ろの行番号が全部ずれる
 *     (空行は readLeadSheet が読み飛ばす)。
 *   ・表が1行目から始まっていないときは、その分の空行を前に足す
 *     (sheet_to_json は使われている範囲の先頭行から返す)。
 */
function sheetToStrings(sheet: XLSX.WorkSheet): string[][] {
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: true,
  });
  const firstRow = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]).s.r : 0;
  const lead: string[][] = Array.from({ length: firstRow }, () => []);
  return [...lead, ...aoa.map((r) => (r ?? []).map((c) => (c == null ? "" : String(c))))];
}

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    // ⚠取込系 route は例外なく import:write を先に要求する(貼り付けと同じ順序・文言)。
    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "物件を作る権限がありません", "FORBIDDEN");
    }

    assertImportJsonBodySize(request, MAX_EXCEL_JSON_BODY_BYTES);
    const body = (await request.json().catch(() => null)) as
      | { fileName?: unknown; xlsxBase64?: unknown }
      | null;
    const fileName = typeof body?.fileName === "string" ? body.fileName : "";
    const base64 = typeof body?.xlsxBase64 === "string" ? body.xlsxBase64 : "";
    if (detectFileFormat(fileName) !== "xlsx" || base64 === "") {
      throw new ApiError(400, "Excelファイル（.xlsx）を選んでください", "BAD_REQUEST");
    }
    if (Math.floor((base64.length * 3) / 4) > MAX_IMPORT_DECODED_BYTES) {
      throw new ApiError(400, "ファイルが大きすぎます", "BAD_REQUEST");
    }

    let wb: XLSX.WorkBook;
    try {
      wb = XLSX.read(Buffer.from(base64, "base64"), { type: "buffer" });
    } catch {
      throw new ApiError(400, "Excelファイルを読み取れませんでした", "BAD_REQUEST");
    }

    const leadRows = wb.SheetNames.flatMap(
      (name) => readLeadSheet(name, sheetToStrings(wb.Sheets[name])).rows,
    );
    if (leadRows.length === 0) {
      throw new ApiError(
        400,
        "取り込める行が見つかりませんでした。「姓名」の列がある顧客管理表（反響メール本文の「URL」列つき、または「物件所在地」の列つき）に対応しています",
        "BAD_REQUEST",
      );
    }
    if (leadRows.length > MAX_ROWS) {
      throw new ApiError(
        400,
        `行が多すぎます（1回に${MAX_ROWS.toLocaleString()}行まで）。シートを分けて取り込んでください`,
        "BAD_REQUEST",
      );
    }

    // ⚠時計を読むのは API 層(境界)だけ(貼り付けと同じ)。
    const maxYear = new Date().getFullYear();
    const rows = [];
    // ⚠重複の見立ては**1行ずつ順に**。並列にすると行数ぶんの問い合わせが
    //   同時に走り、接続を食い潰す。
    for (const row of leadRows) {
      const first = buildPasteDraft(row.text, { maxYear });
      const text = withFallbackLinkKey(row.text, first, fallbackLinkKey(row));
      const draft = text === row.text ? first : buildPasteDraft(text, { maxYear });
      const dup = await lookupPasteDuplicates(session, perms, {
        address: draft.property.address.value,
        lotNumber: draft.property.lotNumber.value,
        externalLinkKey: draft.externalLinkKey,
        ownerName: draft.owner?.name.value ?? null,
        ownerCurrentAddress: draft.owner?.currentAddress.value ?? null,
      });
      const { status, reasons } = leadRowStatus(draft, {
        blocked: dup.duplicates.blocked,
        similarCount: dup.similar.length,
        ownerCandidateCount: dup.ownerCandidates.length,
        ownerCandidatesTruncated: dup.ownerCandidatesTruncated,
      });
      rows.push({
        sheetName: row.sheetName,
        rowNumber: row.rowNumber,
        // 要確認の行を「貼り付けて物件化」へ回すための文章(鍵の行つき)。
        text,
        draft,
        ownerNote: composeLeadOwnerNote(row, draft),
        status,
        reasons,
        registeredPropertyId: dup.duplicates.blockedByPropertyId,
      });
    }

    return apiResponse({ rows });
  } catch (error) {
    return handleApiError(error);
  }
}
