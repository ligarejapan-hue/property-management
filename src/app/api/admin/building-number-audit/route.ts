// GET /api/admin/building-number-audit
//
// 家屋番号に「範囲」（例 5-1-1 ～ 5-1-43）が入っている物件の一覧（read-only・DB 無変更）。
// 区分建物の全部事項の読み取りの誤り（PR #563 で修正）で入った値を、人が直すための点検表。
// 各物件の最新の謄本（削除済みを除く）を、直した読み取りで読み直して候補を出す。
//
// 権限: user_management:read（管理者エリア）AND property:read。
// 監査: 件数・フラグのみ（物件ID・住所・家屋番号の値は記録しない）。
// 時間: 謄本の読み直しは 1 件ずつ。BUILDING_NUMBER_AUDIT_TIME_BUDGET_MS を超えたら残りは未処理で返す。
//   読み直し1件ごとにも残り時間で打ち切る（遅い保存先・重いPDFで上限を超えないため）。
// 続き: 未処理・上限超えのときは nextCursor（物件ID）を返す。?after=<物件ID> で続きから点検する
//   （同じ先頭を何度も読み直して、後ろの物件にいつまでも届かない、を防ぐ）。
// 担当分しか見られない役割（field_staff）は、権限の付与があっても使えない（全物件を見る道具のため）。
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
import { isPropertyScopedRole } from "@/lib/property-access";
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

/** 残り時間で打ち切る。打ち切ったら null（読み直し自体は止められないが、応答は待たない）。 */
async function withinBudget<T>(p: Promise<T>, remainingMs: number): Promise<T | null> {
  if (remainingMs <= 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), remainingMs);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    if (isPropertyScopedRole(session.role)) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "user_management", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "property", "read")) {
      throw new ApiError(403, "物件閲覧の権限がありません", "FORBIDDEN");
    }

    const afterRaw = new URL(request.url).searchParams.get("after");
    const after = afterRaw && UUID_RE.test(afterRaw) ? afterRaw : null;

    const where = {
      isArchived: false,
      OR: [{ buildingNumber: { contains: "～" } }, { buildingNumber: { contains: "〜" } }],
    };
    const [total, fetched] = await Promise.all([
      prisma.property.count({ where }),
      prisma.property.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        // 1件多く取って、続きがあるかを知る
        take: BUILDING_NUMBER_AUDIT_MAX_TARGETS + 1,
        ...(after ? { cursor: { id: after }, skip: 1 } : {}),
        select: { id: true, address: true, buildingName: true, roomNo: true, buildingNumber: true },
      }),
    ]);
    const truncated = fetched.length > BUILDING_NUMBER_AUDIT_MAX_TARGETS;
    const properties = fetched.slice(0, BUILDING_NUMBER_AUDIT_MAX_TARGETS);

    const started = Date.now();
    let timeBudgetExhausted = false;
    /** 読み直しを終えた最後の物件（続きの起点）。 */
    let lastDoneId: string | null = after;
    const rows: BuildingNumberAuditRow[] = [];
    for (const p of properties) {
      if (!isRangeBuildingNumber(p.buildingNumber)) {
        if (!timeBudgetExhausted) lastDoneId = p.id;
        continue;
      }
      let result: { suggestion: string | null; status: BuildingNumberSuggestionStatus } | null = null;
      if (!timeBudgetExhausted) {
        result = await withinBudget(
          suggestFor(p.id),
          BUILDING_NUMBER_AUDIT_TIME_BUDGET_MS - (Date.now() - started),
        );
        if (result === null) timeBudgetExhausted = true;
        else lastDoneId = p.id;
      }
      if (result === null) result = { suggestion: null, status: "not_processed" };
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

    // 続きがあるとき（時間切れ・上限超え）だけ、続きの起点を返す
    const nextCursor =
      timeBudgetExhausted || truncated
        ? (timeBudgetExhausted ? lastDoneId : properties[properties.length - 1]?.id ?? null)
        : null;

    return apiResponse({
      total,
      truncated,
      timeBudgetExhausted,
      maxTargets: BUILDING_NUMBER_AUDIT_MAX_TARGETS,
      // 時間切れで1件も読めなかったときは null になり得る（その場合は先頭から＝after をそのまま返す）
      nextCursor: nextCursor ?? (timeBudgetExhausted ? after : null),
      hasMore: timeBudgetExhausted || truncated,
      rows,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
