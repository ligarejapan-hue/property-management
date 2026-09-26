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
 * ⚠**監査記録に添付の生ファイル名を載せない**。手で取り込んだ謄本は
 *   「山田太郎_謄本.pdf」のように氏名や住所を含みうる。`processRegistryPdf` は
 *   受け取った fileName を ImportJob と AuditLog.detail に保存するため、
 *   ここでは固定のラベルを渡す(画面の下見には本当のファイル名を出す)。
 *
 * ⚠**下見で見せた添付を、そのまま反映する**。POST が「最新の1件」を引き直すと、
 *   確認画面を開いている間に別の謄本が添付された場合、利用者は A を見て承認し
 *   B の所有者が入る。POST は下見で返した添付IDを受け取り、一致しなければ拒否する。
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
import { writeAuditLog } from "@/lib/audit";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { parseRegistryOwnerTable } from "@/lib/registry-owner-table";
// ⚠反映の検査と安全策は**共通処理に集約**している(まとめて反映の裏の処理も同じ関数を
//   通る)。ここに条件を足さない・ここで条件を緩めない。
import {
  SUPPORTED_CERTIFICATE_TYPE,
  applyRegistryOwnersToProperty,
  loadLatestRegistryText,
} from "@/lib/registry-owner-apply/apply";
// ⚠表示名は共通ヘルパを使う(日本時間で日付を作る)。自前で toISOString すると
//   深夜0〜9時の添付が添付タブと違う日付になる。
import { registryDisplayName } from "@/lib/attachments/registry-display-name";

/**
 * 物件を取り出し、権限と担当範囲を確認する。
 * 読み取り(下見)と書き込み(反映)で必要な権限が違うので action で切り替える。
 * ⚠反映のときの「所有者が空か」「謄本が読めるか」「氏名・住所を書けるか」は
 *   共通処理(applyRegistryOwnersToProperty)側で確かめる。
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
  if (action === "apply") {
    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "取込の権限がありません", "FORBIDDEN");
    }
    // ⚠所有者を作って紐づける操作なので、他の所有者の窓口(/owners, /owners/create-and-link)
    //   と同じく owner:write も必須。画面はこの権限で出し分けているが、API を直接
    //   叩かれても同じ線で止める(import:write だけだと権限の抜け道になる)。
    if (!hasPermission(perms, "owner", "write")) {
      throw new ApiError(403, "所有者を編集する権限がありません", "FORBIDDEN");
    }
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

  return { session, property, perms };
}

/** 下見: 登録される予定の所有者を返す。保存はしない。 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const { session, property } = await loadProperty(id, "preview");
    const registry = await loadLatestRegistryText(id);
    const owners = parseRegistryOwnerTable(registry.text) ?? [];

    // ⚠この経路は謄本PDFを storage から直接読むため、`/uploads/[...path]` が
    //   残している閲覧の記録を通らない。同じ非PIIの記録をここでも残す
    //   (氏名・住所・ファイル名は載せない)。
    await writeAuditLog({
      userId: session.id,
      action: "registry_pdf_preview",
      targetTable: "attachments",
      targetId: registry.attachmentId,
      detail: { propertyId: id },
    });

    return apiResponse({
      alreadyHasOwners: property.propertyOwners.length > 0,
      attachment: {
        id: registry.attachmentId,
        // ⚠生ファイル名は返さない。手で取り込んだ謄本は「山田太郎_謄本.pdf」の
        //   ように氏名や住所を含みうる(添付の一覧も同じ理由で固定の表示名にしている)。
        label: registryDisplayName(
          SUPPORTED_CERTIFICATE_TYPE,
          registry.createdAt,
        ),
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
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const { session, perms } = await loadProperty(id, "apply");

    // 下見で見せた添付のID。古い呼び出し元が無い新設APIなので必須にする。
    const body = (await request.json().catch(() => null)) as
      | { attachmentId?: unknown }
      | null;
    const attachmentId = body?.attachmentId;
    if (typeof attachmentId !== "string" || !attachmentId) {
      throw new ApiError(
        400,
        "確認した謄本が指定されていません",
        "ATTACHMENT_ID_REQUIRED",
      );
    }

    // ⚠ここから先(所有者が空か・謄本の読み取り・項目ごとの権限・書き込み)は
    //   **共通処理**に集約している。まとめて反映の裏の処理も同じ関数を通るため、
    //   守りを片方だけ直す事故が起きない。
    const outcome = await applyRegistryOwnersToProperty({
      session,
      perms,
      propertyId: id,
      // 利用者が確認画面で見た添付。これと最新が違えば共通処理が 409 にする。
      expectedAttachmentId: attachmentId,
    });
    const result = outcome.result;

    return apiResponse(result);
  } catch (error) {
    return handleApiError(error);
  }
}
