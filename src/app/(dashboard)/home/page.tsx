"use client";

import { useSession } from "next-auth/react";
import { HomeContent } from "@/components/home/HomeContent";
import { USE_MOCK } from "@/lib/api-client";

export default function HomePage() {
  const { data: session } = useSession();
  const userRole = USE_MOCK
    ? "admin"
    : ((session?.user as { role?: string } | undefined)?.role ?? "field_staff");
  return <HomeContent userRole={userRole} />;
}
