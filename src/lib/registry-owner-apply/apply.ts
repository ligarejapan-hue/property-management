/**
 * 添付済みの謄本(所有者事項)から、その物件の所有者を登録する**共通処理**。
 *
 * 1件ずつのボタン(`/api/properties/[id]/registry-owners`)と、まとめて反映の
 * 裏の処理(`registry-owner-bulk/process-row.ts`)の**両方がここを通る**。
 * ⚠検査と安全策(所有者が空か・確認した謄本が最新か・担当範囲・項目ごとの権限・
 *   物件の項目を書き換えない)を2か所に分けて書くと、片方だけ直す事故が起きる。
 *   レビュー23巡で積み上げた守りなので、**必ずここに集約する**。
 *
 * ⚠**全部事項(certificateType="all")は対象にしない**。全部事項には抹消済みの
 *   旧所有者も載るため、最新の所有者を見分ける規則が別途必要になる。
 */
import prisma from "@/lib/prisma";
import { ApiError, type PermissionEntry } from "@/lib/api-helpers";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { findMissingOwnerFieldWritePerm } from "@/lib/owner-create";
import { getStorage } from "@/lib/storage";
import { extractTextFromPdf } from "@/lib/pdf-extract";
import { parseRegistryOwnerTable } from "@/lib/registry-owner-table";
import { processRegistryPdf } from "@/lib/registry-pdf/process";

/** この機能が扱う謄本の種別。全部事項は対象外。 */
export const SUPPORTED_CERTIFICATE_TYPE = "owner";

/**
 * 取込ジョブ・監査記録に残す名前。**添付の生ファイル名は使わない**(PIIを含みうる)。
 * 利用者が見る下見には、別途ほんとうのファイル名を返している。
 */
export const REGISTRY_OWNER_APPLY_AUDIT_LABEL = "添付済みの謄本から所有者を反映";

export interface LoadedRegistry {
  attachmentId: string;
  fileName: string;
  createdAt: Date;
  text: string;
}

/**
 * いちばん新しい所有者事項の添付(削除済みを除く)。
 * ⚠下見・反映の受付・**書き込みのロックの中の見直し**で同じ条件を使う(条件が
 *   ずれると「見直しでは別の添付が最新」になり、正しい操作が 409 になる)。
 */
export function findLatestOwnerRegistryAttachment(
  db: Pick<typeof prisma, "attachment">,
  propertyId: string,
) {
  return db.attachment.findFirst({
    where: {
      propertyId,
      type: "registry",
      isDeleted: false,
      registryCertificateType: SUPPORTED_CERTIFICATE_TYPE,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, fileName: true, fileUrl: true, createdAt: true },
  });
}

export const attachmentChangedError = () =>
  new ApiError(
    409,
    "確認した謄本とは別の謄本が追加されています。開き直してもう一度確認してください",
    "REGISTRY_ATTACHMENT_CHANGED",
  );

/**
 * 添付済みの所有者事項を1件取り出し、文字を抜き出す。
 *
 * @param expectedAttachmentId 下見で見せた添付のID。渡されたときは、いちばん新しい
 *   添付がそれと同じであることを確かめる(違えば 409)。確認画面を開いている間に
 *   別の謄本が添付された場合に、見ていない方の所有者を入れてしまわないため。
 */
export async function loadLatestRegistryText(
  propertyId: string,
  expectedAttachmentId?: string,
): Promise<LoadedRegistry> {
  const attachment = await findLatestOwnerRegistryAttachment(prisma, propertyId);
  if (!attachment) {
    throw new ApiError(
      404,
      "この物件には所有者事項の謄本が添付されていません",
      "REGISTRY_NOT_FOUND",
    );
  }
  if (expectedAttachmentId && attachment.id !== expectedAttachmentId) {
    throw attachmentChangedError();
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

/**
 * 読み取れた所有者について、**書く項目ごとの**権限を確かめる。
 * ⚠`owner:write` だけでは、氏名や住所を書けない役割でも謄本の値を保存できてしまう。
 *   他の所有者の窓口(`/owners/create-and-link`)と同じ純関数で判定する。
 */
export function assertOwnerFieldWritePerms(
  perms: PermissionEntry[],
  owners: Array<{ name: string; address: string | null }>,
): void {
  for (const owner of owners) {
    const missing = findMissingOwnerFieldWritePerm(perms, {
      name: owner.name,
      address: owner.address,
    });
    if (missing) {
      throw new ApiError(403, `${missing.label} を書き込む権限がありません`, "FORBIDDEN");
    }
  }
}

export interface ApplyRegistryOwnersArgs {
  session: { id: string; role: string };
  perms: PermissionEntry[];
  propertyId: string;
  /**
   * 下見で見せた添付のID。1件ずつのボタンは**必ず渡す**(利用者が見たものを入れる)。
   * まとめて反映は人が中身を見ないので渡さず、実行時点の最新を使う。
   */
  expectedAttachmentId?: string;
}

export interface ApplyRegistryOwnersOutcome {
  attachmentId: string;
  /** 読み取れた所有者の人数(行数)。同じ人が2回載っていれば登録は1人にまとまる。 */
  parsedOwners: number;
  result: Awaited<ReturnType<typeof processRegistryPdf>>;
}

/**
 * 1物件ぶんの反映。エラーは `ApiError` で投げる:
 *   404 物件/謄本/実体が無い / 409 すでに所有者がいる・別の謄本が追加された /
 *   422 読み取れない / 403 権限・担当範囲
 */
export async function applyRegistryOwnersToProperty(
  args: ApplyRegistryOwnersArgs,
): Promise<ApplyRegistryOwnersOutcome> {
  const { session, perms, propertyId, expectedAttachmentId } = args;

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
  // すでに所有者がいる物件は対象外(上書き・二重登録を避ける)。
  // ⚠この判定は受付時点の値。書き込みのロックの中でもう一度見直す
  //   (requireNoExistingOwners)。
  if (property.propertyOwners.length > 0) {
    throw new ApiError(
      409,
      "この物件にはすでに所有者が登録されています",
      "OWNERS_ALREADY_EXIST",
    );
  }

  const registry = await loadLatestRegistryText(propertyId, expectedAttachmentId);
  const owners = parseRegistryOwnerTable(registry.text);
  if (!owners || owners.length === 0) {
    throw new ApiError(
      422,
      "謄本から所有者を読み取れませんでした。手入力で登録してください",
      "REGISTRY_OWNERS_NOT_FOUND",
    );
  }
  assertOwnerFieldWritePerms(perms, owners);

  const result = await processRegistryPdf({
    session,
    text: registry.text,
    propertyId,
    // ⚠生ファイル名ではなく固定ラベル(ImportJob と AuditLog に残るため)
    fileName: REGISTRY_OWNER_APPLY_AUDIT_LABEL,
    edited: undefined,
    // ⚠必ず null。非 null にすると同じ謄本がもう一度添付されてしまう。
    pdfBuffer: null,
    certificateType: SUPPORTED_CERTIFICATE_TYPE,
    // ⚠上の 409 判定は PDF を読む前の値なので、読んでいる間に別タブが所有者を
    //   紐づけると古くなる。書き込みと同じ物件行ロックの中で見直してもらう。
    requireNoExistingOwners: true,
    // ⚠担当者スコープ(canAccessPropertyRecord)の確認も受付時点の値。書き込みの
    //   ロックまでの間に担当を外されても、ロックと同じ1文で見直して 403 にする。
    enforcePropertyScope: true,
    // ⚠読んだ謄本が最新のままかを、書き込みのロックの中でもう一度確かめる。
    beforeFirstWrite: async (tx) => {
      // ⚠添付の**削除・復元**は物件行を押さえずに isDeleted を書く(添付の新規作成は
      //   物件行で直列化されている)。この物件の謄本の添付行をここで押さえて、
      //   削除・復元の書き込みをこの処理の確定まで待たせる。順序は 物件 → 添付。
      await tx.$queryRaw`
        SELECT id FROM attachments
        WHERE property_id = ${propertyId}::uuid AND type = 'registry'
        FOR UPDATE
      `;
      const latest = await findLatestOwnerRegistryAttachment(tx, propertyId);
      if (!latest || latest.id !== registry.attachmentId) throw attachmentChangedError();
    },
    // ⚠所有者だけを入れる。下見も確認画面も所有者しか見せていないので、
    //   物件の項目(不動産番号・地番・家屋番号・登記状況)は書き換えない。
    ownersOnly: true,
  });

  return {
    attachmentId: registry.attachmentId,
    parsedOwners: owners.length,
    result,
  };
}
