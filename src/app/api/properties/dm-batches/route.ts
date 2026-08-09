import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
  handleApiError,
  apiResponse,
  ApiError,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { propertyListQuerySchema } from "@/lib/validators";
import {
  buildPropertyListWhere,
  buildPropertyListOrderBy,
} from "@/lib/property-list-query";
import {
  MAX_DM_EXPORT_ROWS,
  isPlainOwnerLevel,
  groupPropertyOwnersByAddress,
  selectGroupRepresentative,
  type DmRowPropertyOwner,
} from "@/lib/dm-export";
import {
  lockOwnersForShare,
  lockPropertiesForShare,
  sortUniqueIds,
  type RawTx,
} from "@/lib/dm-batch/locks";

// ---------- POST /api/properties/dm-batches ----------
//
// 宛名CSV出力の第1段「控えの作成」(設計書 2026-08-08-dm-sending-management-design.md §2.1)。
// 旧 GET /api/properties/dm-export(検索条件から直接CSV)を置き換える2段階フローの POST 側:
//   POST(本 route)= 検索条件を評価して「出力時点の宛先集合」をバッチ+items として保存
//   GET /api/properties/dm-batches/[id]/csv = 保存済み items から CSV を生成して返す
// 副作用(控えの作成)を POST に置くのは CSRF 境界のため(SameSite=Lax のトップレベル GET
// 遷移では最大1万itemの控えを他サイトから積めない)。
//
// 検索条件・強制条件(dmStatus=send / isArchived=false)・上限2段ガード(最終CSV行数=
// 送付先住所グループ数で MAX_DM_EXPORT_ROWS)・グルーピングは旧 export と同一。
// CSVの中身(氏名・住所)は保存しない=控えは propertyId/代表ownerId/共有者連関のみ。
// PropertyDmLog はどの段でも書かない(送付記録は確定 API が作る)。
//
// 冪等化: attemptKey(UIが押下ごとに発行・unique)。同キー再POSTは未確定なら再利用・
// 確定済みなら 409。別の押下は別キー=別の控え(同日2回の意図した郵送を合流させない)。

const AUDIT_FILTER_KEYS = [
  "propertyType",
  "registryStatus",
  "caseStatus",
  "introductionRoute",
  "assignedTo",
  "updatedFrom",
  "updatedTo",
  "includeArchived",
  "hasWarning",
  "dmSentMax",
  "sortBy",
  "sortOrder",
] as const;

const createBatchSchema = z.object({
  filters: z.record(z.string(), z.string()),
  attemptKey: z.string().min(8).max(128),
});

// ---------- GET /api/properties/dm-batches?unconfirmed=1 ----------
//
// 確定モーダル用の一覧(§2.2)。出力日時・件数・作成者名・DL/確定状態のみ返し、宛先(PII)は返さない。
// field_staff は自分が作成した控えのみ。admin/office は全員分(スコープ外 403 で止まった
// field_staff の控えを引き継いで確定する導線)。
// ⚠固定50件の壁を作らない(@codex #364 R2): 0件バッチ(確定しても記録が生まれない)を除外し、
// page パラメータで古い控えにも到達できるようにする(hasMore で続きの有無を返す)。
export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件一覧の閲覧権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(permissions, "csv_export", "read")) {
      throw new ApiError(403, "CSV エクスポートの権限がありません", "FORBIDDEN");
    }
    const { searchParams } = new URL(request.url);
    const unconfirmedOnly = searchParams.get("unconfirmed") === "1";
    const page = Math.max(1, Number(searchParams.get("page")) || 1);
    const PAGE_SIZE = 50;
    const batches = await prisma.dmExportBatch.findMany({
      where: {
        ...(unconfirmedOnly ? { confirmedAt: null, rowCount: { gt: 0 } } : {}),
        ...(session.role === "field_staff" ? { createdBy: session.id } : {}),
      },
      select: {
        id: true,
        createdAt: true,
        rowCount: true,
        downloadedAt: true,
        confirmedAt: true,
        createdBy: true,
        // 作成者名(スタッフ名=非PII・change-logs と同方針)。admin が複数人の控えを
        // 見分けるために必須(@codex #364 R2)。
        creator: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE + 1,
    });
    const hasMore = batches.length > PAGE_SIZE;
    const data = batches.slice(0, PAGE_SIZE).map((b) => ({
      id: b.id,
      createdAt: b.createdAt,
      rowCount: b.rowCount,
      downloadedAt: b.downloadedAt,
      confirmedAt: b.confirmedAt,
      createdBy: b.createdBy,
      creatorName: b.creator?.name ?? "",
    }));
    return apiResponse({ data, page, hasMore });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    // 権限ゲート(旧 export と同一)。欠ける場合は DB 取得・控え作成・AuditLog を一切行わない。
    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件一覧の閲覧権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(permissions, "csv_export", "read")) {
      throw new ApiError(403, "CSV エクスポートの権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(permissions, "csv_export_personal", "read")) {
      throw new ApiError(
        403,
        "個人情報を含む CSV エクスポートの権限がありません",
        "FORBIDDEN",
      );
    }
    if (!hasPermission(permissions, "owner", "read")) {
      throw new ApiError(403, "所有者情報の閲覧権限がありません", "FORBIDDEN");
    }

    const ownerDisplayConfig = await getOwnerDisplayConfig(session.id, permissions);
    if (
      !isPlainOwnerLevel(ownerDisplayConfig.name) ||
      !isPlainOwnerLevel(ownerDisplayConfig.zip) ||
      !isPlainOwnerLevel(ownerDisplayConfig.address)
    ) {
      throw new ApiError(
        403,
        "DM差込CSV出力に必要な所有者情報（氏名・郵便番号・住所）の表示権限がありません",
        "FORBIDDEN",
      );
    }

    const body = createBatchSchema.parse(await request.json());

    // 冪等の速路: 同じ attemptKey の控えが既にあれば再利用/409(レースの最終防衛は
    // 下の tx 内 FOR UPDATE 照会と P2002 catch)。
    // ⚠冪等キーは作成者スコープ(@codex #364 R1): キーだけで引くと他ユーザーの既存キーに
    // 衝突して他人の batchId/件数を返してしまう(本人しかDLできないため出力も壊れる)。
    const preExisting = await prisma.dmExportBatch.findFirst({
      where: { attemptKey: body.attemptKey, createdBy: session.id },
      select: { id: true, rowCount: true, confirmedAt: true },
    });
    if (preExisting) {
      if (preExisting.confirmedAt) {
        throw new ApiError(
          409,
          "この出力は確定済みです。もう一度出力し直してください",
          "ALREADY_CONFIRMED",
        );
      }
      return apiResponse({
        batchId: preExisting.id,
        rowCount: preExisting.rowCount,
        skippedCount: 0,
        skippedAddressMissingCount: 0,
        reused: true,
      });
    }

    // page / limit は無視して全件出力するが、schema は共有のため parse はそのまま通す。
    const query = propertyListQuerySchema.parse(body.filters);
    const { where, mgmtShortCircuitEmpty, mgmtOverflowed } =
      await buildPropertyListWhere(query, session);

    // 管理IDの一致が上限超で切り捨てられているときは出力しない(宛先の取りこぼし防止・旧exportと同一)。
    if (mgmtOverflowed) {
      throw new ApiError(
        400,
        "管理IDに一致する物件が多すぎます（上限10,000件）。管理IDをより具体的に指定するか、他の条件で絞り込んでください。",
        "EXPORT_LIMIT_EXCEEDED",
      );
    }

    // サーバ側で強制: 送付可のみ・アーカイブ除外(クライアント指定は無視)。
    where.dmStatus = "send";
    where.isArchived = false;

    const orderBy = buildPropertyListOrderBy(query);

    // 上限判定は「最終CSV行数=送付先住所グループ数」で2段ガード(旧exportの方式と同一)。
    const eligibleOwnerWhere = { owner: { isArchived: false } };
    const mailableOwnerWhere = {
      owner: { isArchived: false, address: { not: "" } },
    };
    const whereWithMailableOwners = {
      ...where,
      AND: [
        ...(where.AND ?? []),
        { propertyOwners: { some: mailableOwnerWhere } },
      ],
    };

    const properties = mgmtShortCircuitEmpty
      ? []
      : await prisma.property.findMany({
          where: whereWithMailableOwners,
          select: {
            id: true,
            address: true,
            propertyType: true,
            propertyOwners: {
              where: { owner: { isArchived: false } },
              select: {
                isPrimary: true,
                relationship: true,
                owner: {
                  select: {
                    // 控えは owner の id だけを保存する(氏名・住所はCSV生成時に現在値を読む)。
                    id: true,
                    name: true,
                    nameKana: true,
                    zip: true,
                    address: true,
                    corporateNumber: true,
                  },
                },
              },
              orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
            },
          },
          orderBy,
          take: MAX_DM_EXPORT_ROWS + 1,
        });

    if (properties.length > MAX_DM_EXPORT_ROWS) {
      throw new ApiError(
        400,
        "出力対象が上限（10,000件）を超えています。検索条件で絞り込んでください。",
        "EXPORT_LIMIT_EXCEEDED",
      );
    }

    type OwnerWithId = DmRowPropertyOwner & { owner: { id: string } };
    const grouped = properties.map((p) => ({
      property: p,
      ...groupPropertyOwnersByAddress(p.propertyOwners as OwnerWithId[]),
    }));

    let mailablePropertyCount = 0;
    let skippedCount = 0;
    let totalRows = 0;
    for (const g of grouped) {
      if (g.property.propertyOwners.length === 0) {
        skippedCount += 1;
        continue;
      }
      if (g.groups.length === 0) continue;
      mailablePropertyCount += 1;
      totalRows += g.groups.length;
    }

    if (totalRows > MAX_DM_EXPORT_ROWS) {
      throw new ApiError(
        400,
        "出力対象が上限（10,000件）を超えています。検索条件で絞り込んでください。",
        "EXPORT_LIMIT_EXCEEDED",
      );
    }

    // 控えの item を組み立て(1送付先住所グループ=1item)。id はアプリ側で採番し連関に使う。
    const items: Array<{
      id: string;
      propertyId: string;
      ownerId: string;
      groupOwnerIds: string[];
    }> = [];
    for (const g of grouped) {
      for (const group of g.groups) {
        const rep = selectGroupRepresentative(group) as OwnerWithId;
        items.push({
          id: randomUUID(),
          propertyId: g.property.id,
          ownerId: rep.owner.id,
          groupOwnerIds: group.map((po) => (po as OwnerWithId).owner.id),
        });
      }
    }

    // 監査用の filters は allowlist キーのみ(PII を含み得る mgmtId/keyword は保存しない)。
    const filtersForLog: Record<string, string | number | boolean> = {
      dmStatus: "send",
    };
    for (const key of AUDIT_FILTER_KEYS) {
      const value = query[key];
      if (value !== undefined) filtersForLog[key] = value;
    }

    const batchId = randomUUID();
    let excludedTerminalCount = 0;
    let savedRowCount = items.length;
    try {
      await prisma.$transaction(async (tx) => {
        const rawTx = tx as unknown as RawTx;
        // レースの最終防衛: attemptKey を FOR UPDATE で照会(確定APIと行ロックで直列化)。
        // 通常は0行=何もロックしないため、後続の Owner→物件の順序規約と衝突しない。
        const existing = await tx.$queryRaw<
          { id: string; confirmed_at: Date | null }[]
        >`SELECT id, confirmed_at FROM dm_export_batches WHERE attempt_key = ${body.attemptKey} AND created_by = ${session.id}::uuid FOR UPDATE`;
        if (existing.length > 0) {
          // 並行 POST が先に作った: 下の catch と同じ扱いにするため P2002 相当で抜ける。
          throw Object.assign(new Error("attempt_key exists"), {
            code: "P2002_LIKE",
          });
        }
        // 名寄せと直列化して控えを保存する(#364 R7): 無ロックで保存すると、物件読取と
        // INSERT の間に統合が commit した場合に archive 済み所有者の id が控えに入り、
        // DL が恒久的にグループ不一致 409 になる。Owner(FOR SHARE・id順)→物件親行
        // (FOR SHARE・id順)を取ってからリンクを再検証し、変わっていたら 409 で再試行させる。
        await lockOwnersForShare(rawTx, items.flatMap((it) => it.groupOwnerIds));
        await lockPropertiesForShare(rawTx, items.map((it) => it.propertyId));
        const currentLinks = await tx.propertyOwner.findMany({
          where: {
            propertyId: { in: [...new Set(items.map((it) => it.propertyId))] },
            owner: { isArchived: false },
          },
          select: { propertyId: true, ownerId: true },
        });
        const linkSet = new Set(
          currentLinks.map((l) => `${l.propertyId}\u0000${l.ownerId}`),
        );
        const stale = items.some(
          (it) =>
            !it.groupOwnerIds.every((oid) =>
              linkSet.has(`${it.propertyId}\u0000${oid}`),
            ),
        );
        if (stale) {
          throw new ApiError(
            409,
            "宛先の状態が変わりました。もう一度お試しください",
            "RETRY",
          );
        }
        // 拒否・宛先不明(terminal反響)の付いた宛先グループは控え作成時に除外する
        // (@codex #366 R4 P1)。DL時の検査(2)だけだと、拒否(物件の dmStatus を変えない)を
        // 含む検索条件は再出力しても同じ宛先を含み続け、恒久的に 409 で出力不能になる。
        // 所有者横断(代表 owner_id+共有者連関 log_owners の両経路)+所有者紐づけの無い
        // terminal 記録(個別記録の拒否など)は物件単位(#366 R6)。Owner FOR SHARE
        // 保持中に読む=terminal writer(Owner FOR UPDATE)と直列化(R47)。
        const allOwnerIds = sortUniqueIds(items.flatMap((it) => it.groupOwnerIds));
        const allPropertyIds = sortUniqueIds(items.map((it) => it.propertyId));
        const terminalOwnerIds = new Set<string>();
        const terminalPropertyIds = new Set<string>();
        if (allOwnerIds.length > 0 || allPropertyIds.length > 0) {
          const terminalLogs = await tx.propertyDmLog.findMany({
            where: {
              reactionStatus: { in: ["refused", "undeliverable"] },
              OR: [
                { ownerId: { in: allOwnerIds } },
                { logOwners: { some: { ownerId: { in: allOwnerIds } } } },
                {
                  propertyId: { in: allPropertyIds },
                  ownerId: null,
                  logOwners: { none: {} },
                },
              ],
            },
            select: {
              ownerId: true,
              propertyId: true,
              logOwners: { select: { ownerId: true } },
            },
          });
          for (const log of terminalLogs) {
            if (log.ownerId || log.logOwners.length > 0) {
              if (log.ownerId) terminalOwnerIds.add(log.ownerId);
              for (const lo of log.logOwners) terminalOwnerIds.add(lo.ownerId);
            } else if (log.propertyId) {
              terminalPropertyIds.add(log.propertyId);
            }
          }
        }
        const survivingItems = items.filter(
          (it) =>
            !terminalOwnerIds.has(it.ownerId) &&
            !it.groupOwnerIds.some((oid) => terminalOwnerIds.has(oid)) &&
            !terminalPropertyIds.has(it.propertyId),
        );
        excludedTerminalCount = items.length - survivingItems.length;
        savedRowCount = survivingItems.length;

        await tx.dmExportBatch.create({
          data: {
            id: batchId,
            dmType: "owner_address",
            filters: filtersForLog,
            rowCount: survivingItems.length,
            createdBy: session.id,
            attemptKey: body.attemptKey,
          },
        });
        if (survivingItems.length > 0) {
          await tx.dmExportBatchItem.createMany({
            data: survivingItems.map((it, index) => ({
              id: it.id,
              batchId,
              // 検索の並び順を保存(CSV は常にこの順で描画する=#364 R5)。
              position: index,
              propertyId: it.propertyId,
              ownerId: it.ownerId,
            })),
          });
          await tx.dmExportBatchItemOwner.createMany({
            data: survivingItems.flatMap((it) =>
              it.groupOwnerIds.map((ownerId) => ({ itemId: it.id, ownerId })),
            ),
            skipDuplicates: true,
          });
        }
      });
    } catch (e) {
      // unique(attempt_key) 衝突 = 並行 POST の敗者。勝者の控えを取り直して同じ応答にする。
      const code = (e as { code?: string }).code;
      if (code === "P2002" || code === "P2002_LIKE") {
        const winner = await prisma.dmExportBatch.findFirst({
          where: { attemptKey: body.attemptKey, createdBy: session.id },
          select: { id: true, rowCount: true, confirmedAt: true },
        });
        if (winner) {
          if (winner.confirmedAt) {
            throw new ApiError(
              409,
              "この出力は確定済みです。もう一度出力し直してください",
              "ALREADY_CONFIRMED",
            );
          }
          return apiResponse({
            batchId: winner.id,
            rowCount: winner.rowCount,
            skippedCount: 0,
            skippedAddressMissingCount: 0,
            reused: true,
          });
        }
      }
      throw e;
    }

    // 監査用カウント(旧 export と同じ意味・成功確定後のみ実行)。
    let skippedAddressMissingCount = 0;
    if (!mgmtShortCircuitEmpty) {
      skippedCount += await prisma.property.count({
        where: {
          ...where,
          AND: [
            ...(where.AND ?? []),
            { propertyOwners: { none: eligibleOwnerWhere } },
          ],
        },
      });
      skippedAddressMissingCount = await prisma.propertyOwner.count({
        where: {
          owner: { isArchived: false, OR: [{ address: null }, { address: "" }] },
          property: where,
        },
      });
    }

    // 監査は操作事実のみ(検索条件は batch.filters に保存済み・PIIなし)。
    await writeAuditLog({
      userId: session.id,
      action: "dm_batch_create",
      targetTable: "dm_export_batches",
      targetId: batchId,
      detail: {
        batchId,
        count: savedRowCount,
        excludedTerminal: excludedTerminalCount,
        reused: false,
        createdAt: new Date().toISOString(),
      },
    });

    return apiResponse({
      batchId,
      rowCount: savedRowCount,
      skippedCount,
      skippedAddressMissingCount,
      // 拒否・宛先不明の反響で自動除外した宛先数(UI が平易な文言で表示する)
      excludedTerminalCount,
      reused: false,
      mailablePropertyCount,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
