import { randomUUID } from "node:crypto";
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
import { writeAuditLog } from "@/lib/audit";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { isPdfBuffer } from "@/lib/pdf-extract";
import { getStorage, validateFile, ALLOWED_ATTACHMENT_MIMES, MAX_FILE_SIZE } from "@/lib/storage";
import { assertImportJsonBodySize } from "@/lib/import-body-size";
import type { PropertyType, OccupancyStatus } from "@/generated/prisma";

// ---------- POST /api/import/paste/commit ----------
// 「貼り付けて物件化」の確認画面で人が直した最終値を受け取り、物件・所有者・
// 紐付け・(あれば)添付を1つのトランザクションで確定する。
//
// リクエスト形式:
//   application/json    → CommitBody のみ(PDF なし)
//   multipart/form-data → data: CommitBody を JSON 文字列で・file: PDF(任意)
//                          (取込元の PDF をそのまま物件の添付として保存したい場合)
//
// ⚠この API は「貼った原文」を受け取らない・返さない・監査ログにも書かない。
//   確認画面は Task 7 の下書き(PasteDraft)を人が直した後の**確定値**だけを渡す。

interface CommitBody {
  property: {
    address: string;
    lotNumber: string | null;
    propertyType: string;
    buildingName: string | null;
    roomNo: string | null;
    exclusiveArea: string | null;
    layoutType: string | null;
    occupancyStatus: string | null;
    note: string | null;
  };
  owner: {
    name: string;
    nameKana: string | null;
    phone: string | null;
    email: string | null;
    currentAddress: string | null;
  } | null;
  externalLinkKey: string | null;
  /** 既存の所有者に紐付ける場合。指定があれば新規作成しない。 */
  linkExistingOwnerId?: string | null;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "物件を作る権限がありません", "FORBIDDEN");
    }

    let body: CommitBody;
    let pdfBuffer: Buffer | null = null;
    let pdfFileName = "paste-import.pdf";

    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const dataRaw = form.get("data");
      if (typeof dataRaw !== "string") {
        throw new ApiError(400, "登録データがありません", "BAD_REQUEST");
      }
      try {
        body = JSON.parse(dataRaw) as CommitBody;
      } catch {
        throw new ApiError(400, "登録データが不正な JSON です", "BAD_REQUEST");
      }

      const file = form.get("file");
      if (file && typeof file !== "string") {
        // ⚠案内文言と実際の上限を二重管理しない。実効値は validateFile
        //   (@/lib/storage) が使う MAX_FILE_SIZE と同じ定数を直接参照する
        //   (Task 8 レビュー Minor: 10MBと案内しつつ実際は8MBで弾かれていた)。
        if (file.size > MAX_FILE_SIZE) {
          throw new ApiError(
            400,
            `PDFが大きすぎます(${MAX_FILE_SIZE / 1024 / 1024}MBまで)`,
            "BAD_REQUEST",
          );
        }
        const buffer = Buffer.from(await file.arrayBuffer());
        if (!isPdfBuffer(buffer)) {
          throw new ApiError(400, "PDFファイルではありません", "BAD_REQUEST");
        }
        pdfBuffer = buffer;
        pdfFileName = file.name || pdfFileName;
      }
    } else {
      // ⚠request.json() でボディ全体をバッファする前に過大サイズを弾く
      //   (兄弟ルート /api/import/paste と同じ姿勢。Task 8 レビュー Important)。
      assertImportJsonBodySize(request);
      body = (await request.json()) as CommitBody;
    }

    if (!body?.property?.address || body.property.address.trim() === "") {
      throw new ApiError(400, "住所がありません", "BAD_REQUEST");
    }
    const wantsOwner = Boolean(body.owner?.name || body.linkExistingOwnerId);
    if (wantsOwner && !hasPermission(perms, "owner", "write")) {
      throw new ApiError(403, "所有者を作る権限がありません", "FORBIDDEN");
    }
    if (pdfBuffer) {
      const validationError = validateFile(
        pdfBuffer.length,
        "application/pdf",
        ALLOWED_ATTACHMENT_MIMES,
      );
      if (validationError) {
        throw new ApiError(400, validationError, "INVALID_FILE");
      }
    }

    const p = body.property;

    // PDF があるときだけ、物件 id を先に確定する。ストレージ保存(外部I/O)を
    // トランザクションの外で行うために、保存先キーへ埋め込む id が要る。
    // PDF が無ければ id は Prisma の既定(uuid)に任せる。
    const pregenPropertyId = pdfBuffer ? randomUUID() : null;

    // ⚠外部ストレージへの保存はトランザクションの外で行う(ロックを持つのは
    //   作成の一瞬だけ・attachment-create-parent-lock.test.ts のコメントと同じ型)。
    let uploadedUrl: string | null = null;
    if (pdfBuffer && pregenPropertyId) {
      const key = `properties/${pregenPropertyId}/paste-import/${Date.now()}-${randomUUID()}.pdf`;
      const uploaded = await getStorage().upload(pdfBuffer, {
        key,
        mimeType: "application/pdf",
        fileName: pdfFileName,
      });
      uploadedUrl = uploaded.url;
    }

    const result = await prisma.$transaction(async (tx) => {
      const property = await tx.property.create({
        data: {
          ...(pregenPropertyId ? { id: pregenPropertyId } : {}),
          address: p.address.trim(),
          lotNumber: p.lotNumber?.trim() || null,
          buildingName: p.buildingName?.trim() || null,
          roomNo: p.roomNo?.trim() || null,
          propertyType: (p.propertyType || "unknown") as PropertyType,
          // Decimal(8,2) 列。文字列のまま渡してよい(空文字は null にする)。
          exclusiveArea: p.exclusiveArea ? p.exclusiveArea : null,
          layoutType: p.layoutType?.trim() || null,
          occupancyStatus: (p.occupancyStatus || null) as OccupancyStatus | null,
          externalLinkKey: body.externalLinkKey?.trim() || null,
          note: p.note?.trim() || null,
          introductionRoute: "web_inquiry",
          caseStatus: "new_case",
          registryStatus: "unconfirmed",
          dmStatus: "hold",
          createdBy: session.id,
        },
      });

      let ownerId: string | null = body.linkExistingOwnerId ?? null;
      let ownerCreated = false;
      if (ownerId === null && body.owner?.name) {
        const owner = await tx.owner.create({
          data: {
            name: body.owner.name.trim(),
            nameKana: body.owner.nameKana?.trim() || null,
            phone: body.owner.phone?.trim() || null,
            email: body.owner.email?.trim() || null,
            // ⚠反響フォームの住所は本人の連絡先住所であり、登記上の住所とは
            //   限らない。address(登記上住所)は空のままにする(設計書 §7・
            //   発注者承認 2026-08-26)。address キー自体を書かない。
            currentAddress: body.owner.currentAddress?.trim() || null,
          },
        });
        ownerId = owner.id;
        ownerCreated = true;
      }

      if (ownerId !== null) {
        await tx.propertyOwner.create({
          data: { propertyId: property.id, ownerId },
        });
      }

      let attachmentId: string | null = null;
      if (pdfBuffer && uploadedUrl) {
        // ⚠添付は親の物件行を FOR UPDATE した同一tx内で作る(リポジトリ全体の
        //   規約。src/lib/__tests__/attachment-create-parent-lock.test.ts が
        //   走査で固定している)。この行は同じ tx で今作ったばかりで他 tx から
        //   はまだ見えないが、経路の型を全箇所で揃えるためロックは省略しない。
        await lockPropertyRow(tx, property.id);
        const attachment = await tx.attachment.create({
          data: {
            targetType: "property",
            targetId: property.id,
            propertyId: property.id,
            type: "general",
            fileName: pdfFileName,
            fileUrl: uploadedUrl,
            fileSize: pdfBuffer.length,
            mimeType: "application/pdf",
            uploadedBy: session.id,
          },
          select: { id: true },
        });
        attachmentId = attachment.id;
      }

      return { propertyId: property.id, ownerId, ownerCreated, attachmentId };
    });

    // ⚠監査ログに原文・氏名・電話・メール・住所を入れない。出してよいのは
    //   固定文字列と id・件数のみ(社内の恒久ルール「ログに外部由来の文字を
    //   出すときは許可リスト」)。
    await writeAuditLog({
      userId: session.id,
      action: "paste_import_property_create",
      targetTable: "property",
      targetId: result.propertyId,
      detail: {
        ownerCreated: result.ownerCreated,
        ownerLinked: result.ownerId !== null,
        attachmentCreated: result.attachmentId !== null,
        hasExternalKey: Boolean(body.externalLinkKey),
      },
    });

    return apiResponse({ propertyId: result.propertyId, ownerId: result.ownerId });
  } catch (error) {
    return handleApiError(error);
  }
}
