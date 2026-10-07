import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getApiSession, handleApiError } from "@/lib/api-helpers";
import { extendPushSubscription } from "@/lib/push/subscriptions";

// 通知 段階4a(設計書 §7.5 の 1): shared の端末の期限を「今＋65分」に延ばす。自動ログオフの延長
// (/api/auth/session)と同じ5分ごとに画面が呼ぶ。active=false なら画面は登録し直す。
const schema = z.object({ endpoint: z.string() });

export async function POST(req: NextRequest) {
  try {
    const session = await getApiSession();
    const body = schema.parse(await req.json());
    const active = await extendPushSubscription(session.id, body.endpoint);
    return NextResponse.json({ active }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
