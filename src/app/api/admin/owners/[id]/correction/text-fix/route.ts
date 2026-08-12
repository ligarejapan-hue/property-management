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
  decideTextHygieneFix,
  checkTextHygieneFixSafety,
  type TextHygieneFixBlockReason,
} from "@/lib/owner-text-hygiene";
import { normalizeAddress } from "@/lib/normalize";

// ---------------------------------------------------------------------------
// POST /api/admin/owners/:id/correction/text-fix
// ---------------------------------------------------------------------------
// DQ-04: Owner の自由テキスト（name / nameKana / address）の制御文字・文字化け補正。
//
// field: "name" | "nameKana" | "address"
//   - **note は対象外**（audit-only・絵文字 ZWJ 保護。設計 §DQ-04 §4）。GET 監査では
//     note の issue を表示するが、補正は通常の owner 編集に委ねる（自動 strip しない）。
//
// mode:
//   - "sanitize": サーバ側で decideTextHygieneFix を再計算し、action="sanitize" の
//     ときのみ機械補正（removable な制御文字/ゼロ幅/BOM/bidi 除去・空白畳み）を適用。
//     U+FFFD/mojibake（audit-only）や除去後に空になる値は manual ＝ブロックして人手対応へ。
//   - "set": operator 入力値（newValue）を採用。再び DQ（removable 残存 / U+FFFD）/空化は拒否。
//
// 権限:
//   - dryRun: user_management:read + owner:read
//   - 実行 (dryRun=false): 上記 + owner:write かつ対象フィールドの field-level write
//     （name→owner_name / nameKana→owner_name_kana / address→owner_address の full/edit）。
//
// dryRun preview は対象フィールドが不可視（field-level < read）のとき隠し現在値由来の判定を
// 伏せる（name-fix / contact-fix P1 と同方針）。
//   - sanitize mode: 判定材料（proposal も safety も）が隠し現在値そのもの。reason に到達した
//     時点で proposal.action==="sanitize" 確定＝「隠し値は sanitize 可能クラス」を漏らす class
//     オラクルになるため、version_mismatch/owner_archived も含め **全 reason を伏せる**。
//   - set mode: newValue 由来の reason（forbidden_value / would_be_empty）は operator 自身の
//     入力ゆえ安全。no_change（newValue==現在値）のみ現在値を漏らすため伏せる。
//     version_mismatch/owner_archived は現在値の生値を漏らさないため保持する。
//
// ChangeLog（old/new）は内部変更履歴として記録するが、AuditLog detail には生値を入れない。
// ---------------------------------------------------------------------------

type TextFixField = "name" | "nameKana" | "address" | "currentAddress";

const FIELD_RESOURCE: Record<TextFixField, string> = {
  name: "owner_name",
  nameKana: "owner_name_kana",
  address: "owner_address",
  // 現住所は登記上の住所と同じ機微度＝同じ field-level 権限で扱う。
  currentAddress: "owner_address",
};

function statusFromReasons(reasons: string[]): number {
  if (reasons.includes("version_mismatch")) return 409;
  return 422;
}

/** 対象フィールドの生値が可視か（field-level が full/edit/read）。 */
function canSeeField(
  perms: Parameters<typeof getOwnerFieldLevel>[0],
  field: TextFixField,
): boolean {
  const level = getOwnerFieldLevel(perms, FIELD_RESOURCE[field]);
  return level === "full" || level === "edit" || level === "read";
}

// sanitize mode で不可視フィールドに対し伏せる reason（class オラクル防止＝全件）。
const SANITIZE_MODE_HIDDEN_ORACLE = new Set<string>([
  "no_change",
  "replacement_char",
  "mojibake",
  "would_be_empty",
  "forbidden_value",
  "version_mismatch",
  "owner_archived",
]);
// set mode で不可視フィールドに対し伏せる reason（現在値の同値オラクルのみ）。
const SET_MODE_HIDDEN_ORACLE = new Set<string>(["no_change"]);

function stripHiddenOracle(
  reasons: string[],
  mode: "sanitize" | "set",
): string[] {
  const oracle =
    mode === "sanitize" ? SANITIZE_MODE_HIDDEN_ORACLE : SET_MODE_HIDDEN_ORACLE;
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

    const body = await request.json().catch(() => ({}));
    const version = body?.version;
    if (
      typeof version !== "number" ||
      !Number.isInteger(version) ||
      version < 1
    ) {
      throw new ApiError(
        400,
        "version は正の整数で指定してください",
        "INVALID_INPUT",
      );
    }
    const fieldRaw = body?.field;
    if (
      fieldRaw !== "name" &&
      fieldRaw !== "nameKana" &&
      fieldRaw !== "address" &&
      fieldRaw !== "currentAddress"
    ) {
      throw new ApiError(
        400,
        "field は name / nameKana / address / currentAddress で指定してください",
        "INVALID_INPUT",
      );
    }
    const field: TextFixField = fieldRaw;
    const mode = body?.mode;
    if (mode !== "sanitize" && mode !== "set") {
      throw new ApiError(
        400,
        "mode は sanitize / set で指定してください",
        "INVALID_INPUT",
      );
    }
    let newValueInput: string | null = null;
    if (mode === "set") {
      if (typeof body?.newValue !== "string") {
        throw new ApiError(
          400,
          "newValue は文字列で指定してください",
          "INVALID_INPUT",
        );
      }
      newValueInput = body.newValue;
    }
    const dryRun = body?.dryRun !== false; // default: true

    const fieldVisible = canSeeField(perms, field);

    if (!dryRun) {
      if (!hasPermission(perms, "owner", "write")) {
        throw new ApiError(403, "所有者編集の権限がありません", "FORBIDDEN");
      }
      // 対象は PII フィールド。generic owner:write に加えて field-level write を必須にする。
      if (!hasExplicitWritePerm(perms, FIELD_RESOURCE[field])) {
        throw new ApiError(
          403,
          "対象フィールドを更新する権限がありません",
          "FORBIDDEN",
        );
      }
    }

    const owner = await prisma.owner.findUnique({
      where: { id: ownerId },
      select: {
        id: true,
        name: true,
        nameKana: true,
        address: true,
        currentAddress: true,
        // 現住所を直したときに郵便番号を据え置くか消すかの判断・履歴に使う。
        currentZip: true,
        version: true,
        isArchived: true,
      },
    });
    if (!owner) {
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }
    const currentValue =
      field === "name"
        ? owner.name
        : field === "nameKana"
          ? owner.nameKana
          : field === "currentAddress"
            ? owner.currentAddress
            : owner.address;

    // 1) targetValue（保存する値）と blockReasons を決定。
    let targetValue: string | null = null;
    let hasFinal = false;
    let blockReasons: string[] = [];

    if (mode === "sanitize") {
      const proposal = decideTextHygieneFix(currentValue);
      if (proposal.action === "sanitize") {
        targetValue = proposal.cleanedValue;
        hasFinal = true;
      } else if (proposal.action === "none") {
        blockReasons = ["no_change"];
      } else {
        // manual（audit-only: replacement_char / mojibake / would_be_empty）は自動補正しない。
        blockReasons = [proposal.manualReason ?? "manual"];
      }
    } else {
      // set: operator 入力値を採用（canonical 変換なし。safety gate で残存 DQ / 空化を拒否）。
      targetValue = newValueInput;
      hasFinal = true;
    }

    // 2) 共通 safety（archived / version / no_change / would_be_empty / forbidden_value）。
    if (blockReasons.length === 0 && hasFinal) {
      const safety = checkTextHygieneFixSafety({
        isArchived: owner.isArchived,
        versionMatches: owner.version === version,
        currentValue,
        newValue: targetValue,
      });
      blockReasons = safety.ok ? [] : safety.reasons;
    }
    const eligible = blockReasons.length === 0;

    // ── dryRun: DB / AuditLog を一切書かない ────────────────────────────────
    if (dryRun) {
      if (!fieldVisible) {
        return apiResponse({
          executed: false,
          blockReasons: stripHiddenOracle(blockReasons, mode),
          field,
          mode,
          fieldVisible: false,
        });
      }
      return apiResponse({
        executed: false,
        eligible,
        blockReasons,
        field,
        mode,
        fieldVisible: true,
      });
    }

    // ── 実行 ────────────────────────────────────────────────────────────────
    if (!eligible || !hasFinal || targetValue === null) {
      return apiResponse(
        {
          error: {
            message: "テキスト補正の条件を満たしていません",
            code: "TEXT_FIX_BLOCKED",
            blockReasons,
          },
        },
        statusFromReasons(blockReasons),
      );
    }

    const newVersion = version + 1;
    const finalValue = targetValue;

    // ⚠現住所を直した結果**宛先が変わる**なら、郵便番号は据え置けない（設計 §6.1）。
    //   文字化けの除去や空白の整形だけで宛先が同じなら、郵便番号はそのまま使える。
    //   宛先が変わるのに古い番号を残すと「別の場所の番号 + 新しい住所」になる。
    const clearsCurrentZip =
      field === "currentAddress" &&
      owner.currentZip != null &&
      normalizeAddress(currentValue) !== normalizeAddress(finalValue);
    if (clearsCurrentZip && !hasExplicitWritePerm(perms, "owner_zip")) {
      throw new ApiError(
        403,
        "現住所の郵便番号を更新する権限がありません",
        "FORBIDDEN",
      );
    }
    const TX_BLOCKED_SENTINEL = "__text_fix_blocked_in_tx__";
    let txBlockedReasons: TextHygieneFixBlockReason[] | null = null;
    let txNotFound = false;

    try {
      await prisma.$transaction(async (tx) => {
        const result = await tx.owner.updateMany({
          where: { id: ownerId, version, isArchived: false },
          data: {
            [field]: finalValue,
            ...(clearsCurrentZip ? { currentZip: null } : {}),
            version: { increment: 1 },
          },
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
          const reasons: TextHygieneFixBlockReason[] = [];
          if (cur.isArchived) reasons.push("owner_archived");
          if (cur.version !== version) reasons.push("version_mismatch");
          if (reasons.length === 0) reasons.push("version_mismatch");
          txBlockedReasons = reasons;
          throw new Error(TX_BLOCKED_SENTINEL);
        }

        // ChangeLog（fieldName の old/new。内部変更履歴のため値を含む = 既存編集と同方針）。
        await tx.changeLog.createMany({
          data: [
            {
              targetTable: "owners",
              targetId: ownerId,
              fieldName: field,
              oldValue: currentValue ?? null,
              newValue: finalValue,
              source: "manual",
              changedBy: session.id,
            },
            ...(clearsCurrentZip
              ? [
                  {
                    targetTable: "owners",
                    targetId: ownerId,
                    fieldName: "currentZip",
                    oldValue: owner.currentZip ?? null,
                    newValue: null,
                    source: "manual" as const,
                    changedBy: session.id,
                  },
                ]
              : []),
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
              message: "テキスト補正の条件を満たしていません",
              code: "TEXT_FIX_BLOCKED",
              blockReasons: reasons,
            },
          },
          statusFromReasons(reasons),
        );
      }
      throw e;
    }

    // AuditLog（transaction 外・PII / 生値なし）
    await writeAuditLog({
      userId: session.id,
      action: "owner_correction_text_fix",
      targetTable: "owners",
      targetId: ownerId,
      detail: {
        correctionType: "text_fix",
        dryRun: false,
        field,
        mode,
        updatedFields: clearsCurrentZip ? [field, "currentZip"] : [field],
      },
    });

    return apiResponse({
      executed: true,
      id: ownerId,
      version: newVersion,
      updatedFields: clearsCurrentZip ? [field, "currentZip"] : [field],
    });
  } catch (error) {
    return handleApiError(error);
  }
}
