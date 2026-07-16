# 販売図面 写真自動整列＋レイアウト改善 設計

2026-07-16 / branch `feat/sales-sheet-photo-autolayout`

## 背景・目的

販売図面（自社様式マイソク）エディタの写真配置に関する 5 点の改善。ユーザー（御社）要望:

1. **写真が物件種別（概要表）に被らない** — 現状 `autoArrangePhotos` は写真ゾーン幅を固定 130mm（右端 x≈140mm）にしており、概要表の左端（写真枚数により最小 x≈116mm）に食い込む。写真 1〜2 枚時に「写真と物件種別が被る」。
2. **写真の縦横比を変えない** — 現状はセル寸法を写真に当て `fit:"cover"` のため切り取り／歪みが出る。切り取り・引き伸ばしせず全体表示（余白可＝letterbox）にする。ユーザー選択＝「写真全体を見せる（余白可）」。
3. **移動距離を最小に** — 現状は配列順（＝追加順）にセルへ流し込むため写真が大きく動く。押した時点の各写真位置に最も近いスロットへ割り当て、総移動量を最小化。今の並びを保つ。
4. **写真を入れたら自動整列** — 追加ボタンを押さなくても、写真を 1 枚追加した時点で ①〜③ を自動実行。手動「写真を自動整列」ボタンも残す。
5. **概要表（物件種別）の枠は右端から最大 1/3** — 概要表の幅をページ幅の 1/3（A4横 297mm → ≤99mm）に制限し、左側の写真領域を最大 2/3 まで広げる。

## 対象・非対象

- 対象: 販売図面エディタのレイアウト計算（純関数）と写真追加ハンドラ 1 行。
- 非対象: DB / サーバ route / zod / storage / 認可（**無改修**）。画像そのもの（EXIF 等）不変。文字・表・バッジ等の非写真要素は不動。

## 設計

### A. 概要表の幅上限（要件⑤・`layout-engine.ts`）

`computeSpecSheetLayout` で overview 列幅をページ幅の 1/3 に制限する。
- 定数追加: `PAGE_W_MM = 297`、`OVERVIEW_MAX_WIDTH_MM = PAGE_W_MM / 3`（=99）。
- overview 右端は既存 `OVERVIEW_RIGHT_MM=287`。左端の下限 `OVERVIEW_MIN_X_MM = OVERVIEW_RIGHT_MM - OVERVIEW_MAX_WIDTH_MM`（=188）。
- `overviewX = max(splitX + OVERVIEW_X_OFFSET_MM, OVERVIEW_MIN_X_MM)`。現状 splitX の最大でも overviewX<188 のため実質 188 に固定＝概要表は常に右 1/3、写真域は左 2/3。
- 左カラム（photoArea / heading / price / salesPoints / leftColumnW）は `effectiveSplitX = overviewX - OVERVIEW_X_OFFSET_MM` から一貫して導出（写真域と概要表の間に無駄な隙間を作らない）。
- 影響: 新規作成図面（`buildSpecSheetDocument`）と「レイアウト自動調整」（`autoBalanceLayout`）に反映。既存図面は開いて自動調整/自動整列した時点で反映。

### B. 移動最小の割当（要件③・新規 `min-movement-assignment.ts`）

純関数 `assignMinMovement(photoCenters, slotCenters): number[]`。
- 入力: 各写真の現在中心 `{x,y}[]` と各スロット中心 `{x,y}[]`（同数 n）。
- コスト行列 `cost[i][j] = ユークリッド距離(photo i, slot j)`。
- Hungarian（Kuhn–Munkres, O(n³)）で総コスト最小の割当を求め、`assignment[photoIdx] = slotIdx` を返す。
- 決定的（同点は添字順で解決）。n≤画像上限 50 でも即時。
- 単体テスト: 明快な近接ケース／同点の決定性／既配置は恒等割当。

### C. 写真自動整列の刷新（要件①②③・`editor-document.ts` `autoArrangePhotos`）

- 写真ゾーン右端 = document 内 `overview` 要素の x − `COLUMN_GAP_MM`（要件①）。overview 要素が無ければ `page.width * 2/3 − gap` にフォールバック（要件⑤の思想を素の版面でも維持）。
- `zoneW/zoneH` から従来どおり `packPhotoCells` でスロット（均一グリッド）を得る。
- スロット中心と写真中心から `assignMinMovement` で割当（要件③）。
- 各写真: 割り当てられたスロットの `x/y/w/h` を設定し、`fit:"contain"`（要件②・切り取らず全体表示）。`src/focalX/focalY/z/alt` は保存。
- 純・決定的。幾何と fit がすべて不変なら同一 state 参照（no-op）。変更あれば `dirty=true`。画像ゼロは no-op。

### D. 追加時に自動整列（要件④・`SalesSheetEditor.tsx`）

`handleAddImage` を `autoArrangePhotos(addImageElement(prev, {...}))` に変更（追加→即整列を 1 回の state 更新で・中間の中央配置がちらつかない）。手動ボタン（`onAutoArrange`）は現状維持。

## テスト

- `min-movement-assignment.test.ts`: 近接割当・同点決定性・恒等・n=1/0。
- `layout-engine.test.ts`: overview 幅 ≤ pageWidth/3、overviewX=188、左カラムが effectiveSplitX 由来、写真域と overview が重ならない（更新）。
- `editor-document.autoArrangePhotos`: overview 左端を越えない／`fit:"contain"`／移動最小割当／既配置 no-op／画像ゼロ no-op。
- 影響を受ける既存テスト（spec-sheet-document / autolayout / autobalance）を新座標へ更新。
- 全ゲート: tsc0 / フル vitest / eslint0 / build。

## リスク・留意

- 既存図面は overview が旧位置のまま＝写真整列は旧 overview 基準（開いて「レイアウト自動調整」で新様式に）。挙動不変を破らない（明示操作でのみ再配置）。
- Hungarian は自前実装のため単体テストで正しさを担保。
