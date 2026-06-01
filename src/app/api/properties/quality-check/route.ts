import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";

interface QualityIssue {
  propertyId: string;
  address: string;
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
}

// ---------- GET /api/properties/quality-check ----------

// 物件一覧ロード時に毎回呼ばれるため、全非アーカイブ物件の無制限スキャンを避けて
// 上限を設ける。上限 +1 件まで取得し、超過時はエラーにせず取得範囲で従来どおり
// 判定したうえで summary.scanLimited を立てる（全件チェックでない旨を UI が示せる余地）。
const QUALITY_CHECK_SCAN_LIMIT = 5000;

export async function GET() {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    // 上限 +1 件まで取得して超過を検出する。取得列は判定に必要な非PIIのみ。
    // 所有者は「紐付け有無（件数）」しか見ないため、id 配列ではなく _count を取得して
    // 余計な所有者行・PII を取得しない。
    const scannedRows = await prisma.property.findMany({
      where: { isArchived: false },
      select: {
        id: true,
        address: true,
        lotNumber: true,
        realEstateNumber: true,
        registryStatus: true,
        dmStatus: true,
        caseStatus: true,
        assignedTo: true,
        investigationConfirmedAt: true,
        _count: { select: { propertyOwners: true } },
      },
      take: QUALITY_CHECK_SCAN_LIMIT + 1,
    });

    // 上限超過時はエラーにせず、先頭 SCAN_LIMIT 件のみで従来どおり判定する。
    const scanLimited = scannedRows.length > QUALITY_CHECK_SCAN_LIMIT;
    const properties = scanLimited
      ? scannedRows.slice(0, QUALITY_CHECK_SCAN_LIMIT)
      : scannedRows;

    const issues: QualityIssue[] = [];

    for (const p of properties) {
      // No owner linked
      if (p._count.propertyOwners === 0) {
        issues.push({
          propertyId: p.id,
          address: p.address,
          severity: "warning",
          code: "NO_OWNER",
          message: "所有者が紐付けられていません",
        });
      }

      // Registry not obtained but DM decision is send
      if (p.registryStatus === "unconfirmed" && p.dmStatus === "send") {
        issues.push({
          propertyId: p.id,
          address: p.address,
          severity: "error",
          code: "REGISTRY_DM_MISMATCH",
          message: "登記未取得なのにDM送付可になっています",
        });
      }

      // No lot number
      if (!p.lotNumber) {
        issues.push({
          propertyId: p.id,
          address: p.address,
          severity: "info",
          code: "NO_LOT_NUMBER",
          message: "地番が未入力です",
        });
      }

      // No real estate number
      if (!p.realEstateNumber) {
        issues.push({
          propertyId: p.id,
          address: p.address,
          severity: "info",
          code: "NO_REAL_ESTATE_NUMBER",
          message: "不動産番号が未入力です",
        });
      }

      // Investigation not confirmed
      if (!p.investigationConfirmedAt) {
        issues.push({
          propertyId: p.id,
          address: p.address,
          severity: "warning",
          code: "INVESTIGATION_NOT_CONFIRMED",
          message: "調査情報が未確認です",
        });
      }

      // No assignee
      if (!p.assignedTo) {
        issues.push({
          propertyId: p.id,
          address: p.address,
          severity: "warning",
          code: "NO_ASSIGNEE",
          message: "担当者が未設定です",
        });
      }

      // Case status is new_case but has been sitting
      // (This would ideally check against createdAt, but kept simple for now)
    }

    // Sort: error > warning > info
    const severityOrder = { error: 0, warning: 1, info: 2 };
    issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    return apiResponse({
      data: issues,
      summary: {
        total: issues.length,
        errors: issues.filter((i) => i.severity === "error").length,
        warnings: issues.filter((i) => i.severity === "warning").length,
        info: issues.filter((i) => i.severity === "info").length,
        propertiesChecked: properties.length,
        // 上限到達フラグ（非PII）。true の場合は全件ではなく先頭 scanLimit 件のみ判定済み。
        // 既存UIは未使用でも壊れない（追加フィールドのみ・後方互換）。
        scanLimited,
        scanLimit: QUALITY_CHECK_SCAN_LIMIT,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
