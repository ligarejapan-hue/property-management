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
import { runInvestigation } from "./index";

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
  liquefactionRiskLevel: string | null;
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
  liquefactionRiskLevel: string | null;
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
    liquefactionRiskLevel: r.liquefactionRiskLevel,
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

  // Build hazard summary (防火 / 洪水 / 高潮 / 津波 / 土砂 / 液状化 の順)
  const hazardParts: string[] = [];
  if (data.firePreventionZone)    hazardParts.push(`防火: ${data.firePreventionZone}`);
  if (data.floodRiskLevel)        hazardParts.push(`洪水: ${data.floodRiskLevel}`);
  if (data.stormSurgeRiskLevel)   hazardParts.push(`高潮: ${data.stormSurgeRiskLevel}`);
  if (data.tsunamiRiskLevel)      hazardParts.push(`津波: ${data.tsunamiRiskLevel}`);
  if (data.sedimentRiskCategory)  hazardParts.push(`土砂: ${data.sedimentRiskCategory}`);
  if (data.liquefactionRiskLevel) hazardParts.push(`液状化: ${data.liquefactionRiskLevel}`);
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

  // 診断ログ: unresolvedKeyValues が DB に到達する直前の状態を記録する。
  // selectionReason が "explicit value not resolved" のエンドポイントのみ出力。
  for (const p of result.providers) {
    if (!p.meta) continue;
    const m = p.meta as Record<string, unknown>;
    for (const [key, label] of [["liquefaction", "XKT025"], ["flood", "XKT026"]] as const) {
      const ep = m[key] as Record<string, unknown> | undefined;
      if (ep?.selectionReason === "explicit value not resolved") {
        console.error(
          `[fetch-investigation] pre-save ${p.name}.${label}` +
          ` | unresolvedKeyValues=${JSON.stringify(ep.unresolvedKeyValues ?? null)}` +
          ` | hasOwn=${Object.prototype.hasOwnProperty.call(ep, "unresolvedKeyValues")}`,
        );
      }
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
        liquefactionRiskLevel: (data.liquefactionRiskLevel as string) ?? null,
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
    liquefactionRiskLevel: string | null;
    nearbyPriceSummary: string | null;
    landPriceSummary: string | null;
    facilitySummary: string | null;
  }>,
  note?: string
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

  const updated = await prisma.propertyInvestigation.update({
    where: { propertyId },
    data: { ...fields, version: { increment: 1 } },
    include: WITH_RELATIONS,
  });

  await prisma.propertyInvestigationAuditLog.create({
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

  return serializeRecord(updated)!;
}

/**
 * Confirm investigation: set status=confirmed, copy data to Property fields,
 * write "confirmed" audit log.
 */
export async function confirmInvestigationRecord(
  propertyId: string,
  userId: string
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

  const updated = await prisma.propertyInvestigation.update({
    where: { propertyId },
    data: {
      status: "confirmed",
      confirmedAt: now,
      confirmedBy: userId,
      version: { increment: 1 },
    },
    include: WITH_RELATIONS,
  });

  // Also write to Property fields for backward compat
  await prisma.property.update({
    where: { id: propertyId },
    data: {
      zoningDistrict: inv.zoningDistrict,
      buildingCoverageRatio: inv.buildingCoverageRatio,
      floorAreaRatio: inv.floorAreaRatio,
      investigationConfirmedAt: now,
      version: { increment: 1 },
    },
  });

  await prisma.propertyInvestigationAuditLog.create({
    data: {
      propertyId,
      investigationId: inv.id,
      action: "confirmed",
      beforeJson: JSON.parse(JSON.stringify({ status: inv.status })),
      afterJson: JSON.parse(JSON.stringify({ status: "confirmed", confirmedAt: now.toISOString() })),
      createdBy: userId,
    },
  });

  return serializeRecord(updated)!;
}
