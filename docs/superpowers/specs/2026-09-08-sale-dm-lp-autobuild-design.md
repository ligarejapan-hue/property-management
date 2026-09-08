# 売却DM×アプリ内LP 自動組立(二軸A/B) 設計

> **作成日**: 2026-09-08 / **性質**: 設計のみ(コード変更なし)
> 関連: `2026-08-08-sale-dm-external-paste-design.md`(外部AI貼り付け方式・本設計はその上に積む)、`2026-08-08-dm-sending-management-design.md`(送付管理・反響)。
> 位置づけ: **案A「シナリオ台帳」方式の第1段階**。第2段階(シナリオ台帳・経路×種別の自動割当・DMの写真枠・相続の印)は別設計。

---

## 0. 発注者の方針(2026-09-08 確定)

1. 文面の作り方は**外部AI貼り付けのまま**。アプリ内でAIを直接呼ぶ経路(410で閉鎖済み)は復活させない。AI費用ゼロ・PIIを外部へ出さないルールは維持。
2. LPの役割 = **DMより詳しい説明 + 無料査定の申込フォーム + 電話ボタン**。
3. 出し分けの単位は経路×種別(相続・現地撮影・戸建・一棟・区分など)。→ 第2段階のシナリオ台帳で自動割当。第1段階はその土台。
4. 申込の受け取り = **アプリ内で確認 + メール通知**。
5. **DMの文面とLPの中身を別々の軸でA/B測定**する(DM型の成績=閲覧率、LP型の成績=申込率)。
6. LPには**写真と図**を入れる。写真は社内で用意したもの(宛先の物件写真は使わない)。生成AI用の**画像プロンプトもアプリが出す**。貼り戻しはなるべくコピペ(Ctrl+V)。
7. 申込ボタンの文言は固定(A/Bの対象は本文のみ)。
8. DMの写真枠は**第2段階**(印刷の型の変更を伴うため)。
9. 個人情報の取扱い文は発注者の文章を管理者設定に貼る。無い場合に備えてひな形を初期値にする。
10. 申込の個人情報は**消さずに残す**(自動削除は作らない)。
11. メールは**info@ligarejapan.com のSMTP(メールは Xserver で運用・`sv****.xserver.jp`:465 SSL または 587・ユーザー=アドレス全体・メールボックスのパスワード)**で送る。新しい契約は不要。送信元は管理者設定、**通知先は利用者アカウントごとの設定**(ON/OFF+通知先アドレス)。
12. 凍結の線引き: 1通でも確定・送付済みになった型の DM原本・LP原本(写真と図を含む)は変更不可。LPの「会社案内・連絡先」枠だけは管理者設定から差し替え可。

## 1. 現状(実測 2026-09-08)

- `DmCampaign`(status draft|ready|sent|closed) → `DmVariant`(=型: 文体4項目 tone/length/appeal/strength・`lpUrl`・`promptText`・`bodyTemplate`・`templateFrozenAt`) → `DmRecipientDraft`(宛先: `variantId`・`trackingToken @unique`・`lpFirstAccessAt`・`lpAccessCount`・`phoneInquiryAt`・`outcome`・`deliveryStatus`)。
- 型ごとの外部AI 3手順: `GET .../variants/[variantId]/prompt`(`buildExternalPrompt` = 文体4項目のみ・PII構造的に不在)→ `PUT .../template`(二重digest `PROMPT_STALE`/`TEMPLATE_STALE`・凍結 `VARIANT_FROZEN`・`validateLetterBody`)→ `POST .../apply`(`expandLetterTags`・`LETTER_TAGS=["物件所在","物件種別"]`・`coarsePropertyLocation` は番地手前で切る)。
- 公開: `GET /t/[token]`(`recordTrackingHit` → status=sent のみ計数 → `variant.lpUrl` があれば302、無ければ既定LP `SaleDmConfig.lpUrl`/`SALE_DM_LP_URL`、未設定は404 fail-closed・未知tokenも既定LPへ=列挙耐性)。`GET/POST /u/[token]`(配信停止: HMAC token・Origin検査・4段レート制限・`renderUnsubscribe*Page` 純関数HTML)。`src/proxy.ts` の `PUBLIC_PATHS` に `/t/`・`/u/`。
- **アプリ内LPは存在しない**(LPは外部URLのみ)。**メール送信手段は無い**(nodemailer等の依存なし)。
- 集計: `aggregateByVariant` → sent/delivered/undeliverable/inquiry(LP∪電話)/responseRate。
- 割当: `assignVariantsEvenly`(sequential/random・端数は先頭型から)・`applyManualAssignment`。
- 印刷: `print/route.ts` がHTMLを返しブラウザ印刷。追跡QRと配信停止QRは inline SVG。
- 管理者設定: `admin/sale-dm-settings`(`SaleDmConfig` singleton・秘密は `encryptSecret`(`SALE_DM_SETTINGS_ENC_KEY`))。利用者: `User.email @unique`・`admin/users`。
- 物件: `Property.introductionRoute`(reception_csv/field_survey/web_inquiry/dm_response…)・`Property.propertyType`。「相続」の印は無い。
- 公開レート制限の共通部品 `src/lib/public-rate-limit.ts`。

## 2. 設計

### 2.1 二軸: DM型と LP型

- **DM型 = 既存 `DmVariant`**(変更なし。`lpUrl` は「LP原本なし」時の外部転送先として残す)。
- **LP型 = 新設 `DmLpVariant`**(`dm_lp_variants`)。キャンペーンに属し、DM型とは独立の一覧。
  - `campaignId`, `label`, 文体4項目(`tone/length/appeal/strength`・DM型と同じ列挙), `promptText`, `rawTemplate`(貼り戻した原文そのまま), `headline`, `lead?`, `bodyText`, `faqJson?`(`[{q,a}]`), `heroAssetId?`, `sectionMediaJson?`(`[{heading, kind:"asset"|"figure", ref}]`), `templateFrozenAt?`, `createdAt/updatedAt`。
  - 原文を残す理由: 切り分け規則を後で直したときに再切り分けできる。
- **宛先に両方を割当**: `DmRecipientDraft.lpVariantId String?`(LP型が0件のキャンペーン=null=従来どおり外部転送)。
- **割当(総当たり均等)**: 新純関数 `assignCrossEvenly(recipientIds, dmVariantIds, lpVariantIds, opts)`。
  - 組 `(dm_i, lp_j)` を `n×m` の順序列(ラテン方陣の巡回: i=k mod n, j=(k mod n + ⌊k/n⌋) mod m)で並べ、宛先 k 番目に `seq[k mod n·m]`。端数は先頭の組から1つずつ多い(既存 `evenVariantSequence` と同じ規約)。組の偏りは最大1、LP軸だけの周辺は最大2(テストで固定)。
  - `random` は本数分布を保ったまま順だけシャッフル(既存 `shuffle` を共用)。
  - LP型が0件のときは既存 `assignVariantsEvenly` と**完全一致**の結果(後方互換をテストで固定)。
  - 手動割当は軸ごと(`applyManualAssignment` を LP軸にも適用・未指定宛先は現状維持)。
- **集計(3つの見方)** `aggregateTwoAxis(drafts)`:
  - DM型: 既存 `aggregateByVariant` そのまま(閲覧率 = LP初回閲覧あり ÷ delivered)。
  - LP型: 分母 = `lpFirstAccessAt != null && status==="sent"`、申込 = `formInquiryFirstAt != null`、電話タップ = `phoneTapFirstAt != null`。`inquiryRate`・`phoneTapRate`。分母0は率 null(表示は「—」)。
  - 組み合わせ表: `(dmVariantId, lpVariantId)` ごとに sent/delivered/viewed/inquiry。
  - 画面は必ず**分母と件数を率の隣に**出す(少数での早合点防止)。

### 2.2 LP型のプロンプトと貼り戻し

- `buildLpExternalPrompt({tone,length,appeal,strength})`: DM用と同じく**構造化された選択値だけ**から組み立て(extraInstruction・PII・差出人は含めない=外部貼り付け設計 §2.2 の不変条件を踏襲)。指示の骨子:
  - DMより詳しく(売却の進め方・費用のかかり方・査定で分かること・よくある不安への答え)。
  - 出力は固定見出しで区切る: `【見出し】`(1行) / `【リード文】`(2〜3文) / `【本文】`(段落は空行・小見出しは行頭 `■`) / `【よくある質問】`(`Q.`/`A.` 対 3〜6組)。
  - 社名・連絡先・住所は書かない(会社案内枠はアプリが付ける)。申込を促す一文は可、ボタン文言は書かない(固定「無料査定を申し込む」)。
  - 差し込み記号 `{{物件所在}}` `{{物件種別}}` はDMと同じ2つのみ。氏名・物件特定情報は書かない。断定・誇大表現の禁止(DMと同文)。
  - 「DM-〇の設定を写す」ボタン(文体4項目のコピー)はUIのみ。
- **切り分け `splitLpTemplate(raw): Result<{headline, lead?, body, faq?}, LpSplitError>`(純関数)**:
  - 必須 `【見出し】`・`【本文】`。任意 `【リード文】`・`【よくある質問】`。
  - 見出しの欠け/重複/順番違い/未知の見出し → 保存せず、`code`(`MISSING_SECTION`/`DUPLICATE_SECTION`/`ORDER_MISMATCH`/`UNKNOWN_SECTION`)と該当見出し名を返す。
  - 上限: 見出し60字・リード300字・本文4000字・Q/A各300字・FAQ 6組。超過 `TOO_LONG`(部位名付き)。
  - FAQは `Q.`→`A.` の対で解析。対が崩れたら `FAQ_PAIR_MISMATCH`。
  - 文字のみ受付。HTML/URLは**そのまま文字として表示**(escape)。差し込み記号は既存 `hasUnresolvedTag`/`validateLetterBody` と同じ検査(未知記号は `UNKNOWN_TAG`)。
  - 改行は LF に正規化してから判定(CRLF差で判定が変わらないこと=テストで固定)。
- **保存 `PUT .../lp-variants/[lpId]/template`**: 既存 template route と同じ二重digest(`promptDigest`・`bodyTemplateDigest(rawTemplate)`)・凍結 `VARIANT_FROZEN`・field_staff スコープ。原文と切り分け結果を同一txで保存。監査 `sale_dm_lp_body_paste`。
- **展開**: LP表示時に宛先の物件から `coarsePropertyLocation`(町名まで)と `propertyTypeLabel` を差し込む(既存 `expandLetterTags` を共用)。DMと違い**適用(apply)工程は無い**(LPは表示のたびに展開)。

### 2.3 写真と図

- **共有ライブラリ `DmLpAsset`(`dm_lp_assets`)**: `id`(公開IDは別途 `publicId` 32hex乱数 @unique), `storageKey`, `mime`(image/jpeg|png|webp), `width/height`, `bytes`, `label?`, `createdBy`, `createdAt`, `deletedAt?`。保存は既存 storage backend(`/var/lib/property-management/uploads` 配下・public外)。**保存前EXIF GPS strip は既存のまま適用**。表示用に長辺1600pxへ縮小した派生を作り、公開口は派生だけを返す(原寸は公開しない)。
  - 上限: 1枚8MB、LP型1つにつき参照10枚。削除は**参照しているLP型が無いときだけ**(`REFERENCED`=409)。
  - 取り込み口: ファイル選択・ドラッグ&ドロップ・**クリップボード貼り付け(Ctrl+V / 長押し貼り付け)**。貼り付けは `paste` イベントの `clipboardData.files` を同じアップロードAPIへ流す(受け口は1つ)。
- **公開口 `GET /lp-assets/[publicId]`**: `publicId` のみで1枚返す。一覧不可。**いずれかの LP型が参照している資産だけ**返す(ライブラリに入れただけの資産は404)。ヘッダ: `Cache-Control: public, max-age=31536000, immutable`・`X-Content-Type-Options: nosniff`・`Content-Type` は保存時の mime 固定。`PUBLIC_PATHS` に `/lp-assets/` を追加(proxy テストで固定)。nginx のログ除外は `/t/`・`/u/` と同じ扱い。
- **図(アプリが描く部品)** `src/lib/sale-dm-letter/lp-figures/`: 純関数 `renderFigureSvg(kind, theme)`。初期5種: `sale_flow`(売却の流れ)/`cost_breakdown`(費用の内訳)/`inheritance_deadlines`(相続の期限)/`vacant_burden`(空き家の負担)/`timing_by_type`(種別ごとの売り時)。文字は日本語をSVGで描く(画像AIの文字崩れ回避)。
- **置き場所**: LP型の「写真と図」欄。ヒーロー1枚(`heroAssetId`)+ `■小見出し` ごとに写真1枚または図1つ(`sectionMediaJson`)。貼り直しで小見出しが変わった場合は、見出し文字列が一致する行だけ引き継ぎ、残りは未設定に戻す(純関数 `reconcileSectionMedia(oldHeadings, newHeadings, media)`)。
- **画像プロンプト `buildImagePrompt({slot, heading?, leadSummary?, appeal, propertyKind?, style, aspect})`**(純関数):
  - 入力は LP型の設定値と**切り分け済み本文の小見出し・リード文の要旨**(差し込み記号は除去)。所有者・物件の事実は構造的に入らない。
  - 決まり文句: 画像内に文字を入れない / 実在の人物・看板・住所・ロゴを出さない / 日本の住宅街の雰囲気。
  - 縦横比: ヒーロー 16:9、節の下 4:3。画風: 写真風・イラスト風・フラット図解。
  - 末尾に英語の定型行(style・aspect・"no text, no logos, no readable signage")。
  - 表示は各枠の「AIで作る」→ コピー1クリック。監査 `sale_dm_lp_image_prompt_view`(枠種別のみ)。

### 2.4 公開LPの表示

- `GET /t/[token]` を拡張: `recordTrackingHit` の結果に `lpVariant`(原本あり)が付けば**302ではなく LP HTML を返す**。無ければ従来どおり転送(外部 `variant.lpUrl` → 既定LP)。未知token・LP型なし・既定LP未設定の挙動は**現状維持**(列挙耐性と fail-closed を壊さない)。
- レンダラ `renderLpPage(input: LpRenderInput): string`(純関数・`unsubscribe-page.ts` と同じ作り・React不使用・全値 escape・CSS inline・外部読み込みなし)。
  - 構成(縦一列・スマホ前提): ヒーロー写真 → 見出し → リード文 → 申込ボタン(固定文言・ページ内リンク) → 本文(■小見出し+写真/図) → よくある質問(`<details>`) → 申込フォーム → 会社案内+電話ボタン(`tel:`) → 配信停止の案内(`/u/` の入口)。
  - 差し込みは町名までの所在と種別のみ。氏名・番地・所有者住所は入力型に**存在させない**(`LpRenderInput` に列を持たない)。
  - `Cache-Control: no-store`(宛先ごとに違うため)。画像は公開口側で長期キャッシュ。
  - **送付前(status≠sent)は「プレビュー」帯を出し、フォームは送信不可(disabled+受け口でも拒否)**。閲覧計数は従来どおり sent のみ。
- **社内プレビュー** `GET .../lp-variants/[lpId]/preview`(認証必須・見本の差し込み・プレビュー帯)。
- 電話タップ `POST /t/[token]/phone-tap`: `tel:` リンクの click で `navigator.sendBeacon`。best-effort(失敗してもページは動く)。`phoneTapCount` increment・`phoneTapFirstAt` 初回のみ。sent のみ計数。反響には**立てない**(タップ≠通話。電話反響は従来どおり手入力)。レート制限あり。監査は初回のみ `sale_dm_lp_phone_tap`。

### 2.5 申込フォームと反響

- 項目: `name`(必須・50字)・`phone`(必須・20字・数字/ハイフン/+ のみ)・`email?`(254字・形式)・`contactPref?`(`phone|email|either`)・`contactTime?`(60字)・`message?`(1000字)・`consent`(必須 true)・honeypot(空必須)。
- **受け口 `POST /t/[token]/inquiry`**(`/u/` と同じ守り): Origin/Referer 検査(自ホストのみ)・honeypot・レート制限3種(端末IP 10/分・token 5/時・全体 120/時)・**`status==="sent"` の宛先のみ**(それ以外は 409 で「プレビュー中」ページ)・未知token=404(記録なし)。
- 保存 `DmInquiry`(`dm_inquiries`): `id`, `draftId`(FK), `submittedAt`, `name`, `phone`, `email?`, `contactPref?`, `contactTime?`, `message?`, `handleStatus`(`open|in_progress|done`), `handledById?`, `handledAt?`, `handleNote?`, `notifyStatus`(`pending|sent|failed`), `notifyAttempts`, `notifyLastError?`(定型コードのみ・外部文字を入れない), `createdAt`。
- 宛先の追加列: `formInquiryFirstAt?`, `formInquiryCount Int @default(0)`, `phoneTapFirstAt?`, `phoneTapCount Int @default(0)`。
- 反響への計上(同一tx・`lockPropertyRow`): inquiry 作成 → draft の count/firstAt 更新 → `outcome="inquiry"` → `syncSaleDmReaction(tx, draftId, {allowTerminal:false})`(**拒否済みは上書きしない**。申込自体は保存し画面には出す)。`deriveOutcome` は `formInquiryFirstAt` も入力に加える(LP閲覧∪電話∪フォーム)。
- 同一宛先の複数回送信は全件保存(回数表示)。
- 送信後ページ: 「受け付けました。担当者からご連絡します」。**申込者への自動返信は送らない**(未確認アドレスへ送らない)。
- 社内表示: キャンペーン画面「申込」一覧(未対応が上・対応状況の変更)、宛先一覧バッジ、物件のDM履歴、ホームの反響。
- 同意文・会社案内・連絡先: `SaleDmConfig` に `privacyText`, `companyProfile`, `lpPhone`, `lpPhoneLabel?` を追加(管理者設定)。`privacyText` の初期値はひな形(seed)・発注者文で上書き可。凍結の対象外(§0-12)。

### 2.6 メール通知

- 依存追加: `nodemailer`(⚠反映時の `npm ci` ゲートに新依存の到達確認を足す)。送信先は Xserver の SMTP(`sv****.xserver.jp`・465 SSL 既定・587 STARTTLS も可・認証=メールアドレス全体+メールボックスのパスワード)。Xserver の送信上限(日次数百〜1,500通)に対し通知は日数十通で十分。SPF/DKIM は Xserver サーバーパネルで有効化を推奨(アプリ側の変更なし)。
- **送信設定 `MailConfig` singleton(`mail_config`)**: `smtpHost`, `smtpPort`, `smtpSecure`, `smtpUser`, `smtpPassEnc`(`encryptSecret`・`SALE_DM_SETTINGS_ENC_KEY` 共用), `fromAddress`, `inquiryMailDetail`(`minimal|full`・既定 minimal), `updatedAt/updatedById`。管理者画面 `admin/mail-settings`(`user_management:write`)。パスワードは書き込み専用(値は返さない)。「テスト送信」ボタン=`POST /api/admin/mail-settings/test`(送信先=操作者の通知先アドレス)。
- **通知先は利用者ごと**: `User.inquiryNotifyEnabled Boolean @default(false)`, `User.inquiryNotifyEmail String?`(null=ログインemail)。`admin/users` の作成・編集に2欄追加。送信対象 = `isActive && inquiryNotifyEnabled`。0人なら管理者画面と申込一覧に「通知先が未設定です」。
- **送るタイミング**: 申込txコミット後に `notifyInquiry(inquiryId)` を非同期実行。失敗は 30秒→2分→10分の3回再試行(プロセス内)。全滅で `notifyStatus=failed`・申込一覧に「通知できていません」+「再送」(`POST .../inquiries/[id]/notify`・権限=申込閲覧)。**メール失敗で申込は消えない**。
- 内容(minimal): 件名「【査定申込】{町名}の{種別}({キャンペーン名})」/本文: 受付日時・キャンペーン・DM型/LP型ラベル・町名+種別・申込者名・アプリで開くリンク(社内HTTPSの絶対URL=既存 `trackingBaseUrl` とは別に `appBaseUrl` を MailConfig に持つ)。`full` は電話・メール・要望も含める(発注者が承知のうえで選ぶ)。
- 1通ずつ・まとめない。通知先ごとに1通(To は個別・BCC不使用)。
- 監査: `mail_settings_update`(項目名のみ)・`inquiry_notify_sent`/`inquiry_notify_failed`(inquiryId・宛先はuserIdのみ・アドレスは出さない)。

### 2.7 権限・安全・監査

- DM型・LP型・写真の登録: 既存 `requireSaleDmWriteAccess`。field_staff は既存の物件可視範囲。
- **申込の中身(名前・電話・メール・要望)**: 所有者の個人情報閲覧権限を持つ者のみ。無い者には件数と日時のみ。画面保護(S1b)を申込画面にも適用。対応状況の変更も同権限。
- 管理者のみ: メール設定・会社案内・同意文・写真ライブラリの削除・利用者の通知設定。
- 公開側: token は既存 `trackingToken`(推測不能)。LP に出す個人関連情報は町名+種別のみ。写真は `publicId` で1枚ずつ・一覧不可・参照中のみ。受け口は §2.5。公開パスは nginx ログ除外。
- 監査イベント(新設): `sale_dm_lp_variant_create/update/delete`, `sale_dm_lp_prompt_view`, `sale_dm_lp_body_paste`, `sale_dm_lp_asset_upload/delete`, `sale_dm_lp_image_prompt_view`, `sale_dm_lp_view_first`(公開・初回のみ・tokenのdraftIdのみ), `sale_dm_lp_phone_tap`(初回のみ), `sale_dm_inquiry_submit`(公開・draftIdのみ・入力文字は出さない), `sale_dm_inquiry_view`, `sale_dm_inquiry_status_update`, `mail_settings_update`, `inquiry_notify_sent/failed`。**ログに外部由来の文字を出さない**(既存ルール=許可リスト方式)。
- 保管: 申込は所有者情報と同水準。自動削除なし(§0-10)。日次バックアップに含まれる。

### 2.8 凍結

- `DmLpVariant.templateFrozenAt` は DM型と同じ規則(`isVariantFrozen`/`markVariantsFrozen` を LP型にも適用: 1通でも confirmed/sent → 凍結・解除なし)。凍結後は原文・切り分け結果・ヒーロー・節の写真/図すべて変更不可(`VARIANT_FROZEN`)。
- 凍結対象外: `SaleDmConfig` の会社案内・連絡先・同意文(§0-12)。

### 2.9 データ変更一覧(migration 直列)

| 対象 | 変更 |
|---|---|
| `dm_lp_variants` | 新設(§2.1) |
| `dm_lp_assets` | 新設(§2.3) |
| `dm_inquiries` | 新設(§2.5) |
| `dm_recipient_drafts` | `lp_variant_id`, `form_inquiry_first_at`, `form_inquiry_count`, `phone_tap_first_at`, `phone_tap_count` |
| `sale_dm_config` | `privacy_text`, `company_profile`, `lp_phone`, `lp_phone_label` |
| `mail_config` | 新設(§2.6) |
| `users` | `inquiry_notify_enabled`, `inquiry_notify_email` |

enum 追加なし(状態は文字列列挙をアプリ側で検証)。rollback は列・表の削除で戻せる(enum ADD VALUE を使わない)。

## 3. 実装の段(第1段階=5つのPR・順序固定)

1. **LP型の土台**: §2.1・§2.2・凍結(§2.8)・集計3表・割当の総当たり。所有者側に変化なし。
2. **写真と図**: §2.3(ライブラリ・Ctrl+V・公開口・図5種・画像プロンプト)。
3. **公開LP**: §2.4(QR入口の拡張・プレビュー・電話タップ)。**反映前に公開LP用HTTPSの住所が要る**(§4)。
4. **申込フォーム**: §2.5・§2.7(権限・画面保護・監査)。
5. **メール通知**: §2.6(nodemailer・設定画面・利用者の通知欄・再送)。

各PR: 純関数の総当たりテスト(切り分け・割当・集計・受付判定)/順番が交差する処理の総当たり(同一宛先の申込2重・申込と配信停止・閲覧記録と申込)/公開入口4通り(未知token・送付前・凍結前・LP原本なし)/走査テストはLF正規化/フルスイート緑/@codex クリーンでマージ依頼。

## 4. アプリの外の前提(発注者)

- PR2まで: Xserver のサーバーパネルで `sv****.xserver.jp` の番号と info@ligarejapan.com のメールボックスのパスワードを確認(不明なら再設定)。**チャットに貼らず管理者画面へ直接入力**。SPF/DKIM の有効化を推奨。
- PR3まで: 公開LP用の住所(例 `lp.ligarejapan.com`)を Xserver の「DNSレコード設定」で A レコード1行(VPSのIP)としてVPSへ向ける。証明書はこちらで取得(Let's Encrypt)。`trackingBaseUrl` をその https に切替。
- PR4のあと: 会社案内・連絡先・同意文の入力、写真をライブラリへ。

## 5. 第2段階(範囲外・別設計)

シナリオ台帳(経路×種別 → DM型の組+LP型の組の自動割当)、DMの写真枠(印刷の型の変更・カラー印刷前提)、相続の印(受付帳の登記原因から付けるか手動か)、申込者への自動返信の要否。

## 6. レビューで特に見てほしい論点

- `assignCrossEvenly` が LP型0件で既存結果と完全一致すること(後方互換)。
- `/t/[token]` の分岐追加で、未知token・既定LP未設定・送付前の**既存挙動が1つも変わらない**こと。
- `LpRenderInput` に氏名・番地が構造的に存在しないこと。
- 申込txと `syncSaleDmReaction(allowTerminal:false)` の順序・拒否済み宛先の不変。
- 公開口(`/lp-assets/`)が「参照中の資産だけ」を返し、一覧・原寸を出さないこと。
- メール失敗が申込保存に影響しないこと。ログにアドレス・入力文字が出ないこと。
