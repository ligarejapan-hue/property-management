import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  handleApiError,
  apiResponse,
  ApiError,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { runInvestigation } from "@/lib/investigation";

// ---------- GET /api/properties/[id]/investigation ----------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件閲覧の権限がありません", "FORBIDDEN");
    }

    // Get the latest investigation log
    const latestLog = await prisma.propertyInvestigationLog.findFirst({
      where: { propertyId: id },
      orderBy: { fetchedAt: "desc" },
      include: {
        fetcher: { select: { id: true, name: true } },
      },
    });

    if (!latestLog) {
      return apiResponse({
        status: "idle",
        fetchedAt: null,
        data: {},
        source: "",
      });
    }

    return apiResponse({
      status: latestLog.status === "success" ? "done" : "failed",
      fetchedAt: latestLog.fetchedAt.toISOString(),
      data: latestLog.data,
      source: latestLog.source,
      manuallyEdited: latestLog.manuallyEdited,
      fetchedBy: latestLog.fetcher,
      errorMessage:
        latestLog.status === "failed"
          ? ((latestLog.data as Record<string, unknown>)?.errorMessage as
              | string
              | undefined) ?? "取得に失敗しました"
          : undefined,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- POST /api/properties/[id]/investigation ----------
// Trigger a new investigation via registered providers.

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "物件編集の権限がありません", "FORBIDDEN");
    }

    // Verify property exists and get context for providers
    const property = await prisma.property.findUnique({
      where: { id },
      select: {
        id: true,
        address: true,
        lotNumber: true,
        gpsLat: true,
        gpsLng: true,
      },
    });

    if (!property) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }

    // Parse optional targetYear from request body
    let targetYear: number | undefined;
    try {
      const body = await request.json();
      if (body?.targetYear) targetYear = Number(body.targetYear);
    } catch {
      // Empty body is fine
    }

    // Run all registered investigation providers
    const result = await runInvestigation({
      propertyId: id,
      address: property.address,
      lotNumber: property.lotNumber,
      gpsLat: property.gpsLat ? Number(property.gpsLat) : null,
      gpsLng: property.gpsLng ? Number(property.gpsLng) : null,
      targetYear,
    });

    // Determine overall status for the log record
    const logStatus = result.status === "failed" ? "failed" : "success";

    // Build source label from provider names
    const sourceLabel = result.providers
      .filter((p) => p.status === "success")
      .map((p) => p.source)
      .join(", ");

    // Create investigation log
    const log = await prisma.propertyInvestigationLog.create({
      data: {
        propertyId: id,
        source: sourceLabel || "取得失敗",
        fetchedAt: new Date(result.fetchedAt),
        fetchedBy: session.id,
        status: logStatus,
        targetYear,
        data: JSON.parse(
          JSON.stringify({
            ...result.data,
            _providers: result.providers,
          }),
        ),
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "investigation_trigger",
      targetTable: "property_investigation_logs",
      targetId: log.id,
      detail: {
        propertyId: id,
        providers: result.providers.map((p) => ({
          name: p.name,
          status: p.status,
        })),
        overallStatus: result.status,
      },
    });

    return apiResponse({
      status: logStatus === "success" ? "done" : "failed",
      fetchedAt: log.fetchedAt.toISOString(),
      data: result.data,
      source: sourceLabel,
      providers: result.providers,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
