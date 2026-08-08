# DM送付管理(送付記録・反響・再送候補) 設計

> **作成日**: 2026-08-08 / **性質**: 設計のみ(この PR にコード変更は無い)
> 前段設計 = `deliverables/22A/22E8-response-management-design.md`(2026-06-15・repo外)。本書はその**現状照合済み・決定事項反映版**で、以後の正本。

---

## 0. 発注者の決定事項(2026-08-08 確認済み)

| 論点 | 決定 |
|---|---|
| 送付記録の付け方 | **一括(宛名CSV出力の単位で確定)+ 個別(物件ページから記録/取消)の両方** |
| 反響の種類 | **基本の4つ**: 返事なし(no_response)/連絡あり(replied)/拒否(refused)/宛先不明(undeliverable)。後から追加可能な作りにする |
| 再送までの間隔 | **90日**(再送候補に出るまでの期間。意図した送付はいつでも可) |
| 同一宛先への上限 | **無し**(拒否・宛先不明の自動除外で制御する) |

## 1. 現状(2026-08-08 実測)

- `PropertyDmLog`(`property_dm_logs`)は7列(id/propertyId/sentAt(@db.Date)/method?/sentBy/note?/createdAt)・索引は propertyId のみ。**ownerId・種別・反響列は無い**。
- 書き込みは**売却DMの送付確定(mark-sent)の1箇所のみ**(method="sale_dm")。宛名CSV出力(dm-export)は**意図的に書かない**(テストで固定)。
- 履歴表示は実装済み: `GET /api/properties/[id]/dm-logs` + 物件詳細の「DM送付履歴」(read-only・note は owner_note 表示レベルでマスク・非PII閲覧監査)。→ 22E8 の PR-1 は完了済み。
- 反響は売却DM側(`DmRecipientDraft.outcome/deliveryStatus`)にのみ存在。**returned_undeliverable → 物件 dmStatus=no_send + dmUndeliverableAt の自動連動が既にある**。
- クールダウン/上限の実装・定数・env は**存在しない**(grep 0件)。
- 一覧には #277 で「未送信のみ(dmSentMax=0)」「送信回数ソート」「宛先不明のみ」が既にある(表示補助であり生成時の自動除外ではない)。
- 宛名CSV出力は**検索条件ベース**(チェック選択ではない・上限10,000行・同一送付先住所の共有者は代表1行にグルーピング=`selectGroupRepresentative`)。UI は所有者宛のみ(物件宛 export は API のみで UI 導線なし)。

## 2. 第1段(PR-A): 送付の記録

### 2.1 出力の控え(バッチ) — 「実際に出力した相手にだけ」記録を付ける

CSV 出力と送付確定の間に時間が空く(印刷・投函)。確定時に検索条件を再実行すると、その間の編集で**出力していない物件に記録が付く**(誤一括記録)。よって**出力時点の宛先集合を控えとして保存**し、確定はその控えに対して行う。

新テーブル2つ(additive):

```prisma
model DmExportBatch {
  id          String    @id @default(uuid()) @db.Uuid
  dmType      String    @map("dm_type")            // "owner_address"(現行UIはこれのみ)
  filters     Json?                                 // 監査用の出力条件(既存 export 監査と同じ allowlist 済みキーのみ)
  rowCount    Int       @map("row_count")           // CSV行数(=宛先件数)
  createdBy   String    @map("created_by") @db.Uuid
  createdAt   DateTime  @default(now()) @map("created_at")
  attemptKey  String    @unique @map("attempt_key") // 押下ごとの冪等キー(下記「出力は2段階」)
  downloadedAt DateTime? @map("downloaded_at")      // 初回DLの刻印(配信集合の不変化境界・確定の前提)
  csvDigest   String?   @map("csv_digest")          // 初回DLで配ったCSVのsha256(再試行の同一性検証・PIIは持たない。R39で廃止したcontent_digestとは別役割)
  resendFilterApplied Boolean @default(false) @map("resend_filter_applied") // POST時に再送候補フィルタが使われたか(R50: DL時の候補再評価の対象)
  confirmedAt DateTime? @map("confirmed_at")        // null=未確定
  confirmedBy String?   @map("confirmed_by") @db.Uuid
  sentOn      DateTime? @map("sent_on") @db.Date    // 投函日(確定時に入力)
  items       DmExportBatchItem[]
  creator     User      @relation("DmExportBatchCreator", fields: [createdBy], references: [id])
  @@index([createdAt])
  @@map("dm_export_batches")
}

model DmExportBatchItem {
  id         String  @id @default(uuid()) @db.Uuid
  batchId    String  @map("batch_id") @db.Uuid
  propertyId String? @map("property_id") @db.Uuid  // R49: 物件削除で null 化(下記)
  ownerId    String? @map("owner_id") @db.Uuid      // 代表所有者(所有者宛)。物件宛は null
  batch      DmExportBatch @relation(fields: [batchId], references: [id], onDelete: Cascade)
  property   Property?     @relation(fields: [propertyId], references: [id], onDelete: SetNull) // @codex R49 P1: 削除で控えを道連れにしない(DL後の郵送済み記録を守る)
  owner      Owner?        @relation(fields: [ownerId], references: [id], onDelete: SetNull) // @codex P2: 確定前に所有者が消えたら null 化(確定を巻き戻さない)
  @@index([batchId])
  @@map("dm_export_batch_items")
}
```

- **出力は2段階 = 「POST で控え作成 → GET で CSV ダウンロード」**(R1〜R39 で到達した最終形。@codex R39 P2):
  - **POST `/api/properties/dm-batches`**(body=filters+attemptKey)が検索条件を評価し、**バッチ+items を作成して batchId を返す**。副作用は POST に置く(このリポの規約どおり=**cross-site のトップレベル GET 遷移では控えを作れない**。SameSite=Lax の直叩き/ブックマークで最大1万itemの控えが無限に積まれる穴(R38-39)を CSRF 境界で塞ぐ)。
  - **GET `/api/properties/dm-batches/[id]/csv`** は**保存済みの items から CSV を生成して返す**(no-store・作成者本人のみ・4権限+PII表示レベル(plain)ゲート)。ダウンロードは従来どおりブラウザ遷移(UI は POST→batchId の GET URL へ遷移)。**「初回ダウンロード」を境界とするライフサイクル**(@codex R40 P1 → R41/R42 で確定):
    - **初回 GET(downloadedAt 未設定)**: 凍結 tx は全 writer 共通のロック順序規約に従う=**無ロックで items を先読み→参照 Owner 行(代表+連関全員・安定id順・FOR SHARE)→参照物件親行(安定id順)→バッチ行 FOR UPDATE→items 再読取(先読みと集合不一致なら中止して再試行)**(@codex R43 P2: 初回GET同士のレースで別々の集合を凍結しない+R44 P1: バッチ行だけでは record scope 検証と担当変更が競合しない=物件親行を先にロックすれば担当替えtx(親行ロック規約に従う)と直列化され、剥奪後のPII配信を塞ぐ。バッチ行ロック後に downloadedAt を再判定し、設定済みなら再試行経路へ落とす)。ロック保持中に現在状態を検証してから配る。(1) record scope で1件でも欠ける→**403**(再出力案内) (2) **terminal 反響(refused/undeliverable)が付いた宛先が混ざった→409**(再出力案内。控えが古いまま除外済みの相手へ郵送するのを防ぐ=@codex R42 P1。⚠この検査が並行する反響書込とすれ違わないよう、**terminal を書く全 writer は対象の所有者集合(代表+連関全員)を安定id順に FOR UPDATE してから親行→子行へ進む**=@codex R47 P1: 共有所有者の**別物件**への拒否/宛先不明の書込は、バッチが参照する物件・ログの行ロックとは競合しない。DL側の Owner FOR SHARE と writer 側の Owner FOR UPDATE が衝突することで直列化される。非terminalの反響書込(replied/no_response・LP追跡)は DL の妥当性に影響しないため Owner ロック不要=追跡ヒットのホットパスを重くしない) (3) **宛先資格の再検証**(@codex R48 P1): item ごとに「代表+連関の owner が**現在も PropertyOwner でその物件に紐づいているか**」「物件の dmStatus が **no_send に変わっていないか**」を検査し、1件でも該当すれば **409**(再出力案内。紐づけ解除・送付停止は Owner 行も item も残したまま起きるので (1)(2) では検出できず、CSV の中身もバイト同一になり得る。PropertyOwner の付け外しと dmStatus 更新はどちらも物件親行を先にロックする規約なので、本 tx の親行ロック(FOR SHARE)と直列化される) (4) **owner または物件の削除で null になった item は items から物理削除して除外**(件数報告)し、**rowCount を残存 items 数で同一 tx 内に再計算**(@codex R45 P2: 未確定一覧のモーダルが表示する件数と凍結集合の件数がずれない)。 (5) **再送候補フィルタで作られたバッチ(resendFilterApplied)は §4 の候補述語を item ごとに再評価**し、候補でなくなった宛先(**返信あり=恒久除外・より新しい送付記録で90日以内・terminal・所有者単位除外**)が1件でも混ざれば **409**(再出力案内=@codex R50 P1: これらは CSV の中身に現れず digest では検出できない。通常の検索条件バッチには掛けない=「意図した送付はいつでも可」の発注者判断を崩さない)。残った items が**配信集合そのもの**になり、同一 tx 内で items/owners を再読取して CSV を描画し、**その CSV の sha256 を `csvDigest` に保存**+`downloadedAt` を刻む(いずれも列追加。digest はハッシュのみ=PII は保存しない)。
    - **再試行 GET(downloadedAt 設定済み)**: **初回と同じロック手順の tx で実行**し(Owner FOR SHARE→物件親行→バッチ行→items 再読取。凍結はしないが検証と描画をロック保持中に行う=@codex R47 P1)、同じ items から再生成して **csvDigest と一致した場合のみ配信**。**terminal 反響と宛先資格((3)=PropertyOwner 紐づけ・no_send)、再送候補バッチなら候補述語((5))の検査も初回と同様に毎回掛け、初回DL後に refused/undeliverable が付いた・紐づけが外れた・送付停止になった・候補でなくなった宛先が混ざったら 409**(再出力案内=@codex R45 P1: 反響は CSV 内容に現れず digest では検出できない。初回CSVを既に印刷済みの利用者は再試行しないので影響なし・確定は凍結集合のまま可能)。不一致(owner の氏名/住所や物件情報が初回DL後に変わった・owner 削除で描画不能)は **409**(「内容が変わったため再出力してください」)にする(@codex R43 P1: 同一バッチから内容の異なるCSVが2度印刷され、確定は片方の集合しか記録しない事故を防ぐ。再試行は「初回と同一物の再取得」専用・変わっていたら新しいバッチを作り直す)。権限+本人+スコープ403も再検証。
    - **確定は downloadedAt 必須**(未DLの確定は 409「先にCSVを出力してください」)。確定は items 全件を記録し、**DL後に owner が削除された item は owner_id=null で記録**する(手紙は出ている=@codex R42 P2。DL前の削除は初回GETで既に除外済みなので混同しない)。
  - **冪等化**: attemptKey(UI が押下ごとに発行・POST body で必須・`attempt_key` unique)。同じキーの再 POST は既存バッチを FOR UPDATE で照会し**未確定なら再利用・確定済みなら 409**(確定側と行ロックで直列化=R4)。INSERT の unique 衝突は catch して勝者を取り直す(R5)。**別の押下は別のキー=別の控え**(内容ハッシュで畳むと同日2回の意図した郵送まで合流する=R6)。先例=売却DMキャンペーンの idempotencyKey。
  - **再試行とのズレは構造的に消滅**: CSV は常に**控えの items から**生成するため、「再試行が別の宛先集合を出力する」事態が起きない(R7 の content_digest 照合は不要になり**列ごと削除**)。owner が削除済み(SetNull)の item は CSV から除外し件数を表示(郵送不能のため)。
- **所有者の削除(@codex R4→R41→R42 で確定)**: item の owner FK は SetNull。**DL前の削除=初回GETで items から除外**(郵送されていない=記録しない)/**DL後の削除=itemは残り、確定で owner_id=null として記録**(手紙は出ている)。「DLした集合=確定される集合」の不変条件は downloadedAt 境界で守る。
- **共有者グループ全員の保持(@codex R29 P1)**: 1つのCSV行(=item)は**同一送付先住所の共有者を束ねた1通**であり、代表の ownerId だけを持つと、**代表以外の共有者**が別物件を持つ場合に拒否/宛先不明の記録がその共有者に紐づかず、§4 の所有者単位の除外から漏れる。連関テーブル **`dm_export_batch_item_owners`(item_id FK Cascade, owner_id FK Cascade)** に**グループ全員の ownerId** を保存し(export 時に selectGroupRepresentative のグループから採取)、確定時に **`property_dm_log_owners`(log_id FK Cascade, owner_id FK Cascade)** へコピーする。既存の owner_id 列(代表)は表示・ブリッジ用に維持。migration-A に2連関テーブルを追加。⚠**連関3表(draft_owners 含む)はいずれも owner_id 先頭の索引を必須とする**(@codex R46 P2: 再送候補の所有者単位除外と名寄せの付け替えは owner_id 側から引く。Postgres は FK 参照列に自動で索引を張らず、(item_id, owner_id) 順の複合キーではこの向きの検索に使えない=履歴の成長で全走査になる。特に `property_dm_log_owners`)。

- **CSV の中身(氏名・住所)は保存しない**。控えは propertyId/代表 ownerId のみ=非PII寄りの最小構成。
- 既存の export GET(検索条件から直接CSV)は**新しい2段階フローに置き換える**(旧GETは撤去または新POSTへの誘導)。**PropertyDmLog はどの段でも書かない**(既存テストのピンは維持し、「POSTがbatchを書く」ことを明示する形にテストを更新)。
- item の property FK は **SetNull**(@codex R49 P1 で Cascade から変更): owner 削除と同じ downloadedAt 境界に従う=**DL前の物件削除は初回GETで item を除外**(郵送されていない)/**DL後の削除は item が残り、確定で property_id=null として記録**(手紙は出ている。owner_id と連関は残るので所有者横断の除外は効き続ける)。
- 物件宛 export(UI導線なし)は今回対象外。dmType 列は将来用に持つ(TEXT+アプリ側allowlist・enum は作らない=#361 と同方針)。

### 2.2 送付確定(一括)

- `GET /api/properties/dm-batches?unconfirmed=1` — 確定モーダル用の一覧(出力日時・件数・確定状態。中身の宛先は返さない)。
- `POST /api/properties/dm-batches/[id]/confirm` body=`{ sentOn: "YYYY-MM-DD" }`。**sentOn は「バッチ作成日(JST)以降〜今日以前」のみ受理**(@codex R36/R40 P2: 未来日は実在しない送付を作り、作成日より前の過去日(年の打ち間違い等)は90日経過扱いで全宛先が即再送候補になる。個別記録 POST は過去日可・今日以前のみ)。
- ゲート: 既存 export と同じ4権限+**property:write**(書込は mark-sent/outcome と同じ統一方針・新slugなし)。
- **スコープ外 item の扱い(@codex R3 P2)**: field_staff の担当変更などで**1件でもスコープ外の item がある場合、確定を 403 で拒否**する(スキップして confirmedAt を立てると、その宛先の送付記録が**永久に欠ける**=後から権限のある人が確定しようとしても「確定済み」で弾かれるため)。エラーには「スコープ外が N 件・管理者/事務担当で確定してください」と理由を出す。部分確定(item単位の確定状態)は作らない=単純さ優先(実運用は管理者2名で、まず起きない)。
- 冪等: `confirmedAt` が null の場合のみ、条件付き updateMany(勝者決定)→ 同一 tx で items から `PropertyDmLog` を生成。二重確定は 409。
- ⚠**items の所有者は tx 内で読み直す**(@codex R14 P1 → R40 P2 で順序統一): 確定 tx は **「items を先読み(ロックなし)→ 所有者集合(代表+連関)を安定 id 順に FOR SHARE → バッチ行と item 行を FOR UPDATE で再読取 → 所有者が先読みと不一致なら中止・再試行」** の型(§下記ロック順序=Owner→親→子)で、その時点の ownerId で記録する。tx 前スナップショットの使用や「子を先にロックして直列化の根拠にする」ことはしない(名寄せの Owner 先頭ロックと相互待ちになる)。
- 生成する行: `propertyId / ownerId(代表) / dmType="owner_address" / batchId / sentAt=sentOn / method="mail" / sentBy=操作者`。
- **「何通目」は列で持たず、表示時に導出する**(@codex R26 P2 を機に方式変更・採番系を全廃):
  - 表示 API(DM送付履歴)が、物件ごとの記録を **`sentAt, createdAt, id` 順に並べた時系列の連番**を計算して返す(SQL window か app 側。1物件の記録は少数なので負荷は無視できる)。
  - ⚠採番列(sequence)方式は、**後から入力した古い投函日の個別記録が MAX+1 で最大連番になり、「何通目」が時系列と永久に食い違う**(R26)。表示時導出なら遅れて入れた記録も自動的に正しい位置に入り、削除後の欠番・並行確定の重複・migration の段階投入(旧writer窓・backfill・明示tx)という**採番系の複雑さが構造ごと消える**。
  - これに伴い R2-2(MAX+1)・R20(backfill順序)・R7/R8/R24(migration-A2 の段階投入と advisory lock)の採番系対策は**不要化**(対応履歴に経緯として残す)。migration-A2 自体が消え、**migration は A(列追加のみ)の1本**になる。
  - 同一バッチ内の同物件複数行は sentAt が同日で同順位になり得る→表示は createdAt, id で安定に並ぶ(順位の重複表示は許容: 同日に2通は事実)。
- **ロック順序の統一(@codex R2 P2 → R22 P1 → R26 で採番 advisory を除去)**: 全 DM writer の順序は **「Owner(代表所有者) → variant → 物件親行 → 子行(item/draft/log)」** の一方向。⚠log の insert は owner FK の暗黙ロックを**最後に**取るため、子行を先にロックする writer と「Owner→子」の統合 tx(5d)が混ざると相互待ちになる。子を読まないと所有者が分からない writer(一括確定・mark-sent)は **「先読み(ロックなし)→ Owner を id 順にロック → 子行を FOR UPDATE で再読取 → 所有者が先読みと不一致なら中止して再試行(409/リトライ)」** の型で順序を守る。⚠ロック対象の Owner は**代表だけでなく連関(item_owners/draft_owners)の全所有者**(@codex R31 P1: 代表以外の共有者が並行統合されると、掃き終わった後に archive 済み所有者への連関を作ってしまう)。配線テスト(呼び出し順のソース固定)で全経路を固定する。
- **売却DMブリッジの紐付け**: migration-A で `draft_id String? @db.Uuid` も追加し、mark-sent が作る行に draft の id を残す(§3 の反響同期で使う)。⚠あわせて mark-sent は **`DmRecipientDraft.representativeOwnerId` を `owner_id` にコピー**し、**下書きの共有者グループ全員を `property_dm_log_owners` にコピー**する(@codex R9/R30 P1)。グループの保存のため連関 **`dm_recipient_draft_owners`(draft_id FK Cascade, owner_id FK Cascade)** も migration-A に追加し、**キャンペーン作成(宛先生成)時にグループ全員を保存**する(現行は代表+人数しか持たない)。⚠宛先生成 tx も順序規約に従い **Owner(FOR SHARE・安定id順)→対象物件の親行(FOR SHARE・id順)を取得し、保持したまま PropertyOwner リンクを再検証してから draft+連関を INSERT** する(@codex R49 P2: リンクの付け外しは親行ロック規約で書かれる=Owner ロックだけでは解除と直列化されず、所有者でなくなった相手への draft が生成後の印刷検査もすり抜ける)。⚠**既存の未送付 draft(連関が空)は補完せず、代表のみで記録**する(@codex R31→R33→R34 で確定した最終形): 現在の所有者情報からグループを再計算しても「実際に手紙を受け取る宛先」と一致する保証が無く(R33 P2)、氏名・住所・人数のスナップショット照合でも**同住所での共有者の入れ替え**は検知できない(R34 P2)。不確かな拡張はせず、**移行後に作られた draft(作成時にグループを保存済み)だけが全員連関の対象**。旧 draft は従来どおり代表のみ(監査 detail に legacyGroup を記録)。対象は移行前の未送付下書きのみ=本番は売却DM休眠中でほぼゼロ。これが無いと新しい売却DM経由の拒否/宛先不明が「所有者なし」になり、§4-5 の所有者単位の除外が**新規行に対して効かない**(旧行だけの限界のはずが新規にも及ぶ)。⚠コピー元は **tx 内で(条件付き updateMany の勝者決定後に)draft を再読取した値**を使う(@codex R13 P1): tx 前のスナップショットを使うと、並行する名寄せが draft を master へ付け替えた後に **archive 済みの旧所有者の id でログを作ってしまう**(以後の拒否が所有者横断の除外から見えない)。mark-sent も同じ型=**draft を先読み→所有者集合(代表+連関)を id 順に FOR SHARE→対象物件の親行を FOR UPDATE→条件付き updateMany(draft ロック)→draft を再読取→所有者不一致なら中止・再試行**(@codex R40 P2: 子ロックを直列化の根拠にせず、Owner 先頭の全体順序に従う。⚠親行ロックの省略は不可=@codex R50 P2: 物件ハード削除は親行を保持して draft へ降りてくるため、draft ロック→ログ INSERT の FK 待ちの並びと相互待ちになりデッドロックする。現行 mark-sent は親行を取らない実装なので PR-A で追加)。
- UI: 物件一覧の「DM差込CSV出力」の隣に「**送付の確定**」→ 未確定バッチ一覧(出力日時・件数)→ 投函日(既定=今日)→ 確定。確定済み件数を表示して閉じる。
- 未確定バッチが溜まった場合の掃除は当面しない(件数小・一覧は直近から表示)。必要になれば既存の日次クリーンアップに載せる(将来)。

### 2.3 個別の記録・取消

- `POST /api/properties/[id]/dm-logs` body=`{ sentOn, method?, note? }` — 手渡し等の1件記録。
- `DELETE /api/properties/[id]/dm-logs/[logId]` — 記録ミスの取消。**method="sale_dm" の行は 409**(売却DM側の状態と不整合になるため。案内文で売却DM画面へ誘導)。
  - **宛先不明フラグの再計算(@codex R8 P2)**: undeliverable の反響が付いた行を削除するときは、**親の物件行ロックを保持したまま**残りを数え、その物件に undeliverable のログも returned_undeliverable の売却DM下書きも残らないなら `dmUndeliverableAt` を解除する(dmStatus は人の判断=既存の訂正フローと同じ)。これをしないと「宛先不明のみ」フィルタに根拠のない物件が永久に残る。
- どちらも property:write + record scope + `lockPropertyRecordForWrite` 規約を使う(採番 advisory の廃止(§2.2・R26)により、既存ガードの「txの最初に親行を取る」規約と**矛盾なくそのまま従える**。個別記録は ownerId を持たないため Owner ロックも不要)。
- ⚠一括確定の tx の親ロック(@codex R4 P2 → R49 P2 で**全ロール統一**に変更): 確定は権限を問わず **Owner ロック(§2.2 の順序規約)→対象物件の親行を id 順で FOR UPDATE→バッチ行→items 再読取→INSERT** の順で行う。admin/office を「INSERT のみ・親ロックなし」にすると、物件ハード削除(親行を保持して items へ SetNull で降りてくる)と**逆順のロック取得**になり、確定側が item FOR UPDATE→ログ INSERT の FK ロック待ち・削除側が親行→item 待ちの相互待ちでデッドロックする(@codex R49 P2)。field_staff はさらに親行ロック保持中にスコープを検証(FOR KEY SHARE は assignedTo 更新と衝突しない=TOCTOU 防止・R4)。親行が既に消えていた item は property_id=null の記録として扱う(R49 P1)。順序は常に「Owner→親→子」(採番 advisory は R26 で廃止済み・@codex R28 P2)。

### 2.4 PropertyDmLog の列追加(migration-A・additive)

```
owner_id   String?  @db.Uuid  + FK Owner (ON DELETE SET NULL) + Owner側逆リレーション
dm_type    String?            // "owner_address"/"property_address"/既存行とsale_dmブリッジはnull
batch_id   String? @db.Uuid   // 一括確定のトレース(FKは張らない=バッチ削除と独立)
draft_id   String? @db.Uuid   // 売却DMブリッジ行→DmRecipientDraft の紐付け(反響同期用・FKは張らない)
updated_at DateTime @updatedAt // 既存行は DEFAULT now() で埋める
property_id を nullable 化+FK を ON DELETE SET NULL へ変更(@codex R49 P1: 現行の物件ハード削除はログを Cascade で道連れにし、**拒否/宛先不明の履歴ごと消える**→所有者Oが物件Aで拒否されていても、Aを削除するとOの他物件Bが再送候補に復活する。履歴は所有者側(owner_id+property_dm_log_owners)に残す。物件詳細の履歴表示は propertyId 指定クエリなので無影響・物件が消えた行は所有者横断の除外にだけ効く)
索引追加: [propertyId, sentAt] / [ownerId] / [draftId](@codex R45 P2: 売却DMの outcome 更新・公開LPの追跡ヒットはブリッジ行を draft_id で引く=無索引だと履歴の成長に伴い全走査)
※ sequence 列は持たない(「何通目」は表示時に sentAt,createdAt,id 順で導出=§2.2・R26)
```

### 2.5 監査

- 新 action: `dm_sent_confirm`{batchId,count,sentOn} / `dm_sent_record`{propertyId,sentOn} / `dm_sent_record_delete`{logId}。detail は件数/ID/日付のみ(氏名・住所・note は載せない)。(スコープ外は拒否方式(§2.2)なので skipped キーは無い)
- 既存 `property_dm_csv_export` の detail に batchId を追加。
- `ACTION_EXTRA_KEYS` に上記を登録。あわせて **既存 `property_dm_log_view` のキー(count/total/page/viewedAt)が未登録で表示時に[REDACTED]に潰れている問題を同時に修正**(同ファイルの1行追加)。

### 2.6 表示

- DM送付履歴に「種別」「何通目」列を追加。method の表示を日本語ラベル化(sale_dm→「売却DM」・mail→「郵送」等。**生値の英字がそのまま出ている現状の直し**)。
- 「何通目」は表示時導出(§2.2・R26)なので **PR-A から正しく表示できる**(旧方式で懸念だった「backfill 前の嘘の表示」(R9 P2)は方式変更で消滅)。

## 3. 第2段(PR-B): 反響の記録

- 列追加(migration-B・additive): `reaction_status TEXT DEFAULT 'no_response'`(allowlist: no_response/replied/refused/undeliverable。**enum は作らない**) / `reacted_at DateTime?` / `reaction_note TEXT?` / `reaction_source TEXT?`(下記・"manual"/"sale_dm_sync") + 索引 [reactionStatus]。
- **手動反響と同期の優先規則(@codex R5 P1 → R7 P1 で精緻化)**: `reaction_source` 列("manual"/"sale_dm_sync")で出所を持ち、次の非対称な規則にする:
  - 手動入力(PATCH reaction)は `manual` を立てる。**手動の実反響(replied/refused/undeliverable)は同期に上書きされない**(拒否を手で付けた後、売却DM側のメモ編集の再計算が outcome=none を根拠に no_response へ戻す事故を防ぐ)。
  - ⚠ただし**手動の no_response は実反響をブロックしない**(@codex R7 P1): メモ目的で no_response のまま保存→sourceがmanual化→その後のLPアクセスや電話反響が同期できず**実際は反応があった相手が再送候補に残る**、の裏返しの事故。同期が書ける条件=「**現在の status が no_response**」OR「reaction_source が null/"sale_dm_sync"」。さらに**ブリッジ行(draft_id あり)への手動保存は、値を問わず保存直後にリンク先 draft の現況から同期規則を即時再適用**する(@codex R30/R32 P2: 将来の同期イベントが来る保証は無い。draft に inquiry が残っていれば no_response は replied に戻り、返戻(returned_undeliverable)が残っていれば手動 replied も undeliverable に戻る=優先規則に反する状態を残さない)。
  - ⚠**配達失敗(undeliverable)は手動の replied より優先**(@codex R9 P2): 手動で「連絡あり」を付けた後に返戻(returned_undeliverable)が記録された場合、住所が死んでいる事実の方が新しく強い。同期の undeliverable は、現在値が **manual の refused/undeliverable** 以外なら(manual の replied/no_response を含めて)上書きできる。まとめると優先順位: **同期undeliverable ≧ 手動(refused/undeliverable) > 手動(replied) > 同期replied > no_response**。
  - ⚠**上書きされた手動値は退避して保全**(@codex R19 P2): 同期の undeliverable が手動の replied を上書きすると source が sync になり、後で返戻が**訂正**されたとき戻し先が no_response になって**本物の「連絡あり」が消える**。migration-B に退避列 `manual_reaction_shadow JSONB?` を足し、同期が手動値を上書きするときは**手動側の全量(status/reactedAt/note)をスナップショットとして退避**し、live 行の reactedAt/note は同期値に置き換える(@codex R44 P2: status だけ退避すると、復元後に返戻時の日付・メモが手動反響の説明として残る取り違えが起きる)。訂正の戻しは **shadow があれば全量を復元(source=manual)・無ければ no_response** とする。
  - shadow のライフサイクル(@codex R23 P2): **(1) 手動入力(PATCH)は常に shadow をクリア**(最新の手動入力だけが真実=古い退避値が後から蘇らない)、**(2) 退避は「同期が manual 値を上書きする瞬間」のみ**、**(3) 復元は shadow を消費(復元と同時にクリア)**。これが無いと、復元→手動で no_response に変更→再度の返戻と訂正、の流れで**廃止済みの replied が蘇り**再送候補から誤って外れる。
  - 同期は manual 行への **no_response への格下げを行わない**。訂正の戻し(undeliverable解除等)も sync 由来の値にしか触れない。
  - ⚠**draft_id が無い旧 sale_dm 行への手動更新も、保存直後に「propertyId+JST送付日の保守的フォールバック」を再適用**する(@codex R40 P2: 照合が付けた保守的な反響を手動 no_response で消しても、対応する draft に反響の証拠が残っていれば戻す。将来の同期イベントは保証されないため保存時に行う)。
  - ⚠**訂正の戻し先は「shadow → draft の現況から再導出 → no_response」の順**(@codex R27 P2): 同期の replied(LPアクセス・電話)が同期の undeliverable に上書きされた場合、shadow(手動専用)は空のままなので、盲目的に no_response へ戻すと**下書きに残っている反響(inquiry)が消える**。訂正時は shadow が無ければ **draft の現況(outcome/lpFirstAccessAt/phoneInquiryAt)に同期規則を再適用**して戻し先を導出する。
  - ⚠**売却DM側の訂正による dmUndeliverableAt の再計算も両方を見る**(@codex R10 P2): 既存の outcome 訂正は **DmRecipientDraft の行だけ**を数えて dmUndeliverableAt を解除するため、汎用ログ側に undeliverable(手動含む)が残っていてもフラグが消え、「宛先不明のみ」フィルタから漏れる。outcome 訂正の解除判定を**drafts と PropertyDmLog の両方**を親ロック下で数える形に改修する(§2.3 の削除時再計算と対の規則)。
- `PATCH /api/properties/[id]/dm-logs/[logId]/reaction` body=`{ status, reactedAt?, note? }` — property:write + record scope + lock規約。
- **undeliverable を付けたら 物件 dmStatus=no_send + dmUndeliverableAt=now に自動連動**(売却DM outcome と同じ挙動)。訂正時(undeliverable→他)は、他に undeliverable の記録が無ければ dmUndeliverableAt を解除(dmStatus は人の判断で戻す=売却DMと同じ)。
- reaction_note は note と同じく owner_note 表示レベルで server-side マスク。
- 監査: `dm_reaction_update`{logId,status,reactedAt} — note 本文は載せない。⚠**PR-B で `ACTION_EXTRA_KEYS` にも登録**する(@codex R11 P2: 未登録だと logId/reactedAt が表示時に[REDACTED]へ潰れ、§2.5 で直す property_dm_log_view と同じ穴を新設してしまう)。
- UI: DM送付履歴の行に反響の選択(4種)+日時+メモ。一覧の「宛先不明のみ」フィルタは既存のまま両モードで機能する。
- **売却DM側の反響との同期(@codex P1)**: 売却DMの反響は `DmRecipientDraft.outcome/deliveryStatus` に入り、放置すると「売却DMで連絡が来た相手」が汎用側では no_response のまま=再送候補に出てしまう。対策:
  - **outcome を書く全経路**が、`draft_id` で紐付いたブリッジ行(method="sale_dm")の reaction_status を**同じ tx で更新**する。写像: `returned_undeliverable → undeliverable` / `phoneInquiryAt あり or outcome=inquiry → replied`。訂正時も同様に戻す。
  - ⚠経路は認証済み outcome route だけではない(@codex R2 P1): **公開LP追跡 `recordTrackingHit`**(`/t/<token>` 初回アクセス)が `lpFirstAccessAt + outcome="inquiry"` を直接書く。同期は**共通ヘルパー1本**に集約し、outcome route と recordTrackingHit の**両方**から同一 tx で呼ぶ。ヘルパーはブリッジ行(物件の子行)を書くため**親の物件行ロック規約(lockPropertyRecordForWrite)に従う**(@codex R50 P1: DL 側の親行 FOR SHARE と直列化され、返信・返戻の書込が候補再評価とすれ違わない。terminal を書くときはさらに Owner 先頭 FOR UPDATE=R47)(書く場所を1つでも取りこぼすと再送候補の判定が破れる=[同種の穴は全箇所]の原則。実装時に outcome/deliveryStatus の writer を grep で全列挙して確認する)。
  - 既存の sale_dm 行への **backfill は「再実行可能な照合(reconciliation)」として実装**し、**新コード稼働後に実行**する(@codex R7 P2)。migration-B は列追加のみとし、照合は §同期の共通ヘルパーを使う冪等スクリプト(全 sale_dm 行を draft と突き合わせて上の優先規則で更新)を **PR-B 反映の restart 後に実行**する。⚠migration の中で backfill すると、`migrate deploy → restart` の窓で旧プロセスが書いた反響(LPアクセス等)が draft 側だけに残り、照合済みの行が no_response のまま固定される。照合は冪等なので、窓の有無にかかわらず稼働後にもう一度流せば閉じる(本番は売却DM休眠中のため対象は僅少/ゼロの見込み)。旧行に draft_id が無い場合は propertyId+送付日で対応付け(⚠**送付日の比較は draft.sentAt(UTC時刻)を JST の暦日へ変換してから**行う。mark-sent は log.sentAt を +9h の JST 暦日で保存しており、JST 0時〜9時に確定した旧行は UTC 日付のままだと1日ずれて対応付けを取り逃す=@codex R37 P2。深夜境界のテストを照合に含める)、**一意に対応付いた行には draft_id を書き込んで永続化**する(@codex R16 P1: 紐付けを残さないと、照合後に来る初めての反響(LPアクセス・返戻)が通常同期(draft_id 経由)から永久に見えない)。曖昧なまま残った行(draft_id=null の sale_dm 行)への実行時の保険: 同期ヘルパーは draft に紐付くログが無い場合、**同 propertyId の draft_id=null な sale_dm 行の全件**へ「反響を付ける方向のみ」適用する(格下げなし・過剰に候補から外れるのは許容)。⚠**対応付けが曖昧な行は「反響あり側」に倒す**(@codex R4 P2): 同日に複数 draft があり1対1に決められない場合、その物件の該当 drafts に inquiry/returned_undeliverable が1つでもあれば、曖昧な sale_dm 行へ該当反響(replied/undeliverable)を保守的に付与する。誤って再送候補から**外れる**のは許容(送りすぎ防止が目的)・誤って候補に**入る**のは不可、の非対称で判断する。
  - これにより §4 の再送候補判定は **PropertyDmLog だけを見れば足りる**(2つの保存先を join しない=判定の単一情報源)。

## 4. 第3段(PR-C): 再送候補

- 定義(すべて AND):
  1. `dmStatus = "send"`
  2. 送付記録が1件以上ある
  3. **90日以内の送付記録が無い**(`dmLogs: { none: { sentAt: { gt: cutoff } } }`)。⚠**cutoff は「JST の今日」の暦日から90日戻して導出**する(@codex R38 P2: sentAt は日付のみ(UTC真夜中表現)なので、素の instant 比較だと JST 朝9時まで判定が1日ずれる。深夜〜9時の境界テストを含める)
  4. replied / refused / undeliverable の反響が付いた記録が**1件も無い**
  5. **所有者単位の除外(@codex R8 P1 → R29 P1 で共有者全員に拡張)**: その物件の所有者(PropertyOwner 経由)の誰かに、**他物件も含めて** refused / undeliverable の反響が付いた記録が(**代表(owner_id)または共有者連関(property_dm_log_owners)経由で**)あれば除外する。同じ所有者が物件AとBに紐づくとき、Aで拒否された相手にBから再送する事故を防ぐ(Prisma: `owners: { none: { owner: { dmLogs: { some: { reactionStatus: { in: [refused, undeliverable] } } } } } }` 相当)。⚠限界: ownerId が null の記録(個別記録・旧sale_dm行)は物件単位でしか効かない。また「所有者行は別だが住所が同じ」相手は所有者の名寄せ(既存の品質チェック領域)の守備範囲とし、本機能では扱わない(§6 論点)。
  5b. ⚠**所有者の名寄せ(重複統合)で反響を置き去りにしない**(@codex R11 P1): 既存の統合 tx はメモと PropertyOwner 行を master へ移すが、このままだと **archive された旧所有者に付いた反響ログ**が述語から見えなくなり、統合後の所有者の他物件が再送候補に戻る。統合 tx に **`PropertyDmLog.ownerId`・未確定バッチ item の ownerId・`DmRecipientDraft.representativeOwnerId`(未送付の下書き=後で mark-sent が owner_id へコピーする「予約」)・連関3表(`dm_export_batch_item_owners`/`property_dm_log_owners`/`dm_recipient_draft_owners`)の owner_id の付け替え(source→master・重複行は畳む)**を追加する(@codex R11/R12 P1。PR-A のスコープ=merge route の改修。付け替えは既存の owner FK 群の移送と同じ場所に足し、対象は grep で全列挙して確認する)。
  5d. ⚠**統合 tx の順序は「master と source の両 Owner 行を安定 id 順で FOR UPDATE(最初に)→予約→最後にログ→archive」**(@codex R19/R21 P1・R24 P2 で精緻化): 現行の統合は**両所有者を辞書順でロックする流儀を既に持つ**(相互/循環の統合のデッドロック回避)ので、それを維持したまま**両 Owner のロックを子の付け替えより前(txの最初)**に置く。source だけ先・master 後回しにすると循環統合で相互待ちになり、master のロックを省くと転送中に master 側の archive/version が動く。子の付け替えは**未確定バッチ item・drafts(予約)を先に、`PropertyDmLog` を最後**(予約のロック待ち中に作られたログも最後の付け替えが掬う)。作成側の FOR SHARE(5c)とは Owner ロックの時点で直列化される。
  5c. ⚠**所有者参照を「新規に作る」側も名寄せと直列化する**(@codex R18 P1): 付け替えは既存行にしか効かない。キャンペーン作成(宛先 drafts の representativeOwnerId)と export(控え item の ownerId)は、**tx 前のスナップショットで所有者を決めて後から insert** しており、その隙間で統合が完了すると **archive 済みの旧所有者を参照する新規行**ができる。対策: 所有者参照を新規作成する tx は、**代表所有者の確定(selectGroupRepresentative)を insert と同一 tx 内で行い、対象 Owner 行(複数なら**統合と同じ安定 id 順にソートして**)を `FOR SHARE` で保持したまま insert** する(@codex R25 P2: 順序を揃えないと、複数所有者を掴む作成と統合が互い違いに待ってデッドロックする)。⚠**ロック取得後に PropertyOwner のリンクと Owner.isArchived を再検証**し、選定時と変わっていれば(=選定〜ロックの隙間に統合が commit した)**代表を再解決してやり直す**(@codex R27 P1: 再検証しないと archive 済み所有者への FOR SHARE が成功し、掃き終わった後の新規参照が作れてしまう)。統合 tx は source Owner 行を更新(archive)するため FOR SHARE と衝突して直列化され、(a) 統合が先なら再解決が master を掴み、(b) 作成が先なら commit 後に統合の一括付け替え(5b)が新規行も含めて移す。
- replied を除外する理由: 連絡が来ている相手は人が個別対応する(定型の再送に乗せない)。
- `COOLDOWN_DAYS = 90`(定数)。env `DM_RESEND_COOLDOWN_DAYS` で上書き可(業務値の変更にリリース不要)。上限(cap)は作らない。
- 純関数 `decideResendCandidacy({logs, ownerHasTerminalReaction}, now, {cooldownDays})` → `{eligible, reason}`(表示とテストの単一情報源。一覧 where と同じ規則を対で維持)。⚠入力には物件自身の logs に加えて **所有者単位の除外状態**(その物件の所有者の誰かに他物件も含め refused/undeliverable があるか=@codex R9 P2)を渡す。呼び出し側が §4-5 と同じクエリでこのフラグを計算する=規則の組み合わせ自体は純関数に集約され、where と対で維持できる。
- UI: 物件一覧に「**再送候補のみ**」トグル → そのまま既存の「CSV出力→送付の確定」の流れに乗る(「何通目」は表示時導出(§2.2)なので特別な処理は不要)。

## 5. テスト方針

- 純関数(「何通目」の表示時導出・decideResendCandidacy・allowlist)はユニット。route は既存 dm-logs/route.test の型を踏襲(認可・マスク・監査・冪等)。
- export の「PropertyDmLog を書かない」ピンは維持し、「batch を書く」ことを明示的にアサート。
- 権限/監査 allowlist/lock 順序はソース固定(source-assertion)で配線を固定。

## 6. レビューで特に見てほしい論点

1. (解決済み・@codex R49 P2)一括確定 tx の親ロックは**全ロールで Owner→親→子に統一**した(§2.3)。
2. export がバッチを書くことと、既存の「export は送付履歴を書かない」契約の整合。
3. undeliverable 連動の解除条件(売却DM側と二重管理にならないか)。
4. §3 の売却DM反響同期の写像(returned_undeliverable→undeliverable / inquiry・電話→replied)の妥当性。

### 対応履歴
- R1(2026-08-08): P1×2(sequence採番の直列化→advisory lock+unique backstop+全writer共通ヘルパー / 売却DM反響の同期→draft_id紐付け+outcome同tx更新+backfill)・P2×2(item所有者削除→owner FK SetNull / export冪等化→fingerprint unique+同日再利用)を反映。
- R2(2026-08-08): P1×3(採番はMAX(sequence)+1=取消後の衝突防止 / fingerprintは(propertyId,代表ownerId)ペア列=宛先変化の合流防止 / LP追跡recordTrackingHitも同期経路に=共通ヘルパー集約)・P2×1(ロック順序「advisory→親→子」の全writer統一)を反映。
- R3(2026-08-08): P2×2(fingerprint uniqueは未確定限定の部分unique=確定後の同日再出力を塞がない / スコープ外itemがある確定は403で拒否=記録の永久欠落防止)を反映。
- R4(2026-08-08): P2×3(field_staff確定は親FOR UPDATE保持でスコープ検証=TOCTOU封じ / 再利用照会はFOR UPDATEで確定と直列化 / backfill曖昧行は反響あり側に倒す)を反映。外部AI方式側のP1(一括適用のscope除外)は別紙。
- R5(2026-08-08): P1(手動反響の保護→reaction_source列で出所管理・手動が常に勝つ)・P2(同時新規作成のunique衝突をcatchして勝者を再利用)を反映。
- R6(2026-08-08): P2(同日同内容の別操作の過剰合流→冪等化を内容ハッシュから**押下ごとのattemptKey方式**へ変更=再試行だけが合流)を反映。
- R7(2026-08-08): P1×2(unique+backfillを新writer稼働後の次反映に分離=expand→contract / 手動no_responseは実反響をブロックしない)・P2×2(反響backfillは稼働後の冪等照合に / 再試行はcontent_digest一致検証・ずれたら409)を反映。
- R8(2026-08-08): P1×2(migration-A2自身も採番advisory lockを取る=稼働中writerと直列化 / 再送候補に所有者単位の除外を追加=別物件経由の再送事故防止)・P2×1(undeliverableログ削除時にdmUndeliverableAtを親ロック下で再計算)を反映。
- R9(2026-08-08): P1(mark-sentがrepresentativeOwnerIdをowner_idへコピー=新規行にも所有者除外を効かせる)・P2×3(配達失敗は手動repliedより優先 / 「何通目」表示はA2適用後のPR-Bから / decideResendCandidacyに所有者横断状態を入力)を反映。
- R10(2026-08-08): P2(売却DM側のoutcome訂正の解除判定をdrafts+汎用ログ両方で再計算)を反映。外部AI方式側のP2×2(draft編集PATCHにもproperty:write / 確定にも親行ロック)は別紙。
- R11(2026-08-08): P1(所有者の名寄せtxでdmLogs/バッチitemのownerId付け替え=統合後の反響置き去り防止)・P2×2(content_digest列をスキーマ表に明記 / dm_reaction_updateのACTION_EXTRA_KEYS登録)を反映。
- R12(2026-08-08): P1(名寄せの付け替え対象にDmRecipientDraft.representativeOwnerIdも追加=未送付下書きの予約)・P2(個別記録はadvisory→親ガードの順を明文化・ガード規約の例外としてテスト更新)を反映。
- R13(2026-08-08): P1(mark-sentのowner_idはtx内再読取=名寄せと直列化)を反映。外部AI方式側のP2×2(凍結の列永続化 / assign routeのwrite門)は別紙。
- R14(2026-08-08): P1(一括確定のitemsもFOR UPDATEでtx内読み直し=名寄せと直列化)を反映。外部AI方式側のP2(凍結variantの削除禁止)は別紙。
- R15(2026-08-08)は外部AI方式側のみ(別紙)。
- R16(2026-08-08): P1(照合で一意対応した旧行へdraft_idを永続化+曖昧行への実行時の保守的同期規則)を反映。外部AI方式側のP2(凍結印の稼働後照合)は別紙。
- R17(2026-08-08)は外部AI方式側のみ(別紙)。
- R18(2026-08-08): P1(所有者参照の新規作成もFOR SHAREで名寄せと直列化=5c)を反映。外部AI方式側のP2(適用の専用監査)は別紙。
- R19(2026-08-08): P1(統合txの付け替え順序=予約→最後にログ=5d)・P2(上書きされた手動反響をmanual_reaction_shadowへ退避・訂正時に復元)を反映。外部AI方式側のP2(差し替え時の未確定body全クリア)は別紙。
- R20(2026-08-08): P2(backfillのwindow順序に最終キーid=決定性)を反映。外部AI方式側のP2(差し替えもスコープ外未確定draftで403)は別紙。
- R21(2026-08-08): P1(統合txは最初にsource Owner行をFOR UPDATE=作成側FOR SHAREと完全直列化)を反映。外部AI方式側のP2(凍結印はrestart後スクリプトのみで投入)は別紙。
- R22(2026-08-08): P1(ロック順序にOwnerを追加=「advisory→Owner→variant→親→子」・子先読み→Owner→子再読取→不一致中止の型)を反映。外部AI方式側のP2(凍結判定=列OR派生の二重判定)は別紙。
- R23(2026-08-08): P2(shadowのライフサイクル=手動でクリア/上書き時のみ退避/復元で消費)を反映。外部AI方式側のP2(DELETEも二重判定)は別紙。
- R24(2026-08-08): P1(migration-A2を明示txで包む=advisory xact lockの持続)・P2(統合は両Owner行を安定id順で先頭ロック=既存の辞書順流儀を維持)を反映。外部AI方式側のP2×3(AI直結経路の無効化/assignの凍結印固定/本文サイズ上限)は別紙。
- R25(2026-08-08): P2(作成側の複数OwnerのFOR SHAREも統合と同じ安定id順でソート)を反映。
- R26(2026-08-08): P2(後入れの古い投函日でMAX+1が時系列を壊す)→**sequence列を廃止し「何通目」を表示時導出(sentAt,createdAt,id順)に方式変更**。採番系の対策(R2-2/R20/R7-4b/R8-4c/R24-1)は不要化・migrationはA(列追加のみ)1本に簡素化。
- R27(2026-08-08): P1(代表選定〜ロックの隙間=ロック後にリンクとisArchivedを再検証・変化なら再解決)・P2(訂正の戻し先=shadow→draft現況の再導出→no_responseの順)を反映。外部AI方式側のP2(追加指示の直接入力を案内しない=注意書き方式)は別紙。
- R28(2026-08-08): P2(field_staff確定の局所指示をOwner→親→子へ修正=旧advisory参照の残骸除去)を反映。外部AI方式側のP1(PR-D は PR-A 依存に固定)・P2(空白のみ本文の拒否)は別紙。
- R29(2026-08-08): P1(共有者グループ全員を連関2表(item_owners/log_owners)で保持し所有者除外を共有者全員に拡張・名寄せの付け替え対象にも追加)を反映。
- R30(2026-08-08): P1(売却DM下書きにも共有者連関 dm_recipient_draft_owners を追加・mark-sentでlog_ownersへコピー)・P2×2(ブリッジ行への手動no_responseは即時再導出 / 採番廃止の残骸3箇所を表示時導出へ更新)を反映。外部AI方式側(ヘッダの依存明記/saleDmAi撤去)は別紙。
- R31(2026-08-08): P1(ロック対象を連関の全所有者へ拡張)・P2(既存未送付draftの連関はmark-sent時に再計算で補完)を反映。外部AI方式側のP2(個別draft PATCHの型移動にも凍結固定)は別紙。
- R32(2026-08-08): P1(名寄せの付け替えに第3連関 dm_recipient_draft_owners を追加)・P2(ブリッジ行への手動保存は値を問わず直後に再導出=優先規則の恒常担保)を反映。
- R33(2026-08-08): P1(補完の所有者集合もロック+ロック後再検証)・P2(補完はスナップショット整合時のみ全員採用・不一致は代表のみ+監査記録)を反映。
- R34(2026-08-08): P2(スナップショット照合では同住所の共有者入替を検知不能)→**旧下書きの補完を撤回し「代表のみで記録」に単純化**(R33の補完手順は不要化)。全員連関は移行後に作成された draft のみ。
- R36(2026-08-08): P2(sentOnは今日以前のみ=未来日の誤入力で再送抑止が壊れるのを防ぐ)を反映。
- R37(2026-08-08): P2(旧行照合の送付日はJST暦日で比較・深夜境界テスト)を反映。外部AI方式側のP2×2は別紙。
- R38(2026-08-08): P2×2(attemptKey必須化=鍵なし400・サーバー発行を撤回 / クールダウンcutoffもJST暦日で導出)を反映。
- R39(2026-08-08): P2(クライアント発行キーではcross-site作成を防げない)→**出力を「POSTで控え作成→GETでitemsからCSV」の2段階に再構成**。CSRF境界で無限作成を封じ、content_digest照合は構造的に不要化(列削除)。
- R40(2026-08-08): P1(CSV GETにも4権限+現在スコープ再検証)・P2×3(確定/mark-sentの子先ロック記述をOwner先頭の型へ統一 / バッチsentOnは作成日以降 / 旧行への手動更新も保守的再適用)を反映。外部AI方式側のP2(個別PATCHのtrim検証)は別紙。
- R41(2026-08-08): P2(「DLした集合=確定される集合」の不変条件: スコープで欠けるDLは403・owner削除itemはCSV/確定とも除外)を反映。
- R42(2026-08-08): P1/P2(DL前後で逆向きの要請)→**downloadedAt境界のライフサイクルで確定**: 初回GET=最新状態検証(scope403/terminal反響409/削除item物理除外)+刻印・再試行=同集合再配信・確定=DL必須+DL後削除はnullで記録。
- R43(2026-08-08): P1(再試行の内容drift)→**csvDigest列**: 初回DLでCSVのsha256を保存し再試行は一致時のみ配信・不一致409(ハッシュのみ=PII非保存)。P2(初回GETレース)→**バッチ行FOR UPDATEのtxで凍結を直列化**(ロック後にdownloadedAt再判定・同tx内でitems/owners再読取→描画→digest+刻印)。
- R44(2026-08-08): P1(凍結txのscope検証が担当替えと競合しない)→凍結txを**共通ロック順序(Owner→物件親行→バッチ行→items再読取・不一致中止再試行)**に統一。P2(shadowがstatusのみ)→**manual_reaction_shadowをJSONB全量スナップショット**(status/reactedAt/note)に変更・復元も全量。外部AI側P2(個別PATCHのタグ検証)は別紙。
- R45(2026-08-08): P1(再試行が反響を見ない)→**terminal反響検査を再試行GETにも毎回適用**(409)。P2(凍結時のrowCount不整合)→**残存items数で同一tx内に再計算**。P2(ブリッジ同期の全走査)→**[draftId]索引をmigration-Aに追加**。
- R46(2026-08-08): P2(連関3表のowner_id側が無索引)→**owner_id先頭の索引を3表すべてに必須化**。外部AI側P2(extraInstructionの失効誤発火)は別紙。
- R47(2026-08-08): P1(共有所有者の別物件へのterminal書込とDL検査がすれ違う)→**terminal反響を書く全writerにOwner先頭FOR UPDATEを義務付け+DL側(初回/再試行)はOwner FOR SHAREを検証〜描画まで保持**(非terminal書込はOwnerロック不要=追跡ホットパス維持)。
- R48(2026-08-08): P1(紐づけ解除・no_send化はdigestにもロックにも現れない)→**宛先資格の再検証(PropertyOwnerリンク+dmStatus)をDL両経路の検査に追加**(409・親行FOR SHAREで既存writer規約と直列化)。
- R49(2026-08-08): P1(物件ハード削除がterminal履歴を道連れ)→**PropertyDmLog/バッチitemの物件FKをSetNull化**(nullable・履歴は所有者側に残す・DL境界と整合)。P2(確定と物件削除のデッドロック)→**一括確定の親ロックを全ロールでOwner→親→子に統一**(§6論点1解消)。P2(宛先生成がOwnerロックのみ)→**親行FOR SHARE保持中にリンク再検証してからdraft INSERT**。
- R50(2026-08-08): P1(再送候補バッチのDLが返信・cooldownを見ない)→**resendFilterApplied列+DL両経路で§4候補述語を再評価**(409・通常バッチは対象外=意図した送付はいつでも可)+同期ヘルパーに親行ロック規約を明記。P2(mark-sentの親行ロック欠落)→**Owner→親行FOR UPDATE→draftの順に統一**。
