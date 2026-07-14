# 販売図面「取引情報」パネル 設計

## 背景 / 目的

販売図面(自社マイソク様式)の下部会社帯(`buildFooterBand`)は「会社ブロック / 取引条件テーブル / 担当テーブル」の3部構成。このうち **物件ごとに変わる6項目**——取引態様・広告・報酬・担当者・取引士・特記事項(=`FooterBandData`)——を、作成後も含めて分かりやすく編集できる専用UIを設ける。

会社ブロック(社名 / 免許 / 所在地 / TEL / FAX / Email / HP)は別途「会社情報設定」で管理する company 情報であり、**本機能の対象外**。

### 現状の課題
- 6項目は作成ダイアログの「会社」セクションで入力可能だが、価格→所在→土地→建物→設備…と続く長いフォームの最後尾にあり気づきにくい・入れづらい。
- 作成後の再編集は、帯の table 要素を canvas で直接選択してセルを編集する必要があり分かりにくい。さらに `pickRows` により**作成時に空だった行は落ち**、担当/取引士/特記事項が全空なら **担当テーブルごと省略**されるため、後から足せない穴がある。

## スコープ

### やること
- 販売図面エディタに「取引情報」編集UI(ツールバーボタン → モーダル)を追加。6項目のみ。
- 編集内容を帯の「取引条件テーブル / 担当テーブル(+担当区切り線)」へ即時反映。空→入力で行/表が復活、入力→空で消える(既存 `pickRows`/`hasStaff` 規約どおり)。
- 作成時・作成後のどちらでも同じUIで編集可能。

### やらないこと(out of scope)
- 会社ブロック(社名/免許/所在地/連絡先)の編集(= 会社情報設定の領分)。
- 新しい element 種別の追加(= 二重レンダラ `SalesSheetRenderer.tsx` / `render-html.ts` 無改修)。
- document スキーマ / DB スキーマの変更(帯要素を唯一の正のまま扱う)。
- 取引テーブルの手動微調整位置の永続保持(後述「割り切り」)。

## 設計

### データの持ち方(唯一の正 = 帯要素)
6項目の値は document の帯要素(`footer-terms-table` / `footer-staff-table` の行)に既に埋め込まれている。本機能は**別途の保存領域を設けず、帯要素を唯一の正**として扱う(スキーマ変更なし・二重ソース回避):

1. **パネルを開く時**: 既存の帯テーブルから現在の6値を読み出す純関数 `readFooterData(elements): FooterBandData`(ラベル一致で terms/staff 各行 → 値を復元。欠け・省略は空)。
2. **適用する時**: パネルが保持する6値(メモリ)から帯の取引部分を再生成し、document の該当要素を差し替える。

### 取引部分の再生成(footer-band.ts のリファクタ)
`footer-band.ts` の「取引条件/担当テーブル(+担当区切り線)を組む部分」を純関数として切り出す:

```
export function buildFooterTransactionElements(footer: Rect, data: FooterBandData): SalesSheetElement[]
```

- 返す要素は `footer-terms-table` / `footer-divider-staff` / `footer-staff-table`(値により省略あり)。
- `buildFooterBand` はこれを内部で呼ぶ(**作成時と編集時で同一のレイアウト計算を共有**し、見た目のズレを防ぐ)。会社ブロック・帯外枠・「会社|取引」区切り線は対象外(不変)。
- 行ラベル(取引態様/広告/報酬/担当/取引士/特記事項)は共有定数に集約し、`buildFooterTransactionElements`(生成)と `readFooterData`(復元)が同じ定義を参照する(ラベル変更でのズレ防止)。

### 編集時の帯 Rect 復元
再生成には帯領域の矩形が要る。既存の帯外枠要素 `footer-band`(id 固定)の `{x,y,w,h}` から復元する(= ユーザーが帯ごと移動していればその位置に追随)。`footer-band` が見つからない場合は degrade(下記エッジケース)。

### エディタ結線(reducer アクション)
`editor-document.ts` に純粋 reducer アクション追加:

```
editFooterData(state: EditorState, data: FooterBandData): EditorState
```

- `footer-band` から Rect を復元 → `buildFooterTransactionElements(rect, data)` で新しい取引要素を生成。
- `document.elements` から id が `footer-terms-table` / `footer-staff-table` / `footer-divider-staff` の要素を除去し、新要素を追加。
- editor-document.ts の **no-op 規約(同一参照 / 変更時のみ新参照 + dirty)** に従い、生成結果が現状と同一なら同一参照を返す。

### UI
- `EditorToolbar` に「取引情報」ボタン追加(`onOpenTransactionInfo`)。
- 新コンポーネント `TransactionInfoDialog`(制御コンポーネント): 6項目のフォーム。ウィジェット/選択肢は `field-model` / `option-master` と揃える(取引態様 = select `TRANSACTION_TYPE`、広告 = select `AD_TYPE`、報酬 = combo `COMPENSATION`、担当者/取引士/特記事項 = text)。
- 初期値は開いた時点の `readFooterData(document.elements)` 由来。**「適用」で1回だけ** `editFooterData` を dispatch(モーダル・作成ダイアログと同じ操作感)。
- `SalesSheetEditor` がダイアログ開閉 state と dispatch を保持。

### エラー処理 / エッジケース
- **`footer-band` 要素が無い**(ユーザーが削除した等): 帯 Rect を復元できないため再生成は行わず **no-op**(防御・クラッシュさせない)。実運用の生成済みシートでは `footer-band` は常在するため通常経路に影響なし。パネルは「取引情報」ボタンから開くが、帯が壊れている図面では反映されない旨を UI で案内してもよい(実装時判断)。
- **空値**: `pickRows`/`hasStaff` の既存規約どおり行/表を省略(現状と同挙動)。
- **幾何**: `buildFooterTransactionElements` は既存 `clampRect`/`MIN_DIM_MM` を流用し、w/h 正数(document-schema 準拠・保存 422 回避)を保証。

### 割り切り(既知の制約)
値を適用するたび取引2テーブルは帯内の**既定位置へ再配置**される(手動で微調整した位置は戻る)。会社ブロック・写真・他要素は不変。実運用で取引テーブルを個別に動かす需要は低いと判断。

## テスト方針
- `readFooterData`: terms/staff 完備・一部欠け・全空・staff テーブル省略 の各ケースで正しい6値を復元。
- `buildFooterTransactionElements`: 座標(帯 Rect 由来)、空値の行/表省略、既存 `footer-band.test` の期待(`buildFooterBand` 出力)と parity。
- `editFooterData` reducer: 空→入力で表復活・入力→空で消滅・no-op で同一参照・dirty 遷移。
- `TransactionInfoDialog`: SSR 構造(6項目・widget 種別)を `renderToStaticMarkup` + 文字列 assert。env=node 制約によりクリック/state 遷移は自明変更 + レビューで担保。
- 提出条件: フル `npx vitest run` 緑 / `tsc --noEmit` 0 / eslint(変更分)0 / `npm run build` 成功。

## 位置づけ / 依存
- 現在の main(`fb81188`)を土台とする**新機能・新PR**。「会社情報設定」PR とは独立(`footer-band.ts` に軽微な merge タッチポイントの可能性 —— 会社ブロック改修 vs 取引テーブル切り出しで別領域のため小)。
- **新規依存なし・migration なし・schema 変更なし。**
