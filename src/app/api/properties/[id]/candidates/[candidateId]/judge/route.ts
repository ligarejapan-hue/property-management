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

// Map UI judgment values to DB enum
const judgmentToResult: Record<string, "related" | "different" | "pending"> = {
  same: "related",
  different: "different",
  pending: "pending",
};

// ---------- POST /api/properties/[id]/candidates/[candidateId]/judge ----------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; candidateId: string }> },
) {
  try {
    const { id, candidateId } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "物件編集の権限がありません", "FORBIDDEN");
    }

    const body = await request.json();
    const judgment = body.judgment as string;

    const result = judgmentToResult[judgment];
    if (!result) {
      throw new ApiError(400, "不正な判定値です", "INVALID_JUDGMENT");
    }

    // Verify candidate exists and belongs to this property
    const candidate = await prisma.propertyMatchCandidate.findUnique({
      where: { id: candidateId },
    });

    if (!candidate) {
      throw new ApiError(404, "候補が見つかりません", "NOT_FOUND");
    }

    if (candidate.propertyAId !== id && candidate.propertyBId !== id) {
      throw new ApiError(400, "この物件の候補ではありません", "INVALID_CANDIDATE");
    }

    // Update judgment
    const updated = await prisma.propertyMatchCandidate.update({
      where: { id: candidateId },
      data: {
        result,
        judgedBy: session.id,
        judgedAt: new Date(),
      },
    });

    const labels: Record<string, string> = {
      same: "同一物件として記録しました",
      different: "別物件として記録しました",
      pending: "保留にしました",
    };

    await writeAuditLog({
      userId: session.id,
      action: "candidate_judge",
      targetTable: "property_match_candidates",
      targetId: candidateId,
      detail: { propertyId: id, judgment, result: updated.result },
    });

    return apiResponse({ message: labels[judgment] ?? "記録しました", candidate: updated });
  } catch (error) {
    return handleApiError(error);
  }
}
