import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import {
  hasPermission,
  hasExplicitWritePerm,
  getOwnerFieldLevel,
} from "@/lib/permissions";
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
//   - 実行 (dryRun=false): 上記に加えて owner:write かつ owner_name の
//     field-level write（full/edit）。氏名は PII フィールドのため owner PATCH と
//     同じ field-level 書込モデルを適用する。
//
// Request body: { version:int, mode:"sanitize"|"set", newName?:string, dryRun?:boolean }
//   dryRun の default は true。dryRun=false を明示したときのみ DB を更新する。
//
// レスポンス（PII / 氏名生値を含めない）:
//   dryRun=true（氏名可視）:   200 { executed:false, eligible, blockReasons[], mode, nameVisible:true }
//   dryRun=true（氏名不可視）: 200 { executed:false, blockReasons[], mode, nameVisible:false }
//       └ 氏名生値の値当てオラクル防止（P1）: owner_name の field-level 可視性が
//         full/edit/read 未満（masked/partial/hidden）のユーザーには、隠れた現在値に
//         依存する判定を出さない。
//         - set: no_change（set値==現在値）と eligible（一致/不一致の確定）を伏せる。
//           入力値だけで決まる判定（forbidden_value / name_would_be_empty）は出してよい。
//         - sanitize: 判定材料が隠し現在値そのもの。現在値由来 reason
//           （no_safe_autofix / name_would_be_empty / forbidden_value / no_change）と
//           eligible を全て伏せる（version_mismatch / owner_archived は保持）。
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

/**
 * 氏名生値が可視か（owner_name の field-level 表示レベルが full/edit/read）。
 * masked/partial/hidden（生値を見せない・伏字）の場合は false。owner-memo の
 * resolveOwnerMemoBodyVisibility と同じ閾値で field-level 可視性を判定する。
 */
function canSeeOwnerName(perms: Parameters<typeof getOwnerFieldLevel>[0]): boolean {
  const level = getOwnerFieldLevel(perms, "owner_name");
  return level === "full" || level === "edit" || level === "read";
}

// set mode: 入力値（newName）だけで決まる reason は現在値の生値を漏らさないため
// 保持してよい。隠し現在値に依存する no_change（set値 == 現在値）のみ落とす。
const SET_MODE_HIDDEN_NAME_ORACLE = new Set<string>(["no_change"]);

// sanitize mode: 補正対象・判定材料が隠し現在値そのもの。reason は現在値の性質を
// 漏らす（no_safe_autofix=数値/記号ゴミ, name_would_be_empty=制御文字のみ等,
// no_change=既に整形済み, forbidden_value=sanitize 後も DQ）。現在値由来の reason を
// 全て落とす。version_mismatch / owner_archived は現在値の氏名生値を漏らさないため保持。
const SANITIZE_MODE_HIDDEN_NAME_ORACLE = new Set<string>([
  "no_change",
  "no_safe_autofix",
  "name_would_be_empty",
  "forbidden_value",
]);

/**
 * 氏名不可視ユーザーの dry-run preview から、隠し現在値に依存する判定（同値/性質
 * オラクル）を blockReasons から除去する（P1）。mode により対象が異なる:
 * - set: newName は入力値ゆえ大半の reason は安全。no_change のみ落とす。
 * - sanitize: 判定材料が隠し現在値そのもの。現在値由来の reason を全て落とす。
 * version_mismatch / owner_archived は現在値の氏名生値を漏らさないため保持する。
 */
function stripHiddenNameOracle(reasons: string[], mode: "sanitize" | "set"): string[] {
  const oracle =
    mode === "sanitize"
      ? SANITIZE_MODE_HIDDEN_NAME_ORACLE
      : SET_MODE_HIDDEN_NAME_ORACLE;
  return reasons.filter((r) => !oracle.has(r));
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
    // 氏名生値が可視か（owner_name field-level 可視性）。dryRun preview で隠し現在値の
    // 値当てオラクルを抑止するために使う（P1）。
    const nameVisible = canSeeOwnerName(perms);

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

    if (!dryRun) {
      if (!hasPermission(perms, "owner", "write")) {
        throw new ApiError(403, "所有者編集の権限がありません", "FORBIDDEN");
      }
      // 編集対象は氏名（PII フィールド）。generic owner:write だけでなく
      // owner_name の field-level write（full/edit）を必須にする（owner PATCH と同方針）。
      if (!hasExplicitWritePerm(perms, "owner_name")) {
        throw new ApiError(403, "所有者氏名を更新する権限がありません", "FORBIDDEN");
      }
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
      if (!nameVisible) {
        // 氏名不可視ユーザーには隠し現在値依存の判定（同値/性質オラクル）を出さない（P1）。
        // - set: eligible（一致/不一致の確定）と no_change を伏せ、入力値由来 reason
        //   （forbidden_value 等）は返す。
        // - sanitize: 判定材料が隠し現在値そのもの。eligible と現在値由来 reason
        //   （no_safe_autofix / name_would_be_empty / forbidden_value / no_change）を
        //   全て伏せる（version_mismatch / owner_archived は氏名生値を漏らさず保持）。
        return apiResponse({
          executed: false,
          blockReasons: stripHiddenNameOracle(blockReasons, mode),
          mode,
          nameVisible: false,
        });
      }
      return apiResponse({
        executed: false,
        eligible,
        blockReasons,
        mode,
        nameVisible: true,
      });
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
