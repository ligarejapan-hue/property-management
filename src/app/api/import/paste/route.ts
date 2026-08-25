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
import { assertImportJsonBodySize } from "@/lib/import-body-size";
import { buildOwnerDedupKey } from "@/lib/owner-dedup";

/** 所有者の重複候補として返す1件。氏名/一致の強さのみ(電話・メール・住所は返さない)。 */
interface OwnerCandidate {
  id: string;
  name: string;
  /** strong = 氏名+現住所の鍵が一致(同一人物の可能性が高い)。weak = 氏名だけ一致。 */
  matchStrength: "strong" | "weak";
}

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
      // request.json() で body 全体をバッファする前に過大サイズを弾く
      // (registry-pdf/route.ts と同じ姿勢。2026-08-02 是正済みの非対称を再発させない)。
      assertImportJsonBodySize(request);
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

    // 重複の手がかり: 外部キー一致と住所の前方一致は**別クエリ**で引く。
    // ⚠1つの OR に混ぜて take で切ると、同じ建物の多数戸が既に登録されている
    //   ときに住所一致だけで take を埋めてしまい、ブロックすべき唯一の外部キー
    //   一致行が結果から漏れる(=二重登録を防げない)。外部キー一致は完全一致
    //   なので件数は少なく、take で切らない。住所の前方一致だけ take:50 を掛け、
    //   最後に id で重複を除いて合流する。
    const select = { id: true, address: true, lotNumber: true, externalLinkKey: true } as const;
    const candidateMap = new Map<string, ExistingProperty>();

    if (draft.externalLinkKey) {
      const keyRows = await prisma.property.findMany({
        where: { externalLinkKey: draft.externalLinkKey, isArchived: false },
        select,
      });
      for (const row of keyRows) candidateMap.set(row.id, row);
    }

    if (draft.property.address.value) {
      const addressRows = await prisma.property.findMany({
        where: {
          address: { contains: draft.property.address.value.slice(0, 20) },
          isArchived: false,
        },
        select,
        take: 50,
      });
      for (const row of addressRows) candidateMap.set(row.id, row);
    }

    const candidates: ExistingProperty[] = Array.from(candidateMap.values());

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

    // ---- 所有者の重複候補(設計書 §6: 氏名+住所が一致すれば候補を並べて選ばせる) ----
    // ⚠draft.owner.currentAddress は「現住所」(Owner.currentAddress と同じ意味)。
    //   Owner.address は「登記上の住所」で意味が別(設計 2026-08-10-owner-current-address-design.md)。
    //   貼り付け元は現住所しか持たないので、登記上住所(Owner.address)と比べると
    //   意味の違う値同士を突き合わせることになり、一致すべきでない/しないケースを
    //   両方生む。よって照合は Owner.currentAddress を使う。
    const ownerName = draft.owner?.name.value?.trim() ?? "";
    let ownerCandidates: OwnerCandidate[] = [];
    if (ownerName !== "") {
      const ownerRows = await prisma.owner.findMany({
        where: { name: ownerName, isArchived: false },
        select: { id: true, name: true, currentAddress: true },
        take: 20,
      });

      const draftAddress = draft.owner?.currentAddress.value?.trim() ?? "";
      const draftKey = draftAddress ? buildOwnerDedupKey(ownerName, draftAddress) : null;

      ownerCandidates = ownerRows.map((row) => {
        const candAddress = row.currentAddress?.trim() ?? "";
        const strong =
          draftKey !== null &&
          candAddress !== "" &&
          buildOwnerDedupKey(row.name, candAddress) === draftKey;
        return { id: row.id, name: row.name, matchStrength: strong ? "strong" : "weak" };
      });
    }

    // ⚠貼った原文は返さない（画面側が手元に持っている。往復させるとログや
    //   ブラウザ履歴に PII が増えるだけ）。所有者候補も電話・メール・住所は返さず
    //   id/氏名/一致の強さだけに絞る。デバッグ用フィールドも一切足さない。
    return apiResponse({
      draft,
      duplicates,
      similar,
      ownerCandidates,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
