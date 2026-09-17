# 物件・所有者の「編集中」鍵 設計

2026-09-17。物件と所有者を複数人が同時に編集しないよう、**先に編集を始めた人が終わるまで他の人は編集できない**仕組み(編集の鍵)を足す。
関連: 同時保存の既存の守り(版番号 `version` による楽観ロック) / 自動ログアウト(`idle-session-guard.tsx`・無操作60分)。
見本(画面): https://claude.ai/artifact/JsvYxZuF2jBAARUaFHAeRP (場面①〜⑧・各場面に本書の章番号)

## 0. ひとことで

物件の「編集」や所有者カードの「編集」を押すと、その物件(所有者)に**鍵が1本だけ**かかる。鍵がある間、他の人の画面には「🔒 山田さんが編集中です(14:02〜)」と出て編集できない。保存・閉じるですぐ外れ、画面が止まれば5分、放置なら60分で自動的に外れ、急ぎは管理者が外せる。鍵は**データベースの台帳**に置き、**保存の窓口でも確認**する。既存の版番号の守りはそのまま残す(最後の砦)。

## 1. 発注者の決定事項(2026-09-16〜17)

| # | 項目 | 決定 |
|---|---|---|
| D1 | 他の人が編集中のとき | **編集できないようにする**(表示だけではない) |
| D2 | 対象 | **物件**(編集ウィンドウ)と**所有者**(1人ずつ)。販売図面・建物は対象外 |
| D3 | 鍵が残ったとき | 保存・閉じるで即解除/画面が止まったら自動解除/放置も自動解除/**管理者が外せる** |
| D4 | 画面が止まってから外すまで | **5分**(合図は30秒ごと) |
| D5 | 開いたまま操作が止まったとき | **60分**で外す(自動ログアウトと同じ) |
| D6 | 自分の別の端末・別のタブ | **他の人と同じく待つ**。同じタブの再読み込みは同じ画面として扱う |
| D7 | 鍵の間に止める範囲 | **編集で変える項目だけ**。添付・写真・コメント・ToDo・謄本の自動取得・一括取込・管理者の一括修正は止めない |
| D8 | 作り方 | **案A: 鍵の台帳(新しい表)**。メモリ保持(案B=再起動で全消滅)・既存表に列(案C=物件行の書き換えがDM/謄本の順番待ちと衝突)は不採用 |
| D9 | 同じ保存窓口を使う他の入口 | **鍵の間は断る**(案件ステータス・紹介経路のプルダウン、地番ポップアップ、謄本PDF取込での所有者の手直し)。理由=通すと版番号が進み、鍵を持つ人の保存が409で負ける |

## 2. 鍵のルール

### 2.1 用語

- **資源**: 鍵をかける対象。`property`(物件1件) または `owner`(所有者1人)。
- **画面の合言葉(screen token)**: ブラウザのタブごとに作るランダム値。`sessionStorage` に置くので**同じタブの再読み込みでは変わらず**、別タブ・別端末では別の値になる(D6)。サーバーには**ハッシュだけ**保存する。
- **保持者**: 鍵を持っている「利用者+画面の合言葉」の組。

### 2.2 決まり

1. **1つの資源に鍵は1本だけ**。台帳の一意制約 `(resource_type, resource_id)` で物理的に二重取得を防ぐ。
2. **鍵が有効** ⇔ `now - heartbeat_at ≤ 5分` **かつ** `now - activity_at ≤ 60分`。どちらかを超えた鍵は**期限切れ**で、次に来た人がそのまま取れる。
3. **期限の判定はデータベースの時計(`now()`)が権威**。端末の時計は使わない。端末は「直前の合図から操作があったか」(真偽値)だけを送る。
4. 取得できる条件: 鍵が無い/期限切れ/**同じ保持者**(同じ利用者かつ同じ合言葉)。それ以外は取れない(同じ利用者でも合言葉が違えば取れない=D6)。**管理者も同じ規則**で、他人の鍵を取るにはまず「管理者が外す」を使う。
5. 外れ方:

| きっかけ | 外れるまで | 実装 |
|---|---|---|
| 保存成功・閉じる・キャンセル | 即時 | 画面が「外す」を送る |
| タブを閉じる・別ページへ移動 | 即時(届けば) | `pagehide` で `navigator.sendBeacon` |
| 上が届かない(iPhoneで起きやすい)・電池切れ・電波切れ・別アプリへ切替 | 最後の合図から5分 | 期限切れ |
| 開いたまま操作なし | 最後の操作から60分(55分で予告) | 期限切れ |
| 管理者が外す | 即時 | 管理者用の窓口 |

### 2.3 定数(`src/lib/edit-lock/rules.ts`)

| 名前 | 値 | 備考 |
|---|---|---|
| `EDIT_LOCK_HEARTBEAT_INTERVAL_MS` | 30秒 | 合図の間隔 |
| `EDIT_LOCK_HEARTBEAT_GRACE_MS` | 5分 | D4 |
| `EDIT_LOCK_IDLE_LIMIT_MS` | 60分 | D5。**`IDLE_TIMEOUT_MS`(自動ログアウト)と一致することをテストで固定** |
| `EDIT_LOCK_IDLE_WARN_MS` | 55分 | 予告を出す時点 |
| `EDIT_LOCK_STATUS_POLL_MS` | 30秒 | 見ている人の画面の再確認 |

### 2.4 純関数

判定は画面・窓口・テストで同じものを使うため純関数に出す(同時に走る処理の判定を文字列の走査だけで守ろうとして、順序の交差の指摘が続いた過去の教訓)。

- `isLockExpired(lock, now): boolean`
- `evaluateLock(lock | null, now, requester: { userId, tokenHash }): { state: "free" } | { state: "mine" } | { state: "held_by_other", holderUserId, since } | { state: "held_by_self_other_screen", since }`
  - 期限切れの鍵は `free` と同じ扱い(ただし監査用に `expiredPrevious` を返す)

SQL 側(2.2 の条件)と純関数の閾値は同じ定数から組み立て、**両者が一致することをテストで固定**する。

## 3. データ

### 3.1 新しい表 `edit_locks`(migration `20260917100000_add_edit_locks`・追加のみ)

```prisma
enum EditLockResource {
  property
  owner
}

model EditLock {
  id              String           @id @default(cuid())
  resourceType    EditLockResource @map("resource_type")
  resourceId      String           @map("resource_id")
  userId          String           @map("user_id")
  screenTokenHash String           @map("screen_token_hash")
  acquiredAt      DateTime         @default(now()) @map("acquired_at")
  heartbeatAt     DateTime         @default(now()) @map("heartbeat_at")
  activityAt      DateTime         @default(now()) @map("activity_at")

  user User @relation(fields: [userId], references: [id])

  @@unique([resourceType, resourceId])
  @@index([userId])
  @@map("edit_locks")
}
```

- `resourceId` は物件/所有者への**外部キーを張らない**(資源が2種類のため)。資源の削除・アーカイブ・統合時は 4.6 で明示的に消す。
- 行は「今の鍵」だけを持つ(1資源1行)。**履歴は `audit_logs` に残す**(3.2)。期限切れの行は次の取得で上書きされるので、お掃除の定期処理は足さない(最大でも「編集されたことのある物件+所有者」の行数)。

### 3.2 監査ログ

`writeAuditLog` に次の4種を足す。`targetTable = "edit_locks"`、`detail` は **ID と種別だけ**(自由文・氏名を入れない=許可リスト方式)。

| action | いつ | detail |
|---|---|---|
| `edit_lock_acquire` | 空きから取得 | `resourceType, resourceId` |
| `edit_lock_takeover_expired` | 期限切れの鍵を次の人が取得 | `resourceType, resourceId, previousUserId, expiredBy("heartbeat" \| "idle")` |
| `edit_lock_release` | 本人が外した | `resourceType, resourceId` |
| `edit_lock_force_release` | 管理者が外した | `resourceType, resourceId, previousUserId` |

合図(30秒ごと)は記録しない。

## 4. 窓口(API)

すべて認証必須(`getApiSession`)。画面の合言葉はヘッダ **`X-Edit-Screen`** で送る(本文に混ぜない=保存窓口と同じ渡し方にそろえる)。サーバーは `sha256` にしてから比較・保存する。

### 4.1 権限

| 窓口 | 必要な権限 |
|---|---|
| 取得・合図・外す | その資源の**書き込み権限**。物件=`property:write`+`canAccessPropertyRecord`(アルバイトの担当範囲)/所有者=`owner:write`+所有者の物件スコープ(既存 `scopeOwnerProperties` と同じ判定) |
| 状態を見る | その資源の**閲覧権限**。閲覧できない資源については「鍵の有無」も返さない |
| 管理者が外す | `session.role === "admin"` |

### 4.2 `POST /api/edit-locks/acquire`

本文 `{ resourceType, resourceId }`。

1. トランザクション内で**資源の行をロック**(物件=`lockPropertyRow`/所有者=所有者行の `SELECT … FOR UPDATE`)。→ 4.5 の保存と直列化する。
2. 既存の鍵を読み、`evaluateLock` で判定。
3. `INSERT … ON CONFLICT (resource_type, resource_id) DO UPDATE SET … WHERE <期限切れ OR 同じ保持者>` を1文で実行(`now()` 基準)。行が返らなければ他の人が保持中。
4. 応答:
   - 取得 → `200 { state: "mine", lockId, since }`(期限切れの横取りなら監査 `edit_lock_takeover_expired`)
   - 保持中 → `423 { code: "EDIT_LOCKED", state: "held_by_other" | "held_by_self_other_screen", holderName, since }`
   - 資源が無い → 404

### 4.3 `POST /api/edit-locks/heartbeat`

本文 `{ resourceType, resourceId, active: boolean }`。**資源の行はロックしない**(案Cを退けた理由と同じ=頻度が高い)。

```sql
UPDATE edit_locks
   SET heartbeat_at = now(),
       activity_at  = CASE WHEN $active THEN now() ELSE activity_at END
 WHERE resource_type = $t AND resource_id = $id
   AND user_id = $user AND screen_token_hash = $hash
   AND heartbeat_at >= now() - interval '5 minutes'
   AND activity_at  >= now() - interval '60 minutes'
```

- 1件更新 → `200 { state: "mine", idleSince }`
- 0件 → 現状を読んで `200 { state: "lost", reason: "expired" | "force_released" }` または `200 { state: "taken", holderName, since }`
  - `force_released` の判別: 直近の監査ログ(`edit_lock_force_release`・同資源・`previousUserId = 自分`)を見る
- **期限切れの鍵を合図で生き返らせない**(取り直しは 4.2 を通す=監査と直列化のため)。

### 4.4 `POST /api/edit-locks/release` / `POST /api/edit-locks/force-release`

- `release`: 本文 `{ resourceType, resourceId }`。`DELETE … WHERE 資源 AND user_id AND screen_token_hash`。0件でも 200(冪等)。`sendBeacon` から呼ばれる前提で、**本文は `text/plain` の JSON も受ける**(beacon は Content-Type を自由に付けられないため)。ヘッダが付けられない beacon 用に、合言葉は本文の `screenToken` でも受ける(この窓口に限る)。
- `force-release`(管理者): 本文 `{ resourceType, resourceId, lockId }`。`DELETE … WHERE id = $lockId`(**画面に出ていた鍵だけを外す**。見ている間に別の人が取り直した新しい鍵は外さない)。0件 → `409 { code: "EDIT_LOCK_CHANGED" }`。

### 4.5 `POST /api/edit-locks/status`

本文 `{ resources: [{ resourceType, resourceId }] }`(物件1件+所有者カード分をまとめて1回)。上限50件。
応答は資源ごとに `free` / `mine`(この画面) / `held_by_self_other_screen { since }` / `held_by_other { holderName, since, lockId? }`。`lockId` は**管理者にだけ**返す。

### 4.6 資源の削除・アーカイブ・統合

次の処理の中で、該当資源の鍵行を消す(同じトランザクション内)。
- 物件の削除 `DELETE /api/properties/[id]`
- 所有者のアーカイブ `admin/owners/[id]/correction/archive`
- 所有者の統合 `admin/owners/correction/merge`(統合されて消える側)

## 5. 保存の窓口での確認(D9)

### 5.1 対象

| 窓口 | その窓口を使う入口(すべて止まる) |
|---|---|
| `PATCH /api/properties/[id]` | 編集ウィンドウ `property-edit-form.tsx` / 案件ステータス `CaseStatusField` / 紹介経路 `IntroductionRouteField` / 地番ポップアップ `registry-chiban-popup.tsx` |
| `PATCH /api/owners/[id]` | 物件詳細の所有者カード / 謄本PDF取込 `import/registry-pdf/page.tsx` |

### 5.2 動き

共通関数 `assertNotEditLockedByOther(tx, { resourceType, resourceId, userId, screenTokenHash | null })` を、**資源の行をロックした後・書き込みの前**に呼ぶ(4.2 と同じ順序で直列化=「確認した直後に鍵を取られて版番号だけ進む」隙間を閉じる)。

- 有効な鍵を**別の保持者**が持つ → `423 EDIT_LOCKED`(文言「山田さんが編集中です(14:02〜)」)
  - 合言葉ヘッダが**無い**(反映前から開いていた古い画面) → 文言に「画面を再読み込みしてください」を足す
- 鍵が無い/期限切れ/同じ保持者 → 通す。**版番号の確認はこれまでどおり**その後に行う

⚠`PATCH /api/properties/[id]` は現在トランザクション外の `updateMany`(版番号・謄本取得中の条件つき)で書いている。**`$transaction` + `lockPropertyRow` で包み直す**。条件つき更新(版番号・`registryStatus`)は中にそのまま残す。
⚠`PATCH /api/owners/[id]` も同様に、所有者行をロックしてから確認→書き込みの順にする(現在の書き方は計画段階で読み、包み直しの範囲を決める)。
⚠ロック順序は既存の書き込み規約「所有者 → 物件の親行 → 子行」に合わせる。所有者の保存窓口で物件行も触る場合は、所有者行を先にロックする。

### 5.3 止めないもの(D7)

別の窓口なので鍵を見ない: 添付・写真・コメント・ToDo・所有者メモ・物件と所有者の紐付け・DM・謄本の自動取得・一括取込・管理者の一括修正(`admin/owners/correction/*`)。
→ これらが鍵の間に物件/所有者の行を書き換えると、鍵を持つ人の保存は**既存の409(版番号)**で弾かれる。頻度は低く、入力は画面に残るので許容する(7章に明記)。

## 6. 画面

### 6.1 画面の合言葉

`src/lib/edit-lock/screen-token.ts`: `sessionStorage["edit-screen-token"]` を読み、無ければ `crypto.randomUUID()` で作って保存。**`sessionStorage` の読み書きは try/catch**。使えない場合(プライベートモード等)はそのページの間だけメモリに持つ(再読み込みで別の画面扱い=自分の鍵に最大5分締め出されうる。まれなので許容)。
保存窓口を呼ぶ **6つの入口すべて**が `X-Edit-Screen` を付ける(8.3 の走査テストで固定)。

### 6.2 `useEditLock`(編集する側)

`useEditLock({ resourceType, resourceId })` → `{ acquire(), release(), status, noteActivity() }`

- `acquire()`: 4.2 を呼ぶ。取れたら合図を開始。
- 合図: 30秒ごと。`active` は前回からの操作の有無(編集ウィンドウ/カード内の `input`・`keydown`・`pointerdown`)。
- 55分操作なし → 帯「操作がないため、あと5分で編集を終了します」。
- 応答が `lost: expired` → 帯「しばらく画面が止まっていたため、編集の鍵が外れました。入力すると自動で取り直します」。**入力は消さない**。次に入力したとき `acquire()` を自動で再試行し、取れたら帯を消す。
- 応答が `lost: force_released` → 帯「**管理者が編集を終了しました。この内容は保存できません**」、保存ボタンを無効化。**自動の取り直しはしない**(管理者が外した意図を守る。続けたい場合はウィンドウを閉じて開き直す=通常の取得を通る)。
- 応答が `taken`(または再試行が 423) → 帯「**佐藤さんが編集を始めました。この内容は保存できません**」、保存ボタンを無効化。入力は選択・コピーできるまま残す。
- 保存成功・閉じる・キャンセル → `release()`。
- `pagehide` → `navigator.sendBeacon("/api/edit-locks/release", …)`。
- 画面が裏に回って合図が止まることは正常(iPhone)。戻ったとき(`visibilitychange`)に即座に合図を1回送り、状態を反映する。

### 6.3 `useEditLockStatus`(見ている側)

物件詳細を開いたとき+30秒ごと(画面が表に出ている間だけ)に 4.5 を呼ぶ。

| 状態 | 表示 | 無効化 |
|---|---|---|
| 物件が他の人の鍵 | 上部の帯「🔒 山田さんが編集中です(14:02〜)」 | 編集ボタン・案件ステータス・紹介経路・所在検索の地番保存 |
| 物件が自分の別の画面の鍵 | 「🔒 あなたが別の画面で編集中です(09:12〜)」 | 同上 |
| 所有者Nが鍵 | そのカードの中に同じ文言 | そのカードの編集ボタンだけ |
| 空いた | 帯を消す(次の確認=最大30秒で) | 戻す |

- **管理者**には帯に「鍵を外す」。押すと確認「山田さんの編集を終わらせます。**山田さんが入力中の内容は保存されません。**」→ 4.4 `force-release`(`lockId` 付き)。`EDIT_LOCK_CHANGED` なら「状況が変わりました。表示を更新します」。

### 6.4 帯の見た目

既存の UI 部品(`src/components/ui/`)の注意帯を使う(新しい色・形を作らない)。スマホ幅でも1〜2行に収める。見本は冒頭の Artifact。

### 6.5 断られたときの文言(地番ポップアップ・謄本PDF取込・プルダウン)

`EDIT_LOCKED` を受けたら「山田さんが編集中です(14:02〜)」を、その入口の既存のエラー表示位置に出す。入力は残す。

## 7. 変えないもの

- **版番号(`version`)による楽観ロック**と、その409文言。鍵が効かなかったときの最後の砦として残す。
- 謄本の自動取得中に鍵の項目(所在・地番等)の変更を断る既存の409(`REGISTRY_FETCH_IN_PROGRESS`)。
- 自動ログアウト(60分)の仕組み。定数は共有しない(クライアント部品のため)が、値の一致はテストで固定。
- 5.3 の窓口すべて。販売図面・建物(D2)。

## 8. テスト

### 8.1 純関数(総当たり)

- `evaluateLock` × {鍵なし, 同保持者, 同利用者・別画面, 他人} × {合図 新/古} × {操作 新/古} の全組み合わせ。
- 順序の交差を**決着しないものも含めて**総当たり: (a) A取得/B取得 の両順 (b) A合図/5分経過/B取得 (c) B保存/管理者解除/C取得 (d) A期限切れ/A入力で再取得/B取得 (e) 再読み込み(同合言葉)/別タブ(別合言葉)。
- SQL の閾値と純関数の閾値の一致。`EDIT_LOCK_IDLE_LIMIT_MS === IDLE_TIMEOUT_MS`。

### 8.2 窓口

- 取得: 空き→200/他人保持→423/同利用者別画面→423(`held_by_self_other_screen`)/期限切れ→200+監査 `takeover_expired`/権限なし→403/アルバイトの担当外→403。
- **同時取得**: 実DBで2本同時に取得 → ちょうど1本だけ成功(一意制約+`ON CONFLICT … WHERE`)。
- 合図: 生きている鍵→更新/期限切れ→`lost`(生き返らない)/他人に取られた→`taken`/管理者解除後→`lost: force_released`。
- 外す: 本人のみ・冪等・`text/plain` 本文(beacon)。管理者解除: 管理者以外403/`lockId` 不一致409。
- 状態: 閲覧権限のない資源は返さない/`lockId` は管理者だけ。
- 削除・アーカイブ・統合で鍵行が消える。

### 8.3 保存の窓口(D9)

- `PATCH /api/properties/[id]`・`PATCH /api/owners/[id]`: 他人の鍵→423/自分の画面の鍵→通過/鍵なし→通過/期限切れ→通過/合言葉ヘッダなし+他人の鍵→423(再読み込み文言)/鍵なし+版番号不一致→従来の409。
- **走査テスト**: `src/` 内で上記2窓口へ PATCH を送る箇所を全部洗い出し、**6入口すべてが `X-Edit-Screen` を付けていること**。新しい入口が増えたら落ちる。改行は LF に正規化してから数える。
- 5.3 の窓口が鍵を見ないこと(鍵の間も通る)。

### 8.4 画面(ローカル実機)

Playwright で**ブラウザを2つ**同時に動かす: 取り合い/帯の表示と解除後30秒以内の復帰/保存で即解除/タブを閉じて即解除/管理者解除と相手側の帯/所有者カード単位の鍵/プルダウン・地番ポップアップの無効化。
**実機確認の項目に追加**: iPhoneで編集中に別アプリへ5分以上→戻って入力→取り直し/他人が取った後に戻る/電池切れ相当(機内モード)で5分後に他人が取れる/55分予告。

### 8.5 全体

フルテスト(`npx vitest run`)・`tsc`・`eslint`・`next build`。CI の env に依存しないこと。

## 9. 段取りと本番反映

### 9.1 段取り(2回に分ける)

| 段 | 中身 | 単独で出しても安全な理由 |
|---|---|---|
| 第1段 | 台帳(migration)・純関数・窓口5つ・保存窓口の確認(5章)・削除時の後始末 | 画面がまだ鍵を取らないので**鍵は1本も生まれず**、保存は今までどおり全部通る |
| 第2段 | 画面(6章)・6入口の合言葉ヘッダ・走査テスト・実機確認項目 | 第1段の窓口に乗るだけ |

### 9.2 本番反映

- 第1段に migration あり(表の追加のみ・既存データ不変)。手順は vps-deploy。
- 反映直後は**古い画面が合言葉なしで保存**しに来る → 他人の鍵があれば「再読み込みしてください」で断る(5.2)。発注者から社員へ「編集画面を開いている人は再読み込み」を案内。
- 反映後の確認: 2つのブラウザで取り合い→解除/監査ログに4種が出る/合図の頻度がログを汚していない。

## 10. リスクと対策

| リスク | 対策 |
|---|---|
| 新しい保存の入口が増えたのに合言葉を付け忘れる | 8.3 の走査テストで落とす |
| 5.3 の窓口(管理者の一括修正・自動処理)が鍵の間に書く | 鍵を持つ人は既存の409で弾かれる。入力は画面に残る。頻度は低いので許容し、この章に明記 |
| 保存窓口をトランザクションで包み直すことによるロック順序の衝突 | 「所有者→物件の親行→子行」に合わせる。計画段階で既存の書き込み経路と突き合わせる |
| iPhone で `pagehide` が届かない | 5分の期限切れで回収(D4) |
| `sessionStorage` が使えない端末 | ページの間だけメモリ保持。再読み込みで自分に最大5分締め出される(まれ・許容) |
| 管理者の解除で保持者の入力が失われる | 確認ダイアログで明示。保持者側の入力は画面に残す(保存だけできない) |
| 合図による負荷 | 編集中の人×2回/分+見ている人×2回/分。資源の行はロックしない(4.3) |
| 期限の判定が端末の時計に左右される | 判定はDBの `now()` のみ(2.2-3) |
