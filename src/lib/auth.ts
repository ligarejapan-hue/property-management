import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { compare } from "bcryptjs";
import prisma from "@/lib/prisma";

const MAX_LOGIN_FAILURES = 5;
const LOCK_DURATION_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_MAX_AGE_SEC = 30 * 60; // 30 minutes

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
  },
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as unknown as { role: string }).role;
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
