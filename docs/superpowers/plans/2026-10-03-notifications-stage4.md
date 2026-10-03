# 通知 段階4（画面を閉じていても PC・スマホに届く Web プッシュ）作業計画

2026-10-03。設計書 `docs/superpowers/specs/2026-09-27-notifications-design.md` §7（と §4.6 の 2）を実装する。段階1〜3（本番の画面内のお知らせ・時刻の欄）の上に載せる。

## 発注者の承認（2026-10-03）

- 段階4に着手（「5から7を順に進めて」）。設計書 §3 に書いた前提＝**新しい依存 `web-push`・env 3つ（VAPID）・systemd timer・DB の表の追加**を含めて進める。VPS での env 追加・timer 設置・migrate deploy は、反映のときに改めて指示をもらって行う。
- **Windows の Edge も対象**（Microsoft の中継サービスへの接続を承認）。D14 の許可リストに `*.notify.windows.com` を加える（設計書 §7.2・§12 を更新）。

## 許可する中継サービス（設計書 §7.2・2026-10-03 確認）

| ブラウザ | 送り先のホスト | 照合 |
|---|---|---|
| Chrome（Android 含む） | `fcm.googleapis.com` | 完全一致 |
| Firefox | `updates.push.services.mozilla.com` | 完全一致 |
| Safari（macOS 13〜・iOS 16.4〜のホーム画面アプリ） | `*.push.apple.com` | サブドメインの後方一致（Apple の案内「push.apple.com の任意のサブドメインを許可」） |
| Edge（Windows） | `*.notify.windows.com` | サブドメインの後方一致 |

`https:`・既定ポートのみ・利用者名/パスワード付きは拒否・IP 直書き/localhost は拒否（ホスト名の照合で自然に落ちる）。拒否の応答・ログに URL を出さない。送信時にも同じ確認をし、リダイレクトを追わない。

## PR の分け方（1段階＝1 PR 以上・混ぜない）

### 4a: 登録と受け取り（この PR）
- **DB（migration 1本・表の追加のみ）**: `push_subscriptions` だけ。送信の記録（`notification_deliveries`・`notification_delivery_refs`・`notification_source_cursors`・`notification_source_events`）は 4b、`edit_lock_loss_events` は 4c で、それぞれ使うコードと一緒に足す（使わない表を先に作ると、レビューで中身を確かめられず、4b・4c で形を変えたくなったときに migration が増えるため）。
- ⚠4b の申し送り: 付け替え（`rebind`）では、同じトランザクションで前の結び付けの送り待ち（`pending`・`failed`・`sending`）を `cancelled` にする（設計書 §7.5）。4a の `decideBinding` は `cancelPrevious` を返してあるので、送信記録の表ができたらそこで使う。
- **env**: `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`。4a で使うのは公開鍵だけ（画面に渡す）。未設定ならプッシュの登録は「使えません」（501 相当・画面は今までどおり段階1・2の動き）。
- **API**（ログイン必須）:
  - `GET /api/push/config` … 公開鍵と使えるかどうか。
  - `PUT /api/push/subscription` … 登録・付け替え（§7.5 の 2）。`endpoint` の許可リスト確認、`device_scope`（`shared`=画面を閉じて65分・`personal`=最後のログインから30日）、別の利用者への付け替えは `shared` に戻す、期限切れ・無効化からの再有効化は新しい `binding_id`・`bound_at`、`gone` は再有効化を断る（`endpoint_gone`）、付け替えと同じトランザクションで前の結び付けの未送信を `cancelled`。応答は `binding_id` と `device_scope`・`expires_at` だけ（`endpoint`・鍵は返さない）。
  - `POST /api/push/subscription/extend` … `shared` の `expires_at` を「今＋65分」に延ばす（自動ログオフの延長＝`/api/auth/session` を叩くのと同じ5分ごと）。
  - `DELETE /api/push/subscription` … ログアウトでの解除（`revoked_reason=logout`）。
  - 監査ログは「登録・解除」と件数だけ（`endpoint`・鍵は書かない）。
- **Service Worker（版 2）**: `push` を受けて、本文の `binding_id` と保存値（IndexedDB）を比べ、一致したときだけ中身を出す。違う・無いときは「新しいお知らせがあります（ログインして確認してください）」だけ。表示・消去・書き込みを段階1と同じ1本の順番待ちで処理し、表示のあとで保存値を読み直して違えば閉じる。`install` で `skipWaiting()`・`activate` で `clients.claim()`。画面からの問い合わせに `{ version: 2, push: true }` を返す。
- **画面**: ベルの「PC・スマホにも通知する」に「この端末は自分専用（自分のスマホ・PC）」の選択。許可→`push: true` の SW を確かめてから `pushManager.subscribe()`→`PUT`→返ってきた `binding_id` を SW に保存。ログイン画面を開いたとき・ログインの送信前に `binding_id` を消す（SW 経由・3秒・失敗時は直接）。消せないときは登録を `unsubscribe()` で捨てる、それもできなければログインに進まない（§7.5）。ログイン後に登録があれば付け替え（自動・選択は前の人のものを使わない）。ログアウトで `DELETE` → `unsubscribe()`。

### 4b: 送る（次の PR）
- 依存 `web-push`。送信スクリプト（`scripts/notifications/send.ts`・`www-data` で systemd timer から数分ごと）。N4・N5（§7.4 の送信予定・段階2の `nextActionReminderSlot` を共用）・N6（`notification_source_cursors`/`events`）・N7。端末ごとに1通にまとめる・`SKIP LOCKED`・取り合い（`sending`・15分）・送り直し最大3回・404/410 で `gone`・送る直前の確かめ直し（完了・担当替え・権限・`inquiryNotifyEnabled`）。トランザクションの時間制限 20秒＞送信 10秒（テストで固定）。`docs/deploy.md` に timer の手順。

### 4c: 編集権限が外れた（N2）をサーバーから（その次の PR）
- `edit_lock_loss_events` の記録（取り直しの上書き・管理者の解除は同じトランザクション／期限切れのまま放置は送信スクリプトが見つける）・1時間を過ぎた記録は送らず締める・端末ごとに送信記録を作ってから締める。

## 変えないもの（設計書 §10）
自動ログアウト60分・編集ロックの規則・査定申込のメール通知・謄本一括の進め方・段階1〜3の画面内の知らせ。

## テスト（設計書 §11 段階4 のうち 4a の分）
許可リスト（4社・後方一致の境界 `evil-push.apple.com.attacker`・IP・http・ポート・userinfo）／付け替え（別の利用者→`shared`・期限切れ/無効化→新しい `binding_id`・`gone` は断る・前の結び付けの未送信を `cancelled`）／応答に `endpoint`・鍵が無い／`shared` の延長／ログアウトの解除／SW の `binding_id` 照合（一致・不一致・無し）と順番待ち・表示後の読み直し／ログイン前の消去が失敗したときの扱い／VAPID 未設定で登録を断る。
