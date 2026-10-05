# 売却DMの手紙にイラストを1枚入れる(DMの種類ごと) 設計

- 日付: 2026-10-05
- 発注者の決定:
  - 写真枠に入れるのは **イラスト**。作り方は **外部AIで作って貼る**(LPの写真と同じライブラリ)。(2026-10-02)
  - 置き場所は **文面を作る外部AIが手紙ごとに決める**。本文に【イラスト】と1行書いた所に入る。(2026-10-05)
  - 説明ページ https://claude.ai/artifact/Gn566iiNPKNtq8g9GqpZEw の内容で **「ok。進めて」**。(2026-10-05)
- 「相続の印」は「DMの種類」で済んでいる扱い(受付帳=自動で相続・物件の欄で直せる)。本設計の対象外。

## 1. 目的と成功の条件

売却DMの手紙に、DMの種類(相続・空き家など)に合ったイラストを1枚入れて、開いた人に読んでもらいやすくする。

成功の条件:
1. 管理者が「DMの種類」の画面で、種類ごとに1枚、LPの写真ライブラリからイラストを選べる/外せる。
2. 種類で作った発送を印刷すると、本文の最初の【イラスト】の行にイラストが入る。印が無ければ本文の上に入る。
3. 【イラスト】の文字そのものは、どの場合も紙に出ない。
4. 使っているイラストはライブラリから消せない。印刷時に `/lp-assets/` が 404 にならない。
5. 発送を作った後で台帳のイラストを替えても、作成済みの発送の手紙は変わらない。

## 2. 範囲

対象: 「DMの種類」で作った発送(`dm_variants.scenario_id` あり)。

対象外:
- 「種類を使わない(今までどおり)」の発送(型A/B)。イラストの欄を持たない。
- イラスト専用の「画像の指示文」ボタン(LPの写真の枠にあるもので代用)。
- 「DMの種類」の画面での手紙の見本(今も無い)。手紙の見本はキャンペーン画面の既存の見本に出る。
- 本文が長いときに紙1枚へ収める仕組み(今も無い。イラストは高さの上限で抑える)。

## 3. データ(migration 1本・追加のみ)

```sql
ALTER TABLE dm_scenarios ADD COLUMN letter_illustration_asset_id UUID NULL
  REFERENCES dm_lp_assets(id) ON DELETE RESTRICT;
CREATE INDEX dm_scenarios_letter_illustration_asset_id_idx ON dm_scenarios(letter_illustration_asset_id);

ALTER TABLE dm_variants ADD COLUMN illustration_asset_id UUID NULL
  REFERENCES dm_lp_assets(id) ON DELETE RESTRICT;
CREATE INDEX dm_variants_illustration_asset_id_idx ON dm_variants(illustration_asset_id);
```

Prisma:
- `DmScenario.letterIllustrationAssetId` と `letterIllustrationAsset DmLpAsset?`。
- `DmVariant.illustrationAssetId` と `illustrationAsset DmLpAsset?`。
- `DmLpAsset` に逆向きの relation 2本(`scenarioLetterIllustrations`、`variantIllustrations`)。

既存行はすべて NULL(=今の見た目)。本番の行数は少ない(キャンペーン5)。索引はテーブルが小さいので通常の CREATE INDEX でよい。

## 4. 「使用中」の数え方(asset-references.ts)

写真の削除は論理削除なので、FK の RESTRICT では守れない。数える場所は今と同じく `src/lib/sale-dm-letter/asset-references.ts` だけ。

- `ASSET_REFERENCE_COUNT_SELECT` に次の2つを足す。
  - `scenarioLetterIllustrations: { where: { deletedAt: null } }`
  - `variantIllustrations: true`
- `isAssetReferenced` は4つの合計 > 0 で判定する。
- `countAssetReferences` も4つを数える(`tx` の型に `dmScenario`・`dmVariant` を足す)。
- これで次の4か所が同時に正しくなる。
  - 削除(409 `REFERENCED`)
  - 公開口 `/lp-assets/[publicId]`(使用中だけ返す=印刷で 404 にならない)
  - 一覧の `referenced`
  - LPの写真画面のボタン
- ライブラリ画面の削除ボタンの説明文「LPまたはDMの種類で使われています」は、そのままで意味が通る(手紙もDMの種類の一部)。

## 5. 台帳でイラストを選ぶ・外す

### API: `PUT /api/properties/sale-dm/scenarios/[id]/letter-illustration`

- 本文: `{ assetId: string | null }`
- 権限: 既存の台帳の写真と図の保存(`scenarios/[id]/media` PUT)と同じ。管理者のみ。
- トランザクションの順番(media PUT と同じロック順):
  1. 台帳行を FOR UPDATE(削除済みなら 404)
  2. `assetId` があれば、その写真行を FOR UPDATE する。見つからない・削除済みなら 400 `ASSET_NOT_FOUND`。
     - 写真の削除経路も写真行を FOR UPDATE してから数えるので、「選ぶ」と「消す」がすれ違わない。
  3. 値が同じなら何もせず 200
  4. 更新
  5. `writeAuditLog`(action `sale_dm_scenario_letter_illustration_update`・detail は `{ hasIllustration: boolean }` だけ。`audit-log-detail-safety.ts` の allowlist に登録)
- 返す値: `{ letterIllustrationAssetId: string | null; letterIllustration: { src, width, height } | null }`(src は `/lp-assets/<publicId>`=描画にそのまま使える形)

### 取得

台帳の詳細(`GET scenarios/[id]`)に `letterIllustration: { src, width, height } | null` を足す(`letterIllustrationAssetId` は列のまま返る)。削除済みの写真は null として返す。

### 画面: `admin/dm-scenarios/[id]`

手紙の文面エディタの下に「手紙のイラスト」の枠を置く。
- 選んだ画像の小さな見本
- 「イラストを選ぶ…」ボタン。既存の LPの写真ライブラリ(`lp-asset-library.tsx`)を選択モードで開く(貼り付け・ファイル選択での追加もそのまま使える)。
- 「外す」ボタン
- 説明1行: 「手紙の本文の【イラスト】の行に入ります(無ければ本文の上)。横長(約3:1)がおすすめです」
- 失敗時は理由を赤字で出す(既存の写真と図の枠と同じ)。

### 台帳の種類の設定を変えたとき

語調などを変えると、手紙の文面は消える(既存)。イラストは消さない(文面と独立)。

## 6. 指示文(外部AIへの文)

- `buildExternalPrompt(options, { illustrationMarker?: boolean })` に引数を足す。true のとき【必ず守ること】に1行足す。
  > 手紙の中でイラストを入れるとよい場所に、【イラスト】とだけ書いた行を1行入れてください。場所は文章の流れに合わせて選んでください。
- true にする呼び出し:
  - 台帳 `scenarios/[id]/prompt` と `scenarios/[id]/template`(digest の再計算)
  - キャンペーン側 `variants/[variantId]/prompt` と `.../template`。こちらは **variant.scenarioId があるときだけ** true。
- 呼び出しの「表示」と「保存時の digest 再計算」で同じ値を渡す。食い違うと必ず `PROMPT_STALE` になる(テストで固定)。
- 型A/Bの指示文は変えない(digest も変わらない)。
- 台帳の指示文の digest は変わる。すでに文面を貼った種類は、次に貼り直すとき一度だけ「指示文をコピーし直してください」と出る。保存済みの文面は変わらず、印が無いので本文の上にイラストが入る。

文面の検査(`validateLetterBody`)は変えない。【イラスト】は `{` `}` を含まないので今も通る。【イラスト】の数も制限しない(2つ目以降は描画で消す)。

## 7. 発送を作るときの写し取り(scenario-copy.ts)

- `SCENARIO_FULL_SELECT` / `ScenarioFull` / `LETTER_COPY_MAP` に `letterIllustrationAssetId` → `illustrationAssetId` を足す。
- 写真の ID はそのまま写す(LPの写真と図の写しと同じ扱い)。台帳が参照している間は写真を消せないので通常は起きないが、削除済みなら描画側(§8 の `letterIllustrationFromAsset`)が隠す。
- 「種類を変える」(発送の画面で物件の種類を切り替え)も同じ写し取り関数を通る=新しい種類のイラストになる。既存の経路が `copyScenarioIntoCampaign` / variant の作り直しを使っていることを実装時に確かめ、別経路なら同じ列を足す。
- 作成後に台帳を替えても、variant の値は変わらない。

## 8. 描画(templates)

### 純関数: `placeIllustration(body: string)` → `{ before: string; after: string; hasMarker: boolean }`

- 場所: `src/lib/sale-dm-letter/illustration-marker.ts`
- 印の行の判定: 行全体が `^[\s　]*【イラスト】[\s　]*$`
- 最初の印の行で前後に分ける。印の行はすべて取り除く(2つ目以降も)。
- 印が無ければ `before = ""`、`after = body`、`hasMarker = false`。
- 改行は `\r\n` `\r` `\n` のどれでも扱う。

### `LetterRenderInput` に追加

`illustration?: { src: string; width: number; height: number } | null`

### `renderLetterHtml`

- `illustration` あり:
  1. `before` の本文
  2. `<div class="letter-illustration"><img …></div>`
  3. `after` の本文
- `illustration` なし: 印の行を取り除いた本文だけ(今と同じ見た目)。
- `<img>` の書き方:
  - `src`: エスケープ済み(`/lp-assets/<publicId>`。publicId は 32桁16進のみ受け付け、それ以外は描かない)
  - `alt=""`、`width` / `height` は実寸(読み込み前でも枠が確保される)
  - `decoding="sync"`、`loading="eager"`
- CSS:
  - `.letter-illustration { margin: 3mm 0; text-align: center; }`
  - `.letter-illustration img { display: block; width: 100%; height: auto; max-height: 55mm; object-fit: contain; }`
- 本文の HTML 化は今と同じ(1回だけエスケープ+`<br />`)。前後で分けたうえで、それぞれ同じ関数を通す。

### 印刷 route

- drafts の `include.variant` で `illustrationAsset: { select: { publicId, width, height, deletedAt } }` を読む。
- 削除済みでなければ `illustration` を渡す。
- 印刷ページは同じオリジンなので、相対パス `/lp-assets/<publicId>` で読める(公開口は使用中なら返す)。

### キャンペーン画面の見本

`[campaignId]/page.tsx` の見本は同じ `renderLetterHtml` を使う。
- キャンペーン取得 API の variant に `illustration`(publicId・width・height)を足す。
- 見本の入力にも渡す。

## 9. 失敗時のふるまい

| 場面 | ふるまい |
|---|---|
| 選ぼうとした写真が削除済み | 400 `ASSET_NOT_FOUND`「その写真は削除されています。選び直してください」 |
| 使用中の写真を削除 | 既存どおり 409 `REFERENCED` |
| 印刷時に写真が削除済み(参照があるので通常は起きない) | イラスト無しで描く(印の行は消す) |
| 画像の読み込みが印刷に間に合わない | 実寸の枠は確保されるので崩れない。案内は既存の「表示を確かめてから印刷」に任せる |
| 型A/Bの本文に【イラスト】が書かれていた | イラスト無しとして印の行を消す |

## 10. テスト(TDD)

- `illustration-marker.test.ts`(純関数)
  - 印あり/なし/2つ以上/前後の全角空白/行の途中の【イラスト】(行全体でなければ印ではない=残す)/CRLF
- `sale-dm-templates.test.ts`
  - イラストあり・印ありで、img が本文の間に1つだけ出る
  - 印なしで本文の上に出る
  - イラストなしで「【イラスト】」の文字が出ない
  - src のエスケープと、publicId が16進でなければ描かない
  - `max-height:55mm`
- `sale-dm-asset-references.test.ts`
  - 台帳の手紙イラスト・variant のイラストの参照で「使用中」になる
  - 削除済みの台帳の参照は数えない
  - 走査テスト(4か所が同じファイルを通る)を保つ
- letter-illustration route
  - 権限
  - ロック順(台帳→写真)
  - 削除済みの写真は 400
  - 同じ値は何もしない
  - 監査ログの detail に写真ID以外を出さない
- 指示文
  - `illustrationMarker` true のときだけ一文が入る
  - 台帳の prompt と template で digest が一致する
  - variant(scenarioId あり/なし)で prompt と template の digest が一致する
  - 型A/B の指示文が変わらない
- `sale-dm-scenario-copy.test.ts`
  - イラストが写る(未登録は NULL のまま。削除済みの写真の ID もそのまま写し、描画側が隠す=§7)
  - 作成後に台帳を替えても variant は変わらない
- `sale-dm-print-route.test.ts`
  - variant のイラストが letters に渡る
  - 削除済みは渡らない
- 既存のロック順の横断テスト(`sale-dm-lock-order-guard.test.ts`)に新 route を足す

## 11. 本番反映

- migration 1本(追加のみ)。反映は発注者の承認後、vps-deploy の手順で行う。
- 新しい依存・env はない。
- 反映後の実機確認(実機確認リストに追加):
  - 台帳で選ぶ/外す
  - 使用中は消せない
  - 種類で作った発送の印刷で、印の位置/本文の上に出る
  - 【イラスト】の文字が出ない
  - 型A/B は変わらない
  - 作成後に台帳を替えても作成済みは変わらない
