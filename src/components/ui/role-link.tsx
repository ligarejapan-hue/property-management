"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useSession } from "next-auth/react";
import { USE_MOCK } from "@/lib/api-client";
import { canSee, type AppRole } from "@/lib/nav/roles";

/**
 * 説明文の中の画面名をリンクにする。⚠押せそうに見えて開けないリンクは出さない(@codex #411 R5 P2):
 * その画面を開けない役割の人には、同じ文字をただの文字で出す。
 */
export default function RoleLink({ href, minRole, children }: { href: string; minRole: AppRole; children: ReactNode }) {
  const { data: session } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role;
  if (!USE_MOCK && !canSee(role, minRole)) return <>{children}</>;
  return (
    <Link href={href} className="font-semibold underline underline-offset-2">
      {children}
    </Link>
  );
}
