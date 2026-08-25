import { NextRequest } from "next/server";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { extractTextFromPdf, isPdfBuffer } from "@/lib/pdf-extract";
import { buildPasteDraft } from "@/lib/paste-import/build-draft";
import { judgeDuplicates, type ExistingProperty } from "@/lib/paste-import/find-duplicates";

// ---------- POST /api/import/paste ----------
// リクエスト形式:
//   multipart/form-data → file: PDF binary
//   application/json    → { text }
//
// 貼り付けたテキスト(または PDF から抽出したテキスト)から下書きを組み立て、
// 既存物件との重複を判定して返す。まだ何も保存しない(確認画面はここから先)。

/** 貼り付けの上限。実サンプルは334文字と約900文字なので3桁の余裕がある。 */
const MAX_CHARS = 200_000;
/** PDF の上限（10MB）。 */
const MAX_PDF_BYTES = 10 * 1024 * 1024;

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "物件を作る権限がありません", "FORBIDDEN");
    }

    const contentType = request.headers.get("content-type") ?? "";
    let text = "";

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        throw new ApiError(400, "PDFファイルが見つかりません", "BAD_REQUEST");
      }
      if (file.size > MAX_PDF_BYTES) {
        throw new ApiError(400, "PDFが大きすぎます（10MBまで）", "BAD_REQUEST");
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      if (!isPdfBuffer(buffer)) {
        throw new ApiError(400, "PDFファイルではありません", "BAD_REQUEST");
      }
      text = await extractTextFromPdf(buffer);
      if (text.trim() === "") {
        // ⚠無言で空の下書きを返さない。スキャン画像の PDF はここに来る。
        throw new ApiError(
          400,
          "このPDFには文字が入っていません（画像として保存されたPDFの可能性があります）。画面をコピーして貼り付けてください。",
          "BAD_REQUEST",
        );
      }
    } else {
      const body = (await request.json()) as { text?: unknown };
      if (typeof body.text !== "string") {
        throw new ApiError(400, "貼り付けた文章がありません", "BAD_REQUEST");
      }
      text = body.text;
    }

    if (text.length > MAX_CHARS) {
      throw new ApiError(
        400,
        `貼り付けた文章が長すぎます（${MAX_CHARS.toLocaleString()}文字まで）`,
        "BAD_REQUEST",
      );
    }
    if (text.trim() === "") {
      throw new ApiError(400, "貼り付けた文章がありません", "BAD_REQUEST");
    }

    const draft = buildPasteDraft(text);

    // 重複の手がかり: 外部キーか、正規化前の住所で粗く引いてから純関数で判定する。
    const or: Record<string, unknown>[] = [];
    if (draft.externalLinkKey) or.push({ externalLinkKey: draft.externalLinkKey });
    if (draft.property.address.value) {
      or.push({ address: { contains: draft.property.address.value.slice(0, 20) } });
    }

    let candidates: ExistingProperty[] = [];
    if (or.length > 0) {
      const rows = await prisma.property.findMany({
        where: { OR: or, isArchived: false },
        select: { id: true, address: true, lotNumber: true, externalLinkKey: true },
        take: 50,
      });
      candidates = rows;
    }

    const duplicates = judgeDuplicates(
      {
        address: draft.property.address.value,
        lotNumber: draft.property.lotNumber.value,
        externalLinkKey: draft.externalLinkKey,
      },
      candidates,
    );

    const similar = candidates
      .filter((c) => duplicates.similarPropertyIds.includes(c.id))
      .map((c) => ({ id: c.id, address: c.address, lotNumber: c.lotNumber }));

    // ⚠貼った原文は返さない（画面側が手元に持っている。往復させるとログや
    //   ブラウザ履歴に PII が増えるだけ）。デバッグ用フィールドも一切足さない。
    return apiResponse({
      draft,
      duplicates,
      similar,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
