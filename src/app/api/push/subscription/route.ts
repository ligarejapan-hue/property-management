import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getApiSession, handleApiError, ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { DEVICE_SCOPES } from "@/lib/push/binding";
import { revokePushSubscription, upsertPushSubscription, vapidPublicKey } from "@/lib/push/subscriptions";

// 通知 段階4a(設計書 §7.2・§7.5): 端末の登録・付け替え(PUT)と解除(DELETE)。
// ⚠endpoint・鍵は応答・ログ・監査ログに出さない。応答は結び付け(binding_id)・範囲・期限だけ。
const putSchema = z.object({
  endpoint: z.string(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
  deviceScope: z.enum(DEVICE_SCOPES as [string, ...string[]]).optional(),
});
const deleteSchema = z.object({ endpoint: z.string() });

export async function PUT(req: NextRequest) {
  try {
    const session = await getApiSession();
    if (!vapidPublicKey()) throw new ApiError(501, "PC・スマホへの通知は準備中です", "PUSH_NOT_CONFIGURED");
    const body = putSchema.parse(await req.json());
    const result = await upsertPushSubscription(session.id, {
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      deviceScope: body.deviceScope as "shared" | "personal" | undefined,
    });
    if (result.rebound || body.deviceScope) {
      await writeAuditLog({
        userId: session.id,
        action: "push_subscription_register",
        targetTable: "push_subscriptions",
        detail: { deviceScope: result.deviceScope, rebound: result.rebound },
      });
    }
    return NextResponse.json(
      { bindingId: result.bindingId, deviceScope: result.deviceScope, expiresAt: result.expiresAt.toISOString() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await getApiSession();
    const body = deleteSchema.parse(await req.json());
    const revoked = await revokePushSubscription(session.id, body.endpoint);
    if (revoked) {
      await writeAuditLog({ userId: session.id, action: "push_subscription_revoke", targetTable: "push_subscriptions", detail: { reason: "logout" } });
    }
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
