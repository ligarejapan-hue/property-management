import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess, filterDraftsByFieldStaffScope } from "@/lib/sale-dm-letter/route-guard";
import { startInquiryNotify, NOTIFY_STALE_CLAIM_MS } from "@/lib/sale-dm-letter/inquiry-notify";

// 通知の再送(設計 §2.6・発注者判断 2026-09-18)。門は閲覧権限(requireSaleDmAccess)だけで足りる
// (再送が書き換えるのは notify* の通知状態列だけで、対応状況の変更のような業務データは書かない)。
// キャンペーン作成者の縛りは申込については外す方針のため、ここでも campaign.createdBy は見ない
// (inquiries/[inquiryId]/route.ts の PATCH とはこの1点だけ異なる)。field_staff は物件の
// 担当範囲(作成 or 担当)のみ。通知は物件配下を書き換えないので物件ロックは取らない。
//
// ⚠whole-branch review Important #1: "sending" のまま固まった行はどの画面からも直せなかった。
// notifyInquiry の in-process リトライは最長約12.5分しか生きず、デプロイのたびに起きるサーバー
// 再起動で即座に打ち切られる。残った行は "sending" のままで、15分の保有期限切れによる
// 自己修復は「誰かがもう一度 notifyInquiry を呼ぶ」ことが前提だが、その入口はこの再送 route
// しかない。なので failed / pending に加えて、保有(notifyClaimedAt)が
// NOTIFY_STALE_CLAIM_MS より古い "sending" も再送可能にする。保有がまだ新しい(いままさに
// 送信中の)"sending" は引き続き 409 で弾く(その場合はメッセージだけ変える)。
// 実際に送ってよいかの権威は notifyInquiry 内の atomic な claim(updateMany)で、ここでの
// 判定はあくまで「呼んでよさそうか」のヒント。判定がすり抜けて競合しても、notifyInquiry 側が
// 0件更新で "skipped" になるだけで安全(二重送信にはならない)。
export async function POST(_request: NextRequest, { params }: { params: Promise<{ inquiryId: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { inquiryId } = await params;

    const found = await prisma.dmInquiry.findUnique({
      where: { id: inquiryId },
      select: {
        id: true,
        notifyStatus: true,
        notifyClaimedAt: true,
        draft: { select: { property: { select: { createdBy: true, assignedTo: true } } } },
      },
    });
    if (!found || filterDraftsByFieldStaffScope([{ property: found.draft.property }], session).length === 0) {
      throw new ApiError(404, "申込が見つかりません", "NOT_FOUND");
    }

    const staleSending =
      found.notifyStatus === "sending" &&
      found.notifyClaimedAt !== null &&
      Date.now() - found.notifyClaimedAt.getTime() >= NOTIFY_STALE_CLAIM_MS;
    const resendable = found.notifyStatus === "failed" || found.notifyStatus === "pending" || staleSending;
    if (!resendable) {
      if (found.notifyStatus === "sending") {
        throw new ApiError(409, "現在通知メールを送信中です。しばらくしてからお試しください", "NOT_FAILED");
      }
      throw new ApiError(409, "失敗した通知のみ再送できます", "NOT_FAILED");
    }

    startInquiryNotify(found.id);
    return NextResponse.json({ data: { started: true } }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
