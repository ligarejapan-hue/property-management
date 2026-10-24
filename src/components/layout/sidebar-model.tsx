import {
  Home,
  PhoneIncoming,
  Link2,
  Building2,
  Building,
  Users,
  Shield,
  FileText,
  HelpCircle,
  ClipboardList,
  ClipboardPaste,
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
  Inbox,
  ListChecks,
  Globe,
  Handshake,
} from "lucide-react";
import { canSee, type AppRole } from "@/lib/nav/roles";

export interface NavLeaf {
  label: string;
  href: string;
  icon: React.ReactNode;
  minRole: AppRole;
  /** true のとき Link ではなく別タブの <a>(静的HTML資料)。 */
  external?: boolean;
  /** external のとき開く窓の名前(同じ名前の窓があればそこに開く)。無ければ新しいタブ。 */
  windowName?: string;
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
  /**
   * 左メニューの柱(発注者決定 2026-10-15)。見出しを普通の項目と同じ大きさで出し、
   * 押すと中が開く。中が1つだけのときは見出しそのものがその画面へのリンクになる。
   * 柱でないグループ(物件データ編集・システム管理・資料)は区切り線の下に今まで通り出す。
   */
  pillar?: boolean;
  /** 柱の見出しに出す絵(pillar のときだけ使う)。 */
  icon?: React.ReactNode;
  items: NavLeaf[];
}

const ic = (C: React.ComponentType<{ className?: string }>) => <C className="h-5 w-5" />;

/** サイドバーの全定義(役割で絞る前)。順序はそのまま表示順。 */
export const SIDEBAR_GROUPS: NavGroup[] = [
  {
    key: "home",
    label: null,
    items: [
      { label: "ホーム", href: "/home", icon: ic(Home), minRole: "field_staff" },
    ],
  },
  {
    key: "inquiry",
    label: "反響受付",
    pillar: true,
    icon: ic(PhoneIncoming),
    items: [
      // 業者からの反響の受付(設計 2026-09-28 §2.1)=メイン画面と分けて別窓で開きっぱなしにする。
      // 全員が使う(方針10)。同じ名前の窓があればそこに開く(何枚も増やさない)。
      {
        label: "反響の受付",
        href: "/inquiry-desk",
        icon: ic(PhoneIncoming),
        minRole: "field_staff",
        external: true,
        windowName: "pm-inquiry-desk",
      },
      // ⚠業者の名簿(/agents)はメニューに出さない=反響の受付の窓の中のタブから開く
      //   (発注者決定 2026-10-15)。
      // 公開LPから届いた査定の申込の横断一覧(発注者判断 2026-09-18: キャンペーン作成者に
      // 限らず、売却DMを使える人は誰でも見て対応できる)。通知メールのリンク先。
      // ⚠「DM」から反響受付へ移した(発注者決定 2026-10-15: お客さまからの問い合わせとして一緒に)。
      // ⚠minRole は field_staff(whole-branch review Minor #4): 通知メールは自分が作成/担当
      // する物件の申込について field_staff にも届く(inquiry-notify.ts resolveRecipients)が、
      // その担当者はメールのリンクからしかこの画面に到達できなかった(サイドバーに出ない=
      // 一覧から他の申込へ気付けない)。認可自体は route 側(field_staff は担当範囲のみ)の
      // ままなので、メニューに出すだけでは見える範囲は広がらない。
      { label: "査定の申込", href: "/properties/sale-dm/inquiries", icon: ic(Inbox), minRole: "field_staff" },
    ],
  },
  {
    key: "prop",
    label: "物件",
    pillar: true,
    icon: ic(Building2),
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
    // 取引(設計 2026-10-23 §5)。全員が使う(発注者決定)。項目が1つなので見出しがそのままリンクになる。
    key: "deal",
    label: "取引",
    pillar: true,
    icon: ic(Handshake),
    items: [{ label: "取引", href: "/deals", icon: ic(Handshake), minRole: "field_staff" }],
  },
  {
    key: "field",
    label: "現地調査",
    pillar: true,
    icon: ic(MapIcon),
    items: [
      { label: "現地調査マップ", href: "/field-survey/map", icon: ic(MapIcon), minRole: "field_staff" },
      { label: "巡回履歴", href: "/field-survey/sessions", icon: ic(History), minRole: "field_staff" },
      { label: "物件化の完成待ち", href: "/field-survey/candidates", icon: ic(ClipboardCheck), minRole: "field_staff" },
    ],
  },
  {
    key: "dm",
    label: "DM・LP関係",
    description: "宛名の出力・お手紙とLPの作成・記録の訂正",
    pillar: true,
    icon: ic(Mail),
    items: [
      // 入口ページ(案B)。宛名CSVや売却DMの作成は従来どおり物件一覧にあり、
      // ここはそこへの分かりやすい入口を足すもの。
      { label: "DMメニュー", href: "/dm", icon: ic(Mail), minRole: "office_staff" },
      // 作った売却DMの発送をあとで開き直す入口(画面すっきり化 第1回・2026-10-15)。
      // それまでは作成直後の画面遷移でしか発送の画面に行けなかった。
      { label: "売却DMの発送一覧", href: "/properties/sale-dm", icon: ic(ListChecks), minRole: "office_staff" },
      // LPの入口ページ(発注者決定 2026-10-15 案B)。LPの道具(売却DM設定・LPの写真・DMの種類)は
      // どれも管理者用なので、入口も管理者にだけ出す。
      // ⚠画面すっきり化 第2回(発注者決定 2026-10-15): LPの道具3つは左メニューから外し、
      //   LPメニューの中だけに置く(画面と URL はそのまま)。その3画面にいる間はLPメニューが光る(LP_TOOL_PATHS)。
      { label: "LPメニュー", href: "/lp", icon: ic(Globe), minRole: "admin" },
      // ⚠「査定の申込」は反響受付へ移した(発注者決定 2026-10-15)。
      // 査定申込の通知メールを送る Xserver メールボックスの設定(2026-09 新設)。
      { label: "メール送信設定", href: "/admin/mail-settings", icon: ic(Mail), minRole: "admin" },
      // ⚠「データ品質」から移動(DM の道具がそこに紛れていた)。
      { label: "送付記録の訂正", href: "/admin/orphan-dm-logs", icon: ic(MailX), minRole: "admin" },
    ],
  },
  {
    key: "imp",
    label: "物件データ取り込み",
    description: "外部の一覧・書類からまとめて登録",
    pillar: true,
    icon: ic(Upload),
    items: [
      { label: "受付帳CSV取込", href: "/import", icon: ic(Upload), minRole: "office_staff" },
      { label: "謄本PDF取込", href: "/import/registry-pdf", icon: ic(FileText), minRole: "office_staff" },
      // ⚠取込画面の中のタブからしか行けなかった。
      // 第4回 D(2026-10-16): 受付帳・所有者の取込は「受付帳CSV取込」へまとめ、PDFの一括添付だけが残った(URLは据え置き)。
      { label: "取得済みPDFを一括添付", href: "/import/registry-dm", icon: ic(Mail), minRole: "office_staff" },
      // ⚠**アプリ内のリンクがゼロ**で、URL を直に打つしか到達手段が無かった
      //   (2026-08-16 に発見・08-24 の再実測でも同じ)。
      // ⚠行き先は取込画面の**該当セクション**(@codex #411 R1 P2)。/import/owners は
      //   そこへ送るだけの転送ページで、素の /import へ送ると受付帳の取込と
      //   見分けがつかない場所に着いてしまう。
      { label: "所有者CSV取込", href: "/import#owner-match", icon: ic(Users), minRole: "office_staff" },
      // 社外から届いたメール・PDF・ブラウザ画面を貼って物件にする(2026-08 新設)。
      { label: "貼り付けて物件化", href: "/import/paste", icon: ic(ClipboardPaste), minRole: "office_staff" },
      // 査定サイトの報告書PDFを受け取り、候補の物件に添付する(2026-10-10)。
      // ⚠実際に使えるのは所有者情報をすべて見られる人だけ(画面を開くとAPIが判定して案内する)。
      { label: "書類の受け取り箱", href: "/import/report-inbox", icon: ic(FileText), minRole: "office_staff" },
      // ⚠**管理者のみ**。他人の担当物件もまとめて触るため(APIも管理者だけを通す)。
      //   1件ずつの反映は物件ページの所有者タブにある(こちらは溜まった分の一括処理)。
      { label: "謄本から所有者をまとめて反映", href: "/import/registry-owners", icon: ic(Users), minRole: "admin" },
    ],
  },
  {
    key: "sheet",
    label: "販売図面",
    description: "売り出しの1枚チラシ",
    pillar: true,
    icon: ic(Newspaper),
    items: [
      // 柱に項目が1つなので、左メニューには柱の名前「販売図面」で出る。開いた先の題名も同じ名前に
      // 揃える(実機確認 2026-10-22: 「販売図面を作成」だけメニューと題名が食い違っていた)。
      { label: "販売図面", href: "/sales-sheets/new", icon: ic(Newspaper), minRole: "office_staff" },
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
      { label: "家屋番号チェック", href: "/admin/building-number-audit", icon: ic(ScanSearch), minRole: "admin" },
      { label: "テキスト衛生監査", href: "/admin/owners/text-hygiene", icon: ic(ScanText), minRole: "admin" },
      { label: "氏名・連絡先チェック", href: "/admin/owners/quality-audit", icon: ic(ClipboardCheck), minRole: "admin" },
      // ⚠物件削除で孤児化した送付記録の訂正・取消(PR-B・設計§2.4)は
      //   「DM・LP関係」グループへ移した(DM の道具がここに紛れていたため)。
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
      // 取引の設定(設計 2026-10-23 §5)。会社名・住所などは上の会社情報を使う。
      { label: "取引の設定", href: "/admin/deal-settings", icon: ic(Handshake), minRole: "admin" },
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
const SALE_DM_INQUIRIES = "/properties/sale-dm/inquiries";
/** 左メニューには出さず、LPメニュー(/lp)の中にだけ入口がある画面(画面すっきり化 第2回)。 */
export const LP_TOOL_PATHS = ["/admin/sale-dm-settings", "/admin/lp-assets", "/admin/dm-scenarios"];

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
  // LPメニューは、その中にだけ入口がある3画面でも光る(=DM・LP関係の見出しも自動で開く)。
  if (href === "/lp" && LP_TOOL_PATHS.some((p) => currentPath === p || currentPath.startsWith(p + "/"))) {
    return true;
  }
  // 発送一覧は、一覧と各発送の画面で光る。同じ道の下にある「査定の申込」では光らせない(2つ同時に光らせない)。
  if (href === "/properties/sale-dm") {
    if (currentPath === SALE_DM_INQUIRIES || currentPath.startsWith(SALE_DM_INQUIRIES + "/")) return false;
    return currentPath === href || currentPath.startsWith(href + "/");
  }
  return currentPath === href || currentPath.startsWith(href + "/");
}
