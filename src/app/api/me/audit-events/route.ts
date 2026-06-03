import { NextRequest } from "next/server";
import { z } from "zod";
import {
  getApiSession,
  ApiError,
  handleApiError,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import {
  SCREEN_PROTECTION_EVENT_TYPES,
  SCREEN_PROTECTION_SURFACES,
  eventTypeToAuditAction,
  eventTypeToTrigger,
} from "@/lib/screen-protection";
import { createTokenBucketLimiter } from "@/lib/token-bucket";

/**
 * S1b-3: client-side の copy / cut / contextmenu / print 操作試行を記録する。
 *
 * - 認証済みなら誰でも自分のイベントを記録できる（特別 permission は不要）。
 * - body は eventType / surface の厳格 enum のみ。action / trigger はサーバ側で eventType
 *   から決定し client を信用しない。
 * - detail は { surface, trigger } の非PII enum のみ。URL / path / 選択テキスト / 所有者名 /
 *   userAgent / ipAddress は一切記録しない。
 * - 濫用対策に in-memory token-bucket（60/min/user）。超過は 429（best-effort、操作は妨げない）。
 *
 * S1b-4 の server-side 監査（/uploads の registry PDF アクセス）とは別系統。
 */

const bodySchema = z.object({
  eventType: z.enum(SCREEN_PROTECTION_EVENT_TYPES),
  surface: z.enum(SCREEN_PROTECTION_SURFACES),
});

// 60 events/min/user（capacity=60, refill=1/sec）。
const limiter = createTokenBucketLimiter({ capacity: 60, refillPerSec: 1 });

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();

    if (!limiter.tryConsume(session.id, Date.now())) {
      return new Response(null, { status: 429 });
    }

    const body = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "不正なイベントです", "VALIDATION_ERROR");
    }
    const { eventType, surface } = parsed.data;

    await writeAuditLog({
      userId: session.id,
      action: eventTypeToAuditAction(eventType),
      targetTable: "screen_protection",
      // 個別対象は持たない（targetId は null）。
      targetId: undefined,
      // 非PII enum のみ。
      detail: { surface, trigger: eventTypeToTrigger(eventType) },
    });

    return new Response(null, { status: 204 });
  } catch (error) {
    return handleApiError(error);
  }
}
