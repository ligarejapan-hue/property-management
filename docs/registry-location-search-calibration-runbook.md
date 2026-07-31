# 所在検索エンジン 校正手順書(フェーズ3)

本アプリ内蔵の所在検索(登記情報提供サービスを自動操作して所在/地番/家屋番号で候補検索)を
**有効化するための手順**。実サイトを見られる担当者向け。

> ⚠ **本番は既定で休眠(501)**。この手順を実施し `REGISTRY_FETCH_LOCATION_SEARCH_CALIBRATED=true`
> を設定するまで、所在検索は一切外部アクセスしない(挙動不変)。
>
> ⚠ **利用約款を順守すること**(第12条の2: 過度な検索を避ける=レート制御 1件/分・第4条: ID責任)。
> 既存の外部ソフト「不動産登記情報自動化システム」の selenium フローが実サイトの画面遷移・入力欄の
> 参照になる。

## 1. セレクタ校正(`src/lib/registry-fetch/auto-fetch.ts` の `REGISTRY_SELECTORS`)

> **2026-07-14 更新**: 御社が保存した実画面HTML(ログイン/不動産請求/不動産一覧)から
> 主要セレクタを**確定済み**([確定])。残るは実サイト実行でのみ確定する動的部分([要live])のみ。
> 詳細な設計資料 = `deliverables/registry-calibration/selector-map-20260714.md`。

**[確定](差し替え不要・実要素で確認済み)**: login=`#userId`/`#password`/`button.CForwardLong`・
ログイン後の目印=`form[name=logoutForm]`・所在検索の 請求方法ラジオ `#fuSeikyuMethodSHOZAI`・
種別 `#fuShozaiTypeTOCHI`/`#fuShozaiTypeTATEMONO`・都道府県 `#fuTodofukenShozai`・
直接入力 `#fuShozaiChokusetuNyuryoku`・所在 `#fuChibanKuiki`・地番家屋 `#fuChibanKaoku`・
結果テーブル `#fudosanIchiranTbl`。

**[要live](実サイトで動かして確定)**:
- `locationSearchSubmit`(次へ/請求リストへ進むボタン)… 候補の暫定値は `#myPageTable_next`。実操作で確定。
- `locationSearchRow` の**行内セル**(`$$eval` の `.address`/`.lot`/`.building`/`.ren`)…
  一覧テーブルの実際の列(td)構造に合わせる。
- 都道府県 `selectOption` に渡す**実 option 値/ラベルの一致**(`splitAddressForLocationSearch` が
  返す "東京都" 等がそのまま option value か、ラベル一致指定が要るか)。
- 直接入力モードで**市区町村ダイアログを完全に回避できるか**(できなければダイアログ操作を追加)。
- 番号取得側の `searchInput`(不動産番号入力欄)
  (請求方法=不動産番号 `#fuSeikyuMethodFUDOSAN_NO` は[確定])。
  ⚠**2026-07-31 更新**: 旧記載の `searchSubmit`/`downloadButton` は要校正ではなくなった。
  - `searchSubmit` は**廃止**。旧値 `#myPageSeikyu` は実体が**マイページ一覧の課金ボタン**で
    役割を取り違えていた。請求条件の送信は id 無しの「確定」で、
    現在は段階②専用の `requestConfirmButton`(`button[onclick*="fuBtnForward"]`)。
  - `downloadButton` は**確定値**に是正済み(`button[onclick*="myPageDownload"]`)。
    旧値 `#download-pdf` は**実サイトに存在しなかった**。
  ⚠**番号取得の経路は段階②(請求→PDF)が配線されるまで fail-closed**。
    「確定」は無料でも**カートに `未請求` の行を実際に作る**ため、通せないうちに押すと
    失敗のたびに御社のマイページへゴミ行が積み上がる。実装は
    `searchByRealEstateNumber` がページに触れる前に停止する形にしてある。
  詳細= `deliverables/registry-calibration/stage2-flow-20260731.md`

差し替えたら `splitAddressForLocationSearch`/`extractLocationCandidateRows` の
既存テスト(`playwright-adapter.test.ts`)が緑のままか確認する。

## 2. 有効化フラグ(`app.env` / 環境変数)

すべて設定して初めて所在検索が動く(**二重ゲート**):

```
# 資格情報(env で直接、または管理画面 /admin/registry-settings で暗号化保存)
REGISTRY_FETCH_LOGIN_ID=<利用者識別番号>
REGISTRY_FETCH_PASSWORD=<パスワード>
# 自動取得系セレクタの校正済み宣言
REGISTRY_FETCH_PROVIDER=official
REGISTRY_FETCH_SELECTORS_CALIBRATED=true
# ★所在検索セレクタの校正済み宣言(所在検索を露出させる専用フラグ)
REGISTRY_FETCH_LOCATION_SEARCH_CALIBRATED=true
```

`REGISTRY_FETCH_LOCATION_SEARCH_CALIBRATED` は自動取得の `SELECTORS_CALIBRATED` とは**独立**。
番号取得だけ有効化したい場合は本フラグを立てない(所在検索は 501 のまま=誤露出防止)。

## 3. 検証(本番投入前)

- テスト物件1件の所在で検索 → 候補が返るか(0件でも 500 でなく空で返るか)。
- レート: 連続検索が 1件/分に制御されているか(2回目が `rate_limited`)。
- **秘匿情報**(所在・地番・不動産番号・資格情報)がログ / 監査 / エラー応答に**出ていない**か。

## 4. ロールバック

- `REGISTRY_FETCH_LOCATION_SEARCH_CALIBRATED` を外して再起動 → 所在検索は 501 休眠に戻る
  (コード変更・再ビルド不要)。
