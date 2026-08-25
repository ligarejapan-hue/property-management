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
  /**
   * 見出しの下に出す一言説明(メニュー再編・2026-08-24)。
   * ⚠**名前だけで中身が分かるグループには付けない**(発注者指示: 「物件」
   * 「現地調査」は不要)。名前が抽象的なグループ(取り込み・DM・データ編集・
   * システム管理など)の迷いを減らすためのもの。
   */
  description?: string;
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
      // ⚠これまで物件一覧のボタンからしか行けなかった(メニューに無かった)。
      { label: "物件データエラー確認", href: "/properties/quality-check", icon: ic(ClipboardCheck), minRole: "office_staff" },
      // ⚠「システム管理」から移動(発注者決定)。日々の道具なので物件の並びへ。
      //   権限は据え置き=管理者だけに見える。
      { label: "添付ファイル検索", href: "/admin/attachments", icon: ic(FileSearch), minRole: "admin" },
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
    label: "物件データ取り込み",
    description: "外部の一覧・書類からまとめて登録",
    items: [
      { label: "受付帳CSV取込", href: "/import", icon: ic(Upload), minRole: "office_staff" },
      { label: "謄本PDF取込", href: "/import/registry-pdf", icon: ic(FileText), minRole: "office_staff" },
      // ⚠取込画面の中のタブからしか行けなかった。
      { label: "登記DM取込", href: "/import/registry-dm", icon: ic(Mail), minRole: "office_staff" },
      // ⚠**アプリ内のリンクがゼロ**で、URL を直に打つしか到達手段が無かった
      //   (2026-08-16 に発見・08-24 の再実測でも同じ)。
      // ⚠行き先は取込画面の**該当セクション**(@codex #411 R1 P2)。/import/owners は
      //   そこへ送るだけの転送ページで、素の /import へ送ると受付帳の取込と
      //   見分けがつかない場所に着いてしまう。
      { label: "所有者CSV取込", href: "/import#owner-match", icon: ic(Users), minRole: "office_staff" },
    ],
  },
  {
    key: "dm",
    label: "DM",
    description: "宛名の出力・お手紙の作成・記録の訂正",
    items: [
      // 入口ページ(案B)。宛名CSVや売却DMの作成は従来どおり物件一覧にあり、
      // ここはそこへの分かりやすい入口を足すもの。
      { label: "DMメニュー", href: "/dm", icon: ic(Mail), minRole: "office_staff" },
      { label: "売却DM設定", href: "/admin/sale-dm-settings", icon: ic(Mail), minRole: "admin" },
      // ⚠「データ品質」から移動(DM の道具がそこに紛れていた)。
      { label: "送付記録の訂正", href: "/admin/orphan-dm-logs", icon: ic(MailX), minRole: "admin" },
    ],
  },
  {
    key: "sheet",
    label: "販売図面",
    description: "売り出しの1枚チラシ",
    items: [
      { label: "販売図面を作成", href: "/sales-sheets/new", icon: ic(Newspaper), minRole: "office_staff" },
      // ⚠会社情報(販売図面の差出人)は「システム管理」へ移した(発注者指示 2026-08-25:
      //   常用しないため)。図面の差出人を変えたい人はそちらから。
    ],
  },
  {
    key: "dq",
    label: "物件データ編集",
    description: "名寄せ・誤りの一括修正・チェック",
    collapsible: true,
    items: [
      { label: "所有者補正候補", href: "/admin/owners/correction", icon: ic(UserCog), minRole: "admin" },
      { label: "法人番号紐づけ", href: "/admin/owners/correction?tab=corporate_restore", icon: ic(Link2), minRole: "admin" },
      { label: "表示名監査", href: "/admin/display-name-audit", icon: ic(ScanSearch), minRole: "admin" },
      { label: "郵便番号×住所チェック", href: "/admin/postal-code-audit", icon: ic(MapPinned), minRole: "admin" },
      { label: "テキスト衛生監査", href: "/admin/owners/text-hygiene", icon: ic(ScanText), minRole: "admin" },
      { label: "氏名・連絡先チェック", href: "/admin/owners/quality-audit", icon: ic(ClipboardCheck), minRole: "admin" },
      // ⚠物件削除で孤児化した送付記録の訂正・取消(PR-B・設計§2.4)は
      //   「DM」グループへ移した(DM の道具がここに紛れていたため)。
    ],
  },
  {
    key: "admin",
    // R3 = 名前はそのまま(発注者決定 2026-08-24)。中身が伝わるよう説明を添える。
    label: "システム管理",
    description: "利用者・権限と、操作の記録",
    collapsible: true,
    items: [
      { label: "ユーザー管理", href: "/admin/users", icon: ic(Users), minRole: "admin" },
      { label: "権限テンプレート", href: "/admin/templates", icon: ic(Shield), minRole: "admin" },
      { label: "パスワード変更", href: "/admin/change-password", icon: ic(KeyRound), minRole: "admin" },
      { label: "権限変更履歴", href: "/admin/permission-logs", icon: ic(History), minRole: "admin" },
      { label: "監査ログ", href: "/admin/audit-logs", icon: ic(ClipboardList), minRole: "admin" },
      // ⚠「販売図面」から移動(発注者指示 2026-08-25: 常用しないので普段の並びから外す)。
      // ⚠**DM の差出人はここではない**(@codex #411 R3 P2・実測)。この画面が書くのは
      //   CompanyProfile で、読むのは販売図面(sales-sheet)だけ。DM の差出人は
      //   SaleDmConfig / SALE_DM_* から解決され、売却DM設定の画面で変える。
      //   「図面・DMの差出人」と名乗ると、DMの差出人を直しに来た人が**変わらない
      //   設定をいじって古い差出人のまま郵送してしまう**。
      { label: "会社情報（販売図面の差出人）", href: "/admin/company-settings", icon: ic(Building2), minRole: "admin" },
      // ⚠添付ファイル検索は「物件」グループへ移した(日々の道具のため)。
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

/** 同じページの中の場所を指す項目(`/import#owner-match` など)の一覧。 */
const ANCHOR_HREFS = SIDEBAR_GROUPS.flatMap((g) => g.items)
  .map((i) => i.href)
  .filter((h) => h.includes("#"));

/**
 * サイドバー項目の現在地ハイライト判定(純関数=テスト可能)。
 * - `/properties` は一覧および物件詳細(`/properties/<id>`)で点灯するが、上記の別機能ページ
 *   (品質チェック・売却DM)では点灯させない。
 * - `/import` は完全一致のみ(`/import/registry-pdf` 等では点灯しない)。
 * - それ以外は完全一致、またはその配下(`href + "/"`)で点灯。
 * - ⚠**同じページの中の場所を指す項目**(`/import#owner-match`)は、いま見ている
 *   位置(hash)まで一致したときだけ点灯する(@codex #411 R2 P2)。押した項目とは
 *   別の項目が光る、という食い違いを防ぐ。裏返して、その位置を見ている間は
 *   ページ全体を指す項目(`/import`)を消す=2つ同時に光らせない。
 */
export function isNavItemActive(
  href: string,
  currentPath: string,
  currentHash = "",
): boolean {
  const hashAt = href.indexOf("#");
  if (hashAt !== -1) {
    const base = href.slice(0, hashAt);
    return currentPath === base && currentHash === href.slice(hashAt);
  }
  // いま見ている位置を担当する項目が別にあるなら、こちらは譲る。
  if (currentHash && ANCHOR_HREFS.includes(currentPath + currentHash)) return false;
  if (href === "/properties") {
    if (PROPERTIES_NON_LIST.some((p) => currentPath === p || currentPath.startsWith(p + "/"))) {
      return false;
    }
    return currentPath === href || currentPath.startsWith("/properties/");
  }
  if (href === "/import") return currentPath === "/import";
  return currentPath === href || currentPath.startsWith(href + "/");
}
