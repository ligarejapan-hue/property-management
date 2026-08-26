import { NextRequest } from "next/server";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { extractTextFromPdf, isPdfBuffer, isLikelyScannedPdf } from "@/lib/pdf-extract";
import { buildPasteDraft } from "@/lib/paste-import/build-draft";
import { lookupPasteDuplicates } from "@/lib/paste-import-duplicates";
import {
  assertImportJsonBodySize,
  assertImportMultipartBodySize,
} from "@/lib/import-body-size";
import { MAX_FILE_SIZE } from "@/lib/storage";

// ---------- POST /api/import/paste ----------
// リクエスト形式:
//   multipart/form-data → file: PDF binary
//   application/json    → { text }
//
// 貼り付けたテキスト(または PDF から抽出したテキスト)から下書きを組み立て、
// 既存物件との重複を判定して返す。まだ何も保存しない(確認画面はここから先)。

/** 貼り付けの上限。実サンプルは334文字と約900文字なので3桁の余裕がある。 */
const MAX_CHARS = 200_000;

/**
 * JSON body の上限（この口専用）。
 * ⚠共有の既定値(64MB)は CSV/XLSX 取込の口に合わせた値で、**この口の実態とは
 *   桁が違う**(@codex PR#414 5巡目)。ここが受け付けるのは `{ text }` だけで、
 *   text は MAX_CHARS(20万文字)までしか通らない。
 *   根拠: 20万文字 × 6バイト(最悪。制御文字は `\\uXXXX` の6バイトに膨らむ。
 *   日本語は UTF-8 で3バイトなのでこちらが上限) = 1.2MB。JSON の構造分と
 *   余裕を足して 4MB。
 */
const MAX_PASTE_JSON_BODY_BYTES = 4 * 1024 * 1024;
/**
 * PDF の上限。⚠**確定側(/api/import/paste/commit)と同じ定数**を使う
 * (全体レビュー I-2)。ここだけ 10MB にしていたため、9MB の PDF は読み取りに
 * 成功して人が10項目直したあと、登録の瞬間に 8MB 超で弾かれていた。
 * 案内文言も同じ定数から組み立て、数字を二重管理しない。
 */
const MAX_PDF_BYTES = MAX_FILE_SIZE;

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    // ⚠取込系 route は例外なく import:write を先に要求する（全体レビュー I-1）。
    //   src/app/api/import/** の他の全 route と同じ順序・同じ文言に揃える。
    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "物件を作る権限がありません", "FORBIDDEN");
    }

    const contentType = request.headers.get("content-type") ?? "";
    let text = "";
    // 入口(貼り付け / PDF)で案内文言を変える。人が取った経路の言葉で伝える。
    const isPdfPath = contentType.includes("multipart/form-data");

    if (isPdfPath) {
      // ⚠formData() は**ボディ全体をメモリに読み込む**。読み込んだ後で file.size を
      //   見ても、巨大なリクエストでメモリを食い潰せる(@codex PR#414 2巡目 P1)。
      //   registry-pdf-bulk と同じく Content-Length を**先に**見る。
      assertImportMultipartBodySize(request, MAX_PDF_BYTES);
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        throw new ApiError(400, "PDFファイルが見つかりません", "BAD_REQUEST");
      }
      if (file.size > MAX_PDF_BYTES) {
        throw new ApiError(
          400,
          `PDFが大きすぎます（${MAX_PDF_BYTES / 1024 / 1024}MBまで）`,
          "BAD_REQUEST",
        );
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      if (!isPdfBuffer(buffer)) {
        throw new ApiError(400, "PDFファイルではありません", "BAD_REQUEST");
      }
      text = await extractTextFromPdf(buffer);
      if (isLikelyScannedPdf(text)) {
        // ⚠無言で空の下書きを返さない。スキャン画像の PDF はここに来る。
        // ⚠判定は既存の isLikelyScannedPdf(@/lib/pdf-extract・50文字未満)を使う
        //   (全体レビュー m-2)。`trim() === ""` だと、雑音を数文字だけ吐く
        //   スキャンPDFが「読めた」ことになり、空同然の下書きが出ていた。
        throw new ApiError(
          400,
          "このPDFには文字が入っていません（画像として保存されたPDFの可能性があります）。画面をコピーして貼り付けてください。",
          "BAD_REQUEST",
        );
      }
    } else {
      // request.json() で body 全体をバッファする前に過大サイズを弾く
      // (registry-pdf/route.ts と同じ姿勢。2026-08-02 是正済みの非対称を再発させない)。
      assertImportJsonBodySize(request, MAX_PASTE_JSON_BODY_BYTES);
      const body = (await request.json()) as { text?: unknown };
      if (typeof body.text !== "string") {
        throw new ApiError(400, "貼り付けた文章がありません", "BAD_REQUEST");
      }
      text = body.text;
    }

    if (text.length > MAX_CHARS) {
      // ⚠通った経路の言葉で伝える（全体レビュー m-6）。PDF を投入した人に
      //   「貼り付けた文章が長すぎます」と言っても心当たりがない。
      throw new ApiError(
        400,
        isPdfPath
          ? `PDFの文字数が多すぎます（${MAX_CHARS.toLocaleString()}文字まで）`
          : `貼り付けた文章が長すぎます（${MAX_CHARS.toLocaleString()}文字まで）`,
        "BAD_REQUEST",
      );
    }
    if (text.trim() === "") {
      throw new ApiError(400, "貼り付けた文章がありません", "BAD_REQUEST");
    }

    // ⚠**時計を読むのはここ（API層＝境界）だけ**。純関数側は上限を引数で受け取る。
    //   築年が今年より後になることはないので、今年を上限として渡す。
    const draft = buildPasteDraft(text, { maxYear: new Date().getFullYear() });

    // ⚠重複の見立て（物件・所有者）は**見直しAPIと同じ関数**で行う。
    //   判定も、権限・表示レベル・レコードスコープの扱いも1か所に閉じ込める
    //   (@codex PR#414 6巡目 ②③)。
    const { duplicates: scopedDuplicates, similar, ownerCandidates } =
      await lookupPasteDuplicates(session, perms, {
        address: draft.property.address.value,
        lotNumber: draft.property.lotNumber.value,
        externalLinkKey: draft.externalLinkKey,
        ownerName: draft.owner?.name.value ?? null,
        ownerCurrentAddress: draft.owner?.currentAddress.value ?? null,
      });

    // ⚠貼った原文は返さない（画面側が手元に持っている。往復させるとログや
    //   ブラウザ履歴に PII が増えるだけ）。所有者候補も電話・メール・住所そのものは
    //   返さず、id/氏名/一致の種類だけに絞る。デバッグ用フィールドも一切足さない。
    return apiResponse({
      draft,
      duplicates: scopedDuplicates,
      similar,
      ownerCandidates,
      // ⚠PDF を投入したときだけ、抽出した本文を返す(全体レビュー I-5)。
      //   PDF の人は原文を手元に持っていないため、返さないと確認画面の左側に
      //   突き合わせる材料が何も無い(以前は「（PDF: ファイル名）」だけだった)。
      //   貼り付け経路では画面が原文を持っているので**返さない**(往復させると
      //   ログ・履歴に PII を増やすだけ)。
      extractedText: isPdfPath ? text : null,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
