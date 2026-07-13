// GET /api/admin/owners/correction/corporate-restore-candidates
//
// 割れた会社法人等番号の復元候補一覧(dry-run)。
// 外部exe由来の所有者Excelで分断された会社法人等番号(12桁)を検出する:
//   - address_name_split: 住所末尾に前半断片 + 氏名が後半数字のみ → 12桁復元可
//   - name_fragment:      氏名が「会社名+ラベル+尻切れ断片」 → 会社名の救出のみ
// DB は一切変更しない。反映は corporate-restore-apply(POST)。
//
// 設計上の不変条件(既存 corporate-number-candidates と同型):
// - active Owner のみ・select 最小限・in-memory スキャン上限あり
// - 検出は corporate-number-restore の純関数を再利用
// - display-level を尊重: raw-visible でないフィールドからは検出しない(fail-safe)
// - レスポンスはマスキング済(法人番号は full 権限のみ生値・他は先頭4桁マスク)
// - AuditLog detail は件数のみ(owner.id 配列・法人番号・会社名・住所は載せない)
//
// 権限: user_management:read AND owner:read(既存 correction 系と同じ)
//       + owner_corporate_number=hidden は 403

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission, maskValue } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { maskCorporateNumber } from "@/lib/display-level";
import { isRawVisible } from "@/lib/owner-corporate-candidates";
import {
  detectSplitCorporateOwner,
  type SplitCorporateType,
} from "@/lib/corporate-number-restore";

/** in-memory スキャン上限(既存 corporate-number-candidates と同値)。 */
const MAX_SCAN = 10_000;
/** 返却行の上限。本番実測は約40件(2026-07-13)なので十分に大きい安全弁。 */
const MAX_ROWS = 200;

export interface CorporateRestoreRow {
  ownerId: string;
  type: SplitCorporateType;
  ownerNameMasked: string | null;
  ownerAddressMasked: string | null;
  /** 復元された12桁(分断型のみ)。display-level に従いマスク。 */
  registry12Masked: string | null;
  /** 12桁から算出した13桁(分断型のみ)。display-level に従いマスク。 */
  corporate13Masked: string | null;
  /** 断片除去後の会社名(断片型のみ)。owner_name の display-level に従いマスク。 */
  cleanedNameMasked: string | null;
  /** 一括反映の対象にできるか(分断型=13桁算出済 / 断片型=会社名救出可) */
  eligible: boolean;
  version: number;
  detailUrl: string;
}

/**
 * 法人番号系のマスク方針(owner-corporate-candidates.ts と同一):
 * full → 生値 / hidden → null / それ以外 → 先頭4桁マスク。
 */
function maskCorporateField(
  value: string | null,
  level: "hidden" | "masked" | "partial" | "full" | "read" | "edit",
): string | null {
  if (value == null) return null;
  switch (level) {
    case "hidden":
      return null;
    case "full":
      return value;
    default:
      return maskCorporateNumber(value);
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "user_management", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "所有者閲覧の権限がありません", "FORBIDDEN");
    }

    const displayConfig = await getOwnerDisplayConfig(session.id, perms);
    if (displayConfig.corporateNumber === "hidden") {
      throw new ApiError(403, "法人番号の閲覧権限がありません", "FORBIDDEN");
    }

    // NextRequest 互換のため url は参照のみ(クエリパラメータは現状なし)
    void request;

    const owners = await prisma.owner.findMany({
      where: { isArchived: false },
      select: {
        id: true,
        name: true,
        address: true,
        corporateNumber: true,
        version: true,
      },
      orderBy: { id: "asc" },
      take: MAX_SCAN + 1,
    });
    const truncatedScan = owners.length > MAX_SCAN;
    const scanned = truncatedScan ? owners.slice(0, MAX_SCAN) : owners;

    const rows: CorporateRestoreRow[] = [];
    let split = 0;
    let fragment = 0;
    let nameLost = 0;
    let truncatedRows = false;

    for (const owner of scanned) {
      // display-level が raw-visible でないフィールドからは検出しない(fail-safe)。
      // マスク表示のユーザーが raw 値由来の断片・復元番号を推測できないようにする。
      const detection = detectSplitCorporateOwner({
        name: isRawVisible(displayConfig.name) ? owner.name : null,
        address: isRawVisible(displayConfig.address) ? owner.address : null,
        // 第3型(番号あり氏名欠落)の判定に使う。応答には display-level マスクを通す。
        // 型(検出有無)から番号保有が推測されるのは既存 corporate-number-candidates の
        // 分類トレードオフと同型(owner_corporate_number=hidden は上で 403 済)。
        corporateNumber: owner.corporateNumber,
      });
      if (!detection) continue;

      if (rows.length >= MAX_ROWS) {
        truncatedRows = true;
        break;
      }

      if (detection.type === "address_name_split") split++;
      else if (detection.type === "number_set_name_lost") nameLost++;
      else fragment++;

      const eligible =
        detection.type === "name_fragment"
          ? detection.cleanedName != null
          : detection.corporateNumber13 != null;

      rows.push({
        ownerId: owner.id,
        type: detection.type,
        ownerNameMasked: maskValue(owner.name, displayConfig.name),
        ownerAddressMasked: maskValue(owner.address, displayConfig.address),
        registry12Masked: maskCorporateField(
          detection.companyRegistryNumber12,
          displayConfig.corporateNumber,
        ),
        corporate13Masked: maskCorporateField(
          detection.corporateNumber13,
          displayConfig.corporateNumber,
        ),
        cleanedNameMasked: maskValue(detection.cleanedName, displayConfig.name),
        eligible,
        version: owner.version,
        detailUrl: `/admin/owners/${owner.id}`,
      });
    }

    const summary = {
      split,
      fragment,
      nameLost,
      total: split + fragment + nameLost,
    };

    // 非PII audit(件数のみ)。owner.id 配列・法人番号・会社名・住所は載せない。
    await writeAuditLog({
      userId: session.id,
      action: "owner_correction_corporate_restore_list",
      targetTable: "owners",
      detail: {
        summary,
        truncated: truncatedScan || truncatedRows,
      },
    });

    return apiResponse({
      rows,
      summary,
      truncated: truncatedScan || truncatedRows,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
