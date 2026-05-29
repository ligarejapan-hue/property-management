/**
 * 物件一覧の検索条件（query → where / orderBy / 取込元逆引き）を組み立てる共有ロジック。
 *
 * GET /api/properties（一覧）と GET /api/properties/export（CSV出力）の両方から
 * 呼び出し、検索・フィルタ・sort・field_staff スコープの条件ズレを防ぐための単一定義元。
 *
 * 重要:
 *  - ここで組み立てる where は一覧 API の従来挙動と完全に一致させること。
 *    （挙動が変わると既存テスト properties-route-mgmt-id.test.ts が落ちる）
 *  - PII（mgmtId 生値・所有者名など）はここでは扱わず、呼び出し側の責務とする。
 */
import prisma from "@/lib/prisma";
import { resolveMgmtIdToPropertyIds } from "@/lib/property-mgmt-id-search";
import { propertyListQuerySchema } from "@/lib/validators";
import type { z } from "zod";

export type PropertyListQuery = z.infer<typeof propertyListQuerySchema>;

export interface PropertyListSession {
  id: string;
  role: string;
}

type PrismaClientLike = typeof prisma;

export interface BuildPropertyListWhereResult {
  /** Prisma.PropertyWhereInput 相当。既存実装に合わせ any で扱う。 */
  where: any;
  /** mgmtId 検索が 0 件で短絡（DB を叩かず空結果にすべき）か */
  mgmtShortCircuitEmpty: boolean;
  /** mgmtId 検索の hit 件数（未検索時は null） */
  mgmtHitCount: number | null;
  /** trim 済み mgmtId（未指定時は空文字） */
  mgmtIdTrimmed: string;
}

/**
 * 一覧クエリから Prisma where 条件を組み立てる。
 * mgmtId 検索のために非同期（helper を呼ぶ）。
 */
export async function buildPropertyListWhere(
  query: PropertyListQuery,
  session: PropertyListSession,
  client: PrismaClientLike = prisma,
): Promise<BuildPropertyListWhereResult> {
  const {
    keyword,
    mgmtId,
    propertyType,
    registryStatus,
    dmStatus,
    caseStatus,
    introductionRoute,
    assignedTo,
    updatedFrom,
    updatedTo,
    includeArchived,
    hasWarning,
  } = query;

  const where: any = {};

  if (!includeArchived) {
    where.isArchived = false;
  }

  if (propertyType) where.propertyType = propertyType;
  if (registryStatus) where.registryStatus = registryStatus;
  if (dmStatus) where.dmStatus = dmStatus;
  if (caseStatus) where.caseStatus = caseStatus;
  if (introductionRoute) where.introductionRoute = introductionRoute;
  if (assignedTo) where.assignedTo = assignedTo;

  if (keyword) {
    where.OR = [
      { address: { contains: keyword, mode: "insensitive" } },
      { lotNumber: { contains: keyword, mode: "insensitive" } },
      { realEstateNumber: { contains: keyword, mode: "insensitive" } },
      { buildingNumber: { contains: keyword, mode: "insensitive" } },
    ];
  }

  if (updatedFrom || updatedTo) {
    where.updatedAt = {};
    if (updatedFrom) where.updatedAt.gte = new Date(updatedFrom);
    if (updatedTo) where.updatedAt.lte = new Date(updatedTo);
  }

  // 管理ID（取込元 fileName / rowNumber / __sourceRef）検索。
  // helper で候補 propertyId[] を解決し AND で絞り込む。0件なら即空結果。
  // 既存 keyword 検索とは独立した AND 条件として扱う。
  const mgmtIdTrimmed = (mgmtId ?? "").trim();
  let mgmtHitCount: number | null = null;
  let mgmtShortCircuitEmpty = false;
  if (mgmtIdTrimmed) {
    const mgmtPropertyIds = await resolveMgmtIdToPropertyIds(
      client,
      mgmtIdTrimmed,
    );
    mgmtHitCount = mgmtPropertyIds.length;
    if (mgmtPropertyIds.length === 0) {
      mgmtShortCircuitEmpty = true;
    } else {
      where.AND = [
        ...(where.AND ?? []),
        { id: { in: mgmtPropertyIds } },
      ];
    }
  }

  // field_staff は自分が作成/担当する物件のみ閲覧可能。
  // where.OR (keyword 条件) と混ぜると「担当外でも keyword に一致すれば返る」に
  // なるため AND に追加してスコープを強制する。
  if (session.role === "field_staff") {
    where.AND = [
      ...(where.AND ?? []),
      { OR: [{ createdBy: session.id }, { assignedTo: session.id }] },
    ];
  }

  // hasWarning: quality-check の "error" / "warning" 条件を OR で表現し、
  // 既存 where と AND する。"info" (NO_LOT_NUMBER 等) は粒度が細かいため除外。
  if (hasWarning === true) {
    where.AND = [
      ...(where.AND ?? []),
      {
        OR: [
          { propertyOwners: { none: {} } }, // NO_OWNER
          {
            AND: [
              { registryStatus: "unconfirmed" },
              { dmStatus: "send" },
            ],
          }, // REGISTRY_DM_MISMATCH
          { investigationConfirmedAt: null }, // INVESTIGATION_NOT_CONFIRMED
          { assignedTo: null }, // NO_ASSIGNEE
        ],
      },
    ];
  }

  return { where, mgmtShortCircuitEmpty, mgmtHitCount, mgmtIdTrimmed };
}

/** sortBy / sortOrder から Prisma orderBy を組み立てる。 */
export function buildPropertyListOrderBy(query: PropertyListQuery) {
  return { [query.sortBy]: query.sortOrder };
}

/**
 * 物件IDの配列から「取込元（管理ID）」を一括逆引きする（N+1 回避）。
 * createdId ごとに最初の success 行だけを採用し、__sourceRef があればそれを、
 * なければ `${fileName}:${rowNumber}行` を返す。
 */
export async function loadImportSourceMap(
  client: PrismaClientLike,
  propertyIds: string[],
): Promise<Map<string, string>> {
  const importSourceMap = new Map<string, string>();
  if (propertyIds.length === 0) return importSourceMap;

  const importRows = await client.importJobRow.findMany({
    where: { createdId: { in: propertyIds }, status: "success" },
    select: {
      createdId: true,
      rowNumber: true,
      rawData: true,
      job: { select: { fileName: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  for (const row of importRows) {
    if (!importSourceMap.has(row.createdId!)) {
      const rd = (row.rawData as Record<string, string>) ?? {};
      importSourceMap.set(
        row.createdId!,
        rd.__sourceRef ?? `${row.job.fileName}:${row.rowNumber}行`,
      );
    }
  }

  return importSourceMap;
}
