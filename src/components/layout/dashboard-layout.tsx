"use client";

import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import Sidebar from "./sidebar";
import Header from "./header";
import { USE_MOCK } from "@/lib/api-client";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { data: session } = useSession();

  const userName = USE_MOCK ? "モック管理者" : (session?.user?.name ?? "ユーザー");
  const userRole = USE_MOCK ? "admin" : ((session?.user as { role?: string } | undefined)?.role ?? "VIEWER");

  const handleLogout = () => {
    if (USE_MOCK) return;
    signOut({ callbackUrl: "/login" });
  };

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      <Sidebar userRole={userRole} currentPath={pathname} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header userName={userName} userRole={userRole} onLogout={handleLogout} />
        <main className="flex-1 overflow-y-auto p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
