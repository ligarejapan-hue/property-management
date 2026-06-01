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
// 上限を設ける。上限 +1 件まで取得して超過を検出し、超過時は不完全な結果を 200 で
// 返さず明示的なエラー(409 / QUALITY_CHECK_SCAN_LIMIT_EXCEEDED)にする。
// （部分結果を成功で返すと、省略された物件の error/warning が「問題なし」と誤解されるため）
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

    // 上限超過時は部分結果を 200 で返さない（省略された物件の error/warning が見えず
    // 「問題なし」と誤解されるのを防ぐ）。明示的なエラーにして UI のエラー導線に乗せる。
    if (scannedRows.length > QUALITY_CHECK_SCAN_LIMIT) {
      throw new ApiError(
        409,
        "品質チェック対象の物件数が上限を超えています。条件を絞り込むか、管理者に相談してください。",
        "QUALITY_CHECK_SCAN_LIMIT_EXCEEDED",
      );
    }

    const properties = scannedRows;

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
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
