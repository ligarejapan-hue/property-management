import prisma from "@/lib/prisma";

/**
 * GET /api/health
 *
 * 公開（認証なし）・read-only の死活確認エンドポイント。監視やロードバランサ等が
 * 到達性を確認する用途で使う。
 *
 *  - DB へ軽量疎通（SELECT 1）し、短い timeout 内に成功すれば疎通成功とみなす。
 *  - 成功で 200 / ok:true、DB 例外・timeout で 503 / ok:false。
 *  - 応答ボディは { ok, buildId } のみ。
 *      ok      … DB 到達可否（現状の唯一の依存チェック）
 *      buildId … 稼働中ビルドの識別子（env BUILD_ID、未設定時は "unknown"）
 *  - PII・secret・接続文字列（DATABASE_URL 等）やエラー詳細は一切返さない。
 *  - Cache-Control: no-store で中間キャッシュを抑止する。
 *
 * 応答は NextResponse ではなく素の Response.json を使う（公開・フレームワーク非依存で
 * ステータスと header を明示制御するため。api-helpers の apiResponse は header 指定不可）。
 */

// pg adapter（Node 専用）を使うため Node ランタイム必須。
export const runtime = "nodejs";
// 死活確認は毎リクエスト実行する（ビルド時プリレンダ/キャッシュを無効化）。
export const dynamic = "force-dynamic";

const DB_PING_TIMEOUT_MS = 2000;

function getBuildId(): string {
  return process.env.BUILD_ID ?? "unknown";
}

/**
 * DB へ SELECT 1 を投げ、timeout 内に成功すれば true を返す。
 * 例外・timeout はすべて false に倒す（エラー詳細は応答に載せない）。
 */
async function pingDatabase(timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("health-db-timeout")),
      timeoutMs,
    );
  });

  try {
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET() {
  const ok = await pingDatabase(DB_PING_TIMEOUT_MS);

  return Response.json(
    { ok, buildId: getBuildId() },
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
