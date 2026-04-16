/**
 * fetch-investigation.ts
 *
 * Service layer: runs investigation providers, upserts PropertyInvestigation
 * record, and writes audit log.
 */

import prisma from "@/lib/prisma";
import { runInvestigation } from "./index";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InvestigationRecord {
  id: string;
  propertyId: string;
  status: "draft" | "needs_review" | "confirmed";
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

function serializeRecord(
  raw: Awaited<ReturnType<typeof prisma.propertyInvestigation.findUnique>>
): InvestigationRecord | null {
  if (!raw) return null;
  return {
    id: raw.id,
    propertyId: raw.propertyId,
    status: raw.status as "draft" | "needs_review" | "confirmed",
    sourceAddress: raw.sourceAddress,
    normalizedAddress: raw.normalizedAddress,
    landLotNumber: raw.landLotNumber,
    latitude: raw.latitude != null ? Number(raw.latitude) : null,
    longitude: raw.longitude != null ? Number(raw.longitude) : null,
    zoningDistrict: raw.zoningDistrict,
    buildingCoverageRatio: raw.buildingCoverageRatio != null ? Number(raw.buildingCoverageRatio) : null,
    floorAreaRatio: raw.floorAreaRatio != null ? Number(raw.floorAreaRatio) : null,
    hazardSummary: raw.hazardSummary,
    roadSummary: raw.roadSummary,
    infrastructureSummary: raw.infrastructureSummary,
    autoFetchSummary: raw.autoFetchSummary,
    sourceSummary: raw.sourceSummary,
    fetchedAt: raw.fetchedAt?.toISOString() ?? null,
    confirmedAt: raw.confirmedAt?.toISOString() ?? null,
    confirmedBy: (raw as unknown as { confirmer?: { id: string; name: string } | null }).confirmer ?? null,
    version: raw.version,
    createdAt: raw.createdAt.toISOString(),
    updatedAt: raw.updatedAt.toISOString(),
    auditLogs: ((raw as unknown as { auditLogs?: unknown[] }).auditLogs ?? []).map((log) => {
      const l = log as {
        id: string;
        action: string;
        note: string | null;
        creator: { id: string; name: string };
        createdAt: Date;
      };
      return {
        id: l.id,
        action: l.action,
        note: l.note,
        creator: l.creator,
        createdAt: l.createdAt.toISOString(),
      };
    }),
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
 * Run investigation providers, upsert record (status→needs_review),
 * write fetch audit log. Returns the updated record.
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
  // Run providers
  const result = await runInvestigation({
    propertyId,
    address: context.address,
    lotNumber: context.lotNumber,
    gpsLat: context.gpsLat,
    gpsLng: context.gpsLng,
    targetYear: context.targetYear,
  });

  const data = result.data;
  const now = new Date();

  const autoFetchSummary = result.providers
    .map((p) => `${p.name}: ${p.status}${p.error ? ` (${p.error})` : ""}`)
    .join("\n");

  const sourceSummary = result.providers
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

  // Build hazard summary
  const hazardParts: string[] = [];
  if (data.firePreventionZone) hazardParts.push(`防火: ${data.firePreventionZone}`);
  if (data.scenicRestriction) hazardParts.push(`景観: ${data.scenicRestriction}`);
  const hazardSummary = hazardParts.length > 0 ? hazardParts.join(" / ") : null;

  const upsertData = {
    status: "needs_review" as const,
    sourceAddress: context.address,
    latitude: context.gpsLat != null ? context.gpsLat : null,
    longitude: context.gpsLng != null ? context.gpsLng : null,
    zoningDistrict: (data.zoningDistrict as string) ?? null,
    buildingCoverageRatio: toDecimal(data.buildingCoverageRatio),
    floorAreaRatio: toDecimal(data.floorAreaRatio),
    hazardSummary,
    roadSummary,
    autoFetchSummary,
    sourceSummary,
    fetchedAt: now,
  };

  // Get current record for audit before_json
  const existing = await prisma.propertyInvestigation.findUnique({
    where: { propertyId },
    select: { id: true, status: true, zoningDistrict: true, buildingCoverageRatio: true, floorAreaRatio: true },
  });

  const inv = await prisma.propertyInvestigation.upsert({
    where: { propertyId },
    create: { propertyId, ...upsertData },
    update: { ...upsertData, version: { increment: 1 } },
    include: WITH_RELATIONS,
  });

  // Write audit log
  await prisma.propertyInvestigationAuditLog.create({
    data: {
      propertyId,
      investigationId: inv.id,
      action: "fetch",
      beforeJson: existing ? JSON.parse(JSON.stringify(existing)) : null,
      afterJson: JSON.parse(JSON.stringify({ ...upsertData, _providers: result.providers })),
      createdBy: userId,
    },
  });

  return serializeRecord(inv)!;
}

/**
 * Patch investigation fields (user edits). Writes edit audit log.
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
      action: "edit",
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
 * write confirm audit log.
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

  // Update investigation status
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
      action: "confirm",
      beforeJson: JSON.parse(JSON.stringify({ status: inv.status })),
      afterJson: JSON.parse(JSON.stringify({ status: "confirmed", confirmedAt: now.toISOString() })),
      createdBy: userId,
    },
  });

  return serializeRecord(updated)!;
}
