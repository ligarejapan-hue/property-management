"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Building2,
  Building,
  Users,
  Shield,
  FileText,
  HelpCircle,
  ClipboardList,
  History,
  Menu,
  X,
  ChevronDown,
  ChevronRight,
  Upload,
  KeyRound,
  UserCog,
  MapPinned,
  Map as MapIcon,
  ScanSearch,
  ScanText,
  ClipboardCheck,
  FileSearch,
  BookOpen,
  Newspaper,
  Mail,
} from "lucide-react";
import { ThemeToggle } from "@/components/theme/theme-toggle";

interface SidebarProps {
  userRole: string;
  currentPath: string;
}

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
}

const mainNavItems: NavItem[] = [
  {
    label: "物件一覧",
    href: "/properties",
    icon: <Building2 className="h-5 w-5" />,
  },
  {
    label: "マンション棟",
    href: "/buildings",
    icon: <Building className="h-5 w-5" />,
  },
  {
    label: "販売図面を作成",
    href: "/sales-sheets/new",
    icon: <Newspaper className="h-5 w-5" />,
  },
  {
    label: "現地調査マップ",
    href: "/field-survey/map",
    icon: <MapIcon className="h-5 w-5" />,
  },
  {
    label: "巡回履歴",
    href: "/field-survey/sessions",
    icon: <History className="h-5 w-5" />,
  },
  {
    label: "物件化の完成待ち",
    href: "/field-survey/candidates",
    icon: <ClipboardCheck className="h-5 w-5" />,
  },
  {
    label: "受付帳CSV取込",
    href: "/import",
    icon: <Upload className="h-5 w-5" />,
  },
  {
    label: "謄本PDF取込",
    href: "/import/registry-pdf",
    icon: <FileText className="h-5 w-5" />,
  },
  {
    label: "ヘルプ",
    href: "/help",
    icon: <HelpCircle className="h-5 w-5" />,
  },
];

/** 管理者メニュー: アカウント/権限/ログ/添付の運用系(案2で2グループに整理)。 */
const adminNavItems: NavItem[] = [
  {
    label: "ユーザー管理",
    href: "/admin/users",
    icon: <Users className="h-5 w-5" />,
  },
  {
    label: "権限テンプレート",
    href: "/admin/templates",
    icon: <Shield className="h-5 w-5" />,
  },
  {
    label: "監査ログ",
    href: "/admin/audit-logs",
    icon: <ClipboardList className="h-5 w-5" />,
  },
  {
    label: "権限変更履歴",
    href: "/admin/permission-logs",
    icon: <History className="h-5 w-5" />,
  },
  {
    label: "パスワード変更",
    href: "/admin/change-password",
    icon: <KeyRound className="h-5 w-5" />,
  },
  {
    label: "添付検索",
    href: "/admin/attachments",
    icon: <FileSearch className="h-5 w-5" />,
  },
  {
    label: "謄本取得の資格情報",
    href: "/admin/registry-settings",
    icon: <FileText className="h-5 w-5" />,
  },
  {
    label: "売却DM設定",
    href: "/admin/sale-dm-settings",
    icon: <Mail className="h-5 w-5" />,
  },
  {
    label: "会社情報",
    href: "/admin/company-settings",
    icon: <Building2 className="h-5 w-5" />,
  },
];

/** データ品質チェック: 所有者データの一括点検/補正ツール群。 */
const dataQualityNavItems: NavItem[] = [
  {
    label: "所有者補正候補",
    href: "/admin/owners/correction",
    icon: <UserCog className="h-5 w-5" />,
  },
  {
    label: "表示名監査",
    href: "/admin/display-name-audit",
    icon: <ScanSearch className="h-5 w-5" />,
  },
  {
    label: "郵便番号×住所チェック",
    href: "/admin/postal-code-audit",
    icon: <MapPinned className="h-5 w-5" />,
  },
  {
    label: "テキスト衛生監査",
    href: "/admin/owners/text-hygiene",
    icon: <ScanText className="h-5 w-5" />,
  },
  {
    label: "品質監査",
    href: "/admin/owners/quality-audit",
    icon: <ClipboardCheck className="h-5 w-5" />,
  },
];

export default function Sidebar({ userRole, currentPath }: SidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const isActive = (href: string) => {
    if (href === "/properties") {
      return currentPath === href || currentPath.startsWith("/properties/");
    }
    // Exact match for /import to avoid highlighting when on /import/owners etc.
    if (href === "/import") {
      return currentPath === "/import";
    }
    return currentPath === href || currentPath.startsWith(href + "/");
  };

  // 管理者系グループは既定で閉じる(18項目が常時展開されるとモバイルで
  // ドロワーが縦に収まらない)。開閉は「現在地(currentPath)＋ユーザーの手動操作」
  // から毎レンダー導出する: 手動トグル(null=未操作)が無ければ、現在地がグループ内
  // なら自動で開く。dashboard layout は永続で Sidebar が再マウントされないため、
  // useState 初期化だけだと client-side 遷移で別グループへ入っても開かず現在地が
  // サイドバーから消える。導出式にすることで遷移のたび追従する(effect 不要=
  // react-hooks/set-state-in-effect も踏まない)。
  const [adminToggle, setAdminToggle] = useState<boolean | null>(null);
  const [qualityToggle, setQualityToggle] = useState<boolean | null>(null);
  const adminOpen = adminToggle ?? adminNavItems.some((i) => isActive(i.href));
  const qualityOpen =
    qualityToggle ?? dataQualityNavItems.some((i) => isActive(i.href));

  const linkClasses = (href: string) =>
    `flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
      isActive(href)
        ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300"
        : "text-gray-700 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
    }`;

  const isAdmin = userRole === "admin" || userRole === "ADMIN";

  /** 折りたたみ可能なメニューグループ(見出しボタン+開時のみ項目を描画)。 */
  const navGroup = (
    label: string,
    items: NavItem[],
    open: boolean,
    toggle: () => void,
  ) => (
    <>
      <div className="mt-4 mb-1">
        <button
          onClick={toggle}
          aria-expanded={open}
          className="flex w-full items-center gap-2 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          {open ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          {label}
        </button>
      </div>
      {open &&
        items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={linkClasses(item.href)}
            onClick={() => setMobileOpen(false)}
          >
            {item.icon}
            {item.label}
          </Link>
        ))}
    </>
  );

  const navContent = (
    <nav className="flex flex-col gap-1 p-4">
      <div className="mb-2">
        <p className="px-3 py-1 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          メニュー
        </p>
      </div>
      {mainNavItems.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={linkClasses(item.href)}
          onClick={() => setMobileOpen(false)}
        >
          {item.icon}
          {item.label}
        </Link>
      ))}

      {isAdmin && (
        <>
          {navGroup("管理", adminNavItems, adminOpen, () => setAdminToggle(!adminOpen))}
          {navGroup("データ品質チェック", dataQualityNavItems, qualityOpen, () =>
            setQualityToggle(!qualityOpen),
          )}
        </>
      )}

      {/* 資料（使い方ガイド・取り扱いマニュアル）— メニュー最下部・全ユーザーに表示。
          public/docs の静的HTML（個人情報を含まない一般資料）。未ログインは proxy が
          /login へ誘導するが、静的ファイルのため厳密なセッション検証は行わない
          （＝機密情報は載せない前提のドキュメントのみを置く）。将来 機密を含む資料が
          必要になったら auth() で検証する route 経由に切り替えること。
          別タブで開き、作業中の画面を失わないようにする。 */}
      <div className="mt-4 mb-1">
        <p className="px-3 py-1 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          資料
        </p>
      </div>
      <a
        href="/docs/guide.html"
        target="_blank"
        rel="noopener noreferrer"
        className={linkClasses("/docs/guide.html")}
        onClick={() => setMobileOpen(false)}
      >
        <BookOpen className="h-5 w-5" />
        使い方ガイド
      </a>
      <a
        href="/docs/manual.html"
        target="_blank"
        rel="noopener noreferrer"
        className={linkClasses("/docs/manual.html")}
        onClick={() => setMobileOpen(false)}
      >
        <FileText className="h-5 w-5" />
        取り扱いマニュアル
      </a>
    </nav>
  );

  return (
    <>
      {/* Mobile toggle button */}
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        className="fixed top-3 left-3 z-50 rounded-md bg-white dark:bg-gray-900 p-2 shadow-md lg:hidden"
        aria-label="メニューを開く"
      >
        {mobileOpen ? (
          <X className="h-5 w-5 text-gray-700 dark:text-gray-300" />
        ) : (
          <Menu className="h-5 w-5 text-gray-700 dark:text-gray-300" />
        )}
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/30 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-60 transform flex-col border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 transition-transform duration-200 lg:static lg:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* pl-14: モバイルの固定「×」ボタン(left-3 + 36px)がタイトルに重ならない位置から始める */}
        <div className="flex h-14 shrink-0 items-center border-b border-gray-200 dark:border-gray-700 pl-14 pr-4 lg:pl-4">
          <FileText className="mr-2 h-5 w-5 text-indigo-600 dark:text-indigo-400" />
          <span className="text-sm font-bold text-gray-800 dark:text-gray-100">物件管理</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{navContent}</div>
        {/* モバイルではヘッダーからテーマ切替をここへ移動(ヘッダーの詰まり解消)。
            pb の env(safe-area-inset-bottom): iPhone のホームインジケータ/下部バーに
            最下部の操作が隠れないための追加余白(非対応環境では 0 で無害)。 */}
        <div className="shrink-0 border-t border-gray-200 dark:border-gray-700 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] lg:hidden">
          <div className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">表示テーマ</div>
          <ThemeToggle />
        </div>
      </aside>
    </>
  );
}
