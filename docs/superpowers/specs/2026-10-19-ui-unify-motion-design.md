# UIの統一と「押した手応え」 設計書

- 日付: 2026-10-19
- 発注者の回答: 目的=押した手応え・見た目の統一・高級感/今っぽさ。動きの強さ=「2. 標準」。進め方=A(共通部品を育てて画面ごとに置き換える)。設計(下記1〜4)=OK
- 見本(触って比べたページ): https://claude.ai/artifact/59PcaQT8K5Y9Gy6ZArNLV3

## 0. いまの状態(2026-10-19 origin/main `4f23568b` で実測)

- 共通ボタン `src/components/ui/button.tsx` を使うのは29ファイル。手書きの `<button>` が541個
  - 内訳(多い順): 物件142・現地調査67・管理61・取り込み49・DM48・販売図面36・所有者36・棟28・反響25・その他
- 動きの指定はほぼ無い(`animate-spin` 135・`transition-colors` 49・ほか数か所)
- 主ボタンの色が混在(`bg-indigo-600` 99・`bg-blue-500` 44・`bg-green-500` 33 など)
- 角丸: `rounded-md` 635・`rounded-lg` 128・`rounded-full` 104・`rounded-xl` 5
- 共通部品の利用: 小窓 `modal-shell` 11・確認 `confirm-dialog` 11・タブ `tabs` 6・お知らせ `toast-stack` 2。手書きの全面覆い(`fixed inset-0`)が24ファイル

## 1. 動きと見た目の決まり(土台)

`src/app/globals.css` の `@theme` に置く(Tailwind v4 のトークン。tsx からは `duration-*`/`ease-*`/`shadow-*`/`rounded-*` で使える):

| 決まり | 値 | 使いどころ |
|---|---|---|
| 速さ(短) | 120ms | 押す・離す |
| 速さ(標準) | 180ms | 色・影の変化、タブの下線 |
| 速さ(出入り) | 220ms | 小窓・お知らせの出入り |
| 曲線 | `cubic-bezier(.2,.8,.2,1)`(`--ease-out-soft`) | 全部の動き |
| 押した沈み | `scale: .97` | ボタン |
| 影(主ボタン) | 薄い1段(乗せると2段) | 主ボタンのみ |
| 角丸 | 操作要素=`rounded-md` / カード・小窓=`rounded-lg` / 札・丸ボタン=`rounded-full` | `rounded-xl` は使わない |

- 主ボタンの色は**藍(indigo-600、乗せると700)に統一**。青・緑の「主ボタン」は藍へ寄せる
  - 状態を表す色は残す: 完了・成功=緑、削除など壊す操作=赤、注意=琥珀
  - 札(バッジ)・地図の色・グラフの色は対象外
- 端末で「視差効果を減らす」(`prefers-reduced-motion: reduce`)を選んだ人には動きを出さない(沈み・すべり・ふわっと全部。色の変化だけ残す)

## 2. 第1回: 全ボタンに手応えを一度に入れる(全体の決まり)

`globals.css` の `@layer base` に、全 `<button>` 向けの規則を1つ足す:

- 色・影・沈みがなめらかに変わる(`transition` は background-color / border-color / color / box-shadow / scale、速さ=標準)
- 押している間だけ少し沈む: `:active` で `scale: .97`(押せない状態 `:disabled`・`aria-disabled="true"` では沈まない)
- キーボードで選んだときに藍の枠: `:focus-visible` に `outline: 2px solid` 藍・`outline-offset: 2px`
- 選択子は `:where(button)` で詳細度0。**各画面が書いた `transition-*`・`scale-*`・`outline-*` が必ず勝つ**(base 層は utilities 層より下)
- `transform` ではなく個別の `scale` プロパティを使う(Tailwind v4 の `translate-*`/`rotate-*` と打ち消し合わない)

**対象から外すもの**(印 `data-motion="off"` を付けた要素と、その中のボタン):
- 地図の丸ボタン(現地調査の FAB・地図の操作ボタン)
- 謄本の実況パネルの中止ボタン
- 3つ切替など `aria-pressed` を持つボタン群(選択子で自動的に外す: `:where(button:not([aria-pressed]))`)
- 印刷・PDF・販売図面の描画面(画面に出ない)

`role="button"` の div や `<a>` は今回は触らない(置き換えのときに `Button` へ寄せる)。

## 3. 第2回: 共通部品を作り直す(呼び方は変えない)

すべて既存のpropsを保ったまま中身を良くする。使っている画面は自動で新しくなる。

| 部品 | 変えること |
|---|---|
| `Button` | ①主ボタンに薄い影(乗せると濃く) ②**`loading` を追加**: くるくる+文言(既定「処理中」)・自動で押せない ③**`done` を追加**: ✓+文言を短時間出す(呼び出し側が true にする・1.2秒で元に戻すのは呼び出し側の状態) ④`variant` に `ghost`(枠なし・一覧の行内操作)を追加 ⑤`size` に `lg`(スマホの主操作・高さ44px)を追加 |
| `ModalShell` / `ConfirmDialog` | 出るとき: 背景が薄く暗くなり、中身が下から少し上がって現れる(出入り速さ)。閉じるときは今と同じく即時(呼び出し側が部品ごと外す作りのため、消える動きは付けない) |
| `Tabs` | 選んだタブの下線が横にすべる(位置は選択中タブの位置から計算。ref は callback ref で取り、effect 内で setState しない) |
| `ToastStack` | 既存の `pm-toast-in` を出入りの速さ・曲線の決まりに揃える(消えるときは今のまま) |
| 新 `Card` | 枠+角丸lg。`interactive` のときだけ乗せると少し持ち上がり、枠が藍になる。キーボードでも同じ見た目 |
| 新 `Skeleton` | 読み込み中の灰色の帯(光がゆっくり流れる)。まずは物件一覧・物件詳細の初回読み込みで使う |

## 4. 第3回以降: 手書きボタンの置き換え(1回=1PR=本番反映1回)

| 回 | 範囲 | 手書き `<button>` の目安 |
|---|---|---|
| 3 | 物件(`properties`) | 142 |
| 4 | 現地調査(`field-survey`) | 67 |
| 5 | 管理+取り込み(`admin`・`import`) | 110 |
| 6 | DM+販売図面(`sale-dm`・`sales-sheet`) | 84 |
| 7 | 所有者+棟+反響+その他 | 残り全部 |

- 各回でやること: 手書き `<button>` → `Button`(役割と大きさを選ぶ)/手書きの全面覆い → `ModalShell`/一覧の枠 → `Card`/主ボタンの色を藍に/角丸を決まりに
- 置き換えないもの: §2 で外したもの(地図の丸ボタン・実況の中止・3つ切替)は `data-motion="off"` を付けて手書きのまま残す
- 文言・置き場所・押したときの処理は変えない(見た目と動きだけ)

## 5. 確かめ方

- 部品: `renderToStaticMarkup` で出力を確かめるテスト(`loading`/`done`/`ghost`/`lg`、`Card` の `interactive`、`Skeleton`)
- 全体の決まり: `globals.css` に規則・`reduced-motion` の打ち消し・`data-motion="off"` の除外が入っていることを文字列で確かめるテスト
- 置き換えの回: 「その範囲に手書き `<button>` が許可リスト(外したもの)以外に残っていない」を数える走査テスト(LF正規化)
- 毎回: 型・全テスト・変更ファイルのlint・build、提出前レビュー、@codex、実機確認リストに項目を追加
- 使い方ガイド・マニュアルは見た目の変更なので原則更新しない(画面写真や「緑のボタン」など色で説明している箇所があれば直す)

## 6. 変えないもの

- 機能・置き場所・文言
- スマホで入力欄が勝手に拡大しない対策(`globals.css` の `@media (hover:none) and (pointer:coarse)`)
- 画面保護の透かし・印刷用の規則
- ダークモード(新しい影・枠は暗い画面でも見えるように両方の値を持つ)
- 新しい部品を外から入れない(依存追加なし)
