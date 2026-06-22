import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// 前方一致（startsWith）で公開するパス。
// "/t/" = 売却DMの宛先固有 追跡リンク(opaque token のみ・PII を含まない)。受け手(所有者)は
// 本システムの認証ユーザーではないため認証免除が必須。proxy 本体は単体テストで実行できないため、
// isPublicPath を export し sale-dm-proxy-public-path.test.ts で /t/ の公開を担保する。
const PUBLIC_PATHS = ["/login", "/api/auth", "/_next", "/favicon.ico", "/uploads", "/t/"];

// 完全一致で公開するパス。前方一致（startsWith）だと /api/health-xxx 等まで認証免除が
// 広がってしまうため、死活確認の /api/health だけを必要最小の範囲で公開する。
const PUBLIC_EXACT_PATHS = ["/api/health"];

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
