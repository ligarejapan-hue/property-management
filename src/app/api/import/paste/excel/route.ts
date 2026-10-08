import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
  type PermissionEntry,
} from "@/lib/api-helpers";
import { createOwnerSchema } from "@/lib/validators";
import { hasPermission, hasExplicitWritePerm } from "@/lib/permissions";
import { buildPasteDraft } from "@/lib/paste-import/build-draft";
import type { PasteDraft } from "@/lib/paste-import/types";
import {
  readLeadSheet,
  withFallbackLinkKey,
  composeLeadOwnerNote,
  leadRowStatus,
  type LeadRow,
} from "@/lib/paste-import/lead-sheet";
import { lookupPasteDuplicates } from "@/lib/paste-import-duplicates";
import { assertImportJsonBodySize } from "@/lib/import-body-size";
import {
  detectFileFormat,
  MAX_IMPORT_DECODED_BYTES,
  MAX_XLSX_EXPANDED_BYTES,
  cellToString,
} from "@/lib/sheet-parser";
import { assertZipExpandsWithin } from "@/lib/xlsx-zip-guard";

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
 * 1シートの範囲(行・列)の上限。**中身を組み立てる前に**範囲だけで断る
 * (@codex PR#456 2巡目 ③)。圧縮で10MBに収まる繰り返しの多いファイルでも、
 * 全行を配列にしてから1,000行を数えたのでは上限が守りにならない。
 * 実物は書式だけ下まで付いて1シート約1,000行(A1:AJ1015)なので、その5倍。
 */
const MAX_SHEET_ROWS = 5000;
const MAX_SHEET_COLS = 200;


/**
 * JSON body の上限。Excel 本体(デコード後10MBまで・取込共通の上限)を
 * base64 にすると約4/3倍になるので、その分と JSON の構造分を見込む。
 */
const MAX_EXCEL_JSON_BODY_BYTES = Math.ceil((MAX_IMPORT_DECODED_BYTES * 4) / 3) + 64 * 1024;

/**
 * 反響番号の無い行の鍵。依頼日・氏名・物件の住所から作る**ハッシュ**
 * (個人情報そのものを物件の欄に残さない)。取り込み直しても同じ鍵になる。
 */
function fallbackLinkKey(row: LeadRow, draft: PasteDraft): string {
  // ⚠**本文から読んだ氏名・物件の住所も材料に入れる**(@codex PR#456 9巡目)。
  //   補助の列(姓名・住所 物件名)が空や古いままだと、同じ日の別の反響が同じ鍵になり、
  //   2件目が「登録済み」扱いで黙って飛ばされる。本文はメモや進み具合の書き足しでは
  //   変わらないので、取り込み直しても同じ鍵になる性質は保つ。
  // ⚠氏名は**申込者(お名前)の生の値**を使う(@codex PR#491 6巡目)。所有者の氏名は
  //   ご所有者様名を優先するようになったので、それを使うと以前に取り込んだ行と
  //   鍵が変わり、同じ表を取り込み直したときに二重登録を止められない。
  //   以前の owner.name はお名前の値そのもの(無ければ空)だったので、これで同じ鍵になる。
  const seed = [
    row.keySeed,
    draft.applicantName ?? "",
    draft.property.address.value ?? "",
  ].join("|");
  return `xlsx-${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

/** 所有者の項目と、登録APIが書き込みに求める権限(commit/route.ts と同じ対応)。 */
const OWNER_FIELD_PERMS = [
  { key: "name", resource: "owner_name", label: "氏名" },
  { key: "nameKana", resource: "owner_name_kana", label: "フリガナ" },
  { key: "phone", resource: "owner_phone", label: "電話番号" },
  { key: "email", resource: "owner_email", label: "メールアドレス" },
  { key: "currentAddress", resource: "owner_address", label: "現住所" },
] as const;

/** この人がこの行を登録できない理由(所有者の項目の権限・メールの形式)。 */
function ownerFieldReasons(draft: PasteDraft, perms: PermissionEntry[]): string[] {
  const owner = draft.owner;
  if (!owner) return [];
  const reasons: string[] = [];
  for (const f of OWNER_FIELD_PERMS) {
    const value = owner[f.key].value;
    if (value && value.trim() !== "" && !hasExplicitWritePerm(perms, f.resource)) {
      reasons.push(`${f.label}を書き込む権限がありません`);
    }
  }
  const email = owner.email.value?.trim() ?? "";
  if (email !== "" && !createOwnerSchema.shape.email.safeParse(email).success) {
    reasons.push("メールアドレスの形式が正しくありません");
  }
  return reasons;
}

/**
 * シートを「セルの文字列の2次元配列」にする(表示どおりの文字=日付・先頭0も見たまま)。
 * ⚠**配列の添字 = Excel の行番号 - 1** に揃える(行番号は人が元の表と突き合わせる
 *   ために画面と所有者の備考に出る)。
 *   ・空行を落とさない(blankrows: true)。落とすと、その後ろの行番号が全部ずれる
 *     (空行は readLeadSheet が読み飛ばす)。
 *   ・表が1行目から始まっていないときは、その分の空行を前に足す
 *     (sheet_to_json は使われている範囲の先頭行から返す)。
 * ⚠**指数表記に丸められた数値は元の数値に戻す**(@codex PR#456 6巡目)。
 *   12桁以上の案件IDが数値で入っていると、表示用の文字は `1.23456E+11` になり、
 *   別々の反響が同じ反響番号になる(2件目は「登録済み」扱いで黙って飛ばされる)。
 *   日付などは表示どおりの文字が正しいので、指数表記のセルだけを生の値で置き換える
 *   (既存の取込と同じ cellToString で桁を落とさずに文字にする)。
 */
const SCIENTIFIC = /^-?\d+(\.\d+)?E[+-]\d+$/i;
function sheetToStrings(sheet: XLSX.WorkSheet): string[][] {
  const opts = { header: 1 as const, defval: "", blankrows: true };
  const shown = XLSX.utils.sheet_to_json<unknown[]>(sheet, { ...opts, raw: false });
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { ...opts, raw: true });
  const firstRow = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]).s.r : 0;
  const lead: string[][] = Array.from({ length: firstRow }, () => []);
  return [
    ...lead,
    ...shown.map((r, i) =>
      (r ?? []).map((c, j) => {
        const text = c == null ? "" : String(c);
        const value = raw[i]?.[j];
        return SCIENTIFIC.test(text.trim()) && typeof value === "number" ? cellToString(value) : text;
      }),
    ),
  ];
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
    // ⚠登録では所有者を作り、**管理の列(見込度・担当者・メモ)を所有者の備考へ**入れる。
    //   書けない人に下見を見せると、登録で全行403になる(@codex PR#456 1巡目 ②)。
    //   既定の事務担当は owner_note が「読むだけ」なので、ここで分かる言葉で断る。
    //   (備考を省いて登録する道は作らない＝管理の情報を黙って捨てない。)
    if (!hasPermission(perms, "owner", "write")) {
      throw new ApiError(403, "所有者を作る権限がありません", "FORBIDDEN");
    }
    if (!hasExplicitWritePerm(perms, "owner_note")) {
      throw new ApiError(
        403,
        "この取込は、見込度・担当者・メモを所有者の備考に入れます。所有者の備考を書く権限が必要です（管理者に依頼してください）",
        "FORBIDDEN",
      );
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

    const buf = Buffer.from(base64, "base64");
    // ⚠**展開後の大きさ**を先に抑える(@codex PR#456 5巡目)。XLSX.read は中身を丸ごと
    //   展開してから sheetRows を当てるので、小さく圧縮された巨大ファイルで
    //   メモリを食い潰せる。申告サイズは信じず、実際に展開しながら上限で止める。
    try {
      assertZipExpandsWithin(buf, MAX_XLSX_EXPANDED_BYTES);
    } catch {
      throw new ApiError(
        400,
        "Excelファイルの中身が大きすぎるか、壊れています。不要なシートや書式を消してから取り込んでください",
        "BAD_REQUEST",
      );
    }

    let wb: XLSX.WorkBook;
    try {
      // ⚠sheetRows で**読み込む行そのもの**を上限で打ち切る(本来の範囲は !fullref に残る)。
      wb = XLSX.read(buf, {
        type: "buffer",
        sheetRows: MAX_SHEET_ROWS + 1,
      });
    } catch {
      throw new ApiError(400, "Excelファイルを読み取れませんでした", "BAD_REQUEST");
    }

    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      const ref = ws["!fullref"] ?? ws["!ref"];
      if (!ref) continue;
      const range = XLSX.utils.decode_range(ref);
      if (range.e.r + 1 > MAX_SHEET_ROWS || range.e.c + 1 > MAX_SHEET_COLS) {
        throw new ApiError(
          400,
          `シート「${name}」が大きすぎます（1シート${MAX_SHEET_ROWS.toLocaleString()}行・${MAX_SHEET_COLS}列まで）。不要な行や列を消してから取り込んでください`,
          "BAD_REQUEST",
        );
      }
    }

    // ⚠上限を超えた時点で打ち切る(全シートを配列にしてから数えない)。
    const leadRows: LeadRow[] = [];
    for (const name of wb.SheetNames) {
      leadRows.push(...readLeadSheet(name, sheetToStrings(wb.Sheets[name])).rows);
      if (leadRows.length > MAX_ROWS) break;
    }
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
      const text = withFallbackLinkKey(row.text, first, fallbackLinkKey(row, first));
      const draft = text === row.text ? first : buildPasteDraft(text, { maxYear });
      const dup = await lookupPasteDuplicates(session, perms, {
        address: draft.property.address.value,
        lotNumber: draft.property.lotNumber.value,
        externalLinkKey: draft.externalLinkKey,
        ownerName: draft.owner?.name.value ?? null,
        ownerCurrentAddress: draft.owner?.currentAddress.value ?? null,
      });
      const judged = leadRowStatus(draft, {
        blocked: dup.duplicates.blocked,
        similarCount: dup.similar.length,
        ownerCandidateCount: dup.ownerCandidates.length,
        ownerCandidatesTruncated: dup.ownerCandidatesTruncated,
      });
      // ⚠登録で必ず断られる行を「登録できる」と言わない(@codex PR#456 11巡目 ②③)。
      //   登録APIは所有者の項目ごとの書き込み権限とメールの形式を確かめる。
      const extra = judged.status === "registered" ? [] : ownerFieldReasons(draft, perms);
      const reasons = [...judged.reasons, ...extra];
      const status = judged.status === "ready" && extra.length > 0 ? "review" : judged.status;
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
