// POST /api/admin/owners/correction/corporate-restore-apply
//
// 割れた会社法人等番号の一括復元(corporate-restore-candidates のプレビューを反映)。
//
//  - address_name_split(分断型): サーバ側で再検出→復元13桁で国税庁 lookup →
//    found かつ非廃止のときだけ反映する:
//      氏名 = 国税庁の会社名(取込で失われているため)
//      住所 = addressMode="nta" なら国税庁の最新本店所在地(+郵便番号) /
//             "cleaned" なら断片除去後の住所(郵便番号は触らない)
//      corporateNumber(13桁) + companyRegistryNumber(12桁)
//  - name_fragment(断片型): lookup 不要。氏名から「ラベル+尻切れ断片」を除去して
//    会社名を救出するのみ(番号・住所は触らない)。
//
//  - 各 owner は Owner.version 楽観ロック。廃止/該当なし/競合/非該当は skip。
//  - lookup 未設定(APIキー無)は 503(fail-closed・既存 bulk-apply と同型)。
//  - 最大 50 件/バッチ + 時間予算 45s(超過分は not_processed で返し再送してもらう)。
//  - 非PII audit(件数のみ)。ChangeLog には変更フィールドの old/new を記録する。
//
// 権限(fail-closed): user_management:read + owner:read/write に加え、
// 本 route は氏名・住所・郵便番号・法人番号を書き換えるため
// owner_name / owner_address / owner_zip / owner_corporate_number の
// 明示的な書込権限をすべて要求する(断片型のみの場合も同一ゲート=単純・安全側)。

import { NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission, hasExplicitWritePerm } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import {
  isCorporateLookupConfigured,
  lookupCorporateNumber,
} from "@/lib/corporate-lookup";
import { isRawVisible } from "@/lib/owner-corporate-candidates";
import { detectSplitCorporateOwner } from "@/lib/corporate-number-restore";
import { recordChanges } from "@/lib/change-log";
import { OWNER_TRACKED_FIELDS } from "@/lib/property-field-constants";

export const runtime = "nodejs";

const MAX_BULK = 50;

// バッチ全体の時間予算(ms)。国税庁 lookup は最大 ~8s/件かかり得るため、
// nginx proxy_read_timeout(60s) 内に収まるよう既存 bulk-apply と同じ 45s で打ち切る。
const BULK_TIME_BUDGET_MS = 45_000;

const bodySchema = z.object({
  owners: z
    .array(
      z.object({
        ownerId: z.string().uuid(),
        version: z.number().int(),
      }),
    )
    .min(1)
    .max(MAX_BULK),
  addressMode: z.enum(["nta", "cleaned"]),
});

type ItemStatus =
  | "applied"
  | "not_found"
  | "version_conflict"
  | "no_detection"
  | "not_eligible"
  | "lookup_no_result"
  | "closed"
  | "lookup_error"
  | "not_processed";

type OwnerDisplayConfig = Awaited<ReturnType<typeof getOwnerDisplayConfig>>;

async function applyOne(
  ownerId: string,
  version: number,
  addressMode: "nta" | "cleaned",
  changedBy: string,
  displayConfig: OwnerDisplayConfig,
): Promise<ItemStatus> {
  const owner = await prisma.owner.findUnique({
    where: { id: ownerId },
    select: {
      id: true,
      name: true,
      address: true,
      zip: true,
      corporateNumber: true,
      companyRegistryNumber: true,
      version: true,
      isArchived: true,
    },
  });
  if (!owner || owner.isArchived) return "not_found";
  if (owner.version !== version) return "version_conflict";

  // 一覧(candidates)と同じ raw-visible ガードで再検出(サーバ側を正とする)。
  const detection = detectSplitCorporateOwner({
    name: isRawVisible(displayConfig.name) ? owner.name : null,
    address: isRawVisible(displayConfig.address) ? owner.address : null,
  });
  if (!detection) return "no_detection";

  if (detection.type === "name_fragment") {
    // 断片型: 会社名の救出のみ。救出できない(氏名がラベルのみ)は skip。
    if (!detection.cleanedName) return "not_eligible";

    // 楽観ロック: version に加えて読み取り時点の name をスナップショット条件にする。
    // version を bump しない書込パスとのレースでも lost update しない(bulk-apply の
    // corporateNumber:null 条件と同じ発想。count 0 = skip)。
    const updated = await prisma.owner.updateMany({
      where: { id: ownerId, version, name: owner.name },
      data: { name: detection.cleanedName, version: { increment: 1 } },
    });
    if (updated.count === 0) return "version_conflict";

    await recordChanges({
      targetTable: "owners",
      targetId: ownerId,
      changedBy,
      oldValues: { name: owner.name },
      newValues: { name: detection.cleanedName },
      trackedFields: OWNER_TRACKED_FIELDS,
      source: "manual",
    });
    return "applied";
  }

  // 分断型: 復元13桁が算出できないものは skip(candidates 側で eligible=false)。
  if (!detection.corporateNumber13 || !detection.companyRegistryNumber12) {
    return "not_eligible";
  }

  let lookup;
  try {
    lookup = await lookupCorporateNumber(detection.corporateNumber13);
  } catch {
    return "lookup_error";
  }
  if (!lookup.found || !lookup.record) return "lookup_no_result";
  if (lookup.isClosed) return "closed"; // 廃止法人は自動反映しない(手動判断)

  const record = lookup.record;

  // 住所: nta=国税庁の最新本店所在地(空なら断片除去後へフォールバック) /
  //       cleaned=断片除去後(元の登記住所を保つ)。どちらも null なら現状維持。
  const cleanedAddress = detection.cleanedAddress;
  const ntaAddress = record.address !== "" ? record.address : null;
  const newAddress =
    addressMode === "nta"
      ? (ntaAddress ?? cleanedAddress)
      : cleanedAddress;

  const data: {
    name: string;
    corporateNumber: string;
    companyRegistryNumber: string;
    version: { increment: 1 };
    address?: string;
    zip?: string;
  } = {
    name: record.name,
    corporateNumber: detection.corporateNumber13,
    companyRegistryNumber: detection.companyRegistryNumber12,
    version: { increment: 1 },
  };
  if (newAddress != null) data.address = newAddress;
  if (addressMode === "nta" && record.postCode) data.zip = record.postCode;

  // 楽観ロック: version に加えて読み取り時点の corporateNumber をスナップショット条件に
  // する。国税庁 lookup(最大 ~8s)の待機中に「version を bump せず corporateNumber を
  // 埋める」既存パス(import/reception-owner の reuse 等)が走っても lost update しない
  // (bulk-apply の Codex P2 と同型のガード。count 0 = skip)。
  const updated = await prisma.owner.updateMany({
    where: { id: ownerId, version, corporateNumber: owner.corporateNumber },
    data,
  });
  if (updated.count === 0) return "version_conflict";

  // ChangeLog: 実際に変更したフィールドの old/new のみ記録する。
  const oldValues: Record<string, unknown> = {
    name: owner.name,
    corporateNumber: owner.corporateNumber,
    companyRegistryNumber: owner.companyRegistryNumber,
  };
  const newValues: Record<string, unknown> = {
    name: record.name,
    corporateNumber: detection.corporateNumber13,
    companyRegistryNumber: detection.companyRegistryNumber12,
  };
  if (newAddress != null) {
    oldValues.address = owner.address;
    newValues.address = newAddress;
  }
  if (data.zip !== undefined) {
    oldValues.zip = owner.zip;
    newValues.zip = data.zip;
  }
  await recordChanges({
    targetTable: "owners",
    targetId: ownerId,
    changedBy,
    oldValues,
    newValues,
    trackedFields: OWNER_TRACKED_FIELDS,
    source: "manual",
  });
  return "applied";
}

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    // admin correction surface の認可境界(既存 bulk-apply と同型)。
    if (!hasPermission(perms, "user_management", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "所有者閲覧の権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "owner", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    // 氏名・住所・郵便番号・法人番号を書き換えるため field-level 書込権限を
    // すべて要求する(field-level bypass 防止・fail-closed)。
    for (const field of [
      "owner_name",
      "owner_address",
      "owner_zip",
      "owner_corporate_number",
    ] as const) {
      if (!hasExplicitWritePerm(perms, field)) {
        throw new ApiError(403, "復元に必要な権限がありません", "FORBIDDEN");
      }
    }
    if (!isCorporateLookupConfigured()) {
      throw new ApiError(503, "法人番号APIが設定されていません", "NOT_CONFIGURED");
    }

    const displayConfig = await getOwnerDisplayConfig(session.id, perms);

    const json = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(400, "リクエストが不正です", "VALIDATION_ERROR");
    }

    const deadline = Date.now() + BULK_TIME_BUDGET_MS;
    const results: Array<{ ownerId: string; status: ItemStatus }> = [];
    for (const item of parsed.data.owners) {
      if (Date.now() >= deadline) {
        results.push({ ownerId: item.ownerId, status: "not_processed" });
        continue;
      }
      const status = await applyOne(
        item.ownerId,
        item.version,
        parsed.data.addressMode,
        session.id,
        displayConfig,
      );
      results.push({ ownerId: item.ownerId, status });
    }

    const requested = parsed.data.owners.length;
    const applied = results.filter((r) => r.status === "applied").length;

    // 非PII audit(件数と addressMode のみ)。owner.id 配列・生値・法人番号は残さない。
    await writeAuditLog({
      userId: session.id,
      action: "owner_correction_corporate_restore_apply",
      targetTable: "owners",
      detail: {
        requested,
        applied,
        skipped: requested - applied,
        addressMode: parsed.data.addressMode,
      },
    });

    return apiResponse({ results, requested, applied });
  } catch (error) {
    return handleApiError(error);
  }
}
