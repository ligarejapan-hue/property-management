# 現地調査写真 EXIF strip — 実機検証チェックリスト

現地調査ピン写真の EXIF/GPS strip（`stripFieldSurveyPhotoMetadata` + route 接続。PR #142 / #144）が
本番環境・実端末で仕様どおり動くことを、**今後誰でも再現できる手順**として固定する。
[field-survey-photo-privacy-checklist.md](./field-survey-photo-privacy-checklist.md) §7（実機検証項目）の実施手順版。

- 対象コード: VPS 反映済み `08af869`（PR #141〜#146 込み）以降。これより古い環境では実施しない
- スコープ: HTTPS / iOS Safari / Android Chrome / JPEG / PNG / WebP / HEIC 422 / malformed 422 / Orientation
- 本 docs はチェックリストのみ（コード仕様を変更しない）

> **取り扱い注意（必読）**: 確認に使った**実画像・実座標・実 EXIF 値・実ファイルを
> PR 本文・Issue・チャット・ログ・スクリーンショット・テスト fixture に残さない**。
> 記録してよいのは「GPS タグ: 有/無」「Orientation: 有/無・正立/横倒し」「HTTP status」
> 「エラー文言（汎用文言のみ）」など非 PII の結果だけ。
> オンラインの EXIF 確認サービスや生成 AI へ実写真をアップロードしない
> （EXIF 確認は必ずローカルの exiftool 等で・オフラインで行う）。

> **本番書き込みを伴う検証である**: 本チェックリストの実施は read-only ではなく、
> **本番 DB（ピン・写真行）と storage（画像実体）への書き込みを伴う**。
> 実施前に合意を取り、実施者・実施日時を記録し、検証データは専用ピン 1 本に隔離し、
> 終了後に必ず「13. 後始末」を完了すること。

関連実装（仕様の根拠。本 docs では変更しない）:

- strip utility: `src/lib/field-survey/exif-strip.ts`
- アップロード API: `src/app/api/field-survey/pins/[id]/photos/route.ts`
  （削除は `.../photos/[photoId]/route.ts`）
- クライアント: `src/components/field-survey/pin-create-modal.tsx` / `pin-detail-panel.tsx` /
  `use-field-survey-pin-photo-mutations.ts`
  （エラー文言マップ: `src/lib/field-survey-pin-util.ts` の `pinApiErrorMessage`）
- 配信 proxy: `src/app/uploads/[...path]/route.ts` + `src/lib/uploads-authorization.ts`
- 非 HTTPS 警告バナー: `insecure-context-banner.tsx` + `field-survey-secure-context.ts`

---

## 1. 前提条件（実施前に全て確認）

- [ ] 検証 URL は**本番の HTTPS URL**（アドレスバーが `https://` + 鍵マーク）。LAN IP / http で代用しない
- [ ] 検証アカウントが `field_survey:write` を持つ（写真追加に必須）
- [ ] 写真は**自分が作成したピン**に対してのみ追加する
      （他人のピンへの追加は `read_all` / `manage` を持っていても 403）
- [ ] 検証専用ピンを 1 本作り、テスト写真は全てそこに集約する（後始末を容易にするため）
- [ ] アーカイブ済みピンには写真を追加できない（409）→ 検証ピンは後始末完了まで archive しない
- [ ] 本番への書き込みを伴うことの事前合意を取り、実施者・実施日時を記録した
- [ ] PC に exiftool を導入済み（Windows: winget / 公式 zip、macOS: Homebrew）
- [ ] （任意・認可テスト 10-3 用）別スタッフのテストアカウントを用意できる場合のみ 403 確認を行う

検証中に以下が出た場合、MIME / strip の問題ではなく**前提条件（権限・所有・状態）の問題**として切り分ける:

| status | サーバ文言（DevTools で確認） | 原因 |
|---|---|---|
| 403 | 写真の追加権限がありません | `field_survey:write` 欠如 |
| 403 | 他スタッフの pin には追加できません | 自分のピンでない |
| 404 | pin が見つかりません | ピン不在 / ID 誤り |
| 409 | アーカイブ済の pin には写真を追加できません | archived ピン |

---

## 2. テスト資産の準備（PC 上・架空値のみ）

実在の人物・場所・物件を写さない / 指さないこと。被写体は無地の壁・床・手元の文具等にする。
メタデータのダミー値は**架空の値**を使い、使った値自体も記録に残さない（「付与した / 消えた」の事実のみ記録）。

- [ ] **JPEG（GPS 付き）**: 実機カメラで位置情報タグ ON で撮影
      （iOS: 設定 → プライバシー → 位置情報サービス → カメラ = 許可 / Android: カメラ設定 → 位置情報タグ ON）
- [ ] **PNG（eXIf 付き）**: PC 上の適当な PNG（スクリーンショット等で可）に exiftool で
      **EXIF グループ指定**の架空ダミー GPS を書き込む（例: `-exif:gpslatitude=...` 形式。値は架空）。
      **XMP に書かないこと**（PNG の XMP は iTXt に入り strip 対象外 = 残るのが仕様。
      XMP に書くと after 確認で「GPS が残った」ように見える偽 NG になる）
- [ ] **WebP（EXIF chunk 付き）**: exiftool で同様に EXIF グループ指定で書き込むか、
      `cwebp -metadata all` で EXIF 付き JPEG から変換する
- [ ] **malformed**: テキストやゼロ列など**非画像バイト**のファイルを `.jpg` 拡張子で保存する
      （実画像のバイナリ改変は実 EXIF 残存リスクがあるため使わない）。
      応用: 正常な JPEG を `.png` 拡張子に変えて偽装（PNG signature 不一致で malformed になる）
- [ ] **8MB 超**: 8MB（= 8 × 1024 × 1024 byte）+ 1 byte 以上のファイル（中身は任意・拡張子 `.jpg`）。
      ※ちょうど 8MB はサイズ検査を通過する（中身が非画像なら malformed 側の 422 になる）
- [ ] **HEIC**: iPhone 設定 → カメラ → フォーマット = 高効率（HEIC）で撮影した写真、または既存の `.heic` ファイル
- [ ] **before 確認（必須・偽陽性防止）**: 上記 JPEG / PNG / WebP は、アップロード前に PC で
      `exiftool -a -G1 -gps:all <file>` を実行し「GPS: 有・グループが EXIF 系（GPS）」を確認しておく。
      **元ファイルに GPS が無いと、strip が効いていなくても結果は『GPS 無し』になり、検証が偽陽性で通ってしまう**。
      無かった場合は再作成する

exiftool 最小コマンド例（出力全文を記録に貼らない。有/無のみ記録する）:

```
exiftool -a -G1 -gps:all <file>                          # GPS 有無（グループ付き）
exiftool -Orientation -Make -Model -DateTimeOriginal <file>  # 主要タグ
exiftool -a -G1 <file>                                   # 全タグ概観
```

---

## 3. 実施環境の使い分け

| 確認内容 | 実施環境 |
|---|---|
| カメラ起動・位置情報許可・HEIC 自動変換・Orientation 撮影（§4, 6-1, 7-1, 9） | **実機**（iPhone Safari / Android Chrome） |
| PNG / WebP / malformed / 8MB のアップロード（6-3〜6-5, 7-3〜7-5） | PC ブラウザのギャラリー導線で十分（テスト資産を選択） |
| after 確認（ダウンロード + exiftool）・DevTools での status / サーバ文言確認 | PC ブラウザ（同一アカウントでログインして同じピンを開く） |

実機での撮影 → アップロードと、PC での取得 → exiftool 確認は、同一アカウントなら別端末で続けて実施できる。

---

## 4. HTTPS / 画面表示の正常系

| # | 手順 | 期待結果 |
|---|---|---|
| 4-1 | 本番 HTTPS URL で `/field-survey/map` を開く（`?sessionId=` は付けない。付けると履歴閲覧モードになり写真導線が出ない） | 地図が表示され、非 HTTPS 警告バナー（`data-testid="field-survey-insecure-context-banner"`）が**出ない** |
| 4-2 | ピン作成で「現在地を使う」 | 位置情報の許可ダイアログ → 現在地取得が成功する |
| 4-3 | 写真追加の「カメラ」導線を押す | カメラが起動する（`<input capture="environment">` 由来・背面カメラ） |

参考（仕様。確認は任意）: バナーは「http かつ 非 localhost かつ secure context でない」ときだけ表示される。
バナーは**表示のみで機能は止めない**（HTTP でもアップロード自体は可能。geolocation / カメラのみ不安定になる）。

---

## 5. エラー表示の二段構造（先に理解しておく）

**クライアントはサーバの 422 エラー文言を表示しない。** 画面表示は HTTP status から固定文言に
マップされる（`pinApiErrorMessage`）。サーバ側の具体的文言は **DevTools の Network タブ**
（response body の `error.message`）でのみ確認できる。NG 判定の前に必ず両方を見ること。

| 事象 | HTTP | サーバ文言（DevTools） | 画面表示（ユーザーが見る文言） |
|---|---|---|---|
| HEIC / HEIF | 422 | この画像形式は現地調査写真では現在サポートされていません。JPEG / PNG / WebP を使用してください。 | 入力内容に誤りがあります。 |
| malformed | 422 | 画像ファイルを処理できませんでした。 | 入力内容に誤りがあります。 |
| 8MB 超過 | 422 | ファイルサイズが上限 (8MB) を超えています | 入力内容に誤りがあります。 |
| 認証切れ | 401 | — | ログインが必要です。再ログインしてください。 |
| 権限なし | 403 | （§1 の表参照） | 権限がありません。 |
| ピン不在 | 404 | pin が見つかりません | 対象の調査ピンが見つかりません。 |
| archived ピン | 409 | アーカイブ済の pin には写真を追加できません | 状態が変わりました。再読み込みしてください。 |
| サーバエラー | 5xx | — | サーバーエラーが発生しました。時間をおいて再試行してください。 |
| ネットワーク断 | — | — | 調査ピンの操作に失敗しました。 |

- 画面表示文言の確認は **(B) ピン詳細 panel** 導線で行う（写真セクション内に `role="status"` で表示される）。
  **(A) ピン作成 modal** は専用の失敗ブロック表示になる（7-2 参照）
- > **所見として記録**: HEIC で 422 になった際、画面の「入力内容に誤りがあります。」だけで利用者が
  > 「JPEG / PNG / WebP で撮り直す」へ辿り着けるか（UX 観点）。**仕様どおりの動作であり NG ではない**。
  > 分かりにくい場合は「所見」として報告する（文言改善は別タスク・要承認）

---

## 6. 形式別 strip 検証（中核）

各ケース共通手順:

1. **before**: §2 の before 確認済みであること（「GPS: 有」を控えてある）
2. アップロード（導線は §7 マトリクスに従う。初回は (B) ピン詳細 panel が確認しやすい）
3. PC のログイン済みブラウザで同じピンを開き、写真の拡大プレビューから画像を保存
   （右クリック保存。URL は `/uploads/{key}` 形式・同一オリジン。専用ダウンロードボタンは無い）
4. **after**: 保存したファイルを exiftool で確認し、原本とのファイルサイズも比較する

| # | 入力 | 期待結果 |
|---|---|---|
| 6-1 | iPhone JPEG（GPS 付き・実機撮影） | アップロード成功。after: **GPS / Make / Model / DateTimeOriginal / シリアル / MakerNote / XMP がすべて無い**。Orientation のみ残り得る（値 1〜8）。ファイルサイズは原本より小さい（増加したら所見として報告） |
| 6-2 | Android JPEG（GPS 付き・実機撮影） | 同上 |
| 6-3 | PNG（eXIf 付き） | アップロード成功。after: eXIf 由来の EXIF / GPS タグが**無い**。**iTXt / tEXt 系テキスト（XMP 含む）は残っていても NG ではない**（仕様上の残余） |
| 6-4 | WebP（EXIF chunk 付き） | アップロード成功。after: EXIF chunk 由来のタグが**無い**。**XMP chunk は残っていても NG ではない**（仕様上の残余） |
| 6-5 | （任意）JPEG の APPn(n≠1) / COM コメント付き | コメント等は残っていても NG ではない（仕様上の残余） |
| 6-6 | metadata 無しのきれいな画像 | アップロード成功・ファイル内容は無加工（changed=false で原本のまま保存・サイズ不変）。**これは「strip が効いた」証拠にはならない**点に注意（6-1〜6-4 と混同しない） |
| 6-7 | （任意）冪等性 | 6-1 で保存した strip 済みファイルを再アップロード → 再保存 → 再取得すると、バイト同等（サイズ一致・exiftool 結果同一）である |

仕様メモ（期待結果の根拠）:

- JPEG は **APP1 segment（Exif / XMP とも）全 drop + Orientation（値 1〜8）のみ最小 Exif APP1 再注入**。
  Exif 内部の異常（TIFF 構造の破損等）は 422 にせず drop + 再注入なしに倒す（lenient）
- PNG = `eXIf` chunk drop / WebP = `EXIF` chunk drop（+ RIFF size 再計算・VP8X の EXIF flag clear）
- 保存される `fileSize` は strip 後サイズ。storage には strip 後バイトのみ渡る
- 配信（`/uploads/{key}`）はバイト無加工で返すため、**ダウンロードしたファイル = 保存実体**として exiftool 検証が成立する

---

## 7. HEIC / malformed / 8MB（エラー系）

| # | 入力・手順 | 期待結果 |
|---|---|---|
| 7-1 | HEIC: iPhone（高効率フォーマット）で撮影 → カメラ / ギャラリー導線でアップロード試行 | **(a) 422**（画面「入力内容に誤りがあります。」・DevTools でサポート外文言）**または (b) 成功**（= iOS が input 経由で HEIC→JPEG に自動変換して送信。レスポンスの `mimeType` が `image/jpeg`）。**どちらになったかを必ず記録**。(b) の場合は 6-1 と同じ strip 確認を行う |
| 7-2 | HEIC: 「ファイル」アプリ / PC から `.heic` を直接ギャラリー導線で添付 | HEIC のまま届けば 422。変換される場合は 7-1(b) と同様に記録 |
| 7-3 | malformed（ゼロ列 `.jpg`） | 422。画面「入力内容に誤りがあります。」・DevTools「画像ファイルを処理できませんでした。」。**写真は保存されない**（一覧に増えない） |
| 7-4 | （任意）JPEG 実体の `.png` 偽装 | 422（PNG signature 不一致で malformed） |
| 7-5 | 8MB + 1 byte | 422。DevTools「ファイルサイズが上限 (8MB) を超えています」（サイズ検査は strip より先に走るため、巨大ファイルでは strip 系文言は出ない） |
| 7-6 | 7-1〜7-5 の後、写真一覧を再読込 | **失敗分の写真行が 1 件も増えていない**（422 時は storage / DB / 監査ログのいずれにも書き込まない設計） |

> iOS Safari の HEIC→JPEG 自動変換はOS / ブラウザのバージョンに依存する。
> 「(b) 成功」になっても**サーバに HEIC が到達していない**だけであり、422 分岐の回帰ではない。
> どうしても HEIC のままサーバへ届けたい場合は 7-2 の直接添付を優先する。

---

## 8. アップロード導線マトリクス

導線は 2 系統 × input 2 種。すべて `accept="image/*"`・**1 回 1 枚**（multiple なし。連続アップロードは再選択で行う）:

| 導線 | カメラ input（`capture="environment"`） | ギャラリー input |
|---|---|---|
| (A) ピン作成 modal | `pin-create-photo-camera-input` | `pin-create-photo-file-input` |
| (B) ピン詳細 panel | `pin-photo-camera-input` | `pin-photo-file-input` |

- [ ] 8-1 正常 JPEG を (A)(B) × カメラ / ギャラリーの 4 経路で 1 回ずつアップロードできる
- [ ] 8-2 (A) で**写真だけ失敗**するケース（malformed 等を添付してピン作成）:
      ピン本体は保存され、「ピンは保存されました」「写真の保存に失敗しました」と
      「写真なしで完了」「写真だけ再試行」ボタンが表示される（`data-testid="pin-create-photo-failed"`）。
      「写真だけ再試行」は**同じファイルを再送する**（malformed なら再び失敗する）→
      「写真なしで完了」で抜け、(B) ピン詳細 panel から正しい写真を追加できる
- [ ] 8-3 (B) でエラー後、**同じファイルをもう一度選択し直せる**（input が毎回リセットされる仕様）。
      正しいファイルに差し替えて成功すると一覧が更新される
- [ ] 8-4 (B) のエラー文言が写真セクション内に表示される（`role="status"`・§5 のマップ文言）

---

## 9. Orientation 確認

- [ ] 9-1 **縦持ち / 横持ち / 上下逆**で撮影した JPEG を各 1 枚アップロードする（実機撮影）
- [ ] 9-2 一覧サムネイルと拡大プレビューの**両方**で正立して表示される（横倒し / 逆さにならない）。
      サムネイルは原寸 fileUrl の縮小表示（thumbnailUrl は通常 null）
- [ ] 9-3 ダウンロードしたファイルを exiftool で確認: **Orientation タグのみ残り得る（値 1〜8）**。
      Make / Model / GPS 等は無い
- [ ] 9-4 PNG / WebP には Orientation 再注入が無い（JPEG のみの仕様）。PNG / WebP の表示向きは
      ピクセルの向きのまま（ブラウザ既定）になることを理解して判定する

---

## 10. /uploads 配信・認可（取得経路の確認）

- [ ] 10-1 写真 URL（`/uploads/{key}`）をログイン済みブラウザで直開き → 画像が表示される
- [ ] 10-2 同じ URL をシークレットウィンドウ（未ログイン）で直開き → **401**。
      **画像がそのまま表示されたら重大**（認可迂回。STORAGE_BACKEND=local の static 直配信の可能性。
      本番は server / s3 想定）→ 即報告
- [ ] 10-3 （任意・別アカウントがある場合）他スタッフのアカウントで自分のピンの写真 URL を開く → 403
      （`field_survey:read` に加えて `read_all` / `manage` を持つアカウント = 標準の office_staff / admin
      テンプレートでは 200 になるのが仕様）
- [ ] 10-4 （任意）DevTools Network で同じ写真を再読込 → 304 が返る（ETag による再検証。
      認可は毎回実施され、未ログインで If-None-Match を付けても 401 のまま = 認可前に 304 は返らない）
- [ ] 10-5 （任意）レスポンスヘッダの Cache-Control が `private, max-age=3600` である

---

## 11. 監査ログ確認（admin 権限がある場合）

- [ ] 11-1 成功アップロード後: action = `field_survey_pin_photo_create` の監査行があり、
      detail は `{pinId, photoId}` のみ（fileName / URL / 座標が**含まれない**）
- [ ] 11-2 写真削除後: action = `field_survey_pin_photo_delete` も同様に detail 最小
- [ ] 11-3 422 にしたケース（§7）: 対応する監査行が**増えていない**
- [ ] 11-4 確認結果に実 pinId / photoId を転記しない（「detail が最小であることを確認」とだけ記録する）

---

## 12. NG 時の報告テンプレート

期待結果と異なる事象 = **NG**。仕様どおりだが UX / 運用上の気づき = **所見**（例: §5 の HEIC 文言）。
どちらかを明記して以下の形式で報告する。

```markdown
## 実機検証報告（field-survey EXIF strip）

- 区分: NG / 所見
- 実施日時・実施者:
- 端末 / OS / ブラウザ: （例: iPhone 15 / iOS 18 / Safari）
- 該当チェック項目: （例: 7-3）
- 導線: modal / panel × カメラ / ギャラリー（data-testid があれば併記）
- 入力: MIME 種別・サイズ階級（例: 〜1MB）・GPS 付与の有無（値は書かない）
- 操作:
- 観測結果:
  - HTTP status（DevTools）:
  - サーバ文言（汎用文言のみ転記可）:
  - 画面表示文言:
  - 写真一覧の変化: 増えた / 増えない
  - exiftool 結果: GPS: 有/無 ・ Orientation: 有/無 ・ 表示: 正立/横倒し
- 期待結果との差分:
- 再現性: 毎回 / 時々 / 1 回のみ
```

**報告に含めてはいけないもの**: 実座標・実 EXIF 値・画像ファイル本体・exiftool 出力の全文・
`/uploads/{key}` の完全 URL（key 部分）・storageKey・実 pinId / photoId・
スクリーンショット内の地図 / 住所 / 写真本体（添付する場合は必ずマスクする）。

---

## 13. 後始末（必須）

- [ ] 13-1 検証ピンの写真を UI からすべて削除する（自分のピン + `field_survey:write` で削除可能）
- [ ] 13-2 削除後、写真一覧から消えたこと・拡大プレビューが開けないことを確認する
- [ ] 13-3 削除した写真の `/uploads/{key}` をログイン済みブラウザで直開き → **404**
      （= **アプリ経由で配信されなくなったこと**の確認）。
      なお `/uploads/{key}` は storage 実体を読む前に **DB 参照ベースで認可判断**する
      （`authorizeFieldSurveyPinPhoto`: 写真の DB 行から解決した pin が無ければ `not_found` → 404）。
      よって **UI 削除で DB 行が消えると、storage 実体が残っていても 404 になり得る**。
      この 404 は storage 実体の削除完了や orphan 不在の証明には**ならない**

> **orphan（storage 実体の削除漏れ）確認は本チェックリストのスコープ外**。
> 実体削除は best-effort 設計のため、API 削除が成功しても実体が残る可能性がある。
> 確認するには backend / storage レベルの直接点検（local backend なら `public/uploads/` 配下の
> 実ファイル走査、s3 / server backend なら該当 backend 側の存在確認）か、
> **削除前後で実体の有無を突き合わせる専用検証**が別途必要。
> orphan の有無を厳密に追う場合は**別タスク（バックエンド検証）**として扱う。
- [ ] 13-4 検証ピン自体を削除（または archive）する。**写真削除 → ピン削除 / archive の順**を守る
      （archived ピンの写真は操作できなくなるため）
- [ ] 13-5 PC・実機に残したテスト資産（GPS 付き JPEG / ダミー PNG / WebP / malformed ファイル等）を削除する
- [ ] 13-6 実施記録（メモ・チャット・スクリーンショット）に実画像・実座標・実 EXIF 値が
      含まれていないことを最終確認する

---

## 付録A: 期待仕様の早見表

| 項目 | 仕様 |
|---|---|
| JPEG | APP1（Exif / XMP）全 drop + Orientation（値 1〜8 が読めた場合のみ）最小 Exif APP1 を再注入。Exif 内部異常は lenient（drop + 再注入なし。422 にしない） |
| PNG | `eXIf` chunk drop。iTXt / tEXt（XMP 含む）は残る |
| WebP | `EXIF` chunk drop + RIFF size 再計算 + VP8X の EXIF flag clear。XMP chunk は残る |
| HEIC / HEIF | 422（保存しない。共有定数 `ALLOWED_PHOTO_MIMES` は不変・route 側分岐） |
| malformed | 422 fail-closed（JPEG segment 構造異常 / PNG chunk 構造異常 / WebP RIFF size 不一致等。原本を保存しない） |
| 残余（NG ではない） | JPEG APPn(n≠1) / COM・PNG iTXt / tEXt・WebP XMP chunk |
| fileSize | strip 後サイズを DB に記録 |
| 1 リクエスト | 1 枚（FormData フィールド `file`） |
| 422 時の副作用 | storage / DB / 監査ログのいずれにも書き込まない |
| 監査 detail | `{pinId, photoId}` のみ |
| 適用範囲 | field-survey photos route 限定（PropertyPhoto / BuildingPhoto / attachments には適用しない = gpsLat 等の保持は別 route の仕様） |

## 付録B: 既存テストロック（回帰検知用・再確認不要）

合成バイト fixture による strip 仕様のロックは
`src/lib/__tests__/field-survey-exif-strip.test.ts`（utility）と
`src/lib/__tests__/field-survey-pin-photos-route.test.ts`（route 結合・422 副作用なし・監査 detail）が担う。
PII 非保存 invariant ほかは [field-survey-photo-privacy-checklist.md](./field-survey-photo-privacy-checklist.md)
末尾の「壊してはいけない既存テストロック」表を参照。

> 本チェックリストで NG が出た場合も、上記テストが green である限り「コード仕様は維持されている」前提で
> 環境・手順・端末側要因（HEIC 自動変換等）から先に疑うこと。
