import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";

// 送付確定: 確定済み(confirmed)の下書きを sent にし、既存「送付履歴」(PropertyDmLog)へ
// 1 件記録して既存画面に連携する。冪等(既に sent なら再記録しない)。
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { session, permissions } = await requireSaleDmAccess();
    const { id } = await params;

    const draft = await prisma.dmRecipientDraft.findUnique({
      where: { id },
      select: { id: true, propertyId: true, status: true, campaign: { select: { createdBy: true } }, property: { select: { createdBy: true, assignedTo: true } } },
    });
    // 作成者本人のキャンペーン配下のみ(横断アクセス防止)。not-found/not-owned は同じ 404。
    if (!draft || draft.campaign.createdBy !== session.id) throw new ApiError(404, "下書きが見つかりません", "NOT_FOUND");

    // 送付確定は PropertyDmLog(物件の送付履歴)を作り追跡も有効化するため property:write 必須
    // (outcome/clear-dm-undeliverable と統一)。read/export 系の権限だけでは送付できない。
    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "送付を記録する権限(物件 write)がありません", "FORBIDDEN");
    }
    // field_staff は作成 or 担当の物件のみ操作可(物件APIと同じ record scope)。
    if (
      session.role === "field_staff" &&
      draft.property.createdBy !== session.id &&
      draft.property.assignedTo !== session.id
    ) {
      throw new ApiError(403, "この物件を操作する権限がありません", "FORBIDDEN");
    }

    // 既に送付済みなら何もしない(冪等)。
    if (draft.status === "sent") {
      return NextResponse.json(
        { id, status: "sent", alreadySent: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    // 未確定(draft)からの送付は不可。先に確定(confirm)が必要。
    if (draft.status !== "confirmed") {
      throw new ApiError(409, "確定済みの下書きのみ送付できます", "INVALID_STATE");
    }

    const now = new Date();
    // 状態遷移を condition 付き updateMany(where status=confirmed)でアトミックに行い、
    // 勝った(count===1)リクエストだけが PropertyDmLog を作る。並行 POST が両方とも
    // pre-check(confirmed 読取)を通過しても、二重送付・送付履歴の二重作成を防ぐ。
    const result = await prisma.$transaction(async (tx) => {
      const transitioned = await tx.dmRecipientDraft.updateMany({
        where: { id, status: "confirmed" },
        data: { status: "sent", sentAt: now },
      });
      if (transitioned.count === 0) {
        // confirmed→sent を取れなかった理由は2通り: (a) 他リクエストが先に sent 化済み(=本当に既送)、
        // (b) 並行編集(本文編集/再生成/再割当/型変更)で confirmed→draft へ戻った(=未送付)。
        // count=0 を一律「既送」とすると、未送付なのに sent と誤応答してしまう(PropertyDmLog も無い)。
        // 現在の status を読み直して厳密に判別する。
        const current = await tx.dmRecipientDraft.findUnique({ where: { id }, select: { status: true } });
        return current?.status === "sent" ? "already_sent" : "not_sent";
      }
      // PropertyDmLog.sentAt は @db.Date(日付のみ)。method で売却DM由来と分かるようにする。
      await tx.propertyDmLog.create({
        data: {
          propertyId: draft.propertyId,
          sentAt: now,
          method: "sale_dm",
          sentBy: session.id,
        },
      });
      return "won" as const;
    });

    // 並行編集で確定が解除された(未送付)場合は「送付済み」と誤って返さない。再ログ/再監査もしない。
    if (result === "not_sent") {
      throw new ApiError(409, "この宛先は送付できる状態ではありません(編集等で確定が解除された可能性があります)", "NOT_CONFIRMED");
    }
    // 他リクエストが既に confirmed→sent を確定しログ作成済み。再ログ/再監査せず冪等応答を返す。
    if (result === "already_sent") {
      return NextResponse.json(
        { id, status: "sent", alreadySent: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_draft_mark_sent",
      targetTable: "dm_recipient_drafts",
      targetId: id,
      detail: { propertyId: draft.propertyId, sentAt: now.toISOString() },
    });

    return NextResponse.json(
      { id, status: "sent" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
