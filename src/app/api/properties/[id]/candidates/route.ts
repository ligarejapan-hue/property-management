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
import {
  haversineDistance,
  getCandidateStrength,
  CANDIDATE_THRESHOLDS,
} from "@/lib/geo";
import {
  normalizeAddress,
  normalizeLotNumber,
  normalizeRealEstateNumber,
  similarityScore,
} from "@/lib/address-normalizer";

interface CandidateResult {
  id: string;
  address: string;
  lotNumber: string | null;
  realEstateNumber: string | null;
  propertyType: string;
  caseStatus: string;
  distance: number | null;
  strength: string;
  matchType: "gps" | "address" | "lot_number" | "real_estate_number";
  similarity: number;
}

// ---------- GET /api/properties/:id/candidates ----------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const property = await prisma.property.findUnique({
      where: { id },
      select: {
        id: true,
        address: true,
        lotNumber: true,
        realEstateNumber: true,
        gpsLat: true,
        gpsLng: true,
      },
    });

    if (!property) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }

    const candidateMap = new Map<string, CandidateResult>();

    // --- Strategy 1: GPS proximity ---
    if (property.gpsLat != null && property.gpsLng != null) {
      const baseLat = Number(property.gpsLat);
      const baseLng = Number(property.gpsLng);
      const latDelta = 0.0005;
      const lngDelta = 0.0006;

      const nearby = await prisma.property.findMany({
        where: {
          id: { not: id },
          isArchived: false,
          gpsLat: { gte: baseLat - latDelta, lte: baseLat + latDelta },
          gpsLng: { gte: baseLng - lngDelta, lte: baseLng + lngDelta },
        },
        select: {
          id: true,
          address: true,
          lotNumber: true,
          realEstateNumber: true,
          propertyType: true,
          caseStatus: true,
          gpsLat: true,
          gpsLng: true,
        },
      });

      for (const p of nearby) {
        if (p.gpsLat == null || p.gpsLng == null) continue;
        const distance = haversineDistance(
          baseLat,
          baseLng,
          Number(p.gpsLat),
          Number(p.gpsLng),
        );
        const strength = getCandidateStrength(distance);
        if (strength) {
          candidateMap.set(p.id, {
            id: p.id,
            address: p.address,
            lotNumber: p.lotNumber,
            realEstateNumber: p.realEstateNumber,
            propertyType: p.propertyType,
            caseStatus: p.caseStatus,
            distance: Math.round(distance * 10) / 10,
            strength,
            matchType: "gps",
            similarity: 1 - distance / CANDIDATE_THRESHOLDS.weak,
          });
        }
      }
    }

    // --- Strategy 2: Normalized address similarity ---
    const normalizedAddr = normalizeAddress(property.address);
    // Extract the block-level prefix for DB filtering (first ~10 chars)
    const addrPrefix = property.address.slice(0, 10);

    if (addrPrefix.length >= 4) {
      const addrMatches = await prisma.property.findMany({
        where: {
          id: { not: id },
          isArchived: false,
          address: { contains: addrPrefix },
        },
        select: {
          id: true,
          address: true,
          lotNumber: true,
          realEstateNumber: true,
          propertyType: true,
          caseStatus: true,
        },
        take: 20,
      });

      for (const p of addrMatches) {
        if (candidateMap.has(p.id)) continue;
        const normP = normalizeAddress(p.address);
        const score = similarityScore(normalizedAddr, normP);
        if (score >= 0.7) {
          candidateMap.set(p.id, {
            id: p.id,
            address: p.address,
            lotNumber: p.lotNumber,
            realEstateNumber: p.realEstateNumber,
            propertyType: p.propertyType,
            caseStatus: p.caseStatus,
            distance: null,
            strength: score >= 0.9 ? "strong" : score >= 0.8 ? "medium" : "weak",
            matchType: "address",
            similarity: score,
          });
        }
      }
    }

    // --- Strategy 3: Lot number matching ---
    if (property.lotNumber) {
      const normalizedLot = normalizeLotNumber(property.lotNumber);
      const lotMatches = await prisma.property.findMany({
        where: {
          id: { not: id },
          isArchived: false,
          lotNumber: { not: null },
        },
        select: {
          id: true,
          address: true,
          lotNumber: true,
          realEstateNumber: true,
          propertyType: true,
          caseStatus: true,
        },
        take: 50,
      });

      for (const p of lotMatches) {
        if (candidateMap.has(p.id) || !p.lotNumber) continue;
        const normPLot = normalizeLotNumber(p.lotNumber);
        if (normalizedLot === normPLot) {
          candidateMap.set(p.id, {
            id: p.id,
            address: p.address,
            lotNumber: p.lotNumber,
            realEstateNumber: p.realEstateNumber,
            propertyType: p.propertyType,
            caseStatus: p.caseStatus,
            distance: null,
            strength: "strong",
            matchType: "lot_number",
            similarity: 1,
          });
        }
      }
    }

    // --- Strategy 4: Real estate number matching ---
    if (property.realEstateNumber) {
      const normalizedNum = normalizeRealEstateNumber(
        property.realEstateNumber,
      );
      const reMatches = await prisma.property.findMany({
        where: {
          id: { not: id },
          isArchived: false,
          realEstateNumber: { not: null },
        },
        select: {
          id: true,
          address: true,
          lotNumber: true,
          realEstateNumber: true,
          propertyType: true,
          caseStatus: true,
        },
        take: 50,
      });

      for (const p of reMatches) {
        if (candidateMap.has(p.id) || !p.realEstateNumber) continue;
        const normPNum = normalizeRealEstateNumber(p.realEstateNumber);
        if (normalizedNum === normPNum) {
          candidateMap.set(p.id, {
            id: p.id,
            address: p.address,
            lotNumber: p.lotNumber,
            realEstateNumber: p.realEstateNumber,
            propertyType: p.propertyType,
            caseStatus: p.caseStatus,
            distance: null,
            strength: "strong",
            matchType: "real_estate_number",
            similarity: 1,
          });
        }
      }
    }

    // Sort: strong > medium > weak, then by similarity desc
    const strengthOrder = { strong: 0, medium: 1, weak: 2 };
    const candidates = Array.from(candidateMap.values()).sort((a, b) => {
      const sDiff =
        (strengthOrder[a.strength as keyof typeof strengthOrder] ?? 2) -
        (strengthOrder[b.strength as keyof typeof strengthOrder] ?? 2);
      if (sDiff !== 0) return sDiff;
      return b.similarity - a.similarity;
    });

    return apiResponse({
      data: candidates,
      thresholds: CANDIDATE_THRESHOLDS,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
