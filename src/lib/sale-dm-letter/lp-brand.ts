/**
 * 公開LP(売却DMのご案内ページ)の会社固有の固定情報(2026-10-06 発注者確認)。
 * 種類(相続・空き家…)をまたいで共通。電話番号・社名は従来どおり差出人の設定(DB)から取る。
 *  - 画像は public/lp-assets/brand/ の静的ファイル(公開口 /lp-assets/ の下=proxy.ts と本番 nginx の公開範囲のまま・CSP img-src 'self' の範囲)。
 *  - 画像は元の縦横比のまま載せる(width/height は元ファイルの実寸)。
 */
export interface LpBrandImage { src: string; width: number; height: number; alt: string }

export const LP_BRAND = {
  homepageUrl: "https://ligarejapan.com/",
  logo: { src: "/lp-assets/brand/logo.png", width: 1664, height: 243, alt: "Ligare Japan(株式会社リガーレジャパン)" },
  /** ヘッダーの小さな添え書き */
  tagline: "相続・空き家・不動産のご相談窓口",
  /** 電話の受付時間(発注者指定 2026-10-06) */
  phoneHours: "平日 10:00〜19:00",
  /** ヒーローの上の一言(QRから開いた人向け) */
  heroEyebrow: "お手紙をお読みいただいた方へ",
  /** ヒーローの3つの約束(発注者確認済み 2026-10-04: 貸す相談・遠方は電話メール中心・荷物そのまま=可能) */
  promises: ["ご相談・査定は無料", "売却を前提にしません", "遠方でも電話・メールで"],
  /** 案内役のイラスト(Canva作・実在の人物ではない) */
  guide: { src: "/lp-assets/brand/guide.jpg", width: 480, height: 480, alt: "相談窓口の担当者(イメージイラスト)" },
  guideName: "リガーレジャパン ご相談窓口より",
  /** 「窓口はひとつ」の提携先(発注者確認済み 2026-10-06)。専門家/業者の区別はしない(2026-10-07)。
   *  ⚠変えたら lp-figures.ts の NETWORK_LAYOUT(配置表)も作り直す。 */
  partners: ["司法書士", "税理士", "弁護士", "土地家屋調査士", "片付け業者", "引っ越し業者", "内装工事業者"],
  options: [
    { key: "sell", title: "売る", text: "今の価格の目安と、手元に残る金額の見込みをお伝えします。", image: { src: "/lp-assets/brand/opt-sell.jpg", width: 480, height: 480, alt: "契約書の上で家の鍵を手渡すイラスト" } },
    { key: "rent", title: "貸す", text: "貸したときの家賃の目安や、かかる手間もご説明します。", image: { src: "/lp-assets/brand/opt-rent.jpg", width: 480, height: 480, alt: "家の持ち主が入居する夫婦に鍵を渡すイラスト" } },
    { key: "keep", title: "しばらく持つ", text: "持ち続けるときの費用と、気をつけたい期限を整理します。", image: { src: "/lp-assets/brand/opt-keep.jpg", width: 480, height: 480, alt: "手入れされた庭のある静かな家のイラスト" } },
    // 4枚目(発注者決定 2026-10-08): 実例2件目のリースバックとつながる選択肢
    { key: "leaseback", title: "住み続けて売る", text: "自宅を売った後も、そのまま住み続けられる方法(リースバック)もご案内します。", image: { src: "/lp-assets/brand/opt-leaseback.jpg", width: 480, height: 480, alt: "自宅のリビングで息子夫婦や孫とくつろぐ祖父母のイラスト" } },
  ],
} as const;
