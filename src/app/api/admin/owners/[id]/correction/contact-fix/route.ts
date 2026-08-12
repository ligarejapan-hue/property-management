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
  isValidPostalCode,
  formatPostalCode,
} from "@/lib/address-lookup/normalize";
import {
  decideZipFix,
  decidePhoneFix,
  checkContactFixSafety,
  classifyPhone,
  normalizePhone,
  type ContactField,
  type ContactFixBlockReason,
} from "@/lib/owner-contact-format";

// ---------------------------------------------------------------------------
// POST /api/admin/owners/:id/correction/contact-fix
// ---------------------------------------------------------------------------
// DQ-02: Owner.zip / Owner.phone の整形補正。
//
// body: { version:int, field:"zip"|"phone", mode:"format"|"set", newValue?:string, dryRun?:boolean }
//   - mode "format": サーバ側で decideZipFix/decidePhoneFix を再計算し、valid だが
//     未整形のときのみ整形（123-4567 / 区切り統一）を適用。suspicious/non_phone/empty は manual。
//   - mode "set": operator 入力値を採用。空はクリア許可、非空は valid でなければ forbidden_value。
//     採用時は canonical（zip=formatPostalCode / phone=normalizePhone）で保存。
//
// 権限:
//   - dryRun: user_management:read + owner:read
//   - 実行: 上記 + owner:write + 対象フィールドの field-level write
//     （zip→owner_zip / phone→owner_phone の full/edit）。
//
// dryRun preview は対象フィールドが不可視（field-level < read）のとき no_change を伏せ、
// eligible も返さない（隠し現在値の同値オラクル防止。name-fix P1 と同方針）。
//
// ChangeLog（zip/phone の old/new）は内部変更履歴として記録するが、AuditLog detail には
// 値を入れない。
// ---------------------------------------------------------------------------

/**
 * この route が直せる欄。現住所の郵便番号（currentZip）は**値の種類としては zip**
 * なので、整形・妥当性の判定は zip と同じものを使う（FIELD_KIND）。
 */
type TargetField = "zip" | "phone" | "currentZip";

/** 値の種類（整形・妥当性判定の切り替えに使う）。 */
const FIELD_KIND: Record<TargetField, ContactField> = {
  zip: "zip",
  phone: "phone",
  currentZip: "zip",
};

const FIELD_RESOURCE: Record<TargetField, string> = {
  zip: "owner_zip",
  phone: "owner_phone",
  currentZip: "owner_zip",
};

function statusFromReasons(reasons: string[]): number {
  if (reasons.includes("version_mismatch")) return 409;
  return 422;
}

/** 対象フィールドの生値が可視か（field-level が full/edit/read）。 */
function canSeeField(
  perms: Parameters<typeof getOwnerFieldLevel>[0],
  field: TargetField,
): boolean {
  const level = getOwnerFieldLevel(perms, FIELD_RESOURCE[field]);
  return level === "full" || level === "edit" || level === "read";
}

/** 現住所そのものの生値が見えるか。現住所の郵便番号を直すには住所が見えている必要がある。 */
function canSeeCurrentAddress(
  perms: Parameters<typeof getOwnerFieldLevel>[0],
): boolean {
  const level = getOwnerFieldLevel(perms, "owner_address");
  return level === "full" || level === "edit" || level === "read";
}

// 現在値（隠し値）から導出される blockReasons。対象フィールドが不可視のとき
// これらを返すと、隠し値が empty / suspicious / non_phone / 同値 のどれかを
// dry-run プローブで推測できてしまう（Codex DQ-02 P2）。
//   - no_change                : currentValue === newValue（set/format 共通）
//   - empty / suspicious /
//     non_phone / manual        : format mode の decide*Fix が currentValue を分類した結果
// 一方 forbidden_value（operator の newValue 由来）は現在値 PII を漏らさないため抑止しない。
const CURRENT_VALUE_DERIVED_REASONS = new Set<string>([
  "no_change",
  "empty",
  "suspicious",
  "non_phone",
  "manual",
]);

// format mode の dry-run probe では、safety（version/archived）に到達できるのは
// proposal.action === "format"（＝隠し現在値が valid だが未整形＝format 候補）の
// ときに限られる。短絡する suspicious/empty/non_phone/同値は safety 前に弾かれ []
// になる。よって不可視フィールドに対する format probe で version_mismatch /
// owner_archived を返すと、その存在自体が「隠し値は format 候補」というクラスを
// 漏らすオラクルになる（Codex DQ-02 P1）。
//   - これらは format mode の不可視 probe でのみ抑止する。
//   - set mode は safety 到達が operator の newValue 妥当性のみに依存し隠し現在値の
//     クラスに依存しないため抑止しない（正当な楽観ロック/アーカイブ通知を維持）。
//   - 実 apply（非 dry-run）でも従来どおり返す。
const FORMAT_CONDITIONAL_SAFETY_REASONS = new Set<string>([
  "version_mismatch",
  "owner_archived",
]);

/**
 * 隠し現在値に依存する blockReasons を除去する（不可視フィールド用）。
 * format mode では version_mismatch / owner_archived も抑止する（上記 P1）。
 */
function stripHiddenOracle(reasons: string[], mode: "format" | "set"): string[] {
  return reasons.filter((r) => {
    if (CURRENT_VALUE_DERIVED_REASONS.has(r)) return false;
    if (mode === "format" && FORMAT_CONDITIONAL_SAFETY_REASONS.has(r)) return false;
    return true;
  });
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
    const fieldRaw = body?.field;
    if (
      fieldRaw !== "zip" &&
      fieldRaw !== "phone" &&
      fieldRaw !== "currentZip"
    ) {
      throw new ApiError(
        400,
        "field は zip / phone / currentZip で指定してください",
        "INVALID_INPUT",
      );
    }
    const field: TargetField = fieldRaw;
    const kind: ContactField = FIELD_KIND[field];
    const mode = body?.mode;
    if (mode !== "format" && mode !== "set") {
      throw new ApiError(400, "mode は format / set で指定してください", "INVALID_INPUT");
    }
    let newValueInput: string | null = null;
    if (mode === "set") {
      if (typeof body?.newValue !== "string") {
        throw new ApiError(400, "newValue は文字列で指定してください", "INVALID_INPUT");
      }
      newValueInput = body.newValue;
    }
    const dryRun = body?.dryRun !== false; // default: true

    // ⚠現住所の郵便番号は「住所とペアの片割れ」なので、住所が見えていないと直せない
    //   （どの宛先の番号なのかを判断できないまま書き換えることになる）。
    const fieldVisible =
      canSeeField(perms, field) &&
      (field !== "currentZip" || canSeeCurrentAddress(perms));

    if (!dryRun) {
      if (!hasPermission(perms, "owner", "write")) {
        throw new ApiError(403, "所有者編集の権限がありません", "FORBIDDEN");
      }
      // 対象は PII フィールド。generic owner:write に加えて field-level write を必須にする。
      if (!hasExplicitWritePerm(perms, FIELD_RESOURCE[field])) {
        throw new ApiError(403, "対象フィールドを更新する権限がありません", "FORBIDDEN");
      }
      // ⚠現住所の郵便番号を書くことは「この住所の番号はこれだ」と言うのと同じ。
      //   住所側の書込権限も要求する（片方の権限だけでペアを動かさない）。
      if (field === "currentZip" && !hasExplicitWritePerm(perms, "owner_address")) {
        throw new ApiError(
          403,
          "現住所を更新する権限がありません",
          "FORBIDDEN",
        );
      }
    }

    const owner = await prisma.owner.findUnique({
      where: { id: ownerId },
      select: {
        id: true,
        zip: true,
        phone: true,
        currentZip: true,
        currentAddress: true,
        version: true,
        isArchived: true,
      },
    });
    if (!owner) {
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }
    const currentValue =
      field === "zip"
        ? owner.zip
        : field === "currentZip"
          ? owner.currentZip
          : owner.phone;

    // 1) finalValue（保存する canonical 値）と blockReasons を決定。
    let finalValue: string | null = null;
    let hasFinal = false;
    let blockReasons: string[] = [];

    // ⚠現住所が無いのに郵便番号だけ直すと、宛先にならない番号だけが残る（設計 §6.1）。
    //   住所を据え置いたままペアとして書き直す形でのみ許す。
    if (
      field === "currentZip" &&
      (owner.currentAddress ?? "").trim() === ""
    ) {
      blockReasons = ["current_address_missing"];
    }

    if (blockReasons.length > 0) {
      // 現住所が無い＝この欄は直せない。以降の判定はしない。
    } else if (mode === "format") {
      const proposal =
        kind === "zip" ? decideZipFix(currentValue) : decidePhoneFix(currentValue);
      if (proposal.action === "format") {
        finalValue = proposal.cleanedValue;
        hasFinal = true;
      } else if (proposal.action === "none") {
        blockReasons = ["no_change"];
      } else {
        blockReasons = [proposal.manualReason ?? "manual"];
      }
    } else {
      const raw = newValueInput ?? "";
      if (raw.trim() === "") {
        finalValue = null; // クリア（ゴミ削除）許可
        hasFinal = true;
      } else {
        const valid =
          kind === "zip" ? isValidPostalCode(raw) : classifyPhone(raw) === "valid";
        if (!valid) {
          blockReasons = ["forbidden_value"];
        } else {
          finalValue = kind === "zip" ? formatPostalCode(raw) : normalizePhone(raw);
          hasFinal = true;
        }
      }
    }

    // 2) 共通 safety（archived / version / no_change を canonical 値で判定）。
    if (blockReasons.length === 0 && hasFinal) {
      const safety = checkContactFixSafety({
        field: kind,
        isArchived: owner.isArchived,
        versionMatches: owner.version === version,
        currentValue,
        newValue: finalValue,
      });
      blockReasons = safety.ok ? [] : safety.reasons;
    }
    const eligible = blockReasons.length === 0;

    // ── dryRun ───────────────────────────────────────────────────────────────
    if (dryRun) {
      if (!fieldVisible) {
        // 対象フィールド不可視ユーザーには no_change（同値オラクル）を伏せ、eligible も出さない。
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

    // ── 実行 ──────────────────────────────────────────────────────────────────
    if (!eligible || !hasFinal) {
      return apiResponse(
        {
          error: {
            message: "連絡先補正の条件を満たしていません",
            code: "CONTACT_FIX_BLOCKED",
            blockReasons,
          },
        },
        statusFromReasons(blockReasons),
      );
    }

    const newVersion = version + 1;
    const storeValue = finalValue;
    const TX_BLOCKED_SENTINEL = "__contact_fix_blocked_in_tx__";
    let txBlockedReasons: ContactFixBlockReason[] | null = null;
    let txNotFound = false;

    try {
      await prisma.$transaction(async (tx) => {
        const result = await tx.owner.updateMany({
          where: { id: ownerId, version, isArchived: false },
          data: { [field]: storeValue, version: { increment: 1 } },
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
          const reasons: ContactFixBlockReason[] = [];
          if (cur.isArchived) reasons.push("owner_archived");
          if (cur.version !== version) reasons.push("version_mismatch");
          if (reasons.length === 0) reasons.push("version_mismatch");
          txBlockedReasons = reasons;
          throw new Error(TX_BLOCKED_SENTINEL);
        }

        await tx.changeLog.createMany({
          data: [
            {
              targetTable: "owners",
              targetId: ownerId,
              fieldName: field,
              oldValue: currentValue ?? null,
              newValue: storeValue ?? null,
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
              message: "連絡先補正の条件を満たしていません",
              code: "CONTACT_FIX_BLOCKED",
              blockReasons: reasons,
            },
          },
          statusFromReasons(reasons),
        );
      }
      throw e;
    }

    await writeAuditLog({
      userId: session.id,
      action: "owner_correction_contact_fix",
      targetTable: "owners",
      targetId: ownerId,
      detail: {
        correctionType: "contact_fix",
        dryRun: false,
        field,
        mode,
        updatedFields: [field],
      },
    });

    return apiResponse({
      executed: true,
      id: ownerId,
      version: newVersion,
      updatedFields: [field],
    });
  } catch (error) {
    return handleApiError(error);
  }
}
