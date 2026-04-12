/**
 * Stub Investigation Provider
 *
 * Returns data already stored in the property record.  Used as a fallback
 * when no external API is configured, and as a reference implementation for
 * building real providers.
 *
 * Replace / supplement with real providers that call external APIs:
 *   - 国土数値情報API (zoning, fire prevention, building coverage/FAR)
 *   - 路線価API         (route price)
 *   - 道路台帳API       (road type, road width)
 */

import prisma from "@/lib/prisma";
import type {
  InvestigationProvider,
  InvestigationQuery,
  ProviderResponse,
} from "./types";

export class StubProvider implements InvestigationProvider {
  readonly name = "property-db";
  readonly description = "物件DBの既存データを返すスタブプロバイダ";
  readonly fields = [
    "zoningDistrict",
    "buildingCoverageRatio",
    "floorAreaRatio",
    "heightDistrict",
    "firePreventionZone",
    "scenicRestriction",
    "roadType",
    "roadWidth",
    "frontageWidth",
    "frontageDirection",
    "setbackRequired",
    "rosenkaValue",
    "rosenkaYear",
    "rebuildPermission",
    "architectureNote",
  ] as const;

  async fetch(query: InvestigationQuery): Promise<ProviderResponse> {
    const prop = await prisma.property.findUnique({
      where: { id: query.propertyId },
      select: {
        zoningDistrict: true,
        buildingCoverageRatio: true,
        floorAreaRatio: true,
        heightDistrict: true,
        firePreventionZone: true,
        scenicRestriction: true,
        roadType: true,
        roadWidth: true,
        frontageWidth: true,
        frontageDirection: true,
        setbackRequired: true,
        rosenkaValue: true,
        rosenkaYear: true,
        rebuildPermission: true,
        architectureNote: true,
      },
    });

    if (!prop) {
      throw new Error(`Property ${query.propertyId} not found`);
    }

    // Convert Prisma Decimals to plain numbers and strip nulls
    const data: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(prop)) {
      if (val !== null && val !== undefined) {
        data[key] =
          typeof val === "object" && "toNumber" in val
            ? (val as { toNumber(): number }).toNumber()
            : val;
      }
    }

    return {
      source: "物件DB既存データ",
      data,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
