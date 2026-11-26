import type { AppRole } from "@/lib/nav/roles";

export interface HowtoEntry {
  /** 一意の英小文字とハイフン */
  id: string;
  /** 一覧に出す見出し(「〜したい」「〜はどこ」の形・短く) */
  title: string;
  /** 答え(1〜3文・平易な日本語・画面名やタブ名・ボタン名はコードと同じ表記で「」で囲む) */
  answer: string;
  /** 探す言葉。名詞中心・2〜6文字程度の語を5〜12個。別名・略語・言い換えを入れる(例: 取引確認書→取引完了確認書, 規約→管理規約)。助詞や「したい」は入れない */
  keywords: string[];
  /** 飛び先。ログイン後の固定の画面の道だけ(/deals など・id の入る道は不可)。資料なら /docs/guide.html など */
  href: string;
  /** 飛び先のボタンに出す名前(例: 「取引の一覧へ」) */
  hrefLabel: string;
  /** これより下の役割には出さない(飛び先のメニュー項目の minRole 以上にする) */
  minRole: AppRole;
}

// 画面名・タブ名・ボタン名はコードの表記どおり(public/docs のガイド・マニュアルと合わせる)。
export const HOWTO_ENTRIES: HowtoEntry[] = [
  // ── 物件 ──
  {
    id: "property-search",
    title: "物件を探したい",
    answer:
      "「物件一覧」の検索欄に住所・物件名・地番を入れると絞り込めます。所有者の名前や電話番号を入れると、下に候補が出て、選ぶとその物件が開きます。",
    keywords: ["物件検索", "検索", "探す", "住所", "物件名", "地番", "所有者名", "電話番号", "物件一覧"],
    href: "/properties",
    hrefLabel: "物件一覧へ",
    minRole: "office_staff",
  },
  {
    id: "property-register",
    title: "物件を新しく登録したい",
    answer:
      "「物件一覧」の右上の「新規物件登録」を押し、分かる範囲で入れて保存します。空いている欄はあとから足せます。",
    keywords: ["新規登録", "物件登録", "登録", "追加", "新規物件", "入力", "物件作成"],
    href: "/properties",
    hrefLabel: "物件一覧へ",
    minRole: "office_staff",
  },
  {
    id: "property-edit",
    title: "物件の情報を直したい",
    answer:
      "物件の画面の上の「物件を編集」を押すと、基本・販売・調査の欄を直せます。価格や現況は「販売」の欄です。",
    keywords: ["編集", "修正", "変更", "物件編集", "価格", "現況", "面積", "直す"],
    href: "/properties",
    hrefLabel: "物件一覧へ",
    minRole: "office_staff",
  },
  {
    id: "registry-fetch",
    title: "謄本を取りたい",
    answer:
      "物件の画面の「その他」から「所在で謄本を検索」を押します。登記情報サービスの時間内(平日8:30〜23:00・土日祝8:30〜18:00)だけ使え、取得は有料です。",
    keywords: ["謄本", "登記簿", "全部事項", "所有者事項", "謄本取得", "登記", "所在検索", "登記情報"],
    href: "/properties",
    hrefLabel: "物件一覧へ",
    minRole: "office_staff",
  },
  {
    id: "registry-reflect",
    title: "謄本の面積や地番を基本情報に入れたい",
    answer:
      "全部事項の謄本を添付すると、基本情報の空いている欄に面積・地番・家屋番号などが自動で入ります。前に添付した謄本は、添付の行の「この謄本から基本情報に反映」を押します。",
    keywords: ["謄本反映", "面積", "地番", "家屋番号", "築年月", "構造", "基本情報", "全部事項"],
    href: "/properties",
    hrefLabel: "物件一覧へ",
    minRole: "office_staff",
  },
  {
    id: "owner-edit",
    title: "所有者の住所を直したい・メモを残したい",
    answer:
      "物件の画面の「所有者情報」タブで、住所などの確認・直しと、この物件についてのメモを残せます。メモの履歴は消えずに積み重なります。",
    keywords: ["所有者", "持ち主", "オーナー", "住所変更", "メモ", "所有者情報", "連絡先", "持分"],
    href: "/properties",
    hrefLabel: "物件一覧へ",
    minRole: "office_staff",
  },
  {
    id: "property-attach",
    title: "物件に書類を添付したい",
    answer:
      "物件の画面の「添付ファイル」タブの点線の枠に入れます。謄本・書類・画像を同じ枠に入れられ、書類の種類は自動で当てます。",
    keywords: ["添付", "添付ファイル", "書類", "PDF", "アップロード", "管理規約", "規約", "契約書", "重説"],
    href: "/properties",
    hrefLabel: "物件一覧へ",
    minRole: "office_staff",
  },
  {
    id: "report-inbox",
    title: "どの物件のものか分からない書類を付けたい",
    answer:
      "「書類の受け取り箱」に入れると、本文から添付先の物件の候補と書類の種類が出ます。",
    keywords: ["受け取り箱", "書類", "査定報告書", "契約書", "管理規約", "振り分け", "未整理"],
    href: "/import/report-inbox",
    hrefLabel: "書類の受け取り箱へ",
    minRole: "office_staff",
  },
  {
    id: "sales-sheet",
    title: "販売図面(マイソク)を作りたい",
    answer:
      "物件の画面の「販売図面を作成」か、メニューの「販売図面」から作ります。保存してから「PDF出力」かPNG出力で書き出します。",
    keywords: ["販売図面", "マイソク", "チラシ", "図面", "PDF出力", "広告"],
    href: "/sales-sheets/new",
    hrefLabel: "販売図面へ",
    minRole: "office_staff",
  },
  {
    id: "key-box-register",
    title: "キーボックスの場所と番号を登録したい",
    answer:
      "物件の画面の「物件を編集」の「基本」に「キーボックスの設置場所」と「キーボックスの解除番号」があります。入れた値は「反響の受付」の窓と物件の「反響」タブに出ます。",
    keywords: ["キーボックス", "鍵", "解除番号", "暗証番号", "設置場所", "内見", "キーBOX"],
    href: "/properties",
    hrefLabel: "物件一覧へ",
    minRole: "office_staff",
  },
  {
    id: "key-box-view",
    title: "内見の電話でキーボックスの番号を見たい",
    answer:
      "「反響の受付」の窓で物件を選ぶと「キーボックス」として設置場所と解除番号が出ます(反響の詳細・今日明日の内見にも出ます)。",
    keywords: ["キーボックス", "解除番号", "暗証番号", "内見", "鍵", "業者", "電話"],
    href: "/inquiry-desk",
    hrefLabel: "反響の受付へ",
    minRole: "field_staff",
  },
  {
    id: "property-photos",
    title: "物件に写真を載せたい",
    answer:
      "物件の画面の「写真」タブの点線の枠に写真を入れます(まとめて複数可)。",
    keywords: ["写真", "画像", "アップロード", "外観", "室内", "代表写真"],
    href: "/properties",
    hrefLabel: "物件一覧へ",
    minRole: "office_staff",
  },
  {
    id: "investigation",
    title: "用途地域やハザードを調べたい",
    answer:
      "物件の画面の「調査情報」タブで「調査情報を取得」を押すと、取れた分(用途地域・建蔽率・容積率・災害の想定など)が入ります。取れなかった欄は手で入れます。",
    keywords: ["調査情報", "用途地域", "建蔽率", "容積率", "ハザード", "洪水", "防火地域", "道路"],
    href: "/properties",
    hrefLabel: "物件一覧へ",
    minRole: "office_staff",
  },
  {
    id: "csv-export",
    title: "物件の一覧をCSVで出したい",
    answer:
      "「物件一覧」の「出力」から「CSV出力」を押し、出す列を選びます。絞り込んでいれば、その条件の物件だけが出ます。",
    keywords: ["CSV", "エクセル", "Excel", "書き出し", "出力", "一覧表", "ダウンロード"],
    href: "/properties",
    hrefLabel: "物件一覧へ",
    minRole: "office_staff",
  },
  {
    id: "registry-owner-review",
    title: "謄本と所有者の名義が違う物件を見たい",
    answer:
      "「謄本の名義の確認」に、添付した謄本の名義とシステムの所有者が違う物件が並びます。1件ずつ開いて違いを確かめます。",
    keywords: ["名義", "謄本", "所有者違い", "名義違い", "登記名義人", "相続"],
    href: "/properties/registry-owner-review",
    hrefLabel: "謄本の名義の確認へ",
    minRole: "office_staff",
  },
  {
    id: "owner-duplicate",
    title: "同じ所有者が2人に分かれているのをまとめたい",
    answer:
      "「所有者の直し」の「重複候補」タブで、同じ人・同じ会社らしい所有者を確かめ、「統合プレビュー」を見てからまとめます(管理者だけ)。",
    keywords: ["重複", "名寄せ", "統合", "所有者", "二重", "まとめる", "所有者の直し"],
    href: "/admin/owners/correction",
    hrefLabel: "所有者の直しへ",
    minRole: "admin",
  },

  // ── 取引 ──
  {
    id: "deal-create",
    title: "取引を作りたい",
    answer:
      "「取引」の「新しい取引」から作ります。物件の画面の「その他」→「この物件で取引を作成」から作ると、物件名・住所・面積などが写されます。",
    keywords: ["取引", "新しい取引", "案件", "売買", "取引作成", "仲介", "買取再販"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "deal-dates",
    title: "契約日・決済日を入れたい",
    answer:
      "取引の「基本」タブの「契約日時」「決済日時」に入れます。物件の画面の契約予定日・決済予定日は、取引の日付が写るので物件側では直せません。",
    keywords: ["契約日", "決済日", "契約日時", "決済日時", "引渡日", "日程", "予定日", "場所"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "deal-parties",
    title: "売主・買主を入れたい",
    answer:
      "取引の「当事者」タブで売主・買主・代理人・賃借人を足します。「自社を入れる」で会社の情報が、「物件の所有者を売主に入れる」で物件の所有者が入ります。",
    keywords: ["当事者", "売主", "買主", "代理人", "賃借人", "自社", "持分"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "deal-money",
    title: "売買価格・手付金・仲介手数料を入れたい",
    answer:
      "取引の「金額・費用」タブに入れます。仲介手数料の上限・建物消費税・印紙税は自動で計算し、手で直すこともできます。",
    keywords: ["売買価格", "手付金", "仲介手数料", "手数料", "印紙税", "登記費用", "金額", "費用"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "deal-assessed-value",
    title: "固定資産税評価額はどこに入れる・どの書類に載ってる？",
    answer:
      "評価額は固定資産評価証明書に載っています(添付の種類は「評価証明・公課証明」)。取引の「物件」タブの「固都税の評価額(筆ごと)」に家屋評価額・土地評価額を入れると、「金額・費用」タブの建物価格と建物消費税の按分に使います。",
    keywords: ["評価額", "固定資産税評価額", "評価証明", "評価証明書", "固都税", "家屋評価額", "土地評価額", "公課証明", "建物消費税"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "deal-tax-settlement",
    title: "固定資産税・都市計画税を精算したい",
    answer:
      "取引の「精算」タブで「土地・建物ごと」か「合計額だけ」を選んで入れ、「保存して計算する」を押します。土地・建物ごとなら評価証明書の課税標準額から税額を出します。",
    keywords: ["固都税", "固定資産税", "都市計画税", "精算", "日割り", "課税標準額", "起算日", "納税通知書"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "deal-payments",
    title: "振込先の口座・払い方を入れたい",
    answer:
      "取引の「お金の受け渡し」タブで、お金ごとに振込・現金・未定を選び、振込なら口座を入れて保存します。残金決済のご案内と書類確認書に初めから入ります。",
    keywords: ["振込先", "口座", "払い方", "振込", "現金", "お金の受け渡し", "銀行"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "deal-oc",
    title: "オーナーチェンジの賃料・敷金を入れたい",
    answer:
      "取引の「OC」タブで、部屋ごとの賃料・共益費・敷金・滞納・管理会社を入れます。賃料は売主から買主へ日割りで精算します。",
    keywords: ["OC", "オーナーチェンジ", "賃料", "敷金", "家賃", "賃借人", "共益費"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "deal-mailbox",
    title: "集合ポストの解除番号を記録したい",
    answer:
      "取引の「物件」タブの「集合ポスト」で、未確認・なし・ありを選び、「解除番号」「解除方法」を入れて「集合ポストを保存」を押します。鍵受領書に載ります。",
    keywords: ["集合ポスト", "ポスト", "郵便受け", "解除番号", "解除方法", "暗証番号", "ダイヤル"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "deal-keys",
    title: "鍵の本数を入力したい",
    answer:
      "取引の「物件」タブの「鍵」で、「鍵の番号・種類と本数」を1行ずつ入れ(「行を足す」で増やせます)、「鍵を保存」を押します。鍵受領書を出すとき初めから入ります。",
    keywords: ["鍵", "本数", "鍵番号", "合鍵", "キー", "鍵の種類", "引渡し"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "doc-key-receipt",
    title: "鍵受領書を出したい",
    answer:
      "取引の「書類」タブの「そのほかの書類」から「鍵受領書」を押します。鍵の行は「物件」タブの「鍵」の内容、集合ポストの番号は「集合ポスト」の内容が入ります。",
    keywords: ["鍵受領書", "鍵", "受領書", "鍵の受け渡し", "引渡し", "集合ポスト"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "doc-receipts",
    title: "領収書を出したい",
    answer:
      "取引の「書類」タブの「決済の書類」から「手付金領収書」「残金領収書」「精算金領収書」を出します。手付金・残金の領収書は、売主の当事者を発行者にして出します。",
    keywords: ["領収書", "手付金領収書", "残金領収書", "精算金領収書", "手付金", "残金", "印紙"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "doc-settlement-statement",
    title: "精算書を出したい",
    answer:
      "取引の「書類」タブの「決済の書類」から「精算書」を出します。中身は「精算」タブの計算の結果です。",
    keywords: ["精算書", "精算", "固都税", "管理費", "日割り", "決済"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "doc-settlement-guide",
    title: "残金決済のご案内を出したい",
    answer:
      "取引の「書類」タブの「決済の書類」から、買主あての「残金決済のご案内」か売主あての「残金決済のご案内(売主様)」を出します。",
    keywords: ["残金決済のご案内", "決済案内", "決済", "残代金", "振込先", "お持ちいただくもの"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "doc-completion",
    title: "取引完了確認書を出したい",
    answer: "取引の「書類」タブの「決済の書類」から「取引完了確認書」を出します。",
    keywords: ["取引完了確認書", "取引確認書", "完了確認書", "完了確認", "引渡完了", "決済"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "doc-mediation",
    title: "媒介契約書を出したい",
    answer:
      "仲介の取引で、取引の「書類」タブの「契約・媒介の書類」から「媒介契約書」を出します。発行の小窓で一般・専任・専属専任を選びます。",
    keywords: ["媒介契約書", "媒介", "専任", "専属専任", "一般媒介", "媒介契約"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "doc-contract-guide",
    title: "契約のご案内を出したい",
    answer:
      "取引の「書類」タブの「契約・媒介の書類」から「契約のご案内」を出し、宛先(売主様・買主様)を選びます。",
    keywords: ["契約のご案内", "契約案内", "契約", "持ち物", "持参"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "doc-power-of-attorney",
    title: "委任状を出したい",
    answer:
      "取引の「書類」タブの「そのほかの書類」から「委任状」を出します。委任する人・委任を受ける人・委任する事項を選びます。",
    keywords: ["委任状", "委任", "代理", "評価証明取得", "代理人"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "doc-checklist",
    title: "書類確認書・準備チェックリストを出したい",
    answer:
      "取引の「書類」タブの「書類確認書」から、「書類確認書(契約時)」「書類確認書(決済時)」「準備チェックリスト」を出します。",
    keywords: ["書類確認書", "チェックリスト", "準備チェックリスト", "持参するもの", "必要書類", "契約時", "決済時"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "doc-oc",
    title: "賃貸人変更のお知らせを出したい",
    answer:
      "オーナーチェンジの取引では、取引の「書類」タブの「OC の書類」から「賃貸人変更のお知らせ」「仕入相談表」「賃借人属性調査書」「引継書類チェックリスト」を出せます。",
    keywords: ["賃貸人変更のお知らせ", "仕入相談表", "賃借人属性調査書", "引継書類チェックリスト", "OC", "オーナーチェンジ"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "doc-seller-survey",
    title: "売主属性調査書を出したい",
    answer:
      "売主がいる取引で、取引の「書類」タブの「契約・媒介の書類」から「売主属性調査書(社内用)」を出します。お客様に渡す書類ではありません。",
    keywords: ["売主属性調査書", "属性調査", "社内用", "本人確認", "反社"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "doc-funding-plan",
    title: "資金計画表を作りたい",
    answer:
      "取引の画面の右上の「資金計画表」を押し、「購入」か「売却」を選んで入力します。「保存して発行(PDF・Excel)」で書類にします。",
    keywords: ["資金計画表", "資金計画", "ローン", "返済", "手取り", "諸費用", "見積"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "doc-business-plan",
    title: "事業計画書を作りたい",
    answer:
      "買取再販の取引だけ、取引の画面の右上に「事業計画書」が出ます。「社内用」「銀行向け」を選んで入力し、PDF・Excelで発行します。",
    keywords: ["事業計画書", "事業計画", "収支", "利回り", "銀行向け", "買取再販", "粗利"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "deal-doc-history",
    title: "発行した書類をもう一度開きたい",
    answer:
      "取引の「書類」タブに、発行した書類の履歴(書類名・版・発行日時・発行した人)が並びます。「PDF」で開き、「Excel」で保存できます。",
    keywords: ["発行履歴", "書類", "再発行", "PDF", "Excel", "版", "履歴"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "deal-customer-upload",
    title: "お客様に書類をスマホで出してもらいたい",
    answer:
      "取引の画面の「お客様の書類提出」で売主・買主ごとに提出用リンクを発行し、「案内の文面をコピー」でご自分のLINEやメールから送ります。",
    keywords: ["書類提出", "提出用リンク", "アップロード", "印鑑証明", "住民票", "身分証", "お客様"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "deal-timeline",
    title: "取引のこれまでの経緯を見たい",
    answer:
      "取引の「経緯」タブで、コメント・反響・段取り・書類の発行などを新しい順に1本で見られます。担当者が休みの日の問い合わせに使えます。",
    keywords: ["経緯", "履歴", "タイムライン", "やり取り", "段取り", "記録"],
    href: "/deals",
    hrefLabel: "取引の一覧へ",
    minRole: "field_staff",
  },
  {
    id: "deal-settings",
    title: "書類の会社の口座・角印・確認項目を変えたい",
    answer:
      "「取引の設定」で、代表者・振込先口座・書類確認書の項目・段取りのひな形・ロゴ・角印を変えられます(管理者だけ)。",
    keywords: ["取引の設定", "角印", "ロゴ", "振込先口座", "ひな形", "書類確認書", "段取り"],
    href: "/admin/deal-settings",
    hrefLabel: "取引の設定へ",
    minRole: "admin",
  },

  // ── 反響の受付 ──
  {
    id: "inquiry-desk",
    title: "業者からの内見・資料請求を受け付けたい",
    answer:
      "「反響の受付」の窓で業者と物件を選び、用件(内見・広告の許可・資料請求)を選んで「保存する」を押します。",
    keywords: ["反響", "受付", "内見", "資料請求", "広告の許可", "業者", "問い合わせ", "電話"],
    href: "/inquiry-desk",
    hrefLabel: "反響の受付へ",
    minRole: "field_staff",
  },
  {
    id: "material-send",
    title: "業者に物件資料をメールで送りたい",
    answer:
      "種類が「資料請求」の反響を開いて「資料を送る」を押し、送るファイルにチェックを入れて送信します(合計20MB・20ファイルまで)。",
    keywords: ["資料送付", "資料を送る", "メール", "資料請求", "図面送付", "添付"],
    href: "/inquiry-desk",
    hrefLabel: "反響の受付へ",
    minRole: "field_staff",
  },
  {
    id: "sale-dm-inquiries",
    title: "届いた査定の申込を見たい",
    answer:
      "「査定の申込」に、ご案内ページ(LP)から届いた申込が未対応を上にして並びます。対応状況は未対応・対応中・対応済みから選びます。",
    keywords: ["査定の申込", "査定申込", "申込", "LP", "反響", "問い合わせ", "通知"],
    href: "/properties/sale-dm/inquiries",
    hrefLabel: "査定の申込へ",
    minRole: "field_staff",
  },

  // ── 現地調査 ──
  {
    id: "field-survey",
    title: "現地を回って写真とピンを残したい",
    answer:
      "「現地調査マップ」で「巡回を開始」を押し、現場で「撮って登録」を押します。回り終わったら「巡回終了」を押します。",
    keywords: ["現地調査", "巡回", "ピン", "撮影", "地図", "現場", "スマホ"],
    href: "/field-survey/map",
    hrefLabel: "現地調査マップへ",
    minRole: "field_staff",
  },
  {
    id: "field-survey-candidates",
    title: "現地で撮った候補を物件にしたい",
    answer:
      "「物件化の完成待ち」で候補を選んで「物件にする」を押します。住所は「ピンの位置から住所を入力」で自動で入ります(保存前に目で確かめてください)。",
    keywords: ["物件化", "完成待ち", "候補", "物件にする", "ピン", "現地調査"],
    href: "/field-survey/candidates",
    hrefLabel: "物件化の完成待ちへ",
    minRole: "field_staff",
  },

  // ── DM・LP ──
  {
    id: "dm-address-csv",
    title: "DMの宛名を出したい",
    answer:
      "「物件一覧」で送る物件を絞り込み、「出力」から「DM差込CSV出力」を押します。投函したら「出力」から「送付の確定」で日付を入れて記録します。",
    keywords: ["DM", "宛名", "差込", "CSV", "ダイレクトメール", "手紙", "送付の確定"],
    href: "/properties",
    hrefLabel: "物件一覧へ",
    minRole: "office_staff",
  },
  {
    id: "sale-dm",
    title: "売却DM(お手紙)を作って印刷したい",
    answer:
      "「物件一覧」で物件にチェックを入れ、帯の「売却DMを作成」を押します。作った発送は「売却DMの発送一覧」から開き直せます。",
    keywords: ["売却DM", "DM", "お手紙", "手紙", "キャンペーン", "印刷", "発送"],
    href: "/properties/sale-dm",
    hrefLabel: "売却DMの発送一覧へ",
    minRole: "office_staff",
  },
  {
    id: "dm-reaction",
    title: "DMの反響や宛先不明を記録したい",
    answer:
      "物件の画面の「その他」→「DM送付履歴」で「記録」を押し、連絡あり・拒否・宛先不明などを記録します。",
    keywords: ["DM送付履歴", "反響", "宛先不明", "拒否", "返送", "連絡あり"],
    href: "/properties",
    hrefLabel: "物件一覧へ",
    minRole: "office_staff",
  },
  {
    id: "mail-settings",
    title: "通知メール・受付メールの設定をしたい",
    answer:
      "「メール送信設定」で会社のメールボックスを入れ、「テスト送信」で届くか確かめます。申込者への受付メールや追客メールもここで設定します(管理者だけ)。",
    keywords: ["メール設定", "メール送信設定", "通知メール", "受付メール", "追客メール", "テスト送信"],
    href: "/admin/mail-settings",
    hrefLabel: "メール送信設定へ",
    minRole: "admin",
  },

  // ── 取り込み ──
  {
    id: "import-drop",
    title: "受付帳のCSVや謄本のPDFを取り込みたい",
    answer:
      "「ファイルを入れる」の点線の枠に入れると中身を見分けます。行の「受付帳の取り込みへ」「謄本の取り込みへ」などを押して取り込みの画面へ進みます。",
    keywords: ["取り込み", "取込", "インポート", "受付帳", "CSV", "謄本PDF", "ファイルを入れる"],
    href: "/import/drop",
    hrefLabel: "ファイルを入れるへ",
    minRole: "office_staff",
  },
  {
    id: "import-paste",
    title: "メールの文面から物件を登録したい",
    answer:
      "「貼り付けて物件化」に業者のメールやWebページの文章を貼り付けると、住所・種別・所有者などを読み取って入力欄に入れます。確かめてから登録します。",
    keywords: ["貼り付け", "物件化", "メール", "コピペ", "査定依頼", "一括査定", "HOME4U"],
    href: "/import/paste",
    hrefLabel: "貼り付けて物件化へ",
    minRole: "office_staff",
  },

  // ── 管理 ──
  {
    id: "user-add",
    title: "ユーザーを追加したい",
    answer:
      "「ユーザー管理」の「新規ユーザー作成」で追加し、役割と権限テンプレートを割り当てます(管理者だけ)。",
    keywords: ["ユーザー追加", "ユーザー", "アカウント", "社員", "利用者", "新規ユーザー", "担当者"],
    href: "/admin/users",
    hrefLabel: "ユーザー管理へ",
    minRole: "admin",
  },
  {
    id: "permission-template",
    title: "人ごとにできることを決めたい",
    answer: "「権限テンプレート」でできることのセットを作り、「ユーザー管理」で人に割り当てます(管理者だけ)。",
    keywords: ["権限", "権限テンプレート", "ロール", "役割", "アクセス権", "許可"],
    href: "/admin/templates",
    hrefLabel: "権限テンプレートへ",
    minRole: "admin",
  },
  {
    // ヘッダーの鍵のボタンから全員が開ける(メニューの項目は管理者だけ)。
    id: "password-change",
    title: "自分のパスワードを変えたい",
    answer:
      "画面右上の鍵のボタン(「パスワード変更」)を押し、今のパスワードと新しいパスワードを入れます。忘れたときは管理者に再設定をお願いします。",
    keywords: ["パスワード", "パスワード変更", "暗証", "ログイン", "再設定", "PW"],
    href: "/admin/change-password",
    hrefLabel: "パスワード変更へ",
    minRole: "field_staff",
  },
  {
    id: "audit-log",
    title: "誰がいつ何をしたか調べたい",
    answer: "「監査ログ」に、誰がいつ何をしたかの記録が日本語で並びます(管理者だけ)。権限の変更は「権限変更履歴」で見られます。",
    keywords: ["監査ログ", "ログ", "操作履歴", "記録", "誰が", "権限変更履歴"],
    href: "/admin/audit-logs",
    hrefLabel: "監査ログへ",
    minRole: "admin",
  },
  {
    id: "company-settings",
    title: "販売図面の会社名・住所を変えたい",
    answer:
      "「会社情報（販売図面の差出人）」で会社名・住所・免許番号などを変えます(管理者だけ)。DMの差出人はここではなく「売却DM設定」で変えます。",
    keywords: ["会社情報", "差出人", "会社名", "免許番号", "会社住所", "販売図面"],
    href: "/admin/company-settings",
    hrefLabel: "会社情報へ",
    minRole: "admin",
  },
  {
    id: "manual",
    title: "使い方を詳しく知りたい",
    answer: "「取り扱いマニュアル」に画面ごとの操作が、「使い方ガイド」に機能の説明がまとまっています。",
    keywords: ["マニュアル", "使い方", "ガイド", "ヘルプ", "説明書", "操作方法"],
    href: "/docs/manual.html",
    hrefLabel: "取り扱いマニュアルを開く",
    minRole: "field_staff",
  },
];
