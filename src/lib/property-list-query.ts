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

/** "YYYY-MM-DD" を JST(+09:00)の指定時刻の Date にする。日付でない/暦として不正な日付は null(=フィルタ無効)。 */
function jstDayBoundary(day: string | undefined, time: string): Date | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const dt = new Date(`${day}T${time}+09:00`);
  if (Number.isNaN(dt.getTime())) return null;
  // JS は 2026-02-31 を 3 月へ繰り上げてしまう。JST の年月日が入力と一致するか往復検証し、不正な暦日は無視する(@codex R1)。
  const jst = new Date(dt.getTime() + 9 * 60 * 60 * 1000); // +09:00 平行移動して UTC ゲッターで JST 暦日を読む
  const roundTrip = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;
  return roundTrip === day ? dt : null;
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
    propertyTypes,
    registryStatus,
    dmStatus,
    undeliverable,
    dmSentMax,
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

  if (propertyType) {
    where.propertyType = propertyType;
  } else if (propertyTypes && propertyTypes.length > 0) {
    // 複数種別まとめ絞り(販売図面ピッカー)。単一 propertyType 指定時はそちらを優先。
    where.propertyType = { in: propertyTypes };
  }
  if (registryStatus) where.registryStatus = registryStatus;
  if (dmStatus) where.dmStatus = dmStatus;
  // 宛先不明(返送連動で立った dmUndeliverableAt)で絞り込む。
  if (undeliverable === "1") where.dmUndeliverableAt = { not: null };
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
    // 日付フィルタは JST の一日境界で解釈する。new Date("YYYY-MM-DD") は UTC 00:00 になり、JST 表示と9時間ズレて
    // 「今日更新分」が 0 件になっていた(A1 UI総点検)。JST(+09:00)の日の始まり/終わりに固定する(不正な日付は無視)。
    const gte = jstDayBoundary(updatedFrom, "00:00:00.000");
    const lte = jstDayBoundary(updatedTo, "23:59:59.999");
    if (gte || lte) {
      where.updatedAt = {};
      if (gte) where.updatedAt.gte = gte;
      if (lte) where.updatedAt.lte = lte;
    }
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
  const visibilityScope = propertyVisibilityScopeWhere(session);
  if (visibilityScope) {
    where.AND = [...(where.AND ?? []), visibilityScope];
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

  // DM送信回数フィルタは「未送信(0回)」のみ。dmLogs none でネイティブに絞れる(大規模でも高速・ID materialize 無し)。
  // 「N回以下(1/2/3)」は列を持たず groupBy+id notIn になり、DM が多い本番では巨大な ID リストを生んでタイムアウト
  // し得たため廃止した(送信回数の並べ替え sortBy=dmSendCount で代替・@codex R10-P2 + ユーザー判断)。
  if (dmSentMax === 0) {
    where.AND = [...(where.AND ?? []), { dmLogs: { none: {} } }];
  }

  return { where, mgmtShortCircuitEmpty, mgmtHitCount, mgmtIdTrimmed };
}

/**
 * 一覧APIのロール別可視範囲スコープ（単一定義元）。
 * field_staff は自分が作成/担当する物件のみ閲覧可能（createdBy / assignedTo の OR）。
 * それ以外のロールは全件閲覧可＝追加条件なし（null）。
 *
 * buildPropertyListWhere（一覧/CSV export）に加え、quality-check の scoped モード
 * （warningPropertiesTotal / 各ルール判定）でも同一条件を再利用し、
 * 「一覧で見えない物件の情報が件数や警告として漏れない」ことを保証する（Codex P1）。
 */
export function propertyVisibilityScopeWhere(
  session: PropertyListSession,
): { OR: Array<{ createdBy: string } | { assignedTo: string }> } | null {
  if (session.role !== "field_staff") return null;
  return { OR: [{ createdBy: session.id }, { assignedTo: session.id }] };
}

/** sortBy / sortOrder から Prisma orderBy を組み立てる。 */
export function buildPropertyListOrderBy(query: PropertyListQuery) {
  // DM送信回数はリレーション件数(PropertyDmLog)で並べ替える(対応する列は無い)。
  if (query.sortBy === "dmSendCount") {
    return { dmLogs: { _count: query.sortOrder } };
  }
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
