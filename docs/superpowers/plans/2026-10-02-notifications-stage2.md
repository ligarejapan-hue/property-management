# 通知 段階2（画面内で次回対応・査定申込・謄本の一括取得の完了を知らせる）作業計画

2026-10-02。設計書 `docs/superpowers/specs/2026-09-27-notifications-design.md` の §5（段階2）を実装する。段階1（#462）の土台（ベル・右下のポップアップ・OS の通知・共用 PC の後片付け）の上に載せる。

## 範囲

- DB 変更なし・依存追加なし・env 追加なし（鍵は `NEXTAUTH_SECRET` から HKDF で用途別に導出）。
- 画面を開いている間だけ（60秒ごと・タブが見える状態に戻ったとき・見えないタブは5分ごと）。
- 段階3（時刻の欄）・段階4（Web プッシュ）は含めない。

## 1. サーバー

### 1.1 `GET /api/notifications/summary?inquiryCursor=&registryCursor=`

ログイン必須。各区分はその区分を見られる人にだけ返す（見られない区分は `null`）。応答は件数・不透明な値・時刻だけ。物件名・住所・申込者名など PII は返さない。`Cache-Control: no-store`。監査ログには書かない（60秒ごとの読み取りで件数のみ）。

| 区分 | 条件（今の一覧と同じ判定を再利用） | 返すもの |
|---|---|---|
| 次回対応 | `property:read`。`assignedTo = 自分`・`isCompleted = false`・物件の担当範囲（`propertyRecordScopeFilter`） | `today`（予定日＝日本時間の今日）・`overdue`（予定日＜今日。同じ件を両方に数えない）・`reminders: [{ key, slot }]` |
| 査定申込 | `checkSaleDmAccessFor(自分)` が ok（= `requireSaleDmAccess` と同じ条件）。field_staff は物件の担当範囲（申込一覧 API と同じ `scopeWhere`） | `open`（未対応の件数）。さらに `inquiryNotifyEnabled = true` かつ `isActive` の人にだけ `newKeys`・`cursor`・`cursorAt`・（初回のみ）`initialSeenKeys` |
| 謄本の一括取得 | `requestedById = 自分`・`status = "completed"` | `completed: [{ key, href, done, failed, skipped, chargedButFailed }]`・`cursor`・`cursorAt`・（初回のみ）`initialSeenKeys`。件数は項目ごとに `canAccessPropertyRecord` で今見られる物件だけ数え直す（`getBulkJobProgress` と同じ）。見られる項目が0件のジョブは返さない |

- 次回対応の回（`slot`）: 期限 T＝予定日の 9:00（日本時間・時刻の欄は段階3）。回は §7.4 の送信予定（T, T+2h…T+24h, T+30h…T+72h, T+84h…T+156h）のうち「今以前で最も新しい回」。T+168h 以降は返さない（件数には残る）。純関数 `nextActionReminderSlot(T, now, { timed })` を段階4でも共用する（`timed` は段階3で使う。時刻ありは T−5分が最初の回）。
- 不透明な値（`key`）: `HMAC-SHA256(鍵, "利用者ID|種類|…")` の先頭16バイトを base64url。鍵は `NEXTAUTH_SECRET` から HKDF（用途ラベル `notifications-seen`）。次回対応は `actionId|期限T(エポックms)|rev(updatedAt の ISO ミリ秒)|slot`、申込は `inquiryId`、謄本は `jobId`。利用者IDを混ぜるので、同じ件でも人が違えば値が違う。
- カーソル: 中身は `(時刻, ID)`。AES-256-GCM（鍵は HKDF・用途ラベル `notifications-cursor`、追加認証データに `種類|利用者ID`）で暗号化した base64url。別の人・別の種類のカーソルは読めない。読めないカーソルは **400**（黙って初期化しない）。
  - 初回（カーソル無し）: サーバーの今と境界値 UUID（`00000000-0000-0000-0000-000000000000`）で初期カーソルを作り、読み直し範囲（今−5分〜今）にすでにある出来事の不透明な値を `initialSeenKeys` で返す。`newKeys` は空。
  - 2回目以降: ①カーソルより後（`(t, id) > (ct, ci)`）を昇順・上限100件。②読み直し（`t >= ct − 5分` かつ `(t, id) <= (ct, ci)`）を上限で切らず100件ずつ全件。①と②の不透明な値を返す（重複除去は画面側）。次のカーソルは「受け取ったカーソル」と「①の最後」の大きい方（戻さない）。①が100件ちょうどなら次の問い合わせで続きを取る。
  - `cursorAt` はカーソルの時刻（ms）。画面が複数のタブの結果をまとめるとき、新しい方のカーソルを残すためだけに使う（時刻は PII ではない）。
- 謄本の `href` は `/properties/registry-fetch/<jobId>`（段階1のベルが物件の画面のパスを持つのと同じ扱い。見たかどうかの記録には使わない）。

### 1.2 `GET /api/next-actions/mine`（ホームの「自分の次回対応」）

次回対応の知らせを押したときの行き先（設計書 §2 N4「ホームの一覧（または自分の次回対応一覧）」）。今は該当の一覧が無いので足す。

- `property:read`・`assignedTo = 自分`・未完了・予定日 ≤ 今日（日本時間）・物件の担当範囲。予定日の古い順に最大50件。
- 返すもの: `id`・`propertyId`・`scheduledAt`（日付）・`actionType`・`overdue`・物件の `address`（物件の画面で見られる人にだけ。担当範囲で絞った後）。`content`（自由記述）は返さない。

## 2. 画面

- `NoticeKind` に `next_action`・`inquiry_new`・`registry_job_done` を足す（ベルのアイコン・色も）。
- `SummaryPoller`（`NoticeProvider` の中・ログイン後の画面だけ）: 取りに行く→判断（純関数 `decideSummaryNotices`）→保存→`notify`（ベル＋見えないときは OS の通知）＋見えているときは右下のポップアップ。
  - 次回対応: まだ見ていない `reminders` の key があれば1つにまとめて「今日の次回対応が3件、期限切れが1件あります」（0件の側は省く）。押すと `/home`。
  - 申込: まだ見ていない `newKeys` があれば「新しい査定の申込が N 件あります」。押すと「査定の申込」画面。
  - 謄本: まだ見ていない `completed` ごとに「謄本の一括取得が完了しました（成功12件・失敗1件・要手動2件・要確認1件）」（0件の区分は省く。`chargedButFailed` があれば必ず「要確認」を出す）。押すとジョブの画面。
- 状態（カーソル・見た key）は `localStorage` の `pm:notif-summary:v1:<利用者ID>`。見た key は申込・謄本は1日、次回対応は1週間で捨てる。
  - 共用 PC: `clearNoticeStorage()`（ログアウト・ログイン画面）で `pm:notif-summary:` で始まる値をすべて消す。書く直前に後片付けの合図（`NOTICE_SWITCH_KEY`）を読み直し、違えば書かない・出さない（段階1と同じ守り）。
  - 複数のタブ: 判断と保存はベルと同じ Web Locks（`pm:notices`）の中で順に行う（同じ知らせを2つのタブが出さない）。カーソルは `cursorAt` の新しい方を残す。
  - 400（カーソルが読めない）を受けたら、その区分の状態を捨てて次から初回として取り直す。
- 取りに行くことは自動ログオフの延長に数えない（`IdleSessionGuard` は利用者の操作だけを見ている・ポーラーはセッションの延長を呼ばない）。
- ホーム: 「自分の次回対応」（今日・期限切れ）。0件・権限なし・読めないときは何も出さない。押すと物件の画面。

## 3. テスト（設計書 §11 段階2）

- `nextActionReminderSlot` の境界（T、+2h、+24h、+30h、+72h、+84h、+156h、+168h、T 前、時刻ありの T−5分）。
- 「今日」と「期限切れ」に同じ件を二重に数えない・日本時間の日付境界（UTC 15:00 前後）。
- 権限: `property:read` なしで次回対応は null・field_staff は物件の担当範囲を `where` に畳み込む・売却DMを使えない人は申込 null・`inquiryNotifyEnabled=false`／`isActive=false` は新着を返さない。
- PII を返さない（応答に住所・名前・電話・本文が無い）。
- カーソル: 往復・別の利用者／別の種類では読めない・改ざんで 400・初期カーソル（境界値 UUID）・「カーソルより後」が昇順・読み直し範囲の古い行だけが返ってもカーソルが戻らない・読み直しは上限で切らない（100件超）・同じミリ秒の2件をどちらも拾う。
- 謄本の件数は見える項目だけで数え直す・見える項目0件のジョブは返さない・要確認を必ず出す。
- 画面側の判断: 「1件完了＋1件新着」でも新着を出す・同じ key で2回出さない・期限変更（deadline）や担当 A→B→A（rev）で出直す・初回は `initialSeenKeys` を見た扱い・後片付けの合図が変わったら書かない。
- ログアウトの後片付けで `pm:notif-summary:` が消える。

## 4. 進め方

1. 純関数（回・カーソルの比較・判断）→ 2. 不透明な値と暗号化 → 3. 集計（summary）と route → 4. 自分の次回対応 API → 5. 画面（ポーラー・ベルの種類・ホーム）→ 6. 全ゲート・提出前レビュー → PR・@codex。
