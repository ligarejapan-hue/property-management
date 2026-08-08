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
  attemptKey  String    @unique @map("attempt_key") // 押下ごとの冪等キー(下記「出力の冪等化」)
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
  propertyId String  @map("property_id") @db.Uuid
  ownerId    String? @map("owner_id") @db.Uuid      // 代表所有者(所有者宛)。物件宛は null
  batch      DmExportBatch @relation(fields: [batchId], references: [id], onDelete: Cascade)
  property   Property      @relation(fields: [propertyId], references: [id], onDelete: Cascade)
  owner      Owner?        @relation(fields: [ownerId], references: [id], onDelete: SetNull) // @codex P2: 確定前に所有者が消えたら null 化(確定を巻き戻さない)
  @@index([batchId])
  @@map("dm_export_batch_items")
}
```

- **出力の冪等化 = 押下ごとの冪等キー方式**(R1〜R6 で内容ハッシュ方式から到達した最終形。@codex R6 P2):
  - **UI が「DM差込CSV出力」の押下ごとに attemptKey(uuid)を発行**し querystring に付与。route は attemptKey を `DmExportBatch.attempt_key`(**unique**)として保存する。
  - **同じキーの再実行**(ブラウザのダウンロード再試行・同一ナビゲーションの再実行)は、既存バッチを **`SELECT ... FOR UPDATE` で照会→confirmedAt を再検証して再利用**(確定側と行ロックで直列化=@codex R4 P2)。INSERT の unique 衝突は catch して勝者を取り直す(=@codex R5 P2)。
  - **別の押下は別のキー=別の控え**。⚠内容ハッシュで「同日同内容=同一」と畳むと、**別々の操作者が意図して行った同日2回の郵送**まで1つに合流し、確定が1回しかできず送付記録が過少になる(@codex R6 P2)。合流してよいのは「同じ1回のダウンロードの再試行」だけであり、それは attemptKey が正確に表す。
  - attemptKey 無しの直叩き(API 直接呼び出し)はサーバーが発行する(重複排除なしで毎回新規=安全側)。
  - 冪等キーの先例 = 売却DMキャンペーンの idempotencyKey(実装様式もこれに合わせる)。
  - **再試行と控えの中身の一致検証(@codex R7 P2)**: バッチに **content_digest**(=ソート済み宛先行全体の非PIIハッシュ。CSV本文は保存しない)を持たせる。同じ attemptKey の再実行は CSV を再生成するため、初回 commit 後に所有者・住所・代表者が変わっていると**再試行のCSVと控えの中身がずれる**。再実行時に digest を再計算して**一致しなければ 409**(「宛先が変わったため、もう一度出力してください」)=ずれた控えを黙って再利用しない。
- **所有者の削除(@codex P2)**: item の owner FK は SetNull。確定時に ownerId が null の item は `PropertyDmLog.owner_id=null` で記録する(1件の欠けで全体を巻き戻さない)。

- **CSV の中身(氏名・住所)は保存しない**。控えは propertyId/代表 ownerId のみ=非PII寄りの最小構成。
- 所有者宛 export route が CSV 生成と同一リクエスト内で batch+items を書く。**PropertyDmLog は引き続き書かない**(既存テストのピンは維持し、「batch は書く」ことを明示する形にテストを更新)。
- item の property FK は Cascade: 確定前に物件が消えたら控えからも消え、確定時に自然にスキップされる。
- 物件宛 export(UI導線なし)は今回対象外。dmType 列は将来用に持つ(TEXT+アプリ側allowlist・enum は作らない=#361 と同方針)。

### 2.2 送付確定(一括)

- `GET /api/properties/dm-batches?unconfirmed=1` — 確定モーダル用の一覧(出力日時・件数・確定状態。中身の宛先は返さない)。
- `POST /api/properties/dm-batches/[id]/confirm` body=`{ sentOn: "YYYY-MM-DD" }`
- ゲート: 既存 export と同じ4権限+**property:write**(書込は mark-sent/outcome と同じ統一方針・新slugなし)。
- **スコープ外 item の扱い(@codex R3 P2)**: field_staff の担当変更などで**1件でもスコープ外の item がある場合、確定を 403 で拒否**する(スキップして confirmedAt を立てると、その宛先の送付記録が**永久に欠ける**=後から権限のある人が確定しようとしても「確定済み」で弾かれるため)。エラーには「スコープ外が N 件・管理者/事務担当で確定してください」と理由を出す。部分確定(item単位の確定状態)は作らない=単純さ優先(実運用は管理者2名で、まず起きない)。
- 冪等: `confirmedAt` が null の場合のみ、条件付き updateMany(勝者決定)→ 同一 tx で items から `PropertyDmLog` を生成。二重確定は 409。
- 生成する行: `propertyId / ownerId(代表) / dmType="owner_address" / sequence(下記) / batchId / sentAt=sentOn / method="mail" / sentBy=操作者`。
- **sequence の採番(@codex P1)**: 無ロックの採番は並行確定で重複する。対策:
  1. **採番は共通ヘルパー1本に集約**し、PropertyDmLog を書く**全writer**(一括確定・個別記録・売却DM mark-sent)がこれを使う。ヘルパーは tx 内で `pg_advisory_xact_lock`(採番専用の固定キー)を取ってから採番=全採番が直列化される(確定は週に数回・数百行なので直列で十分)。
  2. 採番は **`MAX(sequence)+1`**(@codex R2 P1)。「既存件数+1」だと途中の記録を取消した後([1,2,3]の2を削除→count=2→次が3)に生き残りの3と衝突し、**その物件への記録が全部失敗し続ける**。MAX+1 なら削除に影響されない(欠番は許容=「何通目」表示は歴史の記録であり連番の詰め直しはしない)。
  3. 同一バッチ内に同じ物件の item が複数ある場合(送付先住所が複数の共有者グループ)は、item id 順で **MAX+1 からの連番** を決定的に割り当てる。
  4. **DB側の背水**: `@@unique([propertyId, sequence])`。既存行の sequence を物件ごとに `sentAt,createdAt` 順で**振り直してから**(window関数・決定的)このuniqueを張る。
  4b. ⚠**uniqueとbackfillは「新writer稼働後の次の反映」に分離する**(@codex R7 P1): 本番の反映手順は `migrate deploy → build → restart` の順のため、migration と同じ反映で unique を張ると、**restart までの窓で旧 mark-sent(sequence を採番しない・default 1)が unique 違反で失敗**する。よって **migration-A = 列追加のみ**(unique なし・PR-A と同時反映)、**migration-A2 = backfill+unique**(PR-B の反映に同乗=採番する新 writer が稼働済みの状態で適用)。窓の間の新規行は default 1 だが、A2 の backfill が振り直すので整合する(expand→contract の段階投入)。
  4c. ⚠**migration-A2 自身も採番の advisory lock を取る**(@codex R8 P1): A2 適用中も PR-A のサービスは稼働中(手順は migrate→restart)で、並行する送付確定が backfill と同じ sequence を割り当てると **unique 作成が失敗し反映が中断**する。A2 の SQL は冒頭で `SELECT pg_advisory_xact_lock(採番と同じ固定キー)` を実行し、**backfill〜unique 作成を採番と同じロックの中で行う**(全 writer が同じキーで直列化されているため、migration も同じ列に並ぶだけで安全になる)。
  5. **ロック順序の統一(@codex R2 P2)**: 採番の advisory lock は**常に親の物件行ロック(lockPropertyRecordForWrite / FKの暗黙ロック)より先**に取る。個別記録が「親ロック→advisory待ち」・一括確定が「advisory保持→FK待ち」になると相互待ちでデッドロックする。**「advisory→親→子」の一方向**を全writerの規約とし、配線テスト(呼び出し順のソース固定)で守る。
- **売却DMブリッジの紐付け**: migration-A で `draft_id String? @db.Uuid` も追加し、mark-sent が作る行に draft の id を残す(§3 の反響同期で使う)。
- UI: 物件一覧の「DM差込CSV出力」の隣に「**送付の確定**」→ 未確定バッチ一覧(出力日時・件数)→ 投函日(既定=今日)→ 確定。確定済み件数を表示して閉じる。
- 未確定バッチが溜まった場合の掃除は当面しない(件数小・一覧は直近から表示)。必要になれば既存の日次クリーンアップに載せる(将来)。

### 2.3 個別の記録・取消

- `POST /api/properties/[id]/dm-logs` body=`{ sentOn, method?, note? }` — 手渡し等の1件記録。
- `DELETE /api/properties/[id]/dm-logs/[logId]` — 記録ミスの取消。**method="sale_dm" の行は 409**(売却DM側の状態と不整合になるため。案内文で売却DM画面へ誘導)。
  - **宛先不明フラグの再計算(@codex R8 P2)**: undeliverable の反響が付いた行を削除するときは、**親の物件行ロックを保持したまま**残りを数え、その物件に undeliverable のログも returned_undeliverable の売却DM下書きも残らないなら `dmUndeliverableAt` を解除する(dmStatus は人の判断=既存の訂正フローと同じ)。これをしないと「宛先不明のみ」フィルタに根拠のない物件が永久に残る。
- どちらも property:write + record scope + **`lockPropertyRecordForWrite` 規約適用**(物件配下の書込は親行を先にロック)。
- ⚠一括確定の tx の親ロック(@codex R4 P2 で条件付きに変更): **admin/office_staff の確定**(スコープ判定が常に真)は「INSERT のみ・親 FOR UPDATE なし」(FK の暗黙 FOR KEY SHARE のみ・親行の更新なし=循環の起点にならない)。**field_staff の確定**はスコープ判定が担当変更と競合し得る(FOR KEY SHARE は assignedTo 更新と衝突しない=判定後に担当が外れても確定が通る TOCTOU)ため、**advisory lock 取得後に対象物件の親行を id 順で FOR UPDATE し、保持したままスコープを検証してから** INSERT する。順序は常に「advisory→親→子」(§2.2-5)。

### 2.4 PropertyDmLog の列追加(migration-A・additive)

```
owner_id   String?  @db.Uuid  + FK Owner (ON DELETE SET NULL) + Owner側逆リレーション
dm_type    String?            // "owner_address"/"property_address"/既存行とsale_dmブリッジはnull
sequence   Int @default(1)    // 同一物件の何通目か(§2.2 の採番規則・既存行はbackfillで振り直し)
batch_id   String? @db.Uuid   // 一括確定のトレース(FKは張らない=バッチ削除と独立)
draft_id   String? @db.Uuid   // 売却DMブリッジ行→DmRecipientDraft の紐付け(反響同期用・FKは張らない)
updated_at DateTime @updatedAt // 既存行は DEFAULT now() で埋める
索引追加: [propertyId, sentAt] / [ownerId] / unique [propertyId, sequence](backfill後)
```

### 2.5 監査

- 新 action: `dm_sent_confirm`{batchId,count,sentOn} / `dm_sent_record`{propertyId,sentOn} / `dm_sent_record_delete`{logId}。detail は件数/ID/日付のみ(氏名・住所・note は載せない)。(スコープ外は拒否方式(§2.2)なので skipped キーは無い)
- 既存 `property_dm_csv_export` の detail に batchId を追加。
- `ACTION_EXTRA_KEYS` に上記を登録。あわせて **既存 `property_dm_log_view` のキー(count/total/page/viewedAt)が未登録で表示時に[REDACTED]に潰れている問題を同時に修正**(同ファイルの1行追加)。

### 2.6 表示

- DM送付履歴に「種別」「何通目」列を追加。method の表示を日本語ラベル化(sale_dm→「売却DM」・mail→「郵送」等。**生値の英字がそのまま出ている現状の直し**)。

## 3. 第2段(PR-B): 反響の記録

- 列追加(migration-B・additive): `reaction_status TEXT DEFAULT 'no_response'`(allowlist: no_response/replied/refused/undeliverable。**enum は作らない**) / `reacted_at DateTime?` / `reaction_note TEXT?` / `reaction_source TEXT?`(下記・"manual"/"sale_dm_sync") + 索引 [reactionStatus]。
- **手動反響と同期の優先規則(@codex R5 P1 → R7 P1 で精緻化)**: `reaction_source` 列("manual"/"sale_dm_sync")で出所を持ち、次の非対称な規則にする:
  - 手動入力(PATCH reaction)は `manual` を立てる。**手動の実反響(replied/refused/undeliverable)は同期に上書きされない**(拒否を手で付けた後、売却DM側のメモ編集の再計算が outcome=none を根拠に no_response へ戻す事故を防ぐ)。
  - ⚠ただし**手動の no_response は実反響をブロックしない**(@codex R7 P1): メモ目的で no_response のまま保存→sourceがmanual化→その後のLPアクセスや電話反響が同期できず**実際は反応があった相手が再送候補に残る**、の裏返しの事故。同期が書ける条件=「**現在の status が no_response**」OR「reaction_source が null/"sale_dm_sync"」。
  - 同期は manual 行への **no_response への格下げを行わない**。訂正の戻し(undeliverable解除等)も sync 由来の値にしか触れない。
- `PATCH /api/properties/[id]/dm-logs/[logId]/reaction` body=`{ status, reactedAt?, note? }` — property:write + record scope + lock規約。
- **undeliverable を付けたら 物件 dmStatus=no_send + dmUndeliverableAt=now に自動連動**(売却DM outcome と同じ挙動)。訂正時(undeliverable→他)は、他に undeliverable の記録が無ければ dmUndeliverableAt を解除(dmStatus は人の判断で戻す=売却DMと同じ)。
- reaction_note は note と同じく owner_note 表示レベルで server-side マスク。
- 監査: `dm_reaction_update`{logId,status,reactedAt} — note 本文は載せない。
- UI: DM送付履歴の行に反響の選択(4種)+日時+メモ。一覧の「宛先不明のみ」フィルタは既存のまま両モードで機能する。
- **売却DM側の反響との同期(@codex P1)**: 売却DMの反響は `DmRecipientDraft.outcome/deliveryStatus` に入り、放置すると「売却DMで連絡が来た相手」が汎用側では no_response のまま=再送候補に出てしまう。対策:
  - **outcome を書く全経路**が、`draft_id` で紐付いたブリッジ行(method="sale_dm")の reaction_status を**同じ tx で更新**する。写像: `returned_undeliverable → undeliverable` / `phoneInquiryAt あり or outcome=inquiry → replied`。訂正時も同様に戻す。
  - ⚠経路は認証済み outcome route だけではない(@codex R2 P1): **公開LP追跡 `recordTrackingHit`**(`/t/<token>` 初回アクセス)が `lpFirstAccessAt + outcome="inquiry"` を直接書く。同期は**共通ヘルパー1本**に集約し、outcome route と recordTrackingHit の**両方**から同一 tx で呼ぶ(書く場所を1つでも取りこぼすと再送候補の判定が破れる=[同種の穴は全箇所]の原則。実装時に outcome/deliveryStatus の writer を grep で全列挙して確認する)。
  - 既存の sale_dm 行への **backfill は「再実行可能な照合(reconciliation)」として実装**し、**新コード稼働後に実行**する(@codex R7 P2)。migration-B は列追加のみとし、照合は §同期の共通ヘルパーを使う冪等スクリプト(全 sale_dm 行を draft と突き合わせて上の優先規則で更新)を **PR-B 反映の restart 後に実行**する。⚠migration の中で backfill すると、`migrate deploy → restart` の窓で旧プロセスが書いた反響(LPアクセス等)が draft 側だけに残り、照合済みの行が no_response のまま固定される。照合は冪等なので、窓の有無にかかわらず稼働後にもう一度流せば閉じる(本番は売却DM休眠中のため対象は僅少/ゼロの見込み)。旧行に draft_id が無い場合は propertyId+送付日で対応付ける。⚠**対応付けが曖昧な行は「反響あり側」に倒す**(@codex R4 P2): 同日に複数 draft があり1対1に決められない場合、その物件の該当 drafts に inquiry/returned_undeliverable が1つでもあれば、曖昧な sale_dm 行へ該当反響(replied/undeliverable)を保守的に付与する。誤って再送候補から**外れる**のは許容(送りすぎ防止が目的)・誤って候補に**入る**のは不可、の非対称で判断する。
  - これにより §4 の再送候補判定は **PropertyDmLog だけを見れば足りる**(2つの保存先を join しない=判定の単一情報源)。

## 4. 第3段(PR-C): 再送候補

- 定義(すべて AND):
  1. `dmStatus = "send"`
  2. 送付記録が1件以上ある
  3. **90日以内の送付記録が無い**(`dmLogs: { none: { sentAt: { gt: cutoff } } }`)
  4. replied / refused / undeliverable の反響が付いた記録が**1件も無い**
  5. **所有者単位の除外(@codex R8 P1)**: その物件の所有者(PropertyOwner 経由)の誰かに、**他物件も含めて** refused / undeliverable の反響ログ(`Owner.dmLogs`=migration-A の逆リレーション)が付いていれば除外する。同じ所有者が物件AとBに紐づくとき、Aで拒否された相手にBから再送する事故を防ぐ(Prisma: `owners: { none: { owner: { dmLogs: { some: { reactionStatus: { in: [refused, undeliverable] } } } } } }` 相当)。⚠限界: ownerId が null の記録(個別記録・旧sale_dm行)は物件単位でしか効かない。また「所有者行は別だが住所が同じ」相手は所有者の名寄せ(既存の品質チェック領域)の守備範囲とし、本機能では扱わない(§6 論点)。
- replied を除外する理由: 連絡が来ている相手は人が個別対応する(定型の再送に乗せない)。
- `COOLDOWN_DAYS = 90`(定数)。env `DM_RESEND_COOLDOWN_DAYS` で上書き可(業務値の変更にリリース不要)。上限(cap)は作らない。
- 純関数 `decideResendCandidacy(logs, now, {cooldownDays})` → `{eligible, reason}`(表示とテストの単一情報源。一覧 where と同じ規則を対で維持)。
- UI: 物件一覧に「**再送候補のみ**」トグル → そのまま既存の「CSV出力→送付の確定」の流れに乗る(sequence が自動で増える)。

## 5. テスト方針

- 純関数(sequence 採番・decideResendCandidacy・allowlist)はユニット。route は既存 dm-logs/route.test の型を踏襲(認可・マスク・監査・冪等)。
- export の「PropertyDmLog を書かない」ピンは維持し、「batch を書く」ことを明示的にアサート。
- 権限/監査 allowlist/lock 順序はソース固定(source-assertion)で配線を固定。

## 6. レビューで特に見てほしい論点

1. 一括確定 tx の親ロック方針(§2.3 ⚠): INSERT のみの tx は親 FOR UPDATE を取らない(採番は advisory lock で直列化)、で安全か。
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
