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
import { writeAuditLog } from "@/lib/audit";
import {
  canCreateOwnerMemo,
  resolveOwnerMemoBodyVisibility,
  validateOwnerMemoBody,
  OWNER_MEMO_BODY_MAX_LENGTH,
} from "@/lib/owner-memo";

// ---------------------------------------------------------------------------
// GET /api/owners/:id/memos
// ---------------------------------------------------------------------------
// 権限:
// - owner:read 必須（テーブル単位）。なければ 403。
// - 本文表示は owner_note の displayLevel に従う:
//   - hidden        → memos: [] を返す（UI 破綻を避けるため 403 にしない）
//   - masked/partial → メタ情報のみ返却、body は空文字に伏せる
//   - read/full/edit → 本文そのまま返却
// ---------------------------------------------------------------------------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const owner = await prisma.owner.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!owner) {
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }

    const visibility = resolveOwnerMemoBodyVisibility(perms);

    if (visibility === "hidden") {
      // 本文を読む権限が無い場合は、メタ情報も取得しない（PII 漏えい防止）。
      return apiResponse({ memos: [] });
    }

    const memos = await prisma.ownerMemo.findMany({
      where: { ownerId: id },
      orderBy: { createdAt: "desc" },
      include: {
        creator: { select: { id: true, name: true, email: true } },
      },
    });

    const result = memos.map((m) => ({
      id: m.id,
      ownerId: m.ownerId,
      body: visibility === "visible" ? m.body : "",
      createdAt: m.createdAt,
      creator: m.creator
        ? { id: m.creator.id, name: m.creator.name, email: m.creator.email }
        : null,
    }));

    return apiResponse({ memos: result });
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------------------------------------------------------------------------
// POST /api/owners/:id/memos
// ---------------------------------------------------------------------------
// 権限:
// - owner:write + owner_note の full/edit を要求（field-level write guard と整合）。
// - 拒否時は本文を一切ログ・DB に書かない。
//
// AuditLog:
// - action: "owner_memo_create"
// - detail: { ownerId, memoId, bodyLength }  ※本文は入れない
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    // 権限チェックを body 読込より前に行い、拒否時に本文が到達しないようにする。
    if (!canCreateOwnerMemo(perms)) {
      throw new ApiError(403, "メモを作成する権限がありません", "FORBIDDEN");
    }

    const body = await request.json();
    const validation = validateOwnerMemoBody(body?.body);

    if (!validation.ok) {
      const msg =
        validation.reason === "empty"
          ? "本文を入力してください"
          : `本文は${OWNER_MEMO_BODY_MAX_LENGTH}文字以内で入力してください`;
      throw new ApiError(422, msg, "VALIDATION_ERROR");
    }

    const owner = await prisma.owner.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!owner) {
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }

    const memo = await prisma.ownerMemo.create({
      data: {
        ownerId: id,
        body: validation.body,
        createdBy: session.id,
      },
      include: {
        creator: { select: { id: true, name: true, email: true } },
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "owner_memo_create",
      targetTable: "owner_memos",
      targetId: memo.id,
      detail: {
        ownerId: id,
        memoId: memo.id,
        bodyLength: validation.body.length,
      },
    });

    return apiResponse(
      {
        id: memo.id,
        ownerId: memo.ownerId,
        body: memo.body,
        createdAt: memo.createdAt,
        creator: memo.creator
          ? { id: memo.creator.id, name: memo.creator.name, email: memo.creator.email }
          : null,
      },
      201,
    );
  } catch (error) {
    return handleApiError(error);
  }
}
