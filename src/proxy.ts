import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PATHS = ["/login", "/api/auth", "/_next", "/favicon.ico", "/uploads"];

// 完全一致で公開するパス。前方一致（startsWith）だと /api/health-xxx 等まで認証免除が
// 広がってしまうため、必要最小の範囲（完全一致）でのみ公開する。
// - /api/health: 死活確認の公開エンドポイント。
// - /api/attachments/cleanup-run: cron 駆動の添付お掃除。人間 auth は持たず、
//   ルート側の x-cleanup-secret で保護する（secret 未設定なら 503 で dormant）。
//   ここで素通しできないと、合言葉付きの cron 呼び出しも /login へ redirect され実行されない。
const PUBLIC_EXACT_PATHS = ["/api/health", "/api/attachments/cleanup-run"];

function isPublicPath(pathname: string): boolean {
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
