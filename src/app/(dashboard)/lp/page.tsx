"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useSession } from "next-auth/react";
import { PageHeader } from "@/components/ui/page-header";
import { USE_MOCK } from "@/lib/api-client";
import { canSee, type AppRole } from "@/lib/nav/roles";
import { Settings2, Image as ImageIcon, Tags, Inbox } from "lucide-react";

// LPメニュー(発注者決定 2026-10-15 案B)。
//
// LP(ご案内ページ)の道具は「売却DM設定」「LPの写真」「DMの種類」と3画面に分かれていて、
// LP のための画面がどれなのか分かりにくかった。ここは**用意する順に道具を案内するだけ**の
// 入口ページ(DMメニューと同じ作り)で、各道具そのものは従来の場所でもそのまま使える。
//
// ⚠この画面はデータの取得も更新もしない(案内だけ)。押せそうに見えて開けないリンクは
// 出さない(DMメニューと同じ・@codex #411 R5 P2)。実際の制御は従来どおり各画面の API。

interface Step {
  no: string;
  title: string;
  body: ReactNode;
  href: string;
  linkLabel: string;
  icon: React.ReactNode;
  /** この道具を使える役割。足りない人にはリンクを出さない。 */
  minRole: AppRole;
  /** 使えない人へ出す案内。 */
  unavailable?: ReactNode;
}

const LP_MENU_STEPS: Step[] = [
  {
    // ⚠最初に置く。LP の公開先が未設定だと、お手紙の QR から LP へ案内できない。
    no: "STEP 1",
    title: "LPの公開先と申込フォームを設定する",
    body:
      "LPを公開するURL、申込フォームに出す個人情報の取扱い文などの設定です。" +
      "はじめてLPを使う前に確認してください。",
    href: "/admin/sale-dm-settings",
    linkLabel: "売却DM設定を開く",
    icon: <Settings2 className="h-5 w-5" />,
    minRole: "admin",
    unavailable: "この設定は管理者が行います。",
  },
  {
    no: "STEP 2",
    title: "LPに載せる写真とイラストを用意する",
    body:
      "LPの写真や、お手紙に入れるイラストの置き場です。" +
      "ここに入れた写真を、次の「DMの種類」でLPに選んで使います。",
    href: "/admin/lp-assets",
    linkLabel: "LPの写真を開く",
    icon: <ImageIcon className="h-5 w-5" />,
    minRole: "admin",
    unavailable: "写真の登録は管理者が行います。",
  },
  {
    no: "STEP 3",
    title: "DMの種類ごとにLPを作る",
    body:
      "相続・空き家などの種類ごとに、お手紙とLPを1組ずつ登録します。" +
      "LPの文面・写真・図はここで作り、プレビューで見た目を確かめられます。",
    href: "/admin/dm-scenarios",
    linkLabel: "DMの種類を開く",
    icon: <Tags className="h-5 w-5" />,
    minRole: "admin",
    unavailable: "LPの作成は管理者が行います。",
  },
  {
    no: "STEP 4",
    title: "LPから届いた申込を見る",
    body:
      "LPの申込フォームから届いた査定の申込の一覧です。" +
      "左のメニューの「反響受付」からも開けます。",
    href: "/properties/sale-dm/inquiries",
    linkLabel: "査定の申込を開く",
    icon: <Inbox className="h-5 w-5" />,
    minRole: "field_staff",
  },
];

export default function LpMenuPage() {
  const { data: session } = useSession();
  const userRole = USE_MOCK
    ? "admin"
    : ((session?.user as { role?: string } | undefined)?.role ?? "VIEWER");

  return (
    <div className="p-6">
      <PageHeader
        title="LPメニュー"
        description="LP(ご案内ページ)を用意する順に、道具を並べています。各道具はこれまでの場所でもそのまま使えます。"
      />

      <ol className="mt-6 grid gap-4 sm:grid-cols-2">
        {LP_MENU_STEPS.map((s) => {
          const usable = canSee(userRole, s.minRole);
          return (
            <li
              key={s.no}
              data-testid="lp-menu-step"
              className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900"
            >
              <div className="flex items-center gap-2 text-indigo-700 dark:text-indigo-300">
                <span aria-hidden="true">{s.icon}</span>
                <span className="text-xs font-bold tracking-wider">{s.no}</span>
              </div>
              <h2 className="mt-1 text-base font-semibold text-gray-900 dark:text-gray-100">
                {s.title}
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                {s.body}
              </p>
              {usable ? (
                <Link
                  href={s.href}
                  className="mt-3 inline-block rounded-md border border-indigo-300 bg-white px-3 py-1.5 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 dark:border-indigo-500/40 dark:bg-gray-900 dark:text-indigo-300 dark:hover:bg-gray-800"
                >
                  {s.linkLabel}
                </Link>
              ) : (
                <p
                  data-testid="lp-menu-step-unavailable"
                  className="mt-3 rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                >
                  {s.unavailable}
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
