import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";
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
import { canAccessPropertyRecord } from "@/lib/property-access";
import {
  lockOwnersForShare,
  lockPropertiesForUpdate,
  type RawTx,
} from "@/lib/dm-batch/locks";
import {
  readItemsWithOwners,
  itemSetKey,
  collectOwnerIds,
  collectPropertyIds,
  type BatchItemTxLike,
} from "@/lib/dm-batch/items";

// ---------- POST /api/properties/dm-batches/[id]/confirm ----------
//
// 送付確定(一括)(設計書§2.2)。投函が済んだ控えに投函日を入れ、items から
// PropertyDmLog を生成する。確定は「実際に出力した相手にだけ」= downloadedAt 必須。
//
// - sentOn は「初回DL(downloadedAt)の JST 暦日以降〜今日以前」のみ受理(R36/R40→R51:
//   下限を作成日にすると 8/1 作成・8/8 DL の控えに 8/1 を書けて記録が7日分古くなる)。
// - 確定者: admin/office は誰の控えでも確定可(field_staff がスコープ外 403 で止まった
//   控えを引き継ぐ導線)。field_staff は自分が作成した控えのみ(他人の控えは 404)。
// - スコープ外 item が1件でもあれば 403 で全体拒否(スキップ確定は送付記録の永久欠落を生む)。
// - 冪等: confirmedAt=null の条件付き updateMany の勝者だけがログを生成。二重確定は 409。
// - ロック順序は全ロール統一「Owner(FOR SHARE)→物件親行(FOR UPDATE)→バッチ行→items
//   再読取(不一致中止)→INSERT」(R49: admin を INSERT のみにすると物件ハード削除と
//   逆順ロックになりデッドロックする)。
// - 生成行: propertyId(削除済みは null)/ownerId(代表・DL後削除は null)/dmType=owner_address/
//   batchId/sentAt=sentOn(UTC 00:00=JST暦日)/method=mail。共有者連関は property_dm_log_owners へコピー。

const confirmSchema = z.object({
  sentOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function toJstDateString(d: Date): string {
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: batchId } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    // 閲覧系4権限(既存 export と同一)+書込は property:write(mark-sent/outcome と同じ統一方針)。
    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件一覧の閲覧権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(permissions, "csv_export", "read")) {
      throw new ApiError(403, "CSV エクスポートの権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(permissions, "csv_export_personal", "read")) {
      throw new ApiError(
        403,
        "個人情報を含む CSV エクスポートの権限がありません",
        "FORBIDDEN",
      );
    }
    if (!hasPermission(permissions, "owner", "read")) {
      throw new ApiError(403, "所有者情報の閲覧権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "送付記録を確定する権限がありません", "FORBIDDEN");
    }

    const body = confirmSchema.parse(await request.json());

    const batch = await prisma.dmExportBatch.findUnique({
      where: { id: batchId },
      select: {
        id: true,
        createdBy: true,
        downloadedAt: true,
        confirmedAt: true,
      },
    });
    if (!batch) {
      throw new ApiError(404, "出力の控えが見つかりません", "NOT_FOUND");
    }
    // field_staff は自分の控えのみ(存在も漏らさない)。admin/office は引き継ぎ確定可。
    if (session.role === "field_staff" && batch.createdBy !== session.id) {
      throw new ApiError(404, "出力の控えが見つかりません", "NOT_FOUND");
    }
    if (batch.confirmedAt) {
      throw new ApiError(409, "この控えは確定済みです", "ALREADY_CONFIRMED");
    }
    if (!batch.downloadedAt) {
      throw new ApiError(
        409,
        "先にCSVを出力してください(ダウンロードしていない控えは確定できません)",
        "NOT_DOWNLOADED",
      );
    }

    // sentOn は初回DLの JST 暦日〜今日(JST)の範囲のみ(郵送は CSV 入手より前には起きない)。
    const dlDayJst = toJstDateString(batch.downloadedAt);
    const todayJst = toJstDateString(new Date());
    if (body.sentOn < dlDayJst) {
      throw new ApiError(
        400,
        `投函日はCSVを出力した日(${dlDayJst})以降を指定してください`,
        "SENT_ON_BEFORE_DOWNLOAD",
      );
    }
    if (body.sentOn > todayJst) {
      throw new ApiError(
        400,
        "投函日に未来の日付は指定できません",
        "SENT_ON_IN_FUTURE",
      );
    }

    const confirmed = await prisma.$transaction(async (tx) => {
      const rawTx = tx as unknown as RawTx;
      const itemsTx = tx as unknown as BatchItemTxLike;

      // 先読み(ロックなし)→ Owner→物件親行(FOR UPDATE)→バッチ行→items の順(§2.2/R49)。
      const pre = await readItemsWithOwners(itemsTx, batchId);
      await lockOwnersForShare(rawTx, collectOwnerIds(pre));
      await lockPropertiesForUpdate(rawTx, collectPropertyIds(pre));

      // 条件付き updateMany の勝者だけが記録を作る(バッチ行ロックを兼ねる)。
      const won = await tx.dmExportBatch.updateMany({
        where: { id: batchId, confirmedAt: null },
        data: {
          confirmedAt: new Date(),
          confirmedBy: session.id,
          // sentOn は UTC 00:00 の Date = @db.Date に「UTC暦日=JST暦日」で保存
          // (mark-sent の +9h 規約と同じ暦日基準)。
          sentOn: new Date(`${body.sentOn}T00:00:00Z`),
        },
      });
      if (won.count === 0) {
        throw new ApiError(409, "この控えは確定済みです", "ALREADY_CONFIRMED");
      }

      // items を行ロックして再読取(名寄せ・物件削除とのレースを閉じる)。
      await rawTx.$queryRaw`SELECT id FROM dm_export_batch_items WHERE batch_id = ${batchId}::uuid FOR UPDATE`;
      const items = await readItemsWithOwners(itemsTx, batchId);
      if (itemSetKey(pre) !== itemSetKey(items)) {
        throw new ApiError(
          409,
          "宛先の状態が変わりました。もう一度お試しください",
          "RETRY",
        );
      }

      // field_staff は親行ロック保持中にスコープを再検証(FOR KEY SHARE は担当替えと
      // 衝突しない=TOCTOU 防止・R4)。1件でもスコープ外なら全体を拒否(R3)。
      if (session.role === "field_staff") {
        const propIds = collectPropertyIds(items);
        const props = await tx.property.findMany({
          where: { id: { in: propIds } },
          select: { id: true, createdBy: true, assignedTo: true },
        });
        const propMap = new Map(props.map((p) => [p.id, p]));
        const outOfScope = items.filter((it) => {
          if (it.propertyId == null) return false;
          const p = propMap.get(it.propertyId);
          return !p || !canAccessPropertyRecord(session, p);
        }).length;
        if (outOfScope > 0) {
          throw new ApiError(
            403,
            `担当外の宛先が ${outOfScope} 件あります。管理者または事務担当で確定してください`,
            "FORBIDDEN",
          );
        }
      }

      // 記録の生成。DL後に owner/物件が消えた item も「手紙は出ている」ので
      // null のまま記録する(R42/R49。連関は残っている分をコピー=所有者横断の除外が効く)。
      const sentAtDate = new Date(`${body.sentOn}T00:00:00Z`);
      const logs = items.map((it) => ({
        id: randomUUID(),
        propertyId: it.propertyId,
        ownerId: it.ownerId,
        dmType: "owner_address",
        batchId,
        draftId: null,
        sentAt: sentAtDate,
        method: "mail",
        sentBy: session.id,
      }));
      if (logs.length > 0) {
        await tx.propertyDmLog.createMany({ data: logs });
        const linkRows = items.flatMap((it, i) =>
          it.groupOwnerIds.map((ownerId) => ({ logId: logs[i].id, ownerId })),
        );
        if (linkRows.length > 0) {
          await tx.propertyDmLogOwner.createMany({
            data: linkRows,
            skipDuplicates: true,
          });
        }
      }
      return logs.length;
    });

    await writeAuditLog({
      userId: session.id,
      action: "dm_sent_confirm",
      targetTable: "dm_export_batches",
      targetId: batchId,
      detail: { batchId, count: confirmed, sentOn: body.sentOn },
    });

    return apiResponse({ confirmed });
  } catch (error) {
    return handleApiError(error);
  }
}
