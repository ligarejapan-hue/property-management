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

// ---------- GET /api/properties/search?q=keyword ----------
// Lightweight search for linking import rows to existing properties.

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
    if (q.length < 2) {
      return apiResponse({ data: [] });
    }

    const properties = await prisma.property.findMany({
      where: {
        OR: [
          { address: { contains: q, mode: "insensitive" } },
          { lotNumber: { contains: q, mode: "insensitive" } },
          { realEstateNumber: { contains: q, mode: "insensitive" } },
          { externalLinkKey: { contains: q, mode: "insensitive" } },
        ],
      },
      select: {
        id: true,
        address: true,
        lotNumber: true,
        realEstateNumber: true,
        propertyType: true,
        externalLinkKey: true,
      },
      take: 10,
      orderBy: { updatedAt: "desc" },
    });

    return apiResponse({ data: properties });
  } catch (error) {
    return handleApiError(error);
  }
}
