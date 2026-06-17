/**
 * POST /api/admin/owners/correction/corporate-number-bulk-apply
 *
 * 「missing」候補（name/address/note に 13桁が検出されたが Owner.corporateNumber が空）に対し、
 * 検出番号で国税庁 lookup → found かつ非廃止のときだけ **corporateNumber のみ**を一括反映する（A 案）。
 *
 *  - 名前・住所等は変更しない。DB 書込は Owner.corporateNumber のみ（+ change-log）。
 *  - 各 owner は Owner.version 楽観ロック。廃止法人 / 多重検出 / 未検出 / 設定済 / 競合は skip。
 *  - lookup 未設定（API キー無）は 503（fail-closed・現行と同型）。
 *  - 最大 50 件 / バッチ。preview→confirm は UI 側。
 *  - 非PII audit（件数のみ・owner.id 配列や生値は載せない）。
 */
import { NextRequest } from "next/server";
import { z } from "zod";
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
import { detectCorporateNumberInOwnerLike } from "@/lib/corporate-number";
import {
  isCorporateLookupConfigured,
  lookupCorporateNumber,
} from "@/lib/corporate-lookup";
import { recordChanges, OWNER_TRACKED_FIELDS } from "@/lib/change-log";

export const runtime = "nodejs";

const MAX_BULK = 50;

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
});

type ItemStatus =
  | "applied"
  | "already_set"
  | "not_found"
  | "version_conflict"
  | "no_single_detection"
  | "lookup_no_result"
  | "closed"
  | "lookup_error";

async function applyOne(
  ownerId: string,
  version: number,
  changedBy: string,
): Promise<ItemStatus> {
  const owner = await prisma.owner.findUnique({
    where: { id: ownerId },
    select: {
      id: true,
      name: true,
      address: true,
      note: true,
      corporateNumber: true,
      version: true,
    },
  });
  if (!owner) return "not_found";
  if (owner.corporateNumber) return "already_set"; // missing 限定（既存値は触らない）
  if (owner.version !== version) return "version_conflict";

  const detect = detectCorporateNumberInOwnerLike({
    name: owner.name,
    address: owner.address,
    note: owner.note,
  });
  if (detect.candidates.length !== 1) return "no_single_detection"; // 0=未検出 / 2+=多重は手動

  const num = detect.candidates[0];

  let lookup;
  try {
    lookup = await lookupCorporateNumber(num);
  } catch {
    return "lookup_error";
  }
  if (!lookup.found) return "lookup_no_result";
  if (lookup.isClosed) return "closed"; // 廃止法人 skip

  const updated = await prisma.owner.updateMany({
    where: { id: ownerId, version },
    data: { corporateNumber: num, version: { increment: 1 } },
  });
  if (updated.count === 0) return "version_conflict"; // race（直前に他者更新）

  await recordChanges({
    targetTable: "owners",
    targetId: ownerId,
    changedBy,
    oldValues: { corporateNumber: null },
    newValues: { corporateNumber: num },
    trackedFields: OWNER_TRACKED_FIELDS,
    source: "manual",
  });
  return "applied";
}

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "owner", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (!isCorporateLookupConfigured()) {
      throw new ApiError(503, "法人番号APIが設定されていません", "NOT_CONFIGURED");
    }

    const json = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(400, "リクエストが不正です", "VALIDATION_ERROR");
    }

    const results: Array<{ ownerId: string; status: ItemStatus }> = [];
    for (const item of parsed.data.owners) {
      const status = await applyOne(item.ownerId, item.version, session.id);
      results.push({ ownerId: item.ownerId, status });
    }

    const requested = parsed.data.owners.length;
    const applied = results.filter((r) => r.status === "applied").length;

    // 非PII audit（件数のみ）。owner.id 配列・生値・法人番号は残さない。
    await writeAuditLog({
      userId: session.id,
      action: "owner_correction_corporate_bulk_apply",
      targetTable: "owners",
      detail: { requested, applied, skipped: requested - applied },
    });

    return apiResponse({ results, requested, applied });
  } catch (error) {
    return handleApiError(error);
  }
}
