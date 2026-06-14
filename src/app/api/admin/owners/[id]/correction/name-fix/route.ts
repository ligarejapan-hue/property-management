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
import {
  decideOwnerNameFix,
  checkOwnerNameFixSafety,
  type OwnerNameFixBlockReason,
} from "@/lib/owner-name-quality";

// ---------------------------------------------------------------------------
// POST /api/admin/owners/:id/correction/name-fix
// ---------------------------------------------------------------------------
// DQ-01: 氏名ゴミ（数値/記号/空白のみ・制御文字混入等）の補正。
//
// mode:
//   - "sanitize": サーバ側で decideOwnerNameFix を再計算し、action="sanitize" の
//     ときのみ機械補正（制御文字/U+FFFD 除去・空白正規化）を適用する。
//     実体不明ゴミ（numeric/symbol/whitespace のみ）は救えないため manual 扱いで
//     ブロックし、人手 set / archive に誘導する。
//   - "set": operator が入力した newName を採用。再びゴミ（forbidden_value）/空化は拒否。
//
// 権限:
//   - dryRun: user_management:read + owner:read
//   - 実行 (dryRun=false): 上記に加えて owner:write
//
// Request body: { version:int, mode:"sanitize"|"set", newName?:string, dryRun?:boolean }
//   dryRun の default は true。dryRun=false を明示したときのみ DB を更新する。
//
// レスポンス（PII / 氏名生値を含めない）:
//   dryRun=true:  200 { executed:false, eligible, blockReasons[], mode }
//   dryRun=false: 200 { executed:true, id, version(new), updatedFields:["name"] }
//   400 入力不正 / 403 権限不足 / 404 不存在 / 409 version_mismatch / 422 その他
//
// ChangeLog（name の old/new）は内部変更履歴として記録するが、AuditLog detail には
// 氏名生値を入れない（既存 owner 編集と同方針）。
// ---------------------------------------------------------------------------

function statusFromReasons(reasons: string[]): number {
  if (reasons.includes("version_mismatch")) return 409;
  return 422;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: ownerId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "user_management", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "所有者閲覧の権限がありません", "FORBIDDEN");
    }

    const body = await request.json().catch(() => ({}));
    const version = body?.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      throw new ApiError(400, "version は正の整数で指定してください", "INVALID_INPUT");
    }
    const mode = body?.mode;
    if (mode !== "sanitize" && mode !== "set") {
      throw new ApiError(400, "mode は sanitize / set で指定してください", "INVALID_INPUT");
    }
    let newNameInput: string | null = null;
    if (mode === "set") {
      if (typeof body?.newName !== "string") {
        throw new ApiError(400, "newName は文字列で指定してください", "INVALID_INPUT");
      }
      newNameInput = body.newName;
    }
    const dryRun = body?.dryRun !== false; // default: true

    if (!dryRun && !hasPermission(perms, "owner", "write")) {
      throw new ApiError(403, "所有者編集の権限がありません", "FORBIDDEN");
    }

    const owner = await prisma.owner.findUnique({
      where: { id: ownerId },
      select: { id: true, name: true, version: true, isArchived: true },
    });
    if (!owner) {
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }

    // 補正後の目標値 targetName を決定。sanitize で救えない場合は proposalBlock。
    let targetName: string | null = null;
    let proposalBlock: string[] = [];
    if (mode === "sanitize") {
      const proposal = decideOwnerNameFix(owner.name);
      if (proposal.action === "sanitize") {
        targetName = proposal.cleanedName;
      } else if (proposal.action === "none") {
        proposalBlock = ["no_change"];
      } else {
        proposalBlock = [proposal.manualReason ?? "no_safe_autofix"];
      }
    } else {
      targetName = newNameInput;
    }

    let blockReasons: string[];
    if (targetName === null) {
      blockReasons = proposalBlock;
    } else {
      const safety = checkOwnerNameFixSafety({
        isArchived: owner.isArchived,
        versionMatches: owner.version === version,
        currentName: owner.name,
        newName: targetName,
      });
      blockReasons = safety.ok ? [] : safety.reasons;
    }
    const eligible = blockReasons.length === 0;

    // ── dryRun: DB / AuditLog を一切書かない ────────────────────────────────
    if (dryRun) {
      return apiResponse({ executed: false, eligible, blockReasons, mode });
    }

    // ── 実行 ────────────────────────────────────────────────────────────────
    if (!eligible || targetName === null) {
      return apiResponse(
        {
          error: {
            message: "氏名補正の条件を満たしていません",
            code: "NAME_FIX_BLOCKED",
            blockReasons,
          },
        },
        statusFromReasons(blockReasons),
      );
    }

    const newVersion = version + 1;
    const finalName = targetName;
    const TX_BLOCKED_SENTINEL = "__name_fix_blocked_in_tx__";
    let txBlockedReasons: OwnerNameFixBlockReason[] | null = null;
    let txNotFound = false;

    try {
      await prisma.$transaction(async (tx) => {
        const result = await tx.owner.updateMany({
          where: { id: ownerId, version, isArchived: false },
          data: { name: finalName, version: { increment: 1 } },
        });
        if (result.count === 0) {
          const cur = await tx.owner.findUnique({
            where: { id: ownerId },
            select: { version: true, isArchived: true },
          });
          if (!cur) {
            txNotFound = true;
            throw new Error(TX_BLOCKED_SENTINEL);
          }
          const reasons: OwnerNameFixBlockReason[] = [];
          if (cur.isArchived) reasons.push("owner_archived");
          if (cur.version !== version) reasons.push("version_mismatch");
          if (reasons.length === 0) reasons.push("version_mismatch");
          txBlockedReasons = reasons;
          throw new Error(TX_BLOCKED_SENTINEL);
        }

        // ChangeLog（name の old/new。内部変更履歴のため値を含む = 既存編集と同方針）。
        await tx.changeLog.createMany({
          data: [
            {
              targetTable: "owners",
              targetId: ownerId,
              fieldName: "name",
              oldValue: owner.name,
              newValue: finalName,
              source: "manual",
              changedBy: session.id,
            },
          ],
        });
      });
    } catch (e) {
      if (e instanceof Error && e.message === TX_BLOCKED_SENTINEL) {
        if (txNotFound) {
          throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
        }
        const reasons = txBlockedReasons ?? [];
        return apiResponse(
          {
            error: {
              message: "氏名補正の条件を満たしていません",
              code: "NAME_FIX_BLOCKED",
              blockReasons: reasons,
            },
          },
          statusFromReasons(reasons),
        );
      }
      throw e;
    }

    // AuditLog（transaction 外・PII / 氏名生値なし）
    await writeAuditLog({
      userId: session.id,
      action: "owner_correction_name_fix",
      targetTable: "owners",
      targetId: ownerId,
      detail: {
        correctionType: "name_fix",
        dryRun: false,
        mode,
        updatedFields: ["name"],
      },
    });

    return apiResponse({
      executed: true,
      id: ownerId,
      version: newVersion,
      updatedFields: ["name"],
    });
  } catch (error) {
    return handleApiError(error);
  }
}
