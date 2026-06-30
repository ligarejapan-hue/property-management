# 売却促進DM 作成 + A/Bテスト(Sale DM Letter Assist)設計

- 日付: 2026-06-22
- 種別: 新機能(AI文面生成 + 見た目デザイン + 調整パネル + A/Bテスト + 反響集計)
- スコープ: 初版。下記「スコープ」に含むものを初版で実装。本格分析ダッシュボード・PDFサーバー生成・送付予約・物件宛DM対応は将来
- base: `530a317`(main・本番同期は別途確認)
- branch(予定): `feat/sale-dm-letter-assist`(未作成)
- worktree: 実装時に専用worktreeを用意(並列セッション分離方針に従う)

## 背景 / 動機

不動産の所有者へ「売却しませんか」と促すDMを送る運用がある。
現状のDM機能は **宛先情報(住所・宛名・敬称)のCSV出力に限定**で、**手紙の本文・見た目を作る仕組みは無い**。本文は外部(Word等)で人手作成している。

本機能は、(1) **AIが宛先ごとに本文を生成**、(2) **見た目(デザイン)を選んで体裁を整え**、(3) **調整パネルでトーン等を一括/個別に調整**、(4) **複数デザインをA/Bで送り分け**、(5) **何を誰に送ったか(設定一式)を記録**し、(6) **反響(問い合わせ有無)を入力して型別の反響率を集計**する、一連の流れを提供する。

### 既存資産(再利用する)

| 資産 | ファイル / 概念 | 用途 |
|---|---|---|
| 所有者宛DM | `src/lib/dm-export.ts` / `src/app/api/properties/dm-export/route.ts` | 「1送付先住所=1通」グルーピング・代表者・行マッピング |
| 敬称判定 | `honorificForOwner` / `classifyHonorificKind` | 個人=様 / 法人=御中 等 |
| 郵便番号整形 | `formatPostalCode` / `isValidPostalCode` | NNN-NNNN |
| CSV I/O | `encodeCsv` / `sanitizeCsvCellForExcel`(BOM+CRLF・formula injection対策) | 補助出力の安全化 |
| 送付履歴 | `PropertyDmLog` / `dm-logs-view.tsx` | 送付の運用記録(本機能と連携) |
| 権限ゲート | `property:read` + `csv_export:read` + `csv_export_personal:read` + `owner:read` | 個人情報を含む処理の権限。生値必須 |
| 表示レベル(PIIマスク) | `maskValue` 等 | 生値が取れない場合は 403 |
| 差し替え型バックエンド | 住所補完(provider抽象 + orchestrator + env gate `NOT_CONFIGURED`→503) | AI生成層の設計手本 |

### 足りていないもの(新規に作る)

- AIで本文を生成する仕組み(Claude API・**サーバー側のみ**)
- 見た目デザイン(HTML/CSSテンプレート)と**ブラウザ印刷**出力
- 調整パネル(全体一括 / 1通ずつ)
- A/Bテスト(型の定義・送り分け・設定一式の記録)
- 反響(問い合わせ有無)の記録と型別反響率の集計
- これらを束ねる「送信バッチ(キャンペーン)」と下書きの状態管理(新Prismaモデル)

## スコープ

### やること(初版)

1. 物件一覧の既存DM出力と同じ絞り込み・選択を入口に「売却DMを作成」
2. **3分割の作業画面**(レイアウトA: 左=調整パネル / 中央=手紙プレビュー / 右=宛先リスト)
3. **AIがサーバー側で宛先ごとに本文を生成**(既存の「1送付先=1通・代表者・敬称」を再利用)。**宛名・住所・敬称の取得元はこの物件管理システムの所有者データ(`Owner.name`+敬称+代表者+同住所まとめ)。外部システム連携は不要**
4. **見た目デザイン3種**(信頼/やわらか/インパクト)。HTML/CSSで体裁、**ブラウザ印刷**でPDF化/印刷。まとめ印刷は全通を1HTMLにページ区切りで並べ一括
5. **調整パネル**:デザイン / トーン・丁寧さ / 長さ / 訴求軸(切り口) / 強さ を、**全体一括**と**1通ずつ**の両方で調整。変更はプレビューに反映
6. **A/Bテスト**:複数の「型(=設定一式)」を作り、対象へ **自動均等割り** または **手動指定** で送り分け
7. **送信記録に設定一式を保存**(デザイン+トーン+長さ+訴求+強さ)。「どの型を誰に送ったか」を確実に残す
8. **配達結果+反響記録**:配達結果(届いた/宛先不明で返送/その他返送)は手入力。**反響(問い合わせ)= DMの追跡リンク/QR経由のLPアクセス(自動) または 電話(手入力)** → **型別の反響率・宛先不明率を集計するビュー**
9. **LP連携(追跡リンク/QR)**:既存LPへ、宛先ごとの**固有の追跡リンク(QR+短縮URL)**をDMに掲載。アクセスを記録して当該宛先を自動で「反響あり」にし、設定したLPへ転送
10. **宛先不明(返送)→物件への連動**:宛先不明で返送されたら、対象物件に「宛先不明」フラグを立て、**DM送付ステータスを自動で「送付不可」に連動**(物件一覧にバッジ+フィルタ)。連動は監査記録・手動で解除可能
11. 下書きの保存・確認・編集・再生成・確定
12. 件数上限を設け、超過時は**黙って切らず明示警告**(`truncated`)
13. 補助出力として、設定一式の列を含む**CSV**(外部分析・差し込み用)

### やらないこと(将来別PR)

- 本格的な分析ダッシュボード(初版は型別反響率の単純集計まで)
- サーバー側PDFファイル生成(初版はブラウザ印刷。ヘッドレスブラウザ導入は将来)
- バッチAPIによる非同期大量生成(初版は同期・並列)
- 送付予約 / スケジューリング
- 物件宛DM(`property-dm-export.ts`)への適用(まずは所有者宛)
- 統計的有意差判定など高度なA/B分析

## ユーザー体験(画面の流れ)

作業画面 = **レイアウトA(3分割)**。

```
[ 調整パネル ]   [ === 手紙プレビュー === ]   [ 宛先リスト ]
 デザイン            選択中の宛先の手紙を         送付先を切替
 トーン/長さ          そのまま表示。              型(A/B)バッジ
 訴求軸/強さ          調整で即更新。              反響の入力欄
 [全体|この通]タブ                              (確定後)
```

1. 物件一覧で対象を選択 → 「売却DMを作成」→ 送信バッチを作成しAIが人数分を同期生成
2. 中央プレビューで確認。左パネルで **全体一括** または **この通だけ** 調整 → 再生成/手直し
3. A/B: 型を複数用意し、自動均等割り or 手動で各宛先へ割当
4. OKなものを確定。**各DMに宛先固有の追跡QR/短縮URL**を載せて **ブラウザ印刷**(全通まとめてPDF化/印刷)。補助でCSV出力
5. **反響は自動+手入力**:受け手がQR/リンクからLPにアクセスすると自動で「反響あり」。電話は手入力。配達結果(届いた/宛先不明/その他返送)も手入力 → **型別反響率・宛先不明率**を集計ビューで確認
6. **宛先不明で返送**された宛先は、対象物件のDM送付ステータスを自動で「送付不可」に連動し、物件一覧に「宛先不明」バッジ+フィルタを表示(対応は人が判断・戻せる)
7. 送付は既存の `PropertyDmLog`(送付履歴)とも連携

## データモデル(Prisma 新規)

命名は実装時に最終確定。PII/非PIIを明確に分離する。

```prisma
model DmCampaign {                 // 送信バッチ(A/Bを束ねる単位)
  id          String   @id @default(uuid()) @db.Uuid
  name        String
  status      DmCampaignStatus    // draft / ready / sent / closed
  filterSnapshot Json?            // 対象抽出条件(再現用・非PII寄り)
  createdBy   String   @db.Uuid
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  // variants / recipients を従える
}

model DmVariant {                  // A/Bの「型」= 設定一式のスナップショット(非PII)
  id          String   @id @default(uuid()) @db.Uuid
  campaignId  String   @db.Uuid
  label       String              // "A" / "B" / "C"
  designTemplate String           // formal / soft / impact
  tone        String
  length      String
  appeal      String              // 訴求軸
  strength    String
  extraInstruction String?
}

model DmRecipientDraft {           // 宛先ごとの下書き+送信記録+反響
  id          String   @id @default(uuid()) @db.Uuid
  campaignId  String   @db.Uuid
  propertyId  String   @db.Uuid
  representativeOwnerId String? @db.Uuid
  variantId   String   @db.Uuid   // 割当られた型(A/B)
  overrideJson Json?              // この通だけの調整差分(任意)
  recipientName    String         // 宛名スナップショット(PII)
  recipientZip     String?
  recipientAddress String?        // (PII)
  honorificKind    String
  body        String              // 生成本文(PII)
  model       String?             // 生成モデル(非PII・監査用)
  status         DmDraftStatus    // draft / confirmed / sent
  sentAt         DateTime?
  deliveryStatus DmDeliveryStatus @default(unknown)  // 届いた/宛先不明返送/その他返送/未確認
  returnedAt     DateTime?        // 返送として記録した日
  trackingToken   String  @unique  // 宛先固有の追跡トークン(opaque・QR/短縮URLに使用)
  lpFirstAccessAt DateTime?         // LP初回アクセス(自動・反響シグナル)
  lpAccessCount   Int     @default(0)
  phoneInquiryAt  DateTime?         // 電話問い合わせ(手入力・反響シグナル)
  outcome     DmOutcome?          // none / inquiry。= lpFirstAccessAt または phoneInquiryAt があれば inquiry(導出)
  outcomeNote String?             // 任意メモ(PII配慮)
  respondedAt DateTime?
  generatedBy String   @db.Uuid
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  confirmedAt DateTime?
  property Property @relation(fields: [propertyId], references: [id], onDelete: Cascade)
}

enum DmCampaignStatus { draft ready sent closed }
enum DmDraftStatus    { draft confirmed sent }
enum DmOutcome        { none inquiry }
enum DmDeliveryStatus { unknown delivered returned_undeliverable returned_other }
```

- 到達数 = `deliveryStatus=delivered`、宛先不明数 = `deliveryStatus=returned_undeliverable`
- **反響(問い合わせ)= LPアクセス(`lpFirstAccessAt`)または電話(`phoneInquiryAt`)のいずれか**。`outcome=inquiry` はこの導出値
- **反響率の母数は到達数(宛先不明を除く)**。集計 = 型(`variantId`)ごとに 到達数 と 反響数 を数え `反響 / 到達`。LP/電話の内訳も表示。別途「宛先不明率」も型別/全体で表示
- **宛先不明→物件連動**: `returned_undeliverable` を記録すると、対象 `Property` に denormalized フラグ(`Property.dmUndeliverableAt` を追加)を立て、`dmStatus` を `no_send`(送付不可)へ自動更新。物件一覧のバッジ/フィルタはこのフラグ参照。連動は AuditLog 記録・手動で解除可能
- migration: 新モデル + `Property.dmUndeliverableAt` 追加(additive・冪等)
- **本文・宛名・住所は PII** → 権限・表示レベル・`no-store` の対象。AuditLog には本文を残さない(非PIIメタのみ)
- 送付確定時、既存 `PropertyDmLog` にも記録を残し既存「送付履歴」画面に反映(連携)

## A/Bテストと反響集計

- **型(DmVariant)**: 調整パネルの全体設定をスナップショットしたもの。1キャンペーンに複数定義(例 A=フォーマル/控えめ、B=インパクト/強め)
- **割当**: (a) 自動均等割り(対象をランダム/順番に各型へ)、(b) 手動指定(対象/グループに型を指定)。両対応
- **記録**: 各 `DmRecipientDraft` に `variantId`(=設定一式へのリンク)+ 送信日 + 反響。これで「何を誰に送ったか」が確実に残る
- **個別上書き**: 1通だけの調整は `overrideJson` に差分保持。A/Bの純度を保つため、集計は**割当られた型(variantId)基準**(上書きは本文の微修正用途)
- **集計ビュー**: キャンペーン詳細で 型別に 送付数 / 到達数 / 宛先不明数 / 反響数(LP/電話の内訳) / 反響率(母数=到達) / 宛先不明率 を表示。CSVでも出力可
- **宛先不明→物件連動**: 宛先不明を記録すると対象物件を「送付不可」に自動連動し、物件一覧にバッジ+フィルタで反映(監査記録・手動解除可)

## アーキテクチャ / モジュール構成

住所補完バックエンドと同型の層分離。差し替え可能・テスト容易・fail-closed。

### 1. 純関数: プロンプト構築 `src/lib/sale-dm-letter/prompt.ts`
- 入力: 宛先データ(代表名・敬称種別・共有者数・物件住所・種別・部屋番号 等)+ 型(デザイン/トーン/長さ/訴求/強さ)+ 補足指示
- 出力: `{ system, user }`。`system` は全通共通でキャッシュ対象。コンプライアンス制約(誇大広告・断定価格・宅建業法配慮・敬称整合・差出人明示)を内包
- 本文の軽量バリデータ(差出人有無・禁止語不在)も純関数で

### 2. デザインテンプレート(HTML/CSS) `src/lib/sale-dm-letter/templates/`
- `formal` / `soft` / `impact` の3種。AI本文 + 宛名/差出人 + **宛先固有の追跡QR/短縮URL** を流し込んで体裁化(QRは軽量ライブラリで印刷HTML内生成・サーバー重依存なし)
- 印刷用CSS(`@page` / `page-break-after`)。まとめ印刷は全確定通を1ドキュメントに連結
- デザインの可変要素(色/フォント等)はテンプレ内のCSS変数で調整パネルから上書き可能に

### 3. 生成プロバイダ抽象 `src/lib/sale-dm-letter/providers/`
- `claude.ts`: 公式 Anthropic SDK・**サーバー側のみ**・`NEXT_PUBLIC`不使用。既定 `claude-sonnet-4-6`(env上書き可)。`system`にprompt caching。失敗は当該通のみ`is_error`
- `mock.ts`: 決定的スタブ(テスト/dev/キー未設定の代替)

### 4. オーケストレータ `src/lib/sale-dm-letter/orchestrator.ts`
- env gate(未設定→`NOT_CONFIGURED`→route 503)
- A/B割当(自動均等/手動)の適用
- 件数上限 + `truncated`
- 同期並列(同時実行数キャップ)。バッチAPIは将来

### 5. API routes `src/app/api/properties/sale-dm/`
| メソッド / パス | 役割 |
|---|---|
| `POST .../campaigns` | キャンペーン作成 + 対象集約 + 型割当 + 生成・保存。権限・上限・`truncated` |
| `GET .../campaigns/[id]` | キャンペーン詳細(下書き一覧・型・集計)。PII表示レベル準拠・`no-store` |
| `PATCH .../drafts/[id]` | 本文の手直し / この通の型・上書き変更 |
| `POST .../drafts/[id]/regenerate` | 1通再生成 |
| `POST .../campaigns/[id]/assign` | 型の割当(自動均等 / 手動) |
| `POST .../drafts/confirm` | 確定(bulk) |
| `POST .../drafts/[id]/mark-sent` | 送付済みに(PropertyDmLog連携) |
| `PATCH .../drafts/[id]/outcome` | 配達結果(届いた/宛先不明返送/その他返送)+反響(問い合わせ有無)入力。`returned_undeliverable` 記録時は対象 Property の `dmStatus`→`no_send`・`dmUndeliverableAt` を自動更新(監査) |
| `GET .../campaigns/[id]/print` | 確定分をまとめ印刷用HTMLで返す |
| `GET .../campaigns/[id]/export` | 設定一式+本文+配達結果+反響を含むCSV |
| `GET /t/[token]`(公開) | 追跡リンク。アクセス記録(`lpFirstAccessAt`/`lpAccessCount`)→ 設定LP(`SALE_DM_LP_URL`)へ302転送。**認証不要=`proxy.ts` の公開パス許可が必須**(単体テストでは検出不可) |

### 6. UI
- 物件一覧 `src/app/(dashboard)/properties/page.tsx` に「売却DMを作成」(`canExportDm`相当の権限で表示)+ **「宛先不明」バッジ列・絞り込みフィルタ**(`Property.dmUndeliverableAt` 参照)
- キャンペーン作業画面(レイアウトA・3分割):調整パネル(全体/この通タブ)/ プレビュー / 宛先リスト(型バッジ・配達結果/反響入力)
- 型別の反響率・宛先不明率の集計ビュー

### 7. 権限 / PII
- 既存所有者宛DMと同一: `property:read` + `csv_export:read` + `csv_export_personal:read` + `owner:read`。生値必須(不可なら403)
- 本文・宛名・住所はPII → `no-store`・表示レベル準拠・監査ログに本文非記録
- 設定一式(型)・反響フラグ・モデル名は非PII

### 8. 出力 / 印刷
- 主: HTMLプレビュー + **ブラウザ印刷**(まとめ印刷=1HTML・`page-break`)。サーバーに重い部品を足さない
- 補助: CSV(既存ヘルパ流用・設定一式の列+本文+反響)。formula injection対策維持

## エラー処理
- env未設定 → 503(fail-closed)。UIは「未設定」を表示
- 生成失敗(429/5xx/refusal) → 当該通のみ失敗マーク・全体継続・再生成可
- 件数上限超過 → `truncated` + UI明示警告
- 権限不足 / 生値不可 → 403

## テスト方針(TDD)
- `buildLetterPrompt`(純関数): 敬称整合・差し込み・型の反映・コンプライアンス制約
- テンプレ描画: 3デザインの体裁・ページ区切り・流し込み
- A/B割当(純関数): 自動均等の分配・手動指定・件数偏り
- orchestrator/route: **mock provider** で 生成・上限/truncated・失敗時部分継続・env gate(503)
- 集計: 型別 送付数/到達数/宛先不明数/反響数/反響率(母数=到達)/宛先不明率
- 宛先不明→物件連動: `returned_undeliverable` で `Property.dmStatus`→`no_send`・`dmUndeliverableAt` 更新・物件一覧フィルタ・監査記録・手動解除
- 追跡リンク: トークン一意性 / `/t/[token]` で `lpFirstAccessAt`・`lpAccessCount` 記録→LP転送(302) / 不正トークン処理 / 反響=LP∪電話 の導出 / **公開パス許可(`proxy.ts`)**
- CSV: 設定一式列+本文+配達結果+反響・エスケープ・BOM+CRLF・formula injection
- 権限/PIIマスク(403)・`no-store`

## コスト見積もり(参考)
月1000通でも本文生成API費用は数百〜数千円(出力主因・共通指示はキャッシュ・将来バッチで半額)。郵送/印刷代(月8〜10万円規模)に対し実質無視できる。

## セキュリティ / コンプライアンス
- APIキーは**サーバー側のみ**・`NEXT_PUBLIC`不使用・client直叩きなし・**キー未設定で fail-closed(503)**
- 本文・宛名・住所はPII → 権限・表示レベル・`no-store`。監査ログに本文非記録
- プロンプトに 誇大広告/断定価格/宅建業法 配慮の制約。差出人は設定/プレースホルダ
- 追跡リンクは**opaqueトークン**(URL/QRにPIIを載せない)。公開エンドポイント `/t/[token]` は `proxy.ts` の公開パス許可が必須(単体テスト検出不可)。LP転送時もPIIをクエリに付さない(キャンペーン/型の匿名IDのみ可)。bot/プリフェッチのノイズは初回アクセス時刻で軽く判定
- 出力CSVは formula injection 対策済

## 環境変数(本番設定が必要)
| 変数 | 用途 |
|---|---|
| `SALE_DM_LETTER_PROVIDER` | `claude` / `mock`(未設定→fail-closed) |
| `ANTHROPIC_API_KEY` | Claude API キー(provider=claude時) |
| `SALE_DM_LETTER_MODEL`(任意) | 既定 `claude-sonnet-4-6` の上書き |
| `SALE_DM_LP_URL` | 既存LPの転送先URL(追跡リンクのリダイレクト先) |
| 差出人情報(任意) | 自社名・連絡先のプレースホルダ既定 |

未設定でも機能は安全に停止(503)し既存挙動は不変。本番有効化は別承認(キー受領後)。

## 段階
- **初版(本スコープ)**: 生成 + 3デザイン + 調整パネル(全体/個別) + A/B(自動均等/手動・設定一式記録) + 反響(問い合わせ有無)+ 型別反響率集計 + ブラウザ印刷 + CSV
- **後続(別PR)**: 分析ダッシュボード強化 / サーバーPDF生成 / バッチAPI非同期化 / 送付予約 / 物件宛DM対応 / デザインテンプレ追加
