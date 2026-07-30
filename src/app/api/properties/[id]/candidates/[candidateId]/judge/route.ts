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
  lockPropertyRecordForWrite,
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
    // ⚠**更新と読み直しは同一トランザクション**（@codex #338 R5）。
    // updateMany の行ロックは文の終わりで解放されるので、分けたままだと同じ候補を
    // 2人が同時に判定したとき、後の判定で上書きされた姿を読んでしまう
    // （応答と監査ログに「same を送ったのに result=different」という食い違いが残る／
    //   相手が消していれば findUniqueOrThrow が 500）。tx 内に置くと後続は
    //   commit まで待たされ、自分の更新後の姿を確実に読める。
    // ⚠これは #328 R3 と同じ結論。CAS を入れたら読み直しも必ず同じ tx に入れる。
    const scope = propertyRecordScopeFilter(session);
    const updated = await prisma.$transaction(async (tx) => {
      // 親の物件行を先にロックする（@codex #338 R7）。リレーション述語だけでは
      // 親行がロックされず、担当の付け替えが文の直後に commit されると通る。
      await lockPropertyRecordForWrite(tx, id, session);
      const applied = await tx.propertyMatchCandidate.updateMany({
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
      return tx.propertyMatchCandidate.findUniqueOrThrow({
        where: { id: candidateId },
      });
    });

    const labels: Record<string, string> = {
      same: "同一物件として記録しました",
      different: "別物件として記録しました",
      pending: "保留にしました",
    };

    // ⚠監査ログは**意図的に tx の外**（@codex #338 R5 への判断）。
    // writeAuditLog は内部で例外を握りつぶす設計（監査の失敗が業務操作を壊さない
    // = audit.ts:29-32）で、リポジトリ全体がこの規約。tx 内に入れると監査の失敗が
    // 判定そのものを rollback してしまい、規約が逆転する。
    // 指摘にあった「judgment=same なのに result=different」の食い違いは、
    // 読み直しを tx 内に入れたこと（= 自分の更新後の姿を読む）で解消済み。
    // 403 の場合は throw が先なので監査行も残らない。
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
