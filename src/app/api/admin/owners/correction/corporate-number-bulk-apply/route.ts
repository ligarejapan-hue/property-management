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
  getOwnerDisplayConfig,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission, hasExplicitWritePerm } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { detectCorporateNumberInOwnerLike } from "@/lib/corporate-number";
import {
  isCorporateLookupConfigured,
  lookupCorporateNumber,
} from "@/lib/corporate-lookup";
import { isRawVisible } from "@/lib/owner-corporate-candidates";
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

type OwnerDisplayConfig = Awaited<ReturnType<typeof getOwnerDisplayConfig>>;

async function applyOne(
  ownerId: string,
  version: number,
  changedBy: string,
  displayConfig: OwnerDisplayConfig,
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
      isArchived: true,
    },
  });
  // archived は per-owner corporate-apply と同じく not_found 扱い（mutate しない）。
  if (!owner || owner.isArchived) return "not_found";
  if (owner.corporateNumber) return "already_set"; // missing 限定（既存値は触らない）
  if (owner.version !== version) return "version_conflict";

  // Codex P1: candidates 一覧と同じく field-level display 権限を尊重する。
  // raw-visible (full/read/edit) でない name/address/note からは 13桁を検出しない。
  // これにより「owner_corporate_number は書けるが name/note はマスク」という role が、
  // 閲覧できないフィールドに混入した番号を反映する field-level bypass を防ぐ
  // （isRawVisible は owner-corporate-candidates.ts と単一の source of truth）。
  const detect = detectCorporateNumberInOwnerLike({
    name: isRawVisible(displayConfig.name) ? owner.name : null,
    address: isRawVisible(displayConfig.address) ? owner.address : null,
    note: isRawVisible(displayConfig.note) ? owner.note : null,
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

  // Codex P2: where に corporateNumber: null を含める。
  // import/registry 等の再利用パスは `where: { id, corporateNumber: null }` で
  // version を bump せず corporateNumber を埋めるため、read→write の隙間でそれが
  // 走ると version 一致のままになり missing 前提が崩れる。null 条件を付けることで
  // 「依然 missing のときだけ」書き込み、他パスが入れた値を上書きしない（count 0=skip）。
  const updated = await prisma.owner.updateMany({
    where: { id: ownerId, version, corporateNumber: null },
    data: { corporateNumber: num, version: { increment: 1 } },
  });
  if (updated.count === 0) return "version_conflict"; // race（version 変化 or 既に他パスが set）

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
    // Codex P1: 本 route は admin correction surface（/api/admin/owners/correction/*）。
    // 隣接の candidates 一覧 / address-fill と同じ admin/read 認可境界を先に課す。
    // これが無いと user_management:read を持たない非 admin role が owner_corporate_number
    // 書込権限だけで admin の補正ワークフローを直叩きできてしまう。
    if (!hasPermission(perms, "user_management", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "所有者閲覧の権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "owner", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    // 本 route は corporateNumber のみ更新するため、field-level の owner_corporate_number
    // 書込権限を要求する（per-owner corporate-apply と同じゲート＝field-level bypass 防止）。
    if (!hasExplicitWritePerm(perms, "owner_corporate_number")) {
      throw new ApiError(403, "法人番号を更新する権限がありません", "FORBIDDEN");
    }
    if (!isCorporateLookupConfigured()) {
      throw new ApiError(503, "法人番号APIが設定されていません", "NOT_CONFIGURED");
    }

    // Codex P1: 検出に使う field-level display 権限。candidates 一覧と同じ source。
    // owner_corporate_number=hidden は書込権限ゲートで既に弾かれているが、
    // name/address/note の可視性は別なので detect 時に尊重する。
    const displayConfig = await getOwnerDisplayConfig(session.id, perms);

    const json = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(400, "リクエストが不正です", "VALIDATION_ERROR");
    }

    const results: Array<{ ownerId: string; status: ItemStatus }> = [];
    for (const item of parsed.data.owners) {
      const status = await applyOne(
        item.ownerId,
        item.version,
        session.id,
        displayConfig,
      );
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
