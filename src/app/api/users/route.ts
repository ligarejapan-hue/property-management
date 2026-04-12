import prisma from "@/lib/prisma";
import {
  getApiSession,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";

// ---------- GET /api/users ----------
// Returns a list of active users (id + name only).
// Used for assignee dropdowns etc.

export async function GET() {
  try {
    await getApiSession();

    const users = await prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true, role: true },
      orderBy: { name: "asc" },
    });

    return apiResponse({ data: users });
  } catch (error) {
    return handleApiError(error);
  }
}
