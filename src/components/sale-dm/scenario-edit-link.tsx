"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { USE_MOCK } from "@/lib/api-client";

/** 説明文中の「「DMの種類」の画面で直し…」に添えるリンク。種類の画面は管理者だけが開けるので、管理者以外には出さない。 */
export function scenarioEditHref(scenarioId: string | null | undefined): string {
  return scenarioId ? `/admin/dm-scenarios/${encodeURIComponent(scenarioId)}` : "/admin/dm-scenarios";
}

export default function ScenarioEditLink({ scenarioId }: { scenarioId: string | null | undefined }) {
  const { data: session } = useSession();
  const isAdmin = USE_MOCK || (session?.user as { role?: string } | undefined)?.role === "admin";
  if (!isAdmin) return null;
  return (
    <>
      {" "}
      <Link href={scenarioEditHref(scenarioId)} className="font-semibold underline underline-offset-2">
        DMの種類を開く
      </Link>
    </>
  );
}
