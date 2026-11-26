import type { AppRole } from "@/lib/nav/roles";

/**
 * 検索の枠で引く「画面」。メニューの項目(sidebar-model の SIDEBAR_GROUPS)はそこから自動で入る=
 * ここに書くのは、①メニューに無い画面 ②画面ごとの別名(言い換え・略語・中にある書類やタブの名前)だけ。
 */
export interface ExtraPage {
  label: string;
  href: string;
  minRole: AppRole;
  /** 何の画面か(一覧の2行目) */
  group: string;
}

/** メニューに出していないが、名前で飛べると便利な画面。 */
export const EXTRA_PAGES: ExtraPage[] = [
  { label: "新しい取引", href: "/deals/new", minRole: "field_staff", group: "取引" },
  { label: "表示の設定", href: "/settings/display", minRole: "field_staff", group: "設定" },
  // メニューの項目は管理者だけだが、右上の鍵のボタンから全員が自分のパスワードを変えられる(header.tsx)
  { label: "パスワード変更", href: "/admin/change-password", minRole: "field_staff", group: "設定" },
  { label: "受付帳CSV取込", href: "/import", minRole: "office_staff", group: "物件データ取り込み" },
  { label: "謄本PDF取込", href: "/import/registry-pdf", minRole: "office_staff", group: "物件データ取り込み" },
  { label: "売却DM設定", href: "/admin/sale-dm-settings", minRole: "admin", group: "LPメニュー" },
  { label: "LPの写真", href: "/admin/lp-assets", minRole: "admin", group: "LPメニュー" },
  { label: "DMの種類", href: "/admin/dm-scenarios", minRole: "admin", group: "LPメニュー" },
  { label: "ゴミ箱（削除した添付）", href: "/admin/attachments/trash", minRole: "admin", group: "物件" },
];

/**
 * 画面ごとの別名(道 → 言葉)。打った言葉がこのどれかに当たれば、その画面を出す。
 * ⚠個々の取引・物件の中の書類やタブは、その一覧の画面に寄せる(id の入る道へは飛べないため)。
 */
export const PAGE_ALIASES: Record<string, string[]> = {
  "/home": ["トップ", "最初の画面", "ダッシュボード"],
  "/inquiry-desk": ["反響", "電話", "問い合わせ", "内見", "業者", "業者の名簿", "受付", "キーボックス"],
  "/properties/sale-dm/inquiries": ["査定", "査定依頼", "申込", "一括査定", "追客"],
  "/properties": ["物件", "物件検索", "検索", "一覧", "所有者", "謄本", "登記", "添付", "写真"],
  "/buildings": ["マンション", "棟", "建物", "管理規約", "規約"],
  "/properties/quality-check": ["エラー", "データの誤り", "品質", "チェック"],
  "/admin/attachments": ["添付検索", "ファイル検索", "書類検索", "pdf"],
  "/deals": [
    "取引", "契約", "決済", "案件", "売買", "仲介", "重要事項説明", "重説", "売買契約書", "鍵受領書", "鍵",
    "領収書", "取引完了確認書", "取引確認書", "精算", "手付金", "残金", "集合ポスト", "固定資産税", "評価額",
  ],
  "/deals/new": ["取引を作る", "取引の登録", "新規取引", "契約の登録"],
  "/field-survey/map": ["地図", "マップ", "現地", "現調", "巡回", "空き家"],
  "/field-survey/sessions": ["巡回の記録", "踏破", "ヒートマップ"],
  "/field-survey/candidates": ["物件化", "完成待ち", "候補"],
  "/dm": ["dm", "宛名", "手紙", "郵送", "ダイレクトメール"],
  "/properties/sale-dm": ["発送", "売却dm", "送った記録"],
  "/lp": ["lp", "ランディングページ", "ホームページ"],
  "/admin/mail-settings": ["メールの設定", "送信元", "smtp"],
  "/admin/orphan-dm-logs": ["送付記録", "記録の訂正"],
  "/import/drop": ["取り込み", "取込", "アップロード", "インポート", "csv", "エクセル"],
  "/import/registry-dm": ["一括添付", "取得済みpdf"],
  "/import/paste": ["貼り付け", "コピペ", "メールから物件"],
  "/import/report-inbox": ["受け取り箱", "報告書", "査定サイト"],
  "/import/registry-owners": ["所有者の反映", "まとめて反映"],
  "/sales-sheets/new": ["図面", "チラシ", "マイソク", "販売図面"],
  "/properties/registry-owner-review": ["名義", "名義違い", "名義の確認"],
  "/admin/owners/correction": ["所有者の直し", "重複", "同じ人", "名寄せ", "住所なし", "法人番号"],
  "/admin/users": ["ユーザー", "利用者", "社員", "アカウント", "ユーザー追加"],
  "/admin/templates": ["権限", "テンプレート"],
  "/admin/change-password": ["パスワード", "暗証番号"],
  "/admin/permission-logs": ["権限の履歴"],
  "/admin/audit-logs": ["操作の記録", "ログ", "監査", "履歴"],
  "/admin/company-settings": ["会社情報", "差出人", "会社名"],
  "/admin/deal-settings": ["取引の設定", "宅建業", "免許番号"],
  "/admin/drive": ["ドライブ", "グーグルドライブ", "google"],
  "/docs/guide.html": ["使い方", "ガイド", "説明"],
  "/docs/manual.html": ["マニュアル", "取扱説明書", "手引き"],
  "/help": ["ヘルプ", "困ったとき"],
  "/settings/display": ["色", "ダークモード", "文字の大きさ", "テーマ", "上のメニュー"],
  "/admin/sale-dm-settings": ["売却dmの設定"],
  "/admin/lp-assets": ["lpの写真"],
  "/admin/dm-scenarios": ["dmの種類", "文面"],
  "/admin/attachments/trash": ["ゴミ箱", "削除した添付", "元に戻す"],
};
