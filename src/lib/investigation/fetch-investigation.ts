/**
 * fetch-investigation.ts
 *
 * Service layer: runs investigation providers, upserts PropertyInvestigation
 * record, and writes audit log.
 *
 * Audit action names:
 *   fetch_requested  – 取得開始 (status→fetching)
 *   fetch_succeeded  – 取得成功 (status→needs_review)
 *   fetch_failed     – 取得失敗 (status→failed)
 *   updated          – 手動編集
 *   confirmed        – 確認済み設定
 *   reopened         – 再オープン
 */

import prisma from "@/lib/prisma";
import { ApiError } from "@/lib/api-helpers";
import type { PropertyRecordScope } from "@/lib/property-record-guard";
import { runInvestigation } from "./index";

/**
 * 担当者スコープを**書き込み文自体に畳み込む**ための共通処理（@codex #338 P2）。
 * 呼び出し側のガードは受付時点の判定なので、判定から書込までの間に担当が
 * 付け替わると担当外の物件へ編集が残る。0 件更新 = その間に外れた → 403。
 *
 * scope が undefined（admin / office_staff）のときは条件を積まない。
 */
function assertScopedWrite(count: number): void {
  if (count === 0) {
    throw new ApiError(
      403,
      "この物件を操作する権限がありません",
      "FORBIDDEN",
    );
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InvestigationStatus = "draft" | "fetching" | "needs_review" | "confirmed" | "failed";

export interface InvestigationRecord {
  id: string;
  propertyId: string;
  status: InvestigationStatus;
  sourceAddress: string | null;
  normalizedAddress: string | null;
  landLotNumber: string | null;
  latitude: number | null;
  longitude: number | null;
  zoningDistrict: string | null;
  buildingCoverageRatio: number | null;
  floorAreaRatio: number | null;
  hazardSummary: string | null;
  roadSummary: string | null;
  infrastructureSummary: string | null;
  autoFetchSummary: string | null;
  sourceSummary: string | null;
  // 住所正規化
  postalCode: string | null;
  municipalityCode: string | null;
  geocodePrecision: string | null;
  // 規制
  firePreventionArea: string | null;
  heightDistrict: string | null;
  // ハザード詳細（reinfolib XKT系 個別フィールド）
  floodRiskLevel: string | null;
  stormSurgeRiskLevel: string | null;
  tsunamiRiskLevel: string | null;
  sedimentRiskCategory: string | null;
  // 価格・周辺情報
  nearbyPriceSummary: string | null;
  landPriceSummary: string | null;
  facilitySummary: string | null;
  // 生データ・出典・エラー
  fieldSourcesJson: Record<string, unknown> | null;
  rawPayloadJson: Record<string, unknown> | null;
  lastFetchError: string | null;
  fetchVersion: number;
  fetchedAt: string | null;
  confirmedAt: string | null;
  confirmedBy: { id: string; name: string } | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  auditLogs: AuditLogEntry[];
}

export interface AuditLogEntry {
  id: string;
  action: string;
  note: string | null;
  creator: { id: string; name: string };
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDecimal(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

type RawInvestigation = {
  id: string;
  propertyId: string;
  status: string;
  sourceAddress: string | null;
  normalizedAddress: string | null;
  landLotNumber: string | null;
  latitude: unknown;
  longitude: unknown;
  zoningDistrict: string | null;
  buildingCoverageRatio: unknown;
  floorAreaRatio: unknown;
  hazardSummary: string | null;
  roadSummary: string | null;
  infrastructureSummary: string | null;
  autoFetchSummary: string | null;
  sourceSummary: string | null;
  postalCode: string | null;
  municipalityCode: string | null;
  geocodePrecision: string | null;
  firePreventionArea: string | null;
  heightDistrict: string | null;
  floodRiskLevel: string | null;
  stormSurgeRiskLevel: string | null;
  tsunamiRiskLevel: string | null;
  sedimentRiskCategory: string | null;
  nearbyPriceSummary: string | null;
  landPriceSummary: string | null;
  facilitySummary: string | null;
  fieldSourcesJson: unknown;
  rawPayloadJson: unknown;
  lastFetchError: string | null;
  fetchVersion: number;
  fetchedAt: Date | null;
  confirmedAt: Date | null;
  confirmedBy: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  confirmer?: { id: string; name: string } | null;
  auditLogs?: Array<{
    id: string;
    action: string;
    note: string | null;
    creator: { id: string; name: string };
    createdAt: Date;
  }>;
};

function serializeRecord(raw: unknown): InvestigationRecord | null {
  if (!raw) return null;
  const r = raw as RawInvestigation;
  return {
    id: r.id,
    propertyId: r.propertyId,
    status: r.status as InvestigationStatus,
    sourceAddress: r.sourceAddress,
    normalizedAddress: r.normalizedAddress,
    landLotNumber: r.landLotNumber,
    latitude: r.latitude != null ? Number(r.latitude) : null,
    longitude: r.longitude != null ? Number(r.longitude) : null,
    zoningDistrict: r.zoningDistrict,
    buildingCoverageRatio: toDecimal(r.buildingCoverageRatio),
    floorAreaRatio: toDecimal(r.floorAreaRatio),
    hazardSummary: r.hazardSummary,
    roadSummary: r.roadSummary,
    infrastructureSummary: r.infrastructureSummary,
    autoFetchSummary: r.autoFetchSummary,
    sourceSummary: r.sourceSummary,
    postalCode: r.postalCode,
    municipalityCode: r.municipalityCode,
    geocodePrecision: r.geocodePrecision,
    firePreventionArea: r.firePreventionArea,
    heightDistrict: r.heightDistrict,
    floodRiskLevel: r.floodRiskLevel,
    stormSurgeRiskLevel: r.stormSurgeRiskLevel,
    tsunamiRiskLevel: r.tsunamiRiskLevel,
    sedimentRiskCategory: r.sedimentRiskCategory,
    nearbyPriceSummary: r.nearbyPriceSummary,
    landPriceSummary: r.landPriceSummary,
    facilitySummary: r.facilitySummary,
    fieldSourcesJson: r.fieldSourcesJson != null ? (r.fieldSourcesJson as Record<string, unknown>) : null,
    rawPayloadJson: r.rawPayloadJson != null ? (r.rawPayloadJson as Record<string, unknown>) : null,
    lastFetchError: r.lastFetchError,
    fetchVersion: r.fetchVersion,
    fetchedAt: r.fetchedAt?.toISOString() ?? null,
    confirmedAt: r.confirmedAt?.toISOString() ?? null,
    confirmedBy: r.confirmer ?? null,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    auditLogs: (r.auditLogs ?? []).map((l) => ({
      id: l.id,
      action: l.action,
      note: l.note,
      creator: l.creator,
      createdAt: l.createdAt.toISOString(),
    })),
  };
}

const WITH_RELATIONS = {
  confirmer: { select: { id: true, name: true } },
  auditLogs: {
    orderBy: { createdAt: "desc" as const },
    take: 30,
    include: { creator: { select: { id: true, name: true } } },
  },
} as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Get existing investigation record, or null if not yet created. */
export async function getInvestigation(propertyId: string): Promise<InvestigationRecord | null> {
  const raw = await prisma.propertyInvestigation.findUnique({
    where: { propertyId },
    include: WITH_RELATIONS,
  });
  return serializeRecord(raw);
}

/**
 * Run investigation providers, upsert record, write audit logs.
 *
 * Lifecycle:
 *   1. Upsert → status=fetching + audit: fetch_requested
 *   2. runInvestigation (providers, server-side)
 *   3a. Success → update → status=needs_review + audit: fetch_succeeded
 *   3b. Failure → update → status=failed   + audit: fetch_failed
 *
 * ⚠**取得の結果保存には担当者スコープを畳み込まない = 途中の担当変更でも
 * スコープで破棄しない**（@codex #338 R2 に対する設計判断）。
 * 呼び出し元 (investigation/fetch route) が**送信前に**担当者スコープで弾いており、
 * ここに来るのは認可された利用者が開始した取得だけ。外部呼び出しには数秒かかるため
 * その間の担当変更で結果を捨てると、課金した取得が無駄になり status が fetching の
 * まま残る（利用者の直接編集 = patchInvestigation / confirmInvestigationRecord は
 * 結果が編集として残るため、あちらは updateMany + 0件403 で原子化してある）。
 */
export async function runAndUpsertInvestigation(
  propertyId: string,
  userId: string,
  context: {
    address: string;
    lotNumber: string | null;
    gpsLat: number | null;
    gpsLng: number | null;
    targetYear?: number;
  }
): Promise<InvestigationRecord> {
  // ---- Step 1: set status=fetching ----------------------------------------
  const { invId, beforeStatus } = await prisma.$transaction(async (tx) => {
    const existing = await tx.propertyInvestigation.findUnique({
      where: { propertyId },
      select: { id: true, status: true },
    });

    const inv = await tx.propertyInvestigation.upsert({
      where: { propertyId },
      create: {
        propertyId,
        status: "fetching",
        sourceAddress: context.address,
        lastFetchError: null,
      },
      update: {
        status: "fetching",
        sourceAddress: context.address,
        lastFetchError: null,
        version: { increment: 1 },
      },
      select: { id: true },
    });

    await tx.propertyInvestigationAuditLog.create({
      data: {
        propertyId,
        investigationId: inv.id,
        action: "fetch_requested",
        beforeJson: existing ? { status: existing.status } : undefined,
        afterJson: { status: "fetching", address: context.address },
        createdBy: userId,
      },
    });

    return { invId: inv.id, beforeStatus: existing?.status ?? null };
  });

  // ---- Step 2: run providers (outside transaction) -------------------------
  let result: Awaited<ReturnType<typeof runInvestigation>>;
  try {
    result = await runInvestigation({
      propertyId,
      address: context.address,
      lotNumber: context.lotNumber,
      gpsLat: context.gpsLat,
      gpsLng: context.gpsLng,
      targetYear: context.targetYear,
    });
  } catch (err) {
    // ---- Step 3a: failure path --------------------------------------------
    const errMsg = err instanceof Error ? err.message : String(err);
    await prisma.$transaction(async (tx) => {
      await tx.propertyInvestigation.update({
        where: { propertyId },
        data: {
          status: "failed",
          lastFetchError: errMsg,
          fetchedAt: new Date(),
          version: { increment: 1 },
        },
      });
      await tx.propertyInvestigationAuditLog.create({
        data: {
          propertyId,
          investigationId: invId,
          action: "fetch_failed",
          beforeJson: { status: "fetching" },
          afterJson: { status: "failed", error: errMsg },
          createdBy: userId,
        },
      });
    });
    throw err;
  }

  // ---- Step 3b: success path -----------------------------------------------
  const data = result.data;
  const now = new Date();

  const autoFetchSummary = result.providers
    .map((p) => `${p.name}: ${p.status}${p.error ? ` (${p.error})` : ""}`)
    .join("\n");

  const sourceSummary =
    result.providers
      .filter((p) => p.status === "success")
      .map((p) => p.source)
      .filter(Boolean)
      .join(", ") || null;

  // Build road summary from structured fields
  const roadParts: string[] = [];
  if (data.roadType) roadParts.push(`種別: ${data.roadType}`);
  if (data.roadWidth != null) roadParts.push(`幅員: ${data.roadWidth}m`);
  if (data.frontageWidth != null) roadParts.push(`間口: ${data.frontageWidth}m`);
  if (data.frontageDirection) roadParts.push(`方角: ${data.frontageDirection}`);
  const roadSummary = roadParts.length > 0 ? roadParts.join(" / ") : null;

  // Build hazard summary (防火 / 洪水 / 高潮 / 津波 / 土砂 の順)
  const hazardParts: string[] = [];
  if (data.firePreventionZone)    hazardParts.push(`防火: ${data.firePreventionZone}`);
  if (data.floodRiskLevel)        hazardParts.push(`洪水: ${data.floodRiskLevel}`);
  if (data.stormSurgeRiskLevel)   hazardParts.push(`高潮: ${data.stormSurgeRiskLevel}`);
  if (data.tsunamiRiskLevel)      hazardParts.push(`津波: ${data.tsunamiRiskLevel}`);
  if (data.sedimentRiskCategory)  hazardParts.push(`土砂: ${data.sedimentRiskCategory}`);
  if (data.scenicRestriction)     hazardParts.push(`景観: ${data.scenicRestriction}`);
  const hazardSummary = hazardParts.length > 0 ? hazardParts.join(" / ") : null;

  // Build field sources map (field→source)
  const fieldSourcesJson: Record<string, string> = {};
  for (const p of result.providers) {
    if (p.status === "success") {
      for (const f of p.fields) {
        fieldSourcesJson[f] = p.source;
      }
    }
  }

  // Geocoding 結果をプロバイダの meta から取得（reinfolib 等がセットする）
  let geocodedLat: number | null = null;
  let geocodedLng: number | null = null;
  let geocodedAddress: string | null = null;
  for (const p of result.providers) {
    if (p.status === "success" && p.meta) {
      if (typeof p.meta.geocodedLat === "number") geocodedLat = p.meta.geocodedLat;
      if (typeof p.meta.geocodedLng === "number") geocodedLng = p.meta.geocodedLng;
      if (typeof p.meta.normalizedAddress === "string") geocodedAddress = p.meta.normalizedAddress;
    }
  }

  // 診断ログ: reinfolib の flood が unresolved のとき JSON.stringify 直前の状態を出力。
  for (const p of result.providers) {
    if (p.name !== "reinfolib" || !p.meta) continue;
    const m = p.meta as Record<string, unknown>;
    for (const key of ["flood"]) {
      const ep = m[key] as Record<string, unknown> | undefined;
      if (!ep || ep.selectionReason !== "explicit value not resolved") continue;
      console.error(
        `[fi] ${key} hasKV=${Object.prototype.hasOwnProperty.call(ep, "unresolvedKeyValues")} kv=${JSON.stringify(ep.unresolvedKeyValues ?? null)}`,
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const rawPayloadJson = JSON.parse(JSON.stringify(result));

  const inv = await prisma.$transaction(async (tx) => {
    const updated = await tx.propertyInvestigation.update({
      where: { propertyId },
      data: {
        status: "needs_review",
        latitude: context.gpsLat ?? geocodedLat ?? null,
        longitude: context.gpsLng ?? geocodedLng ?? null,
        normalizedAddress: geocodedAddress ?? undefined,
        zoningDistrict: (data.zoningDistrict as string) ?? null,
        buildingCoverageRatio: toDecimal(data.buildingCoverageRatio),
        floorAreaRatio: toDecimal(data.floorAreaRatio),
        firePreventionArea: (data.firePreventionZone as string) ?? null,
        heightDistrict: (data.heightDistrict as string) ?? null,
        floodRiskLevel: (data.floodRiskLevel as string) ?? null,
        stormSurgeRiskLevel: (data.stormSurgeRiskLevel as string) ?? null,
        tsunamiRiskLevel: (data.tsunamiRiskLevel as string) ?? null,
        sedimentRiskCategory: (data.sedimentRiskCategory as string) ?? null,
        hazardSummary,
        roadSummary,
        autoFetchSummary,
        sourceSummary,
        fieldSourcesJson,
        rawPayloadJson,
        lastFetchError: null,
        fetchedAt: now,
        fetchVersion: { increment: 1 },
        version: { increment: 1 },
      },
      include: WITH_RELATIONS,
    });

    await tx.propertyInvestigationAuditLog.create({
      data: {
        propertyId,
        investigationId: updated.id,
        action: "fetch_succeeded",
        beforeJson: { status: beforeStatus },
        afterJson: {
          status: "needs_review",
          providers: result.providers.map((p) => ({ name: p.name, status: p.status })),
        },
        createdBy: userId,
      },
    });

    return updated;
  });

  return serializeRecord(inv)!;
}

/**
 * Patch investigation fields (user edits). Writes "updated" audit log.
 * Returns updated record.
 */
export async function patchInvestigation(
  propertyId: string,
  userId: string,
  fields: Partial<{
    zoningDistrict: string | null;
    buildingCoverageRatio: number | null;
    floorAreaRatio: number | null;
    hazardSummary: string | null;
    roadSummary: string | null;
    infrastructureSummary: string | null;
    sourceSummary: string | null;
    normalizedAddress: string | null;
    landLotNumber: string | null;
    latitude: number | null;
    longitude: number | null;
    postalCode: string | null;
    municipalityCode: string | null;
    geocodePrecision: string | null;
    firePreventionArea: string | null;
    heightDistrict: string | null;
    floodRiskLevel: string | null;
    stormSurgeRiskLevel: string | null;
    tsunamiRiskLevel: string | null;
    sedimentRiskCategory: string | null;
    nearbyPriceSummary: string | null;
    landPriceSummary: string | null;
    facilitySummary: string | null;
  }>,
  note?: string,
  /**
   * 担当者スコープ述語（field_staff のみ渡る）。更新文の where に畳み込んで
   * 原子化する（@codex #338 P2）。undefined なら条件を積まない。
   */
  scope?: PropertyRecordScope,
): Promise<InvestigationRecord> {
  const existing = await prisma.propertyInvestigation.findUnique({
    where: { propertyId },
    select: {
      id: true, status: true, zoningDistrict: true,
      buildingCoverageRatio: true, floorAreaRatio: true,
      hazardSummary: true, roadSummary: true, infrastructureSummary: true,
      sourceSummary: true, normalizedAddress: true, landLotNumber: true,
      latitude: true, longitude: true,
      postalCode: true, municipalityCode: true, geocodePrecision: true,
      firePreventionArea: true, heightDistrict: true,
      nearbyPriceSummary: true, landPriceSummary: true, facilitySummary: true,
    },
  });

  if (!existing) {
    throw new Error("調査レコードが存在しません。先に調査情報を取得してください。");
  }

  // ⚠スコープを更新文に畳み込んで原子化する（@codex #338 P2）。
  // 0 件 = 判定から書込までの間に担当が外れた → 403（編集を残さない）。
  // ⚠更新と監査ログは1トランザクション（@codex #338 R3・confirm と同じ理由）。
  // 分けると「編集は残ったが監査が無い」中途状態が作れる。
  const updated = await prisma.$transaction(async (tx) => {
    const applied = await tx.propertyInvestigation.updateMany({
      where: { propertyId, ...(scope ? { property: scope } : {}) },
      data: { ...fields, version: { increment: 1 } },
    });
    assertScopedWrite(applied.count);

    await tx.propertyInvestigationAuditLog.create({
      data: {
        propertyId,
        investigationId: existing.id,
        action: "updated",
        beforeJson: JSON.parse(JSON.stringify(existing)),
        afterJson: JSON.parse(JSON.stringify(fields)),
        note: note ?? null,
        createdBy: userId,
      },
    });

    // 応答用の読み直しも同一 tx 内（自分の更新後の姿を返す）。
    return tx.propertyInvestigation.findUniqueOrThrow({
      where: { propertyId },
      include: WITH_RELATIONS,
    });
  });

  return serializeRecord(updated)!;
}

/**
 * Confirm investigation: set status=confirmed, copy data to Property fields,
 * write "confirmed" audit log.
 */
export async function confirmInvestigationRecord(
  propertyId: string,
  userId: string,
  /** 担当者スコープ述語（field_staff のみ渡る・@codex #338 P2）。 */
  scope?: PropertyRecordScope,
): Promise<InvestigationRecord> {
  const inv = await prisma.propertyInvestigation.findUnique({
    where: { propertyId },
    select: {
      id: true, status: true,
      zoningDistrict: true, buildingCoverageRatio: true, floorAreaRatio: true,
    },
  });

  if (!inv) {
    throw new Error("調査レコードが存在しません");
  }

  const now = new Date();

  // ⚠スコープを更新文に畳み込んで原子化する（@codex #338 P2）。
  // confirm は**物件本体にも書き戻す**ので、判定から書込までに担当が外れると
  // 担当外の物件の用途地域・建蔽率まで書き換わる。0 件なら 403 で何も残さない。
  //
  // ⚠**3つの書き込みを1トランザクションで包む**（@codex #338 R3）。分けたままだと
  // 「調査は confirmed になったが、物件へのコピーが 403 で止まり監査も無い」という
  // 中途状態が残る（2文に分けたこと自体が持ち込んだ退行）。0 件拒否が「何も残さない」
  // と言えるようにするには、拒否の throw で全体が rollback される必要がある。
  const updated = await prisma.$transaction(async (tx) => {
    const applied = await tx.propertyInvestigation.updateMany({
      where: { propertyId, ...(scope ? { property: scope } : {}) },
      data: {
        status: "confirmed",
        confirmedAt: now,
        confirmedBy: userId,
        version: { increment: 1 },
      },
    });
    assertScopedWrite(applied.count);

    // Also write to Property fields for backward compat
    // （こちらもスコープ付き。同じ不変条件を2文で担保する＝片方だけ守る形を残さない）
    const propApplied = await tx.property.updateMany({
      where: { id: propertyId, ...(scope ? scope : {}) },
      data: {
        zoningDistrict: inv.zoningDistrict,
        buildingCoverageRatio: inv.buildingCoverageRatio,
        floorAreaRatio: inv.floorAreaRatio,
        investigationConfirmedAt: now,
        version: { increment: 1 },
      },
    });
    assertScopedWrite(propApplied.count);

    await tx.propertyInvestigationAuditLog.create({
      data: {
        propertyId,
        investigationId: inv.id,
        action: "confirmed",
        beforeJson: JSON.parse(JSON.stringify({ status: inv.status })),
        afterJson: JSON.parse(JSON.stringify({ status: "confirmed", confirmedAt: now.toISOString() })),
        createdBy: userId,
      },
    });

    // 応答用の読み直しも同一 tx 内（自分の更新後の姿を返す）。
    return tx.propertyInvestigation.findUniqueOrThrow({
      where: { propertyId },
      include: WITH_RELATIONS,
    });
  });

  return serializeRecord(updated)!;
}
