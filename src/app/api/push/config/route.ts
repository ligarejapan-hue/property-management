import { NextResponse } from "next/server";
import { getApiSession, handleApiError } from "@/lib/api-helpers";
import { vapidPublicKey } from "@/lib/push/subscriptions";

// 通知 段階4a: 画面が端末を登録するための公開鍵(VAPID)。鍵がそろっていなければ使えない
// (画面は「PC・スマホにも通知する」を段階1・2の動き=画面を開いている間だけ、にとどめる)。
export async function GET() {
  try {
    await getApiSession();
    const publicKey = vapidPublicKey();
    return NextResponse.json({ enabled: publicKey !== null, publicKey }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
