import prisma from "@/lib/prisma";

/**
 * GET /api/health
 *
 * 公開（認証なし）・read-only の死活確認エンドポイント。監視やロードバランサ等が
 * 到達性を確認する用途で使う。
 *
 *  - DB へ軽量疎通（SELECT 1）し、成功すれば疎通成功とみなす。
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

// DB 疎通プローブの上限（ミリ秒）。接続取得(maxWait)と実行(timeout)の双方に適用する。
const DB_PING_TIMEOUT_MS = 2000;
// DB プローブ結果の保持時間（ミリ秒）。公開エンドポイントゆえ、濫用（高頻度アクセス）
// 時でも DB プローブを最大 1 回 / この期間に集約し、共有 pg プールを枯渇させない。
// 死活情報の陳腐化は最大でこの期間に収まる。
const HEALTH_CACHE_TTL_MS = 1000;

let cachedResult: { ok: boolean; at: number } | null = null;
let inFlightProbe: Promise<boolean> | null = null;

function getBuildId(): string {
  return process.env.BUILD_ID ?? "unknown";
}

/**
 * DB へ SELECT 1 を投げ、疎通できれば true。例外・timeout はすべて false に倒す
 * （エラー詳細は応答に載せない）。
 *
 * インタラクティブトランザクションの maxWait（接続取得）と timeout（実行）で
 * プローブ自体に上限を設ける。タイムアウト時は Prisma がトランザクションを
 * キャンセル＆ロールバックして接続を解放するため、DB/ネットワーク stall 時に
 * クエリ／接続を握り続けて pg プールを枯渇させない。
 */
async function probeDatabase(): Promise<boolean> {
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1`;
      },
      { maxWait: DB_PING_TIMEOUT_MS, timeout: DB_PING_TIMEOUT_MS },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * DB 疎通を確認する。TTL 内はキャッシュ結果を返し、進行中のプローブには相乗りさせる
 * ことで、公開エンドポイントへの高頻度アクセスでも DB プローブ／接続が多重化せず、
 * pg プールを枯渇させない（HTTP 前段の rate limit を補完する app 層の防御）。
 */
async function checkDatabase(): Promise<boolean> {
  const now = Date.now();

  if (cachedResult && now - cachedResult.at < HEALTH_CACHE_TTL_MS) {
    return cachedResult.ok;
  }

  if (!inFlightProbe) {
    inFlightProbe = probeDatabase()
      .then((ok) => {
        cachedResult = { ok, at: Date.now() };
        return ok;
      })
      .finally(() => {
        inFlightProbe = null;
      });
  }

  return inFlightProbe;
}

export async function GET() {
  const ok = await checkDatabase();

  return Response.json(
    { ok, buildId: getBuildId() },
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
