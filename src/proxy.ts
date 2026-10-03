import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// 前方一致（startsWith）で公開するパス。
// "/t/" = 売却DMの宛先固有 追跡リンク(opaque token のみ・PII を含まない)。受け手(所有者)は
// 本システムの認証ユーザーではないため認証免除が必須。proxy 本体は単体テストで実行できないため、
// isPublicPath を export し sale-dm-proxy-public-path.test.ts で /t/ の公開を担保する。
// "/u/" = 売却DMの配信停止(郵送QR)。/t/ と同じく受け手(所有者)向けの公開ページ。
//   停止の書き込みは route 側の HMAC 署名検証+回数制限+Origin 検査で守る。
// "/lp-assets/" = LP用写真の公開口(設計 2026-09-08 §2.3)。publicId(32hex乱数)だけで1枚を返し、
// 一覧は取れない。どこかのLP型が参照している資産だけを返す(route 側で判定)。
// "/icons/" = ホーム画面に追加したときのアイコン(通知 段階1)。静的な画像のみ・PII なし。
const PUBLIC_PATHS = ["/login", "/api/auth", "/_next", "/favicon.ico", "/uploads", "/t/", "/u/", "/lp-assets/", "/icons/"];

// 完全一致で公開するパス。前方一致（startsWith）だと /api/health-xxx 等まで認証免除が
// 広がってしまうため、必要最小の範囲（完全一致）でのみ公開する。
// - /api/health: 死活確認の公開エンドポイント。
// - /api/attachments/cleanup-run: cron 駆動の添付お掃除。人間 auth は持たず、
//   ルート側の x-cleanup-secret で保護する（secret 未設定なら 503 で dormant）。
//   ここで素通しできないと、合言葉付きの cron 呼び出しも /login へ redirect され実行されない。
// - /api/field-survey/sessions/auto-end-run: cron 駆動の巡回自動終了（無操作1時間）。
//   同上（x-auto-end-secret で保護・未設定なら 503 dormant）。
// - /sw.js・/manifest.webmanifest: 通知 段階1 の静的ファイル（下記）。
const PUBLIC_EXACT_PATHS = [
  "/api/health",
  "/api/attachments/cleanup-run",
  "/api/field-survey/sessions/auto-end-run",
  // 通知 段階4b: Web プッシュの送信(timer 駆動)。x-push-run-secret で保護・未設定なら 503 で休眠。
  "/api/notifications/push-run",
  // 通知 段階1: Service Worker とホーム画面追加の設定。ログイン画面(未ログイン)でも
  // 読む必要がある(共用 PC の通知の後片付け・iPhone のホーム画面追加)。中身は静的・PII なし。
  "/sw.js",
  "/manifest.webmanifest",
];

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT_PATHS.includes(pathname)) return true;
  return PUBLIC_PATHS.some((p) => pathname.startsWith(p));
}

export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Mock mode: skip all auth checks
  if (process.env.NEXT_PUBLIC_USE_MOCK === "true") {
    return NextResponse.next();
  }

  // Allow public paths
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Edge-compatible session check: look for the session token cookie
  // NextAuth v5 JWT strategy stores session in this cookie
  const sessionToken =
    request.cookies.get("authjs.session-token")?.value ??
    request.cookies.get("__Secure-authjs.session-token")?.value;

  if (!sessionToken) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Note: Full auth verification (role checks, session validity)
  // is done server-side in API routes and page components via getApiSession()
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|uploads/).*)"],
};
