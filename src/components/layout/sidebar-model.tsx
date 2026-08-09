import {
  Home,
  Link2,
  Building2,
  Building,
  Users,
  Shield,
  FileText,
  HelpCircle,
  ClipboardList,
  History,
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
  MailX,
} from "lucide-react";
import { canSee, type AppRole } from "@/lib/nav/roles";

export interface NavLeaf {
  label: string;
  href: string;
  icon: React.ReactNode;
  minRole: AppRole;
  /** true のとき Link ではなく別タブの <a>(静的HTML資料)。 */
  external?: boolean;
}
export interface NavGroup {
  key: string;
  /** null のときは見出しを描かない(先頭のホーム等)。 */
  label: string | null;
  collapsible?: boolean;
  items: NavLeaf[];
}

const ic = (C: React.ComponentType<{ className?: string }>) => <C className="h-5 w-5" />;

/** サイドバーの全定義(役割で絞る前)。順序はそのまま表示順。 */
export const SIDEBAR_GROUPS: NavGroup[] = [
  {
    key: "home",
    label: null,
    items: [{ label: "ホーム", href: "/home", icon: ic(Home), minRole: "field_staff" }],
  },
  {
    key: "prop",
    label: "物件",
    items: [
      { label: "物件一覧", href: "/properties", icon: ic(Building2), minRole: "office_staff" },
      { label: "マンション棟", href: "/buildings", icon: ic(Building), minRole: "office_staff" },
    ],
  },
  {
    key: "field",
    label: "現地調査",
    items: [
      { label: "現地調査マップ", href: "/field-survey/map", icon: ic(MapIcon), minRole: "field_staff" },
      { label: "巡回履歴", href: "/field-survey/sessions", icon: ic(History), minRole: "field_staff" },
      { label: "物件化の完成待ち", href: "/field-survey/candidates", icon: ic(ClipboardCheck), minRole: "field_staff" },
    ],
  },
  {
    key: "imp",
    label: "取込・登記",
    items: [
      { label: "受付帳CSV取込", href: "/import", icon: ic(Upload), minRole: "office_staff" },
      { label: "謄本PDF取込", href: "/import/registry-pdf", icon: ic(FileText), minRole: "office_staff" },
      { label: "謄本取得の資格情報", href: "/admin/registry-settings", icon: ic(FileText), minRole: "admin" },
    ],
  },
  {
    key: "sheet",
    label: "販売図面",
    items: [
      { label: "販売図面を作成", href: "/sales-sheets/new", icon: ic(Newspaper), minRole: "office_staff" },
      { label: "会社情報", href: "/admin/company-settings", icon: ic(Building2), minRole: "admin" },
    ],
  },
  {
    key: "dm",
    label: "売却DM",
    items: [{ label: "売却DM設定", href: "/admin/sale-dm-settings", icon: ic(Mail), minRole: "admin" }],
  },
  {
    key: "dq",
    label: "データ品質",
    collapsible: true,
    items: [
      { label: "所有者補正候補", href: "/admin/owners/correction", icon: ic(UserCog), minRole: "admin" },
      { label: "法人番号紐づけ", href: "/admin/owners/correction?tab=corporate_restore", icon: ic(Link2), minRole: "admin" },
      { label: "表示名監査", href: "/admin/display-name-audit", icon: ic(ScanSearch), minRole: "admin" },
      { label: "郵便番号×住所チェック", href: "/admin/postal-code-audit", icon: ic(MapPinned), minRole: "admin" },
      { label: "テキスト衛生監査", href: "/admin/owners/text-hygiene", icon: ic(ScanText), minRole: "admin" },
      { label: "氏名・連絡先チェック", href: "/admin/owners/quality-audit", icon: ic(ClipboardCheck), minRole: "admin" },
      // 物件削除で孤児化した送付記録の訂正・取消(PR-B・設計§2.4)
      { label: "孤児DM記録の訂正", href: "/admin/orphan-dm-logs", icon: ic(MailX), minRole: "admin" },
    ],
  },
  {
    key: "admin",
    label: "システム管理",
    collapsible: true,
    items: [
      { label: "ユーザー管理", href: "/admin/users", icon: ic(Users), minRole: "admin" },
      { label: "権限テンプレート", href: "/admin/templates", icon: ic(Shield), minRole: "admin" },
      { label: "パスワード変更", href: "/admin/change-password", icon: ic(KeyRound), minRole: "admin" },
      { label: "権限変更履歴", href: "/admin/permission-logs", icon: ic(History), minRole: "admin" },
      { label: "監査ログ", href: "/admin/audit-logs", icon: ic(ClipboardList), minRole: "admin" },
      { label: "添付検索", href: "/admin/attachments", icon: ic(FileSearch), minRole: "admin" },
    ],
  },
  {
    key: "doc",
    label: "資料",
    items: [
      { label: "使い方ガイド", href: "/docs/guide.html", icon: ic(BookOpen), minRole: "field_staff", external: true },
      { label: "取り扱いマニュアル", href: "/docs/manual.html", icon: ic(FileText), minRole: "field_staff", external: true },
      { label: "ヘルプ", href: "/help", icon: ic(HelpCircle), minRole: "field_staff" },
    ],
  },
];

/** userRole で見えるサイドバーグループ(空グループは除く)。 */
export function visibleSidebar(userRole: string): NavGroup[] {
  return SIDEBAR_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((i) => canSee(userRole, i.minRole)) }))
    .filter((g) => g.items.length > 0);
}

/**
 * /properties の URL 名前空間を間借りしているだけで「物件一覧」とは別機能のページ。
 * これらでは物件一覧を現在地ハイライトしない(C-5 UI総点検: 品質チェックで物件一覧が光る現在地ズレ)。
 */
const PROPERTIES_NON_LIST = ["/properties/quality-check", "/properties/sale-dm"];

/**
 * サイドバー項目の現在地ハイライト判定(純関数=テスト可能)。
 * - `/properties` は一覧および物件詳細(`/properties/<id>`)で点灯するが、上記の別機能ページ
 *   (品質チェック・売却DM)では点灯させない。
 * - `/import` は完全一致のみ(`/import/registry-pdf` 等では点灯しない)。
 * - それ以外は完全一致、またはその配下(`href + "/"`)で点灯。
 */
export function isNavItemActive(href: string, currentPath: string): boolean {
  if (href === "/properties") {
    if (PROPERTIES_NON_LIST.some((p) => currentPath === p || currentPath.startsWith(p + "/"))) {
      return false;
    }
    return currentPath === href || currentPath.startsWith("/properties/");
  }
  if (href === "/import") return currentPath === "/import";
  return currentPath === href || currentPath.startsWith(href + "/");
}
