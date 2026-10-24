// GET /api/admin/building-number-audit
//
// 家屋番号に「範囲」（例 5-1-1 ～ 5-1-43）が入っている物件の一覧（read-only・DB 無変更）。
// 区分建物の全部事項の読み取りの誤り（PR #563 で修正）で入った値を、人が直すための点検表。
// 各物件の最新の謄本（削除済みを除く）を、直した読み取りで読み直して候補を出す。
//
// 権限: user_management:read（管理者エリア）AND property:read。
// 監査: 件数・フラグのみ（物件ID・住所・家屋番号の値は記録しない）。
// 時間: 謄本の読み直しは 1 件ずつ。BUILDING_NUMBER_AUDIT_TIME_BUDGET_MS を超えたら残りは未処理で返す。
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
import { getStorage } from "@/lib/storage";
import { extractTextFromPdf } from "@/lib/pdf-extract";
import {
  BUILDING_NUMBER_AUDIT_MAX_TARGETS,
  BUILDING_NUMBER_AUDIT_TIME_BUDGET_MS,
  isRangeBuildingNumber,
  suggestBuildingNumberFromText,
  type BuildingNumberSuggestionStatus,
} from "@/lib/building-number-audit";

export interface BuildingNumberAuditRow {
  propertyId: string;
  address: string;
  buildingName: string | null;
  roomNo: string | null;
  buildingNumber: string;
  suggestion: string | null;
  status: BuildingNumberSuggestionStatus;
}

async function suggestFor(
  propertyId: string,
): Promise<{ suggestion: string | null; status: BuildingNumberSuggestionStatus }> {
  const attachment = await prisma.attachment.findFirst({
    where: { propertyId, type: "registry", isDeleted: false },
    orderBy: { createdAt: "desc" },
    select: { fileUrl: true },
  });
  if (!attachment) return { suggestion: null, status: "no_registry" };
  try {
    const storage = getStorage();
    const key = storage.keyFromUrl(attachment.fileUrl);
    if (!key) return { suggestion: null, status: "unreadable" };
    const file = await storage.read(key);
    if (!file) return { suggestion: null, status: "unreadable" };
    const text = await extractTextFromPdf(file.body);
    if (!text.trim()) return { suggestion: null, status: "unreadable" };
    const suggestion = suggestBuildingNumberFromText(text);
    return suggestion ? { suggestion, status: "suggested" } : { suggestion: null, status: "not_found" };
  } catch {
    // 謄本の本文・ファイル名を含みうるため、例外の中身は出さない
    return { suggestion: null, status: "unreadable" };
  }
}

export async function GET() {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "user_management", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "property", "read")) {
      throw new ApiError(403, "物件閲覧の権限がありません", "FORBIDDEN");
    }

    const where = {
      isArchived: false,
      OR: [{ buildingNumber: { contains: "～" } }, { buildingNumber: { contains: "〜" } }],
    };
    const [total, properties] = await Promise.all([
      prisma.property.count({ where }),
      prisma.property.findMany({
        where,
        orderBy: { createdAt: "asc" },
        take: BUILDING_NUMBER_AUDIT_MAX_TARGETS,
        select: { id: true, address: true, buildingName: true, roomNo: true, buildingNumber: true },
      }),
    ]);
    const truncated = total > properties.length;

    const started = Date.now();
    let timeBudgetExhausted = false;
    const rows: BuildingNumberAuditRow[] = [];
    for (const p of properties) {
      if (!isRangeBuildingNumber(p.buildingNumber)) continue;
      let result: { suggestion: string | null; status: BuildingNumberSuggestionStatus };
      if (timeBudgetExhausted || Date.now() - started > BUILDING_NUMBER_AUDIT_TIME_BUDGET_MS) {
        timeBudgetExhausted = true;
        result = { suggestion: null, status: "not_processed" };
      } else {
        result = await suggestFor(p.id);
      }
      rows.push({
        propertyId: p.id,
        address: p.address,
        buildingName: p.buildingName,
        roomNo: p.roomNo,
        buildingNumber: p.buildingNumber ?? "",
        ...result,
      });
    }

    const suggested = rows.filter((r) => r.status === "suggested").length;
    await writeAuditLog({
      userId: session.id,
      action: "building_number_audit_view",
      detail: { total, returned: rows.length, suggested, truncated, timeBudgetExhausted },
    });

    return apiResponse({
      total,
      truncated,
      timeBudgetExhausted,
      maxTargets: BUILDING_NUMBER_AUDIT_MAX_TARGETS,
      rows,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
