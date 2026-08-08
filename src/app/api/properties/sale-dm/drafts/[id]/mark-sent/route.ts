import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { lockOwnersForShare, type RawTx } from "@/lib/dm-batch/locks";

// 送付確定: 確定済み(confirmed)の下書きを sent にし、既存「送付履歴」(PropertyDmLog)へ
// 1 件記録して既存画面に連携する。冪等(既に sent なら再記録しない)。
//
// PR-A(送付記録・設計書§2.2)でブリッジを拡張:
//  - ログに ownerId(代表)+draftId を書き、下書きの共有者グループ全員を
//    property_dm_log_owners へコピーする(反響の所有者横断除外の土台)。
//  - tx は共通ロック順序「先読み→Owner(FOR SHARE・id順)→物件親行(FOR UPDATE)→
//    条件付き updateMany(draft ロック)→draft 再読取→所有者不一致なら中止」に従う。
//    親行ロックの省略は不可(R50: 物件ハード削除は親行を保持して draft へ降りてくるため、
//    draft ロック→ログ INSERT の FK 待ちと相互待ちでデッドロックする)。
//  - コピー元は tx 内で勝者決定後に再読取した値(R13: tx 前スナップショットだと並行する
//    名寄せ後に archive 済み所有者の id でログを作ってしまう)。
//  - 連関が空の旧 draft は補完せず代表のみで記録(R34)。監査 detail に legacyGroup を残す。
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
    // PropertyDmLog.sentAt は @db.Date(日付のみ)。Prisma は Date をオフセット無しの
    // UTC 壁時計で送るため、DATE 列は **UTC の暦日**に切られる。素の now を渡すと
    // JST 0〜9時の送付確定(例: JST 7/30 08:00 = UTC 7/29 23:00)が前日 7/29 として
    // 記録され、送付履歴の表示もそのまま前日になる。+9h 平行移動して
    // UTC 暦日 = JST 暦日 に揃える(既存規約: property-list-query.ts の
    // jstDayBoundary / coverage cells の「UTC として解釈してから JST へ」と同じ
    // JST 暦日基準)。draft.sentAt(素の DateTime=瞬間)と監査ログは実時刻のまま。
    const sentOnJst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    // 状態遷移を condition 付き updateMany(where status=confirmed)でアトミックに行い、
    // 勝った(count===1)リクエストだけが PropertyDmLog を作る。並行 POST が両方とも
    // pre-check(confirmed 読取)を通過しても、二重送付・送付履歴の二重作成を防ぐ。
    const result = await prisma.$transaction(async (tx) => {
      const rawTx = tx as unknown as RawTx;
      // 先読み(ロックなし): ロック対象の所有者集合(代表+連関全員)を列挙する。
      const pre = await tx.dmRecipientDraft.findUnique({
        where: { id },
        select: {
          representativeOwnerId: true,
          propertyId: true,
          draftOwners: { select: { ownerId: true } },
        },
      });
      if (!pre) return "not_sent" as const;
      const preOwners = [
        ...(pre.representativeOwnerId ? [pre.representativeOwnerId] : []),
        ...pre.draftOwners.map((o) => o.ownerId),
      ];
      // 順序規約: Owner(FOR SHARE・id順)→物件親行(FOR UPDATE)→子行(draft/log)。
      await lockOwnersForShare(rawTx, preOwners);
      await rawTx.$queryRaw`SELECT id FROM properties WHERE id = ${pre.propertyId}::uuid FOR UPDATE`;
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
      // 勝者決定後に再読取した値でログを作る(R13)。所有者集合が先読みと違えば中止
      // (並行する名寄せがロック前に付け替えを終えていた場合。ロック順序があるため稀)。
      const fresh = await tx.dmRecipientDraft.findUnique({
        where: { id },
        select: {
          representativeOwnerId: true,
          propertyId: true,
          draftOwners: { select: { ownerId: true } },
        },
      });
      const freshOwners = [
        ...(fresh?.representativeOwnerId ? [fresh.representativeOwnerId] : []),
        ...(fresh?.draftOwners.map((o) => o.ownerId) ?? []),
      ];
      if (
        !fresh ||
        JSON.stringify([...new Set(preOwners)].sort()) !==
          JSON.stringify([...new Set(freshOwners)].sort())
      ) {
        throw new ApiError(
          409,
          "宛先の所有者情報が変わりました。もう一度お試しください",
          "RETRY",
        );
      }
      // PropertyDmLog.sentAt は @db.Date(日付のみ)。method で売却DM由来と分かるようにする。
      // ownerId(代表)+draftId をブリッジとして残す(dmType はブリッジ行なので null)。
      const logId = randomUUID();
      await tx.propertyDmLog.create({
        data: {
          id: logId,
          propertyId: fresh.propertyId,
          ownerId: fresh.representativeOwnerId,
          dmType: null,
          batchId: null,
          draftId: id,
          sentAt: sentOnJst,
          method: "sale_dm",
          sentBy: session.id,
        },
      });
      // 共有者グループ全員を連関へコピー。連関が空の旧 draft は代表のみ(補完しない=R34)。
      const group = fresh.draftOwners.map((o) => o.ownerId);
      const linkTargets =
        group.length > 0
          ? group
          : fresh.representativeOwnerId
            ? [fresh.representativeOwnerId]
            : [];
      if (linkTargets.length > 0) {
        await tx.propertyDmLogOwner.createMany({
          data: linkTargets.map((ownerId) => ({ logId, ownerId })),
          skipDuplicates: true,
        });
      }
      return group.length > 0 ? ("won" as const) : ("won_legacy" as const);
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
      detail: {
        propertyId: draft.propertyId,
        sentAt: now.toISOString(),
        // 旧 draft(共有者連関なし)は代表のみで記録した事実を残す(R34)。
        legacyGroup: result === "won_legacy",
      },
    });

    return NextResponse.json(
      { id, status: "sent" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
