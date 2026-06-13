// GET  /api/owners/[id]/corporate-cleanup  … preview(dry-run・DB 無変更)
// POST /api/owners/[id]/corporate-cleanup  … apply(明示確定)
//
// 設計上の不変条件(corporate-apply 踏襲):
// - 自動上書きしない(POST で apply.* を明示)。サーバ側で proposal を再計算し client 値を信用しない。
// - owner:write + 変更フィールドの field-level write(hasExplicitWritePerm)を厳格に要求。
// - display-level raw-visible(full/read/edit)のフィールドのみ検出・除去対象に渡す(bypass 防止)。
// - version 楽観ロック(staleness 兼用)。
// - AuditLog detail に法人番号生値・会社名・住所・note 本文を一切含めない。
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
import { hasPermission, hasExplicitWritePerm, maskValue } from "@/lib/permissions";
import { maskCorporateNumber } from "@/lib/display-level";
import { writeAuditLog } from "@/lib/audit";
import { recordChanges, OWNER_TRACKED_FIELDS } from "@/lib/change-log";
import {
  decideOwnerCorporateCleanup,
  type OwnerCleanupInput,
} from "@/lib/corporate-number-cleanup";

type Level = "hidden" | "masked" | "partial" | "full" | "read" | "edit";

function isRawVisible(level: Level): boolean {
  return level === "full" || level === "read" || level === "edit";
}

function gatedInput(
  owner: { name: string; address: string | null; note: string | null; corporateNumber: string | null },
  cfg: { name: Level; address: Level; note: Level },
): OwnerCleanupInput {
  return {
    name: isRawVisible(cfg.name) ? owner.name : null,
    address: isRawVisible(cfg.address) ? owner.address : null,
    note: isRawVisible(cfg.note) ? owner.note : null,
    corporateNumber: owner.corporateNumber,
  };
}

function maskCnToSet(value: string | null, level: Level): string | null {
  if (value == null) return null;
  return level === "full" || level === "edit" || level === "read" ? value : maskCorporateNumber(value);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "所有者閲覧の権限がありません", "FORBIDDEN");
    }

    const cfg = await getOwnerDisplayConfig(session.id, perms);
    if (cfg.corporateNumber === "hidden") {
      throw new ApiError(403, "法人番号の閲覧権限がありません", "FORBIDDEN");
    }

    const owner = await prisma.owner.findUnique({
      where: { id },
      select: { id: true, name: true, address: true, note: true, corporateNumber: true, version: true, isArchived: true },
    });
    if (!owner || owner.isArchived) {
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }

    const proposal = decideOwnerCorporateCleanup(
      gatedInput(owner, { name: cfg.name as Level, address: cfg.address as Level, note: cfg.note as Level }),
    );

    await writeAuditLog({
      userId: session.id,
      action: "owner_corporate_cleanup_preview",
      targetTable: "owners",
      targetId: id,
      detail: {
        action: proposal.action,
        manualReason: proposal.manualReason,
        importAction: proposal.importAction,
        detectedInCount: proposal.detectedIn.length,
        changedFieldsCount: proposal.changedFields.length,
      },
    });

    return apiResponse({
      cleanup: {
        action: proposal.action,
        manualReason: proposal.manualReason,
        importAction: proposal.importAction,
        detectedIn: proposal.detectedIn,
        changedFields: proposal.changedFields,
        version: owner.version,
        before: {
          nameMasked: maskValue(owner.name, cfg.name),
          addressMasked: maskValue(owner.address, cfg.address),
          noteMasked: maskValue(owner.note, cfg.note),
        },
        after: {
          nameMasked: maskValue(proposal.cleanedName, cfg.name),
          addressMasked: maskValue(proposal.cleanedAddress, cfg.address),
          noteMasked: maskValue(proposal.cleanedNote, cfg.note),
        },
        corporateNumberToSetMasked: maskCnToSet(proposal.corporateNumberToSet, cfg.corporateNumber as Level),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const applySchema = z.object({
  version: z.number().int(),
  apply: z.object({
    name: z.boolean(),
    address: z.boolean(),
    note: z.boolean(),
    corporateNumber: z.boolean(),
  }),
});

const FIELD_PERM: Record<"name" | "address" | "note" | "corporateNumber", string> = {
  name: "owner_name",
  address: "owner_address",
  note: "owner_note",
  corporateNumber: "owner_corporate_number",
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let auditUserId: string | null = null;
  let auditOwnerId: string | null = null;
  let auditApplied: Record<string, boolean> | null = null;
  let auditImportAction: string | null = null;
  let auditResult = "validation_error";
  let auditHttpStatus: number | null = null;

  try {
    const { id } = await params;
    auditOwnerId = id;
    const session = await getApiSession();
    auditUserId = session.id;
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "owner", "write")) {
      auditResult = "forbidden";
      throw new ApiError(403, "所有者を更新する権限がありません", "FORBIDDEN");
    }

    const raw = await request.json().catch(() => ({})) as unknown;
    const parsed = applySchema.safeParse(raw);
    if (!parsed.success) throw new ApiError(400, "リクエスト形式が不正です", "VALIDATION_ERROR");
    const body = parsed.data;
    auditApplied = body.apply;

    const anyApply = body.apply.name || body.apply.address || body.apply.note || body.apply.corporateNumber;
    if (!anyApply) throw new ApiError(400, "反映対象が1つも指定されていません", "VALIDATION_ERROR");

    for (const f of ["name", "address", "note", "corporateNumber"] as const) {
      if (body.apply[f] && !hasExplicitWritePerm(perms, FIELD_PERM[f])) {
        auditResult = "forbidden";
        throw new ApiError(403, `${f} を更新する権限がありません`, "FORBIDDEN");
      }
    }

    const cfg = await getOwnerDisplayConfig(session.id, perms);
    if (cfg.corporateNumber === "hidden") {
      auditResult = "forbidden";
      throw new ApiError(403, "法人番号の閲覧権限がありません", "FORBIDDEN");
    }

    const owner = await prisma.owner.findUnique({
      where: { id },
      select: { id: true, name: true, address: true, note: true, corporateNumber: true, version: true, isArchived: true },
    });
    if (!owner || owner.isArchived) {
      auditResult = "not_found";
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }

    const proposal = decideOwnerCorporateCleanup(
      gatedInput(owner, { name: cfg.name as Level, address: cfg.address as Level, note: cfg.note as Level }),
    );
    auditImportAction = proposal.importAction;

    if (proposal.action !== "cleanup") {
      auditResult = "not_available";
      throw new ApiError(409, "自動で適用できる混入除去がありません", "CLEANUP_NOT_AVAILABLE");
    }

    for (const f of ["name", "address", "note", "corporateNumber"] as const) {
      if (body.apply[f] && !proposal.changedFields.includes(f)) {
        throw new ApiError(400, "適用対象が提案と一致しません", "APPLY_FIELD_MISMATCH");
      }
    }

    const updateFields: Record<string, unknown> = {};
    if (body.apply.name) updateFields.name = proposal.cleanedName;
    if (body.apply.address) updateFields.address = proposal.cleanedAddress;
    if (body.apply.note) updateFields.note = proposal.cleanedNote;
    if (body.apply.corporateNumber) updateFields.corporateNumber = proposal.corporateNumberToSet;

    const result = await prisma.owner.updateMany({
      where: { id, version: body.version },
      data: { ...updateFields, version: { increment: 1 } },
    });

    if (result.count === 0) {
      auditResult = "version_conflict";
      throw new ApiError(409, "他のユーザーが先に更新しました", "CONFLICT");
    }

    await recordChanges({
      targetTable: "owners",
      targetId: id,
      changedBy: session.id,
      oldValues: owner as unknown as Record<string, unknown>,
      newValues: updateFields,
      trackedFields: OWNER_TRACKED_FIELDS,
    });

    auditResult = "applied";
    auditHttpStatus = 200;
    await writeAuditLog({
      userId: session.id,
      action: "owner_corporate_cleanup_apply",
      targetTable: "owners",
      targetId: id,
      detail: {
        applied: body.apply,
        importAction: auditImportAction,
        result: auditResult,
        httpStatus: auditHttpStatus,
      },
    });

    return apiResponse({ ok: true, owner: { id, version: body.version + 1 } });
  } catch (error) {
    if (auditUserId && auditOwnerId && error instanceof Error && "status" in error) {
      const apiErr = error as ApiError;
      auditHttpStatus = apiErr.status;
      try {
        await writeAuditLog({
          userId: auditUserId,
          action: "owner_corporate_cleanup_apply",
          targetTable: "owners",
          targetId: auditOwnerId,
          detail: {
            applied: auditApplied ?? { name: false, address: false, note: false, corporateNumber: false },
            importAction: auditImportAction,
            result: auditResult,
            httpStatus: auditHttpStatus,
          },
        });
      } catch {
        // audit 失敗は本処理を壊さない
      }
    }
    return handleApiError(error);
  }
}
