import { NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import {
  assertPropertyRecordAccess,
  lockPropertyRecordForWrite,
} from "@/lib/property-record-guard";

const createCommentSchema = z.object({
  body: z.string().min(1, "コメント本文は必須です").max(2000),
  parentId: z.string().uuid().optional().nullable(),
});

// ---------- GET /api/properties/:id/comments ----------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: propertyId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    // ⚠担当者スコープ（認可・PII 横断監査 2026-07-30）。物件本体と同じ可視範囲に
    // 揃える（発注者判断: 担当外に見せてよいのは地図の線・ヒートマップだけ）。
    // コメント本文は自由記述で顧客の話が入るため、担当外には出さない。
    await assertPropertyRecordAccess(propertyId, session, "read");

    // Fetch top-level comments with one level of replies
    const comments = await prisma.comment.findMany({
      where: { propertyId, parentId: null },
      include: {
        author: { select: { id: true, name: true } },
        replies: {
          include: {
            author: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return apiResponse({ data: comments });
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- POST /api/properties/:id/comments ----------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: propertyId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    // ⚠コメントの投稿は**書き込み**なので property:write を要求する
    //（認可・PII 横断監査 2026-07-30。read だけで投稿できていた＝閲覧しか
    // 許していない利用者が物件の記録を書き足せる状態だった）。
    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    // 物件の存在確認（404）と担当者スコープ（403）を兼ねる。
    // 物件本体と同じ可視範囲に揃える（発注者判断 2026-07-30）。
    await assertPropertyRecordAccess(propertyId, session, "write");

    const body = await request.json();
    const data = createCommentSchema.parse(body);

    // If replying, verify parent exists and belongs to same property
    if (data.parentId) {
      const parent = await prisma.comment.findUnique({
        where: { id: data.parentId },
        select: { propertyId: true },
      });
      if (!parent || parent.propertyId !== propertyId) {
        throw new ApiError(404, "返信先のコメントが見つかりません", "NOT_FOUND");
      }
    }

    // ⚠**作成もスコープに対して原子的にする**（@codex #338 R4）。
    // create は where を持てないので、トランザクション内で物件行を
    // FOR UPDATE でロックしてから作る（担当の付け替えを待たせる）。
    // 0 件 = ロック時点で担当外 → 403（コメントを残さない）。
    const comment = await prisma.$transaction(async (tx) => {
      await lockPropertyRecordForWrite(tx, propertyId, session);
      return tx.comment.create({
        data: {
          propertyId,
          authorId: session.id,
          body: data.body,
          parentId: data.parentId ?? null,
        },
        include: {
          author: { select: { id: true, name: true } },
        },
      });
    });

    await writeAuditLog({
      userId: session.id,
      action: "create",
      targetTable: "comments",
      targetId: comment.id,
      detail: { propertyId, parentId: data.parentId ?? null },
    });

    return apiResponse(comment, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
