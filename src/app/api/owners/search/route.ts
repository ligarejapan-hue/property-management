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

// ---------- GET /api/owners/search?q=keyword ----------
// Lightweight search for linking import rows to existing owners.

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
    if (q.length < 1) {
      return apiResponse({ data: [] });
    }

    const owners = await prisma.owner.findMany({
      where: {
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { nameKana: { contains: q, mode: "insensitive" } },
          { phone: { contains: q, mode: "insensitive" } },
          { address: { contains: q, mode: "insensitive" } },
          { externalLinkKey: { contains: q, mode: "insensitive" } },
        ],
      },
      select: {
        id: true,
        name: true,
        nameKana: true,
        phone: true,
        address: true,
        externalLinkKey: true,
      },
      take: 10,
      orderBy: { updatedAt: "desc" },
    });

    return apiResponse({ data: owners });
  } catch (error) {
    return handleApiError(error);
  }
}
