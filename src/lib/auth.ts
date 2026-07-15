import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { compare } from "bcryptjs";
import prisma from "@/lib/prisma";

const MAX_LOGIN_FAILURES = 5;
const LOCK_DURATION_MS = 30 * 60 * 1000; // 30 minutes
// セッションは「無操作1時間でログアウト」のスライド式。実際の無操作判定と延長は
// クライアントの IdleSessionGuard が行い、以下はその前提となる cookie 側の寿命設定。
// - IDLE_TIMEOUT: クライアントの無操作ログアウト時間(idle-session-guard の IDLE_TIMEOUT_MS と一致)。
// - REFRESH_INTERVAL: クライアントの延長間隔(同 REFRESH_INTERVAL_MS と一致)。
// - maxAge: cookie は「最後の操作 + IDLE_TIMEOUT」まで生存させる必要がある。延長は最大
//   REFRESH_INTERVAL 間隔なので、最後の延長は最後の操作の最大 REFRESH_INTERVAL 前になり得る。
//   よって IDLE + REFRESH のバッファを持たせ、無操作ログアウト境界より前に cookie が失効して
//   誤ログアウトするのを防ぐ(@codex #290 R6)。
// - updateAge: セッションendpointアクセス時にこの間隔で JWT を回転し cookie を延長(スライド)。
//
// トレードオフ(@codex #290 R8 P2②): 延長は最大 REFRESH_INTERVAL 間隔なので、cookie の寿命は
// 「最後の操作 + IDLE_TIMEOUT」〜「+ IDLE_TIMEOUT + REFRESH_INTERVAL」の幅を持つ。そのため
// サーバ入口(auth()/getApiSession)は、意図した無操作境界の最大 REFRESH_INTERVAL(5分)ぶん
// 後までcookieを受理し得る。ここを厳密に締めると、逆に有効ユーザーを最大5分早くログアウトさせて
// しまう(バッファを入れた理由=R6)。実ブラウザではクライアントガードが1時間で確実に signOut し、
// JS 無効/直接アクセスでも maxAge(65分)で必ず失効するため、この5分の許容は意図的に受容する。
// 厳密なサーバ強制が要る場合はトークンに最終操作時刻を載せる別設計が必要(現状は過剰)。
const IDLE_TIMEOUT_SEC = 60 * 60; // 無操作1時間でログアウト
const REFRESH_INTERVAL_SEC = 5 * 60; // 操作中は最大5分ごとに延長
const SESSION_MAX_AGE_SEC = IDLE_TIMEOUT_SEC + REFRESH_INTERVAL_SEC; // 65分(バッファ込み)
const SESSION_UPDATE_AGE_SEC = REFRESH_INTERVAL_SEC; // 5分

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = credentials?.email as string | undefined;
        const password = credentials?.password as string | undefined;

        if (!email || !password) return null;

        const user = await prisma.user.findUnique({ where: { email } });

        // Check if user exists and is active
        if (!user || !user.isActive) return null;

        // Check if account is locked
        if (user.lockedUntil && user.lockedUntil > new Date()) {
          return null;
        }

        // Compare password
        const passwordValid = await compare(password, user.passwordHash);

        if (!passwordValid) {
          const newFailedCount = user.loginFailedCount + 1;
          const updateData: {
            loginFailedCount: number;
            lockedUntil?: Date;
          } = {
            loginFailedCount: newFailedCount,
          };

          // Lock account after MAX_LOGIN_FAILURES consecutive failures
          if (newFailedCount >= MAX_LOGIN_FAILURES) {
            updateData.lockedUntil = new Date(Date.now() + LOCK_DURATION_MS);
          }

          await prisma.user.update({
            where: { id: user.id },
            data: updateData,
          });

          return null;
        }

        // Reset failed count on success
        await prisma.user.update({
          where: { id: user.id },
          data: {
            loginFailedCount: 0,
            lockedUntil: null,
            lastLoginAt: new Date(),
          },
        });

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        };
      },
    }),
  ],
  session: {
    strategy: "jwt",
    maxAge: SESSION_MAX_AGE_SEC,
    // スライド式(無操作1時間でログアウト)。操作があると updateAge 間隔で有効期限を延長する。
    updateAge: SESSION_UPDATE_AGE_SEC,
  },
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        // 初回ログイン: authorize() で有効性は確認済み。
        token.id = user.id;
        token.role = (user as unknown as { role: string }).role;
        return token;
      }
      // 既存トークンの検証/回転(スライド延長・キープアライブ含む)時は、DB でユーザーの
      // 有効性とロールを再確認する。管理者が無効化/削除/降格したユーザーが、延長で
      // セッションを保ち続けるのを防ぐ(@codex #290 R7 P1)。
      // next-auth v5 では jwt が null を返すと cookie がクリアされ、セッションが失効する。
      if (token.id) {
        let dbUser: { isActive: boolean; role: string } | null;
        try {
          dbUser = await prisma.user.findUnique({
            where: { id: token.id as string },
            select: { isActive: true, role: true },
          });
        } catch {
          // DB 一時障害で有効ユーザーを失効させない(fail-open)。next-auth v5 は jwt が
          // 例外を投げると JWTSessionError で cookie をクリアするため、ここで握って token を
          // 返す。無効化判定は次回の回転で再試行される(@codex #290 R8)。
          return token;
        }
        // クエリ成功時のみ確定的に判定する(null=削除済み・isActive=false=無効化)。
        if (!dbUser || !dbUser.isActive) {
          return null; // 無効化/削除 → セッション失効(cookie クリア)
        }
        token.role = dbUser.role; // ロール変更(降格/昇格)を即反映
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        (session.user as unknown as { role: string }).role = token.role as string;
      }
      return session;
    },
  },
});
