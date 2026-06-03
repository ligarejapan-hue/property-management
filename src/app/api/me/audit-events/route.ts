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
 *
 * CSRF / 同一オリジン境界（17-A: Origin / Referer 検証は意図的に未採用）:
 * - 主な CSRF 経路（cross-site の認証済み POST）は NextAuth v5 既定の SameSite=Lax
 *   session cookie で既に緩和される。cross-site の fetch / XHR / 上位フォーム POST は
 *   cookie を送らないため、src/proxy.ts が cookie 不在で /login へ 307 redirect するか、
 *   getApiSession() が 401 を投げ、本ハンドラの writeAuditLog へ到達しない。
 * - 本 endpoint は非PII enum（{ surface, trigger }、action / trigger はサーバ派生）だけを
 *   記録する監査補助であり、想定リスクは主に「監査ノイズ」（token-bucket で 60/min/user に
 *   上限）であって、PII 漏洩・状態変更・権限変更ではない。
 * - そのため Route Handler への Origin / Referer 検証（同一オリジン check）は今回採用しない。
 *   低重大度に対して header 読み取りを増やすと、本ファイルの header 不参照（PII 防御）方針と
 *   競合し、Origin を省く正規文脈（referrer-policy no-referrer、将来の sendBeacon 等）で
 *   正規イベントを無音で取りこぼすリスクの方が大きい。残余（同一サイト subdomain、旧 Chrome の
 *   Lax+POST 窓、将来の SameSite=None 化）は、必要時に別途 defense-in-depth として検討する。
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
