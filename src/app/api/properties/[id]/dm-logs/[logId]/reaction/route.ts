import { NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission, hasExplicitWritePerm } from "@/lib/permissions";
import {
  assertPropertyRecordAccess,
  lockPropertyRecordForWrite,
} from "@/lib/property-record-guard";
import { writeAuditLog } from "@/lib/audit";
import { isRealCalendarDate } from "@/lib/calendar-date";
import {
  REACTION_STATUSES,
  isTerminalReaction,
  applyManualReaction,
} from "@/lib/dm-reaction/core";
import {
  syncSaleDmReaction,
  SyncOwnerSetChangedError,
  type ReactionSyncTx,
} from "@/lib/dm-reaction/sync";
import {
  reconcileLegacySaleDmLog,
  type LegacyReconcileTx,
} from "@/lib/dm-reaction/reconcile";
import { lockOwnersForUpdate, type RawTx } from "@/lib/dm-batch/locks";

// ---------- PATCH /api/properties/:id/dm-logs/:logId/reaction ----------
//
// 送付記録への手動反響(設計書§3・PR-B)。4種 allowlist(TEXT+アプリ側)。
//   - 認可: property:write + record scope + tx 親行ロック(親→子規約)。
//   - terminal(refused/undeliverable)を書くとき、またはブリッジ行(draftId あり=再導出が
//     terminal を書き得る)は、対象所有者集合(代表+連関全員)を親行より先に FOR UPDATE(R47)。
//   - 手動保存は常に受理(applyManualReaction・shadow クリア)。ブリッジ行は保存直後に
//     同一 tx で syncSaleDmReaction を呼び再導出=draft 側に証拠があれば同期値が優先規則で
//     戻る(手動 no_response で消しても復活する=R32/R40)。
//   - undeliverable 連動(汎用側に複製): 手動で宛先不明になったら dmStatus=no_send +
//     dmUndeliverableAt。宛先不明から訂正したら、残数(宛先不明の他ログ+返送済みの
//     sent ドラフト)ゼロで dmUndeliverableAt=null(dmStatus は人が戻す=clear-dm-undeliverable と同方針)。
//   - 監査 dm_reaction_update {logId,status,reactedAt}(note 本文は載せない)。

const reactionSchema = z.object({
  status: z.enum(REACTION_STATUSES),
  // 形式に加えて実在日を検査(2026-02-31 等は 422。個別記録 POST の sentOn と同型)。
  reactedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isRealCalendarDate, "実在する日付を指定してください")
    .optional(),
  // note は「省略=変更なし」(@codex #366 R2 P1: 履歴 GET は表示レベルでマスクした値を
  // 返すため、フォームがそれを往復させると実メモをマスク値や null で潰す)。
  // 消すときは明示的に null(または空文字)を送る。
  note: z.string().max(500).nullable().optional(),
});

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; logId: string }> },
) {
  try {
    const { id: propertyId, logId } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "反響を記録する権限がありません", "FORBIDDEN");
    }

    const body = reactionSchema.parse(await request.json());

    // 反響メモの変更(上書き・消去)はフィールドレベル権限 owner_note の edit/full が必要
    // (#366 R10)。表示レベルがマスクのユーザーは既存メモを見えないまま破壊できてしまう。
    // note 省略(変更なし)は権限不要=反響種別・日付だけの記録は従来どおり可能。
    if (body.note !== undefined && !hasExplicitWritePerm(permissions, "owner_note")) {
      throw new ApiError(403, "メモを変更する権限がありません", "FORBIDDEN");
    }

    // 未来の反響日は実在しない出来事を作る(個別記録の sentOn と同じ扱いで 400)。
    if (body.reactedAt) {
      const todayJst = new Date(Date.now() + JST_OFFSET_MS)
        .toISOString()
        .slice(0, 10);
      if (body.reactedAt > todayJst) {
        throw new ApiError(
          400,
          "反響日に未来の日付は指定できません",
          "REACTED_AT_IN_FUTURE",
        );
      }
    }

    await assertPropertyRecordAccess(propertyId, session, "write");

    const result = await prisma.$transaction(async (tx) => {
      const rawTx = tx as unknown as RawTx;

      // 先読み(無ロック): ロック対象の所有者集合を知るため(mark-sent と同じ
      // 「先読み→Owner→親→子」の型)。
      const pre = await tx.propertyDmLog.findFirst({
        where: { id: logId, propertyId },
        select: {
          id: true,
          ownerId: true,
          draftId: true,
          method: true,
          logOwners: { select: { ownerId: true } },
        },
      });
      if (!pre) {
        throw new ApiError(404, "送付記録が見つかりません", "NOT_FOUND");
      }

      // 順序規約(R47): Owner(FOR UPDATE・id順)→物件親行→子行。terminal を書くとき、
      // またはブリッジ行/旧 sale_dm 行(再導出・照合が terminal を書き得る)は Owner を
      // 先にロックする。非 terminal の通常行はロック不要(ホットパス維持)。
      const needsOwnerLock =
        isTerminalReaction(body.status) ||
        pre.draftId != null ||
        pre.method === "sale_dm";
      const preOwnerIds = [
        ...(pre.ownerId ? [pre.ownerId] : []),
        ...pre.logOwners.map((o) => o.ownerId),
      ];
      if (needsOwnerLock) {
        await lockOwnersForUpdate(rawTx, preOwnerIds);
      }
      await lockPropertyRecordForWrite(tx, propertyId, session);

      // ロック下で再読取(並行の削除・更新に耐える)。
      const fresh = await tx.propertyDmLog.findFirst({
        where: { id: logId, propertyId },
        select: {
          id: true,
          ownerId: true,
          draftId: true,
          method: true,
          sentAt: true,
          reactionStatus: true,
          reactedAt: true,
          reactionNote: true,
          reactionSource: true,
          manualReactionShadow: true,
          logOwners: { select: { ownerId: true } },
        },
      });
      if (!fresh) {
        throw new ApiError(404, "送付記録が見つかりません", "NOT_FOUND");
      }

      // 先読み→ロックの間に名寄せが所有者を付け替えていたら中止(@codex #366 R2 P1)。
      // ロックしたのは旧所有者で、terminal を書く行は新所有者に付いている=新所有者の
      // 別物件の CSV 出力(Owner FOR SHARE)とすれ違う。中止→再試行で掴み直す
      // (他の DM writer と同じ「先読み→ロック→再読取→不一致中止」の型)。
      if (needsOwnerLock) {
        const lockedSet = new Set(preOwnerIds);
        const freshOwnerIds = [
          ...(fresh.ownerId ? [fresh.ownerId] : []),
          ...fresh.logOwners.map((o) => o.ownerId),
        ];
        if (freshOwnerIds.some((id) => !lockedSet.has(id))) {
          throw new ApiError(
            409,
            "所有者の情報が変わりました。もう一度お試しください",
            "RETRY",
          );
        }
      }
      const prevStatus = fresh.reactionStatus;

      const next = applyManualReaction(fresh, {
        status: body.status,
        // 反響日は暦日入力: sentOn と同じ「UTC暦日=JST暦日」の 00:00Z で保存。
        reactedAt: body.reactedAt
          ? new Date(`${body.reactedAt}T00:00:00Z`)
          : null,
        // 省略=既存メモを保持 / null・空文字=消す / 文字列=上書き。
        note:
          body.note === undefined
            ? fresh.reactionNote
            : body.note?.trim()
              ? body.note.trim()
              : null,
      });
      await tx.propertyDmLog.update({
        where: { id: logId },
        data: {
          reactionStatus: next.reactionStatus,
          reactedAt: next.reactedAt,
          reactionNote: next.reactionNote,
          reactionSource: next.reactionSource,
          // 手動保存は shadow を常にクリア(applyManualReaction の契約)
          manualReactionShadow: Prisma.DbNull,
        },
      });

      // ブリッジ行は保存直後に同一 tx で再導出(draft 側に証拠があれば優先規則で戻る)。
      // 旧 sale_dm 行(draftId なし)は照合の保守的フォールバックを再適用(Task 6 共用)。
      try {
        if (fresh.draftId != null) {
          await syncSaleDmReaction(
            tx as unknown as ReactionSyncTx,
            fresh.draftId,
          );
        } else if (fresh.method === "sale_dm") {
          await reconcileLegacySaleDmLog(tx as unknown as LegacyReconcileTx, {
            id: logId,
            propertyId,
            sentAt: fresh.sentAt,
          });
        }
      } catch (e) {
        // 同期側の所有者集合レース(名寄せ)は 409(再試行)へ変換する。
        if (e instanceof SyncOwnerSetChangedError) {
          throw new ApiError(409, e.message, "RETRY");
        }
        throw e;
      }

      // 物件の宛先不明フラグは「再導出後の最終状態」に連動させる。
      const finalRow = await tx.propertyDmLog.findUnique({
        where: { id: logId },
        select: { reactionStatus: true, reactedAt: true, reactionSource: true },
      });
      const finalStatus = finalRow?.reactionStatus ?? next.reactionStatus;

      let undeliverableLinked = false;
      let undeliverableCleared = false;
      if (finalStatus === "undeliverable" && prevStatus !== "undeliverable") {
        await tx.property.update({
          where: { id: propertyId },
          data: { dmStatus: "no_send", dmUndeliverableAt: new Date() },
        });
        undeliverableLinked = true;
      } else if (
        prevStatus === "undeliverable" &&
        finalStatus !== "undeliverable"
      ) {
        // 残数ゼロなら自動フラグのみ解除(dmStatus は人の判断で戻す)。
        const [logCount, draftCount] = await Promise.all([
          tx.propertyDmLog.count({
            where: {
              propertyId,
              reactionStatus: "undeliverable",
              id: { not: logId },
            },
          }),
          tx.dmRecipientDraft.count({
            where: {
              propertyId,
              status: "sent",
              deliveryStatus: "returned_undeliverable",
            },
          }),
        ]);
        if (logCount + draftCount === 0) {
          await tx.property.update({
            where: { id: propertyId },
            data: { dmUndeliverableAt: null },
          });
          undeliverableCleared = true;
        }
      }

      return {
        reactionStatus: finalStatus,
        reactedAt: finalRow?.reactedAt ?? next.reactedAt,
        reactionSource: finalRow?.reactionSource ?? next.reactionSource,
        undeliverableLinked,
        undeliverableCleared,
      };
    });

    await writeAuditLog({
      userId: session.id,
      action: "dm_reaction_update",
      targetTable: "property_dm_logs",
      targetId: logId,
      detail: {
        logId,
        status: body.status,
        reactedAt: body.reactedAt ?? null,
      },
    });

    return apiResponse({
      id: logId,
      reactionStatus: result.reactionStatus,
      reactedAt: result.reactedAt,
      reactionSource: result.reactionSource,
      undeliverableLinked: result.undeliverableLinked,
      undeliverableCleared: result.undeliverableCleared,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
