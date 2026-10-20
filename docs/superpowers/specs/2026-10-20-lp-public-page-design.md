# 広告用のご案内ページ(DMの種類ごとの公開URL)+Google計測 設計書

- 日付: 2026-10-20
- 発注者の指示: 「お客さんに見せるURLを出して」→「web広告用のLPはこれを作れば問題ない?」→計測タグは「まずはGoogle」。設計の提案(URL・申込の受け方・Googleの計測・本番側・今回入れないもの)に「はい」。
- 位置づけ: 売却DM×アプリ内LP(`docs/superpowers/specs/*sale-dm*`・`/t/<token>` のご案内ページ)の上に、**宛先を持たない一般向けの入口**を足す。

## 0. 今の仕組みと足りないもの

- 今あるご案内ページは `GET /t/<token>` だけ。token は手紙の宛先1件に1本で、文章にその物件の所在(町名まで)と種別が差し込まれ、閲覧・電話タップ・申込がその宛先の反響として記録される。他の人に見せると、別の物件の文言が出て、反響の数字がその宛先に付く=共有用に使えない。
- 管理画面の「プレビュー」は社内の入口(Tailscale)からしか届かない。公開ドメイン `app.ligarejapan.com` は nginx で `/t/`・`/u/`・`/lp-assets/` だけを出している。
- 広告に使うには、入口のURLに加えて「どの広告から来たか」の記録と、Google広告の成果計測(コンバージョン)が要る。今のページは守りのため外部スクリプト・外部通信を一切許していない。

## 1. URLと見せ方

- 形: `https://app.ligarejapan.com/lp/<公開名>`。公開名(slug)はDMの種類ごとに管理者が「DMの種類」の画面で決める。空なら公開しない。
  - 公開名の規則: 半角の小文字英数字とハイフンのみ・2〜40文字(`^[a-z0-9-]{2,40}$`)。全種類で重複不可(DBの一意制約)。
  - 初期値の案(発注者が画面で入れる・移行では入れない): `souzoku`(相続)・`souzoku-mansion`(相続（マンション）)・`akiya`(空き家)・`furuiie`(古い家)。「相続（試作）」は公開しない。
- 出す条件(すべて満たすときだけ 200・それ以外は 404 で中身の有無を漏らさない): 公開ゲート `SALE_DM_LP_PUBLIC_ENABLED` が真/公開名が一致/削除済みでない/「使う」(active)/LPの見出しと本文が登録済み(`hasRenderableLpVariant`)。
- 紙面は `renderLpPage` をそのまま使う(新しい mode `"public"`)。
  - 物件を差し込まない(`property: { address: null, propertyType: null }`)=所在の文言は今の一般形(「ご所有の物件の周辺」「不動産」)に落ちる。
  - 冒頭の小見出し(eyebrow)は手紙向けの「お手紙をお読みいただいた方へ」ではなく「不動産の売却・活用でお悩みの方へ」(`LP_BRAND.publicEyebrow`)。
  - プレビューの帯なし・配信停止の案内なし・電話タップの計測スクリプトなし(宛先がないため)。チェック札の動き・固定ボタン・送信の守りは live と同じ。
  - `<meta name="robots">` は `index,follow`。見出し情報(OGP)を自動で付ける: `og:title`=見出し・`og:description`=リード文(無ければ本文の最初の段落・120字まで)・`og:image`=一番上の写真(絶対URL=追跡用URL+`/lp-assets/<publicId>`・無ければ省略)・`og:url`=追跡用URL+`/lp/<公開名>`・`og:type`=website・`twitter:card`=`summary_large_image`(写真があるとき)。
- 社内プレビュー(`/api/properties/sale-dm/scenarios/[id]/preview`)は今のまま(宛先を持たない社内確認用)。広告ページの実物は公開名を付けたあと公開URLで確かめる。

## 2. 申込の受け方

- フォームはDM用と同じ欄に **「物件の所在地(分かる範囲で・任意)」** を1欄足す(`propertyAddress`・200字まで)。お名前・電話番号の2つだけ必須という約束は変えない。
- 「どの広告から来たか」: ページを開いたURLの `utm_source` `utm_medium` `utm_campaign` `utm_term` `utm_content` `gclid` をサーバー側で読み取り(各200字まで・制御文字は落とす・それ以外は捨てる)、フォームの隠し欄に入れて申込と一緒に保存する。
- 保存先は今の `dm_inquiries` に **「広告ページからの申込」として入れる**(新しい表は作らない)。理由: 申込一覧・対応状況・通知メール・受付メール・お知らせ(ベル/プッシュ)の仕組みをそのまま使えるため。見え方は提案どおり「申込一覧に札付きで一緒に並ぶ」。
  - 列の追加: `source`('dm' | 'public'・既定 'dm')・`scenario_id`(dm_scenarios・任意・Restrict)・`public_slug`(申込時点の公開名)・`property_address`・`utm_source`/`utm_medium`/`utm_campaign`/`utm_term`/`utm_content`/`gclid`。
  - `draft_id` を NULL 可に変える(宛先がない申込のため)。整合の守りとして CHECK 制約 `draft_id IS NOT NULL OR scenario_id IS NOT NULL`。既存の行は全部 `draft_id` あり=`source='dm'`。
- 受け口 `POST /lp/<公開名>/inquiry`。守りは `/t/<token>/inquiry` と同じ多層(端末IP 10/分・送信元判定・公開ゲート・本文32KB上限・honeypot・入力検証・存在確認(公開名→DMの種類)・**端末IP 5/時**・公開名ごと 200/時・全体 120/時=DM用とは別の枠・監査は非PIIのみ)。公開名は秘密ではないので、1つの端末が公開名の枠を使い切って正規の訪問者を締め出せないよう、端末ごとの1時間の上限を先に置く(内部レビュー P2)。JS送信は JSON、JSなしは従来のHTML結果ページ。
- 申込一覧の「経路」(utm)は訪問者のURL由来の自由な文字列なので、所在地と同じく電話とメールの両方を見られる人にだけ返す。
- 申込後: `startInquiryNotify`(通知メール)+`startInquiryAutoReply`(受付メール)をそのまま呼ぶ。
  - 通知メールの文面: 件名「【査定申込】広告ページ(相続)」。本文の「キャンペーン」行は「広告ページ(DMの種類名)」、DM型/LP型の行は出さない、「物件」行は入力された所在地(詳細=full のときだけ・minimal では「所在地(入力あり/なし)」)。full のときは「経路: utm_source / utm_medium / utm_campaign」も1行。
  - 宛先の決め方: 物件が無いので担当範囲の判定は「物件の担当・作成者なし」として扱う=現地担当(field_staff)には送らない。それ以外は今までどおり(通知ONの在籍者・権限チェック)。
- 申込一覧(横断・`/properties/sale-dm/inquiries`): 広告ページの行は「広告ページ(相続) ・ 入力された所在地(無ければ「所在地の記入なし」) ・ 経路: google / cpc / 秋キャンペーン」の形で出す。対応状況・メモ・通知の再送は同じ。現地担当には出ない(物件の担当範囲に入らないため)。
- 物件の画面・キャンペーンの画面の申込一覧には出ない(宛先・物件が無いため)。

## 3. Googleの計測

- 「LPの設定」(`/admin/sale-dm-settings`)に2欄を足す: **Googleタグ ID**(`G-…`/`AW-…`/`GT-…`・`^(G|AW|GT)-[A-Z0-9]{4,20}$`)と **申込完了のコンバージョン ラベル**(`^[A-Za-z0-9_-]{4,64}$`)。保存先は `sale_dm_config.google_tag_id` / `google_conv_label`。
- 広告ページ(`/lp/<公開名>`)だけ、タグ ID が入っているときに Google のタグ(gtag.js)を読み込む。DM用のご案内ページ(`/t/`)・社内プレビューは今までどおり一切読み込まない。
- 申込完了の送り方: 送信スクリプトは申込が「done」になったときに `document` へ `lp:inquiry-done` イベントを出す(固定文字列・値は含まない)。Google のタグ側のスクリプトがそれを受けて `gtag('event','conversion',{send_to:'<AW-ID>/<ラベル>'})`(ラベルがあるとき)と `gtag('event','generate_lead')` を送る。
- CSP(広告ページだけ・タグ ID があるときだけ広げる): `script-src` に `https://www.googletagmanager.com`、`connect-src` に `https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com https://*.googleadservices.com https://www.google.com https://www.google.co.jp https://googleads.g.doubleclick.net https://pagead2.googlesyndication.com`、`img-src` に `https://www.google.com https://www.google.co.jp https://www.googletagmanager.com https://*.google-analytics.com https://googleads.g.doubleclick.net https://pagead2.googlesyndication.com`、`frame-src https://td.doubleclick.net https://www.googletagmanager.com`。タグ ID が空のときは今の CSP のまま。
- `X-Robots-Tag` は付けない(検索に載せる)。

## 4. 本番側(反映時)

- nginx(`/etc/nginx/sites-available/app.ligarejapan.com` と `deploy/nginx/property-management.conf.example`)に `location ^~ /lp/` を足す。URL に資格情報は載らない(utm は広告の印)ので、アクセスログは通常どおり残す。
- アプリの公開パス(`src/proxy.ts` の `PUBLIC_PATHS`)に `"/lp/"` を足す。管理画面の `/lp`(LPメニュー)は完全一致の別物。**`src/app/(dashboard)/lp/` の下に画面を増やすと公開されてしまう**ため、走査テストで「`(dashboard)/lp` 直下は `page.tsx` だけ」を守る。
- migration 1本(追加・NULL可への緩和・CHECK 制約)。列は任意なので DB はそのままでよいが、**公開ページからの申込(draft_id が NULL の行)が入ったあとに旧コードへ戻すと旧コードが落ちる**(宛先を必ずあるものとして読むため・@codex #535 P1)。戻し方は docs/deploy.md「8.1」(公開名を外す→公開ページの申込の行を退避表へ→旧コード→再開時に戻す)。
- nginx の `/lp/` は `/t/` と同じくアクセスログ・エラーログに残さない(query の utm_* は訪問者が自由に書ける文字列・@codex #535 P2)。
- 機械送信(honeypot)への「受け付けました」は JSON に `silent:true` を添え、ページは申込完了の合図(Google のコンバージョン)を出さない(@codex #535 P2)。

## 5. 今回入れないもの(次の回)

- 広告ページの申込を物件として登録する操作(「物件にする」ボタン)。
- 電話ボタンのタップ計測(Google 側のコンバージョンで測る前提。アプリ側には持たない)。
- 公開ページの閲覧数の集計(Google アナリティクスで見る)。
- ホームページ側のドメイン(ligarejapan.com)で見せる形(DNS か転送が別途要る)。

## 6. テスト(TDD)

- 純関数: 公開名の検証・utm の読み取りと清書・所在地の欄の検証・`renderLpPage` の public mode(帯なし/eyebrow/隠し欄/所在地欄/OGP/robots/Google タグの有無/done イベント)・CSP の組み立て・通知メール文面(広告ページ)・一覧の整形(広告ページの行)。
- 経路: `GET /lp/[slug]`(404 の条件すべて・200 の中身・ヘッダ)・`POST /lp/[slug]/inquiry`(bot/invalid/404/throttled/done・記録の中身・通知と受付メールの起動)。
- 既存の読み手(`draft` が NULL 可になる)の null 安全: 申込一覧 API・個別更新・再送・キャンペーン別一覧・お知らせ・プッシュ。
- 走査: migration の中身・proxy の公開パス・`(dashboard)/lp` 直下・nginx の見本。
