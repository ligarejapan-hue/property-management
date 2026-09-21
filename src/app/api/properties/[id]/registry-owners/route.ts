/**
 * 添付済みの謄本(所有者事項)から、その物件の所有者を登録する。
 *
 * 背景: 謄本PDFを一括で添付した経路は所有者を読み取っていなかったため、
 * 「謄本はあるのに所有者が空」の物件が本番に1,821件ある。すでに取得済みの
 * 書類なので、追加の費用なしで所有者を埋められる。
 *
 *   GET  … 下見。登録される予定の所有者を返すだけで、**何も保存しない**。
 *   POST … 反映。既存の取込処理(processRegistryPdf)をそのまま使う。
 *
 * ⚠**全部事項(certificateType="all")は対象にしない**。全部事項には抹消済みの
 *   旧所有者も載るため、最新の所有者を見分ける規則が別途必要になる
 *   (本番・手元ともに全部事項は0件なので、実物が手に入ってから設計する)。
 *
 * ⚠添付は作らない(既にある)。`processRegistryPdf` は pdfBuffer が null の
 *   ときだけ添付を作らないので、必ず null で渡すこと。
 *
 * ⚠**所有者の表として読めたときだけ登録する**。`parseRegistryText` には
 *   「所有者」の語の後ろを拾う簡易フォールバックがあり、表が無いテキストでも
 *   それらしい文字列を氏名にしてしまう。所有者事項は必ず表なので、
 *   表が読めない=読み取り失敗として扱い、手入力へ誘導する。
 */
import { NextRequest } from "next/server";

import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { getStorage } from "@/lib/storage";
import { extractTextFromPdf } from "@/lib/pdf-extract";
import { parseRegistryOwnerTable } from "@/lib/registry-owner-table";
import { processRegistryPdf } from "@/lib/registry-pdf/process";

/** この機能が扱う謄本の種別。全部事項は対象外。 */
const SUPPORTED_CERTIFICATE_TYPE = "owner";

interface LoadedRegistry {
  attachmentId: string;
  fileName: string;
  createdAt: Date;
  text: string;
}

/**
 * 物件を取り出し、権限と担当範囲を確認する。
 * 読み取り(下見)と書き込み(反映)で必要な権限が違うので action で切り替える。
 */
async function loadProperty(propertyId: string, action: "preview" | "apply") {
  const session = await getApiSession();
  const perms = await getUserPermissions(session.id);

  if (!hasPermission(perms, "property", "read")) {
    throw new ApiError(403, "物件を見る権限がありません", "FORBIDDEN");
  }
  // 謄本の中身(所有者の氏名・住所)を見せるので、謄本の閲覧権限を必須にする
  if (!hasPermission(perms, "registry_pdf", "preview")) {
    throw new ApiError(403, "謄本を見る権限がありません", "FORBIDDEN");
  }
  if (action === "apply" && !hasPermission(perms, "import", "write")) {
    throw new ApiError(403, "取込の権限がありません", "FORBIDDEN");
  }

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: {
      id: true,
      assignedTo: true,
      createdBy: true,
      propertyOwners: { select: { id: true }, take: 1 },
    },
  });
  if (!property) {
    throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
  }
  if (!canAccessPropertyRecord(session, property)) {
    throw new ApiError(403, "この物件を扱う権限がありません", "FORBIDDEN");
  }

  return { session, property };
}

/** 添付済みの所有者事項を1件取り出し、文字を抜き出す。 */
async function loadLatestRegistryText(
  propertyId: string,
): Promise<LoadedRegistry> {
  const attachment = await prisma.attachment.findFirst({
    where: {
      propertyId,
      type: "registry",
      isDeleted: false,
      registryCertificateType: SUPPORTED_CERTIFICATE_TYPE,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, fileName: true, fileUrl: true, createdAt: true },
  });
  if (!attachment) {
    throw new ApiError(
      404,
      "この物件には所有者事項の謄本が添付されていません",
      "REGISTRY_NOT_FOUND",
    );
  }

  const storage = getStorage();
  const key = storage.keyFromUrl(attachment.fileUrl);
  if (!key) {
    throw new ApiError(404, "謄本の実体が見つかりません", "REGISTRY_FILE_MISSING");
  }
  const file = await storage.read(key);
  if (!file) {
    throw new ApiError(404, "謄本の実体が見つかりません", "REGISTRY_FILE_MISSING");
  }

  let text = "";
  try {
    text = await extractTextFromPdf(file.body);
  } catch {
    throw new ApiError(
      422,
      "謄本から文字を読み取れませんでした。手入力で登録してください",
      "REGISTRY_TEXT_UNREADABLE",
    );
  }
  if (!text.trim()) {
    throw new ApiError(
      422,
      "謄本から文字を読み取れませんでした。手入力で登録してください",
      "REGISTRY_TEXT_UNREADABLE",
    );
  }

  return {
    attachmentId: attachment.id,
    fileName: attachment.fileName,
    createdAt: attachment.createdAt,
    text,
  };
}

/** 下見: 登録される予定の所有者を返す。保存はしない。 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const { property } = await loadProperty(id, "preview");
    const registry = await loadLatestRegistryText(id);
    const owners = parseRegistryOwnerTable(registry.text) ?? [];

    return apiResponse({
      alreadyHasOwners: property.propertyOwners.length > 0,
      attachment: {
        id: registry.attachmentId,
        fileName: registry.fileName,
        createdAt: registry.createdAt,
      },
      owners: owners.map((o) => ({
        name: o.name,
        address: o.address,
        share: o.share,
      })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/** 反映: 既存の取込処理で所有者を登録する。添付は作らない。 */
export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const { session, property } = await loadProperty(id, "apply");

    // すでに所有者がいる物件は対象外(上書き・二重登録を避ける)
    if (property.propertyOwners.length > 0) {
      throw new ApiError(
        409,
        "この物件にはすでに所有者が登録されています",
        "OWNERS_ALREADY_EXIST",
      );
    }

    const registry = await loadLatestRegistryText(id);
    const owners = parseRegistryOwnerTable(registry.text);
    if (!owners || owners.length === 0) {
      throw new ApiError(
        422,
        "謄本から所有者を読み取れませんでした。手入力で登録してください",
        "REGISTRY_OWNERS_NOT_FOUND",
      );
    }

    const result = await processRegistryPdf({
      session,
      text: registry.text,
      propertyId: id,
      fileName: registry.fileName,
      edited: undefined,
      // ⚠必ず null。非 null にすると同じ謄本がもう一度添付されてしまう。
      pdfBuffer: null,
      certificateType: SUPPORTED_CERTIFICATE_TYPE,
    });

    return apiResponse(result);
  } catch (error) {
    return handleApiError(error);
  }
}
