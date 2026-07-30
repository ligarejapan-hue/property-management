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
import {
  assertPropertyRecordAccess,
  propertyRecordScopeFilter,
} from "@/lib/property-record-guard";

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

    // ⚠担当者スコープ（認可・PII 横断監査 2026-07-30）。物件本体と同じ可視範囲に
    // 揃える（発注者判断: 担当外に見せてよいのは地図の線・ヒートマップだけ）。
    await assertPropertyRecordAccess(id, session, "write");

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
    // ⚠**スコープを更新文に畳み込んで原子化する**（@codex #338 R3）。
    // 上のガードは受付時点の判定なので、判定から更新までに担当が外れると
    // 担当外の物件の重複判定が残る。候補は2物件(A/B)を参照するが、
    // スコープが効くのは**URL パスの物件 (id)**。A 側/B 側どちらが id かは
    // 上で検証済みなので、その側のリレーションにスコープを掛ける。
    // 0 件 = その間に担当が外れた → 403。
    const scope = propertyRecordScopeFilter(session);
    const applied = await prisma.propertyMatchCandidate.updateMany({
      where: {
        id: candidateId,
        ...(scope
          ? {
              OR: [
                { propertyAId: id, propertyA: scope },
                { propertyBId: id, propertyB: scope },
              ],
            }
          : {}),
      },
      data: {
        result,
        judgedBy: session.id,
        judgedAt: new Date(),
      },
    });
    if (applied.count === 0) {
      throw new ApiError(
        403,
        "この物件を操作する権限がありません",
        "FORBIDDEN",
      );
    }
    const updated = await prisma.propertyMatchCandidate.findUniqueOrThrow({
      where: { id: candidateId },
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
