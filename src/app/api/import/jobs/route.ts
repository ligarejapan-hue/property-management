import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";

// ---------- GET /api/import/jobs ----------

export async function GET() {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const jobs = await prisma.importJob.findMany({
      include: {
        executor: { select: { id: true, name: true } },
        _count: { select: { rows: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return apiResponse({ data: jobs });
  } catch (error) {
    return handleApiError(error);
  }
}
