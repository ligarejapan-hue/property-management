"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { PageHeader } from "@/components/ui/page-header";
import { USE_MOCK } from "@/lib/api-client";
import { canSee, type AppRole } from "@/lib/nav/roles";
import { Mail, MailX, FileSpreadsheet, Settings2 } from "lucide-react";

// DM メニュー(メニュー再編・発注者決定 2026-08-24 案B)。
//
// DM の道具は画面をまたいで散らばっており(宛名CSV/売却DM作成=物件一覧のボタン・
// 設定=管理画面・記録の訂正=別の管理画面)、「どこから始めるのか」が分からない
// という指摘があった。ここは**送る流れの順に道具を案内するだけ**の入口ページで、
// 各道具そのものは従来の場所でもそのまま使える(入口が増えるだけ)。
//
// ⚠この画面はデータの取得も更新もしない(案内だけ)。ただし**押せそうに見えて
//   開けないリンクは出さない**(@codex #411 R5 P2): 事務担当にも見せる画面なので、
//   管理者専用の道具は「管理者にご依頼ください」に差し替える。実際の制御は
//   従来どおり各画面の API が行う=ここは見せ方だけを合わせる。

interface Step {
  no: string;
  title: string;
  body: string;
  href: string;
  linkLabel: string;
  icon: React.ReactNode;
  /** この道具を使える役割。足りない人にはリンクを出さない。 */
  minRole: AppRole;
  /** 使えない人へ出す案内。 */
  unavailable?: string;
}

const STEPS: Step[] = [
  {
    no: "STEP 1",
    title: "送る相手を絞る",
    body:
      "物件一覧で「DM判断」や担当者などの条件を指定して、送る対象を絞り込みます。" +
      "拒否・宛先不明の方は、この後の出力で自動的に外れます。",
    href: "/properties",
    linkLabel: "物件一覧を開く",
    icon: <FileSpreadsheet className="h-5 w-5" />,
    minRole: "office_staff",
  },
  {
    // ⚠**作成より前に置く**(@codex #411 R3 P2)。差出人・案内先が未設定だと
    //   物件一覧に「売却DMを作成」ボタンがそもそも出ない(saleDmPrintReady)。
    //   作成を先に案内すると、はじめて使う人が STEP 2 で行き止まりになる。
    no: "STEP 2",
    title: "差出人や案内先を設定する",
    body:
      "お手紙に載る差出人、案内ページ(LP)、追跡用のURLの設定です。" +
      "ここが未設定だと、物件一覧に「売却DMを作成」のボタンが出ません。" +
      "はじめて送る前に必ず確認してください（宛名CSVの出力だけなら設定は不要です）。",
    href: "/admin/sale-dm-settings",
    linkLabel: "売却DM設定を開く",
    icon: <Settings2 className="h-5 w-5" />,
    minRole: "admin",
    unavailable:
      "この設定は管理者が行います。まだ設定されていない場合は管理者にご依頼ください。",
  },
  {
    no: "STEP 3",
    title: "宛名やお手紙を作る",
    body:
      "絞り込んだ状態のまま、物件一覧のボタンから宛名CSVを出力するか、" +
      "売却DMの文面を作ります。出力した控えは「送付の確定」で記録になります。",
    href: "/properties",
    linkLabel: "物件一覧のボタンへ",
    icon: <Mail className="h-5 w-5" />,
    minRole: "office_staff",
  },
  {
    no: "STEP 4",
    title: "送ったあとの記録を整える",
    body:
      "反響や宛先不明の記録は、ふだんは各物件の「DM送付履歴」で行います。" +
      "物件を削除した後に残った記録だけは、こちらで訂正・取消ができます。",
    href: "/admin/orphan-dm-logs",
    linkLabel: "送付記録の訂正を開く",
    icon: <MailX className="h-5 w-5" />,
    minRole: "admin",
    unavailable:
      "ふだんの記録は各物件の「DM送付履歴」で行えます。削除した物件の記録の訂正は管理者にご依頼ください。",
  },
];

export default function DmMenuPage() {
  const { data: session } = useSession();
  const userRole = USE_MOCK
    ? "admin"
    : ((session?.user as { role?: string } | undefined)?.role ?? "VIEWER");

  return (
    <div className="p-6">
      <PageHeader
        title="DMメニュー"
        description="送る流れの順に、DMの道具を並べています。各道具はこれまでの場所でもそのまま使えます。"
      />

      <ol className="mt-6 grid gap-4 sm:grid-cols-2">
        {STEPS.map((s) => {
          const usable = canSee(userRole, s.minRole);
          return (
            <li
              key={s.no}
              data-testid="dm-menu-step"
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
                // ⚠押せそうに見えて開けないリンクは出さない(@codex #411 R5 P2)。
                <p
                  data-testid="dm-menu-step-unavailable"
                  className="mt-3 rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                >
                  {s.unavailable}
                </p>
              )}
            </li>
          );
        })}
      </ol>

      <p className="mt-6 text-xs text-gray-500 dark:text-gray-400">
        送付済みの履歴は、各物件のページの「DM送付履歴」で確認できます。
      </p>
    </div>
  );
}
