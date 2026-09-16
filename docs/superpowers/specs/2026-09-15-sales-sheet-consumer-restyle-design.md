# 販売図面 消費者向けひな型(第①段: 見た目+書体)設計

2026-09-15。販売図面の新規作成ひな型を、消費者が読みやすい「整理型(案3)×紺」に作り替える。
関連: [[sales-sheet-consumer-restyle]](3案の見本・Web調査) / [[sales-sheet-three-column]](本段で廃止する3列) / [[sales-sheet-map-qr]] / [[sales-sheet-photo-pack]](モザイク)。
見本: https://claude.ai/code/artifact/732e18ab-be03-4dd5-9ecf-554d9848ffb5 (案3)

## 0. ひとことで

新しく作る販売図面を「紺の帯・左に写真と間取り図・右に価格と大きな表・線のない表・電話番号を大きく」に変え、PDFの字を編集画面と同じ BIZ UDPゴシックにそろえる。既存の図面の見た目は変えない。

## 1. 全体の段取り(発注者承認 2026-09-15)

| 段 | 内容 | 本書の範囲 |
|---|---|---|
| **①** | 見た目(案3×紺・罫線なし・文字サイズ)+書体 | **本書** |
| ② | 写真: 手で変えた大きさを守る+主役を選ぶ | 別の仕様書 |
| ③ | 規約の必須項目(公正取引協議会加盟・情報公開日・次回更新予定日・有効期限) | 別の仕様書(会社設定に列追加=migration) |
| F3 | 物件に販売用の欄 | 別の仕様書(migration) |

## 2. 発注者の決定事項(2026-09-14〜15)

1. 形=**案3 整理型**(最初の並び。あとで自由に動かせる前提)。
2. 色=**端正(紺系)**。
3. **罫線は使わない**。区切りは項目名の色・1行おきの淡い色・間隔だけ。**余白を詰めて中身を大きく**(2026-09-14 指摘)。
4. 間取り図・敷地図は**写真の仲間として左に置く**。
5. 7月の**3列(中央に間取り図)の動きは全面廃止**(本番の図面2件はどちらも間取り図・写真なし=実害なし・2026-09-15 実測)。
6. 設計その1(紙面の中身と置き場所)・設計その2(仕組みと確認のしかた)を承認。

## 3. 紙面(A4横 297×210mm)

```
y=0   ┌──────────────── キャッチ帯(紺・全幅・h16) ────────────────┐
      │ キャッチコピー(白16pt太)                         物件種目(白) │
y=19.5├──────────────────────────┬─────────────────────────────┤
      │ 写真ゾーン x7 w124         │ 右列 x136 w154                │
      │ (写真+間取り図・モザイク)   │  物件名 14pt 紺               │
      │                          │  価格 32pt 赤                 │
      │                          │  主要表 12pt(8行・1行おき淡紺)│
      │                          │  詳細表 10pt ×2列(線なし)     │
y=167.5├──────────────────────────┴─────────────────────────────┤
y=170 │ おすすめポイント ◆… ◆… ◆…(淡紺の帯 x7 w283 h12・10.5pt太) │
y=185 ├──────────────────────────────────────────────────────────┤
      │ 会社ブロック │ 取引6項目(表2つ) │ 電話 19pt │ 地図QR枠 │
y=210 └──────────────────────────────────────────────────────────┘
```

- 文字の外側余白は左右7mm。キャッチ帯の塗りだけ紙の端まで(家庭用プリンタで端が白く欠けても文字は欠けない)。
- 座標は `layout-engine.ts` の新しい定数に集約し、ビルダーとエディタの両方が同じ値を使う(二重定義しない)。

### 3.1 色と文字

| 用途 | 値 |
|---|---|
| 基本色(帯・項目名・物件名・電話) | 紺 `#1f3a5f` |
| 価格 | 赤 `#b7281e` |
| 1行おきの色・ポイント帯 | 淡紺 `#eef2f7` |
| 本文 | `#1a1a1a` / 補足 `#555555` |
| 書体 | `"BIZ UDPGothic","Yu Gothic UI","Meiryo",sans-serif`(全要素共通・明朝見出しは使わない) |

| 部品 | 文字 | 縮小の下限 |
|---|---|---|
| キャッチコピー | 16pt 太 | ― |
| 物件名 | 14pt 太 | ― |
| 価格 | 32pt 太 | ― |
| 主要表 | 12pt | **11pt** |
| 詳細表 | 10pt | **8pt** |
| ポイント帯 | 10.5pt 太 | ― |
| 電話番号 | 19pt 太 | ― |

## 4. 単位ごとの設計

### 4.1 表の見た目の指定(document-schema / 両レンダラ)

`tableElementSchema.style` に**任意の3項目**を追加する(すべて optional=既存図面はそのまま通る)。

| 項目 | 型 | 未指定時 |
|---|---|---|
| `borderless` | boolean | false(今どおり `0.2mm solid borderColor`) |
| `stripeColor` | CSS色(`isCssColor` 検証) | なし |
| `cellPaddingMm` | 0以上の数 | `0.5mm 1mm`(今どおり) |

- `borderless:true` のとき td の border を出さない。`stripeColor` は偶数行(2,4,…行目)の td 背景。`cellPaddingMm` は上下=値・左右=値×1.2。
- **`render-html.ts` と `SalesSheetRenderer.tsx` を同時に改修**し、`render-html-parity.test.ts` に「線なし・1行おき色の表」を含む文書で両レンダラが同じ信号(背景色・border無し)を出すことを追加。
- 色は既存の `sanitizeCssValue` を通す(`url(` 等を拒否する既存テストに `stripeColor` の拒否ケースを追加)。

### 4.2 ひな型の目印(document-schema)

`themeSchema` に任意の `template?: "consumer-2026-09"` を追加する。

- 新ビルダーは必ず付ける。**付いていない図面=旧ひな型**。
- 旧ひな型では次の3つの自動機能を**使えなくする**(ボタンを無効化+「新しいひな型で作り直すと使えます」の説明)。手での移動・大きさ変更・文字編集・PDF出力は今どおり使える。
  - 「写真を自動整列」「レイアウト自動調整」
  - 写真追加時の自動整列(旧ひな型では追加するだけで並べ直さない)
  - 「間取り図にする/写真に戻す」の後の並べ直し(ボタン自体は使えるが並べ直さない)
  - 取引情報パネルの帯の再生成(既存の `canEditTransactionInfo` 無効化と同じ出し方)
- 理由: 旧ひな型は部品の組み合わせ(表1枚・種目タグなし)が新しい計算と合わず、並べ直すと崩れる。本番の旧図面は2件のみ(写真0・間取り図0・最終更新 2026-07-12)。

### 4.3 主要表と詳細表の行(新規 `sheet-rows` 関数)

`buildSheetRows` は項目名(label)しか返さないため、**項目キーで振り分ける純関数**を追加する。

```ts
splitMainDetailRows(kind, fields, values): { main: Row[]; detail: Row[] }
```

**主要8行(種別ごとに固定・この順)**

| 種別 | 主要8行(項目名 ← 項目キー) |
|---|---|
| 戸建 | 交通←access / 間取り←layout / 土地面積←landArea / 建物面積←buildingArea / 築年月←builtYearMonth / 構造・階数←structure+aboveFloors / 駐車場←parking / 現況・引渡←occupancy+delivery |
| 区分 | 交通←access / 間取り←layout / 専有面積←exclusiveArea / バルコニー←balconyArea+balconyDir / 築年月←builtYearMonth / 所在階・階数←floorNo+totalFloors / 管理費・修繕積立金←managementFee+repairFee / 現況・引渡←occupancy+delivery |
| 一棟 | 交通←access / 想定利回り←grossYield / 満室想定収入←expectedIncome / 総戸数←totalUnits / 土地面積←landArea / 延床面積←totalFloorArea / 築年月←builtYearMonth / 構造・階数←structure+aboveFloors |
| 土地 | 交通←access / 土地面積←landArea / 坪単価←unitPrice / 用途地域←useDistrict / 建蔽率・容積率←coverageRatio+floorRatio / 接道←roadDirections+roadKind+roadWidth / 地目←landCategory / 現況・引渡←occupancy+delivery |

- 2つ以上のキーをまとめる行は、値がある方だけを「 / 」でつなぐ(両方空なら空)。単位付けは既存 `formatValue` と同じ規則(二重付与しない)。
- **主要表は8行とも常に出す**(空でも行を残す=作成後に編集画面で埋められる)。

**詳細表**

- 上記以外の表示項目を field-model の順で並べる。ただし次は**詳細に出さない**(ほかの場所に出るため): 価格・物件種目・建物名称・取引6項目(取引態様/広告/報酬/担当者/取引士/特記事項)。
- 🆕**値が空の行は出さない**(消費者に空欄を見せない)。
- 🆕**つながりのある項目は1行にまとめる**: 建蔽率/容積率・接道(種別/幅員/方向)・各階面積(1階/2階/3階)・セットバック(値+単位)。
- 2列に分ける: 前半を左の表、後半を右の表(行数が奇数なら左が1行多い)。

> 🆕印の2点は仕様書作成時に判明した必要事項(戸建の詳細は約26行あり、8ptでも2列で約23行しか入らない)。

### 4.4 レイアウト計算(`layout-engine.ts`)

`computeSpecSheetLayout` を新しい紙面に置き換える(純関数・決定的)。

- 入力: `mainRowCount`(=8)・`detailRowCount`・`footerHeight`。**`hasFloorPlan` と `photoCount` による左右の揺れは廃止**(写真ゾーンは常に x7 w124)。
- 出力: `catchBand` / `catchCopy` / `kindTag`(新) / `heading` / `price` / `mainTable` / `detailTableLeft` / `detailTableRight` / `salesPoints` / `footer` / `photoZone` / `mapQrSlot`(新) / 各表の文字サイズ。
- 文字サイズ: 主要表は12pt から、詳細表は10pt から、**枠に入る最大の大きさ**を 0.5pt 刻みで選ぶ(行高=文字×1.35+上下余白で見積もり)。下限(主要11pt・詳細8pt)で入らない場合は下限の値を返し、`overflow:true` を付ける。
- 主要表と詳細表の境目は、主要表の必要高さで決める(主要表が縮めば詳細表が広がる)。
- **削除**: `FLOOR_PLAN_MIDDLE_X_MM`・`SPLIT_X_*`・`OVERVIEW_*` の3列/右1/3前提の定数、`floorPlan` 出力。`packPhotoCells` は作成時の初期並び用に残す。

### 4.5 作成(`build-document.ts` / `buildSpecSheetDocument`)

- 要素構成を §3 に置き換える。id: `catch-band` / `catch-copy` / `kind-tag`(新) / `heading` / `price` / `overview`(=主要表・既存 id を流用) / `overview-detail-a`・`overview-detail-b`(新) / `sales-points` / 会社帯(`footer-*`) / 写真 / `floor-plan`。
- 表は `borderless:true`・主要表だけ `stripeColor:#eef2f7`・`cellPaddingMm` は主要1.2/詳細0.8。
- ポイントは淡紺の帯(shape `sales-points-band` 新)の上に「おすすめポイント　◆…　◆…　◆…」(最大3つ・4つ目以降は出さない)。
- 間取り図があれば `floor-plan` を写真ゾーンの**仲間**として置く(作成時は写真+間取り図をまとめて `packPhotoCells` で初期配置。間取り図は代表写真の次)。
- 写真は最大3枚(今どおり)+間取り図1枚。
- `theme = { fontFamily: 新書体, accentColor: 紺, template: "consumer-2026-09" }`。
- 各種別ビルダー(区分/土地/戸建/一棟)は `splitMainDetailRows` の結果を渡すだけに変える(値の組み立ては不変)。

### 4.6 会社帯(`footer-band.ts`)

- 帯の外枠 `footer-band` は残す(取引情報パネルが帯の位置を復元するのに使う)が、**塗りは白・線なし**。縦の区切り線(`footer-divider-*`)は作らない。
- 横の配分(x7〜290): 会社ブロック 105mm / 取引6項目 75mm(表2つ横並び・各3行・7.5pt・線なし) / 電話ブロック 72mm / 地図QR枠 22mm(残りは間隔)。
- 会社ブロック: 社名10pt太紺 / 免許・所在地・TEL FAX・Email・HP を7pt。**最下行は③の規約行のために空けておく**(①では何も置かない)。
- 電話ブロック: 「内覧のご希望・ご質問はお電話で」8pt太紺 / 電話番号(会社TEL)19pt太紺 / 右寄せ。
- `footer-terms-table` / `footer-staff-table` の id と行ラベルは維持(`readFooterData` / `editFooterData` の互換)。担当の表は今どおり値があるときだけ出す。
- `footerColumnGeometry` は新ひな型用の配分に変える。旧ひな型では §4.2 のとおり再生成を無効化するので、旧配分は持たない。

### 4.7 3列の廃止(`editor-document.ts` / `SalesSheetEditor.tsx` / `ElementPanel.tsx`)

- `autoArrangePhotos`: 写真ゾーン=`photoZone`(x7 y19.5 w124 h148)固定。**`floor-plan` も整列対象に含める**(`TEMPLATE_ELEMENT_IDS` から外す)。概要表の右1/3スナップは廃止。並び順は配列順(今どおり)で、間取り図は特別扱いしない。
- `autoBalanceLayout`: テンプレ枠を新しい計算結果へ戻す+写真ゾーンのモザイク。中央列の処理を削除。
- `setAsFloorPlan` / `unsetFloorPlan`: id の付け替え(常に1枚)だけを行い、位置は写真ゾーンの並べ直しに任せる。`defaultFloorPlanRect` と中央列の幅ドラッグ時の再配置(`reflowPhotosForFloorPlan`・`commitFloorPlanGeometry`)は削除。
- 地図QR: `positionMapQr` は**会社帯右端の `mapQrSlot` に置くだけ**に単純化(間取り図の縮小・写真ゾーン下端の予約・削除時の高さ復元をすべて削除)。
- `cachedGalleryAspects` による同期処理は、写真追加・自動整列でも使える形のまま残す(②で使う)。

### 4.8 入りきらない警告(編集画面のみ)

- 編集画面で `overview` / `overview-detail-a` / `overview-detail-b` の描画後、中身の高さが枠を超えていたら、ツールバー付近に「表の文字が入りきっていません(項目を減らすか、枠を広げてください)」を出す。
- PDF/画像には何も出さない。保存も止めない。

### 4.9 書体(サーバー)

- 本番(Ubuntu 24.04)に公式パッケージ `fonts-morisawa-bizud-gothic` を導入する(`apt install` → `fc-cache`)。**本番反映のときに別途承認を得てから行う**。
- 導入確認: `fc-match "BIZ UDPGothic"` が BIZ UDPGothic を返すこと。
- 未導入でも書体指定の2番目以降で描画されるため、PDF出力は失敗しない(字が違うだけ)。
- アプリに書体ファイルは同梱しない。

## 5. 変えないもの

- 既存図面(`theme.template` なし)の見た目と保存内容。
- 作成ダイアログの入力項目と値の組み立て、取引情報パネルの入力項目。
- QRの中身(物件住所の Google マップ検索)と生成方法。
- データベース(migration なし)・API・権限。

## 6. テスト

- **レイアウト**: 4種別 × 写真0/1/3枚 × 間取り図あり/なし × 詳細行 0/12/26 の全組合せで、(a)部品同士が重ならない (b)すべて紙の内側 (c)w/h が正 (d)表の文字が下限以上 (e)下限で入らないときだけ `overflow:true`。
- **行の振り分け**: 種別ごとに主要8行の順番・まとめ行の連結・空行の除外・詳細に出さない項目・2列の分け方。
- **表の指定**: 両レンダラの出力比較(parity)・不正な色の拒否・未指定時は今と同じ出力(既存テストを変更せずに通る)。
- **旧ひな型**: `template` なしの文書で3つの自動機能が何も変えない(同一参照)・ボタンが無効。
- **3列廃止**: `floor-plan` が写真ゾーン内に並ぶ・地図QRが `mapQrSlot` に置かれる。既存の3列前提テスト(editor-document-floor-plan / map-qr / spec-sheet-document / layout-engine / editor-document-autolayout / autobalance / build-mansion・house・building / editor-toolbar)は新仕様に書き換える。
- **目視**: 4種別の実寸PNGを Playwright で描き、見本(案3)と並べて確認し、発注者に提示する。
- **全体**: フル `npx vitest run`・`tsc`・eslint・`npm run build`。

## 7. 本番反映

- コードのみ(migration・依存・env なし)+**書体パッケージの導入(サーバー変更=別承認)**。
- 反映後の実機確認: 新しい図面を1枚作る → 見た目(紺・線なし・文字サイズ) → PDFの字が BIZ UDPゴシック → 写真と間取り図を足して自動整列 → 地図QRが会社帯右端。

## 8. リスクと対策

| リスク | 対策 |
|---|---|
| 詳細の項目が多い物件で表があふれる | 空行を出さない+まとめ行+8ptまで縮小+編集画面の警告 |
| 旧図面で自動機能を押して崩れる | 旧ひな型では無効化(§4.2) |
| 書体未導入のままPDFを出す | 書体指定の予備で描画は継続・反映手順に `fc-match` 確認を入れる |
| 3列廃止の削除漏れで古い計算が残る | 削除する定数・関数を §4.4/§4.7 に列挙し、grep で残存ゼロを確認 |
