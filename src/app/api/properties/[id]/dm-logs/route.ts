import { NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission, maskValue } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import {
  assertPropertyRecordAccess,
  lockPropertyRecordForWrite,
} from "@/lib/property-record-guard";
import { writeAuditLog } from "@/lib/audit";

// ---------- GET / POST /api/properties/:id/dm-logs ----------
//
// GET: 物件の DM 送付履歴（PropertyDmLog）を返す（B-3 PR-1）。
//   - 認可: property:read + owner:read（DM 送付は所有者宛のため owner:read も要求）。
//     いずれか欠ける場合は 403 とし、DB 取得・AuditLog 書き込みを一切行わない。
//   - PII: note は所有者備考と同じ表示レベル（owner_note → ownerDisplayConfig.note）で
//     server-side マスクする（生値はクライアントに返さない）。
//   - 送信者名（staff）・method・日付は PII ではないため素表示（change-logs の changer.name と同方針）。
//   - 非PII の AuditLog（件数・閲覧時刻のみ。note 本文・送信者名・owner 由来キーは残さない）。
//
// POST: 手渡し等の1件記録(設計書§2.3・PR-A)。
//   - 認可: property:write + record scope。tx は lockPropertyRecordForWrite で始める(親→子規約)。
//   - sentOn は過去日可・今日(JST)以前のみ。method は allowlist(mail/hand_delivery/other)。
//   - 個別記録は ownerId/dmType を持たない(null)=所有者宛バッチとは区別される。
//   - 監査 dm_sent_record {propertyId, sentOn}(note 本文は載せない)。

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: propertyId } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    // 権限ゲート。欠ける場合は DB 取得・AuditLog を行わず 403。
    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件情報の閲覧権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(permissions, "owner", "read")) {
      throw new ApiError(403, "所有者情報の閲覧権限がありません", "FORBIDDEN");
    }

    // レコード単位のアクセス制御（物件詳細 API GET /api/properties/[id] と同方針）。
    // field_staff は createdBy / assignedTo の物件のみ閲覧可。propertyId だけで DM 履歴を
    // 引けると担当外物件の送付履歴（および note）が読めてしまうため、ログ取得・監査の前に弾く。
    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true, createdBy: true, assignedTo: true },
    });
    if (!property) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }
    if (!canAccessPropertyRecord(session, property)) {
      throw new ApiError(403, "この物件を閲覧する権限がありません", "FORBIDDEN");
    }

    // note のマスクに使う表示レベル（owner_note）。取得済み permissions を再利用して二重解決を避ける。
    const ownerDisplayConfig = await getOwnerDisplayConfig(session.id, permissions);

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, Number(searchParams.get("page")) || 1);
    const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit")) || 50));

    const where = { propertyId };

    const [logs, total] = await Promise.all([
      prisma.propertyDmLog.findMany({
        where,
        select: {
          id: true,
          sentAt: true,
          method: true,
          note: true,
          createdAt: true,
          sender: { select: { id: true, name: true } },
        },
        orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.propertyDmLog.count({ where }),
    ]);

    // note は所有者備考と同じ表示レベルで server-side マスク（生値を返さない）。
    const data = logs.map((log) => ({
      id: log.id,
      // sentAt は @db.Date（日付のみ）。UTC 基準の YYYY-MM-DD 文字列で返し、
      // クライアントでの TZ 依存の日付ずれ（負オフセットで前日表示）を防ぐ。
      sentAt: log.sentAt.toISOString().slice(0, 10),
      method: log.method,
      note: maskValue(log.note, ownerDisplayConfig.note),
      sentBy: { id: log.sender.id, name: log.sender.name },
      createdAt: log.createdAt,
    }));

    // 非PII の操作監査（note 本文・送信者名などの PII は残さない）。
    await writeAuditLog({
      userId: session.id,
      action: "property_dm_log_view",
      targetTable: "property_dm_logs",
      targetId: propertyId,
      detail: {
        count: data.length,
        total,
        page,
        viewedAt: new Date().toISOString(),
      },
    });

    return apiResponse({
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const createLogSchema = z.object({
  sentOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  method: z.enum(["mail", "hand_delivery", "other"]).optional(),
  note: z.string().max(500).optional(),
});

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: propertyId } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    // 書込は property:write(mark-sent/outcome/一括確定と同じ統一方針・新slugなし)。
    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "送付記録を追加する権限がありません", "FORBIDDEN");
    }

    const body = createLogSchema.parse(await request.json());

    // 過去日可・今日(JST)以前のみ(未来の投函は実在しない送付を作る)。
    const todayJst = new Date(Date.now() + JST_OFFSET_MS)
      .toISOString()
      .slice(0, 10);
    if (body.sentOn > todayJst) {
      throw new ApiError(
        400,
        "投函日に未来の日付は指定できません",
        "SENT_ON_IN_FUTURE",
      );
    }

    // 404/403 の出し分け(存在確認+record scope)。作成の原子性は tx 内の親行ロックで守る。
    await assertPropertyRecordAccess(propertyId, session, "write");

    const created = await prisma.$transaction(async (tx) => {
      await lockPropertyRecordForWrite(tx, propertyId, session);
      return tx.propertyDmLog.create({
        data: {
          propertyId,
          // 個別記録は宛先(所有者)を特定しない: ownerId/dmType は null。
          ownerId: null,
          dmType: null,
          batchId: null,
          draftId: null,
          // sentOn は UTC 00:00 の Date = @db.Date に「UTC暦日=JST暦日」で保存(既存規約)。
          sentAt: new Date(`${body.sentOn}T00:00:00Z`),
          method: body.method ?? null,
          note: body.note?.trim() ? body.note.trim() : null,
          sentBy: session.id,
        },
        select: { id: true },
      });
    });

    await writeAuditLog({
      userId: session.id,
      action: "dm_sent_record",
      targetTable: "property_dm_logs",
      targetId: created.id,
      detail: { propertyId, sentOn: body.sentOn },
    });

    return apiResponse({ id: created.id }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
