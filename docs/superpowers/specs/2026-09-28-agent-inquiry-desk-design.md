# 業者からの反響の受付(受付の窓) 設計書

- 日付: 2026-09-28
- 発注者予告: 2026-09-27「次の大型開発で反響の受付(不動産業者から内見や広告依頼の一括管理)を作る」
- 見本(発注者確認済み):
  - ER図 第5版 https://claude.ai/artifact/Wmiqhh7WuvqLxSR8evu3uR
  - 画面見本 版3 https://claude.ai/artifact/HGxNfi9E5eevjsZg6tPT2x
  - 別の窓のイメージ https://claude.ai/artifact/8EGB9MWThvqjBFtqDrzqrR
- ⚠既存の「査定の申込」(売却DMの公開LP経由・**所有者本人**からの申込=`dm_inquiries`)とは**別物**。混同しない。

## 0. 発注者と確定した方針(再提案しない)

1. 目的は3つ: **対応漏れをなくす**/**物件ごとの反響件数を物件画面で見る**/**メール・電話・FAXの記録を一か所にまとめる**。売主向けの報告書・物件どうしの比較一覧は作らない。
2. 量は**月30件未満**。対応は**数人で分担**し、反響ごとに担当者を決める。
3. 入口は**ほとんど電話**。メール自動取り込みは**作らない**(メールで来た分はメモ欄に本文を貼るだけ)。FAX(03plus のインターネットFAX)の取り込みは後回し。入口の種別(電話/メール/FAX)は記録する。
4. 用件は**内見/広告の許可/資料請求の3つ**。賃貸はやらない=空室確認は扱わない。購入申込も対象外。
5. 内見は**日時・案内か下見か・こちらの立ち会い・内見後の結果**を持つ。案内=お客様連れ、下見=業者だけ。**1つの反響に内見を複数**持てる(日程変更・2回目の案内)。鍵の手配は持たない。
6. 物件は**必ず結び付ける**(物件が分からない反響は無い)。物件は物件名で探す。区分マンションは**部屋まで**。
7. **業者の名簿**=電話帳型・**会社の情報だけ**(電話は**代表電話**)。問い合わせ者(業者の担当)の**名前・携帯・メール**は**反響ごと**に入れる(メール=資料請求の送り先)。名簿は**使いながら増やす**=反響を登録した人がその場で新しい業者を登録できる。国の宅建業者検索を開くリンクを付ける。国のサイトからの一括取り込みはしない(利用規約で一括取得の可否が確認できないため)。
8. **広告の可否は物件ごと(区分は部屋ごと)に先に決めておく**。媒体は **自社HP/at home/SUUMO/HOME'S/その他のポータル/チラシ** の6つ、値は **○(可)/×(不可)/△(担当者に確認)**。
9. 通知メールは**送らない**。ホームに「未対応○件」「今日・明日の内見○件」を出す。
10. **全員が使える**(管理者・事務スタッフ・現地スタッフ)。現地スタッフは今、自分が登録した/担当の物件しか見えないが、**受付の窓の物件検索に限り全物件を探せる**。見えるのは**物件名・部屋番号・町名まで・広告の可否だけ**(所有者・価格など他の中身は見えない・物件画面は今まで通り開けない)。
11. **メイン画面と分けて別の窓で処理する**=同じアプリ・同じログインの**受付専用画面**(メニュー無し)。メイン画面のボタンから別窓で開く/ブックマークで直接開く。スマホでは1枚で開く。
12. 登録の並び順=**業者 → 問い合わせ者(名前・携帯・メール) → 物件 → 用件 → 内見の予定 → 入口 → 保存**。「その場で回答した=対応済みで登録」のチェックは**付けない**。
13. 反響の担当者の既定=**登録した本人**(後から振り替え可)。内見後の結果は**後から反響を開いて書く**。
14. 2026-09-26 の発注者要望「次に押すボタンを光らせる+助言の吹き出し」を最初から入れる(売却DMの手順の案内 `src/components/sale-dm/step-guide.tsx` の型を流用)。

## 1. データ(新しい表4つ・既存の表は変えない・migration は ADD のみ)

```prisma
enum AgentInquiryKind   { viewing ad_permission material_request }
enum AgentInquiryChannel { phone email fax }
enum AgentInquiryStatus { open in_progress done }
enum ViewingType        { guided preview }          // 案内 / 下見
enum AdMedium           { own_site athome suumo homes other_portal flyer }
enum AdPermissionValue  { ok ng ask }                // ○ × △

model Agent {                       // 業者の名簿(会社のみ)
  id           String   @id @default(uuid()) @db.Uuid
  companyName  String   @map("company_name")          // 商号(必須)
  companyKana  String?  @map("company_kana")
  branchName   String?  @map("branch_name")
  licenseNo    String?  @map("license_no")            // 例: 東京都知事(3)第12345号
  phone        String                                  // 代表電話(必須・formatPhoneJp で整形して保存)
  fax          String?
  email        String?
  address      String?
  note         String?
  isArchived   Boolean  @default(false) @map("is_archived")
  version      Int      @default(1)
  createdById  String   @map("created_by_id") @db.Uuid
  createdAt / updatedAt
  @@index([companyName])
  @@map("agents")
}

model AgentInquiry {                // 反響
  id             String   @id @default(uuid()) @db.Uuid
  propertyId     String   @map("property_id") @db.Uuid     // 必須(区分は部屋=Property 行)
  agentId        String   @map("agent_id") @db.Uuid
  contactName    String?  @map("contact_name")             // 問い合わせ者
  contactMobile  String?  @map("contact_mobile")           // 携帯(formatPhoneJp)
  contactEmail   String?  @map("contact_email")            // 資料の送り先
  kind           AgentInquiryKind
  channel        AgentInquiryChannel @default(phone)
  receivedAt     DateTime @default(now()) @map("received_at")
  status         AgentInquiryStatus  @default(open)
  assigneeId     String?  @map("assignee_id") @db.Uuid     // 既定=登録者
  note           String?                                    // メール本文の貼り付けもここ
  version        Int      @default(1)
  createdById    String   @map("created_by_id") @db.Uuid
  createdAt / updatedAt
  property Property @relation(onDelete: Restrict)
  agent    Agent    @relation(onDelete: Restrict)
  @@index([status, receivedAt])
  @@index([propertyId, receivedAt])
  @@index([agentId, receivedAt])
  @@map("agent_inquiries")
}

model AgentViewing {                // 内見の予定(1反響に複数)
  id           String   @id @default(uuid()) @db.Uuid
  inquiryId    String   @map("inquiry_id") @db.Uuid
  scheduledAt  DateTime @map("scheduled_at")
  viewingType  ViewingType @map("viewing_type")
  attendantId  String?  @map("attendant_id") @db.Uuid      // こちらの立ち会い(無しも可)
  resultNote   String?  @map("result_note")
  canceledAt   DateTime? @map("canceled_at")
  createdAt / updatedAt
  inquiry AgentInquiry @relation(onDelete: Cascade)
  @@index([scheduledAt])
  @@map("agent_viewings")
}

model PropertyAdPermission {        // 広告の可否(物件×媒体で1行)
  id          String   @id @default(uuid()) @db.Uuid
  propertyId  String   @map("property_id") @db.Uuid
  medium      AdMedium
  value       AdPermissionValue
  updatedById String   @map("updated_by_id") @db.Uuid
  updatedAt   DateTime @updatedAt @map("updated_at")
  @@unique([propertyId, medium])
  @@map("property_ad_permissions")
}
```

- 未設定の媒体は行が無い=画面では「未設定(—)」と出す。△と未設定は区別する。
- 問い合わせ者の携帯・メールは**業者の担当者個人の業務連絡先**。所有者 PII と同じ扱いにはしないが、監査ログには値を書かない(§4)。
- 物件・業者は削除させない(`Restrict`)。業者は「しまう」(`isArchived`)だけ。反響は削除せず、誤登録は状態を「対応済み」+メモで扱う(削除の要望が出たら別途)。

## 2. 画面

### 2.1 受付の窓 `/(desk)/inquiry-desk`(新しいレイアウト・メニュー無し)
- 見出し: 「反響の受付」+ログイン中の人+未対応件数。
- 上から: **今日・明日の内見**(取り消し以外・時刻順)→ **登録フォーム** → **一覧**(未対応/対応中/対応済みのタブ・担当者で絞り込み・新しい順・対応済みは直近30日を既定表示)。
- 一覧の1件を開くと詳細(同じ窓の中で): 状態・担当の変更、メモ、内見の追加・日時変更・取り消し・結果の記入。
- 一覧・詳細の「メイン画面で物件を開く」: 素の `<a href target="pm-main">` で名前付きの窓に開く(`window.open` はブロックされる環境があるため使わない)。**その物件の閲覧権限が無い人には出さない**。
- スマホ幅では同じ画面を1枚で表示。
- メイン画面の「↗ 反響の受付を別窓で開く」は `<a href="/inquiry-desk" target="pm-inquiry-desk">`(同じ名前の窓があればそこへ)。

### 2.2 登録フォーム
1. **業者**: 1つの検索欄に代表電話・携帯・会社名のどれでも。
   - 数字7桁以上 → 代表電話と**過去の反響の問い合わせ者の携帯**をハイフン無視で照合(`phoneSearchDigits` と `regexp_replace` の既存方式)。携帯で当たったら「○○不動産(前回 田中様)」と出し、選ぶと問い合わせ者の名前・携帯・メールも前回の値で埋める(書き換え可)。
   - それ以外 → 商号・ふりがな・支店の部分一致。しまった業者は出さない。
   - 名簿に無い → 「＋名簿にない業者を新しく登録」で小窓。必須は商号と代表電話。国の宅建業者検索 `https://etsuran2.mlit.go.jp/TAKKEN/` を開くリンク。登録するとフォームに戻り選択済みになる。
2. **問い合わせ者**: 名前・携帯・メール(すべて任意)。用件=資料請求でメールが空なら「資料の送り先のメールが空です」と黄色で知らせる(保存は止めない=FAXで送る場合もあるため)。
3. **物件**: 物件名・部屋番号・所在地で検索(物件名の無い戸建・土地は所在地で探す)→ 選ぶとその物件の**広告の可否 6媒体**を表示。
4. **用件**: 内見/広告の許可/資料請求。
5. **内見の予定**(用件=内見のとき): 日付・時刻・案内/下見・立ち会い(利用者から選ぶ・「なし」可)。日時は空でも保存できる(「日程調整中」)。
6. **入口**: 電話(既定)/メール/FAX。メモ。
7. 保存 → 状態=未対応・担当=登録者・受けた日時=今。
- 案内の光と吹き出し: 未入力の次の欄(業者→物件→用件→保存)を光らせる。「案内を消す」は端末ごとに記憶(売却DMの型と同じ)。

### 2.3 メイン画面
- **物件画面の「反響」欄**: 件数(反響・案内・下見・資料請求)/広告の可否(押すと ○→×→△→未設定 と切り替わる・物件の編集権限がある人だけ)/時系列(新しい順・内見は予定日時で、それ以外は受けた日時で並べる・取り消した内見は薄く)。
- **業者の名簿** `/agents`: 検索・一覧(代表電話・反響件数・最終日)・詳細(会社情報の編集・その業者からの反響一覧)・しまう。
- **ホーム**: 「未対応の反響○件」「今日・明日の内見○件」→ 押すと受付の窓の該当タブ。
- サイドバー: 「反響の受付」(別窓で開く)と「業者の名簿」。

## 3. API(すべて `getApiSession` 必須・`handleApiError`)

| メソッド・パス | 役割 |
|---|---|
| `GET /api/agents?q=` | 業者検索(電話は7桁以上で数字照合・携帯は反響から逆引き・上限20件) |
| `POST /api/agents` / `PATCH /api/agents/[id]` | 業者の登録・編集・しまう(`version` で 409) |
| `GET /api/agents/[id]` | 業者の詳細+反響一覧 |
| `GET /api/agent-inquiries?status=&assignee=` | 一覧(ページング) |
| `GET /api/agent-inquiries/upcoming` | 今日・明日の内見 |
| `GET /api/agent-inquiries/counts` | ホーム用の件数 |
| `POST /api/agent-inquiries` | 登録(内見の予定を同時に作れる・1トランザクション) |
| `GET/PATCH /api/agent-inquiries/[id]` | 詳細・状態/担当/メモ/問い合わせ者の変更(`version` で 409) |
| `POST /api/agent-inquiries/[id]/viewings` / `PATCH .../viewings/[vid]` | 内見の追加・変更・取り消し・結果 |
| `GET /api/agent-inquiries/property-search?q=` | 受付の窓専用の物件検索(§4) |
| `GET /api/properties/[id]/agent-inquiries` | 物件画面の反響欄(件数・時系列) |
| `PUT /api/properties/[id]/ad-permissions` | 広告の可否の変更(物件の編集権限) |

入力検証は zod。電話・携帯は `formatPhoneJp` で整形して保存(桁不正は保存を止めず警告だけ=所有者編集と同じ扱い)。メールは形式チェック。

## 4. 権限と安全

- 新しい権限 `agent_inquiry:read` / `agent_inquiry:write` を作り、migration で**3つのテンプレート(管理者用・事務担当用・現地担当用)すべてに付与**(`INSERT ... WHERE NOT EXISTS` の既存の型)。個別の上書きで外せる。
- **受付の窓専用の物件検索**: `agent_inquiry:read` があれば全物件を対象にするが、返す項目は**許可リスト**で `id・物件名(buildingName)・部屋番号・町名まで(番地以降を落とす)・種別・広告の可否` だけ。所有者・価格・地番・メモは返さない。検索の条件は物件名・部屋番号・所在地だけ(**所有者・地番・メモでは探せない**=返さない情報を検索のヒット有無から推測させない)。
- **反響の登録・変更**は `agent_inquiry:write`。物件の閲覧権限は問わない(方針10)。ただし**物件画面の反響欄と広告の可否の変更**は既存の物件の権限(`assertPropertyAccessible` 相当+編集権限)に従う。
- 一覧・詳細で出す物件の情報も、上の許可リストと同じ範囲に限る。「メイン画面で物件を開く」は物件の閲覧権限がある人にだけ出す。
- 監査ログ(`writeAuditLog`): 業者の登録・編集・しまう、反響の登録・状態/担当の変更、内見の追加・変更・取り消し、広告の可否の変更。detail には **id・変えた項目名・状態の値だけ**(問い合わせ者の名前・携帯・メール・メモの中身は書かない=許可リスト方式)。
- 同時に直したとき: `version` を進め、古い版からの保存は 409(黙って上書きしない)。
- 受付の窓も既存のログイン・自動ログアウト・画面保護の対象(`proxy.ts` の公開パスに足さない)。

## 5. 作る順番(3回に分けて本番に出す)

1. **PR1 データと裏側**: migration(4表+enum+権限付与)・API 全部・純関数(業者検索の判定・物件検索の許可リスト・時系列の並べ方・件数)・テスト。画面なし。
2. **PR2 受付の窓**: `/inquiry-desk`(フォーム・新しい業者の小窓・一覧・詳細・今日明日の内見・案内の光)。**ここで使い始められる**。
3. **PR3 メイン画面側**: 物件画面の反響欄・広告の可否・業者の名簿画面・ホームの件数・サイドバー・別窓ボタン。

各 PR は TDD → フル `npx vitest run` → tsc → eslint → build → 提出前レビュー → @codex(クリーンまで)→ 発注者マージ → 本番反映(PR1 は migration あり)。

## 6. テスト方針

- 純関数(総当たり): 業者検索の入力の振り分け(7桁境界・ハイフン・全角数字)/物件検索の返却項目が許可リストだけであること/町名までの切り落とし/時系列の並び(内見=予定日時・他=受けた日時・取り消し)/件数/資料請求で送り先メールが空のときの警告。
- API: 権限なし 403・現地スタッフが自分の担当外の物件に反響を登録できること・担当外の物件の中身(所有者・価格)が一切返らないこと・409・監査 detail に携帯/メール/メモが含まれないこと。
- 画面: `renderToStaticMarkup` で並び順・必須表示・権限なしの「物件を開く」非表示。実ブラウザ(Playwright)で別窓の開閉と、受付の窓で保存→メイン画面の反響欄に出ることを確認。

## 7. やらないこと(今回)

メールの自動取り込み/FAX の取り込み/03plus の着信履歴との連携/通知メール/売主向け報告書/物件どうしの比較一覧/鍵の手配/購入申込/国のサイトからの一括取り込み/反響の削除。
