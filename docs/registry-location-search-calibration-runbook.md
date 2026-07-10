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

実サイトの所在検索画面を開き、下記 `TODO(calibrate)` の CSS セレクタを **実要素に差し替える**:

- `locationSearchAddress` … 所在(住所)入力欄
- `locationSearchLot` … 地番入力欄
- `locationSearchBuilding` … 家屋番号入力欄
- `locationSearchSubmit` … 検索実行ボタン
- `locationSearchResult` … 検索結果コンテナ(候補0件でも表示される要素)
- `locationSearchRow` … 各候補行

さらに `searchByLocation` 内の `$$eval` 抽出関数の行内セレクタ(`[data-ref]` / `.address` /
`.lot` / `.building` / `.ren`)を、実サイトの1行の中の各セル要素へ差し替える。

自動取得(不動産番号)側の login / search / download セレクタが未校正なら、併せて校正する
(所在検索は login を共有する)。

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
