# 販売図面 3列レイアウト設計(写真 / 間取り図・敷地図 / 概要表)

2026-07-17。販売図面エディタの版面を、実機フィードバックに基づき **3列構成** にする。
関連: [[sales-sheet-photo-pack]](モザイク配置 packMosaic)。

## 背景・目的

現状は2列(左2/3=写真+間取り図が写真列の上、右1/3=概要表)。御社要望:

- 版面を **左=写真(モザイク) / 中央=間取り図・敷地図 / 右1/3=概要表** の3列にしたい。
- 中央の図の **幅をドラッグで調整** でき、広げると左の写真が **反比例で狭くなる**(指を離した瞬間に写真が自動で詰め直し)。
- どの画像を中央の「間取り図/敷地図」にするかを **写真を選んで指定** できる(現状、間取り図を指定するUIが実質存在せず、測量図等も普通の写真として扱われている)。

## 全体像

版面の上下(キャッチ帯・見出し・価格・セールスポイント・会社帯)は不変。中央帯を3列にする。

```
● キャッチ帯(上・全幅)  見出し/価格(左上)
┌──────────┬────────────┬──────────┐
│ 写真(左)  │ 間取り図/    │ 概要表(右) │
│ モザイク  │ 敷地図(中央) │ 1/3固定    │
│          │ 幅=ユーザー  │            │
└──────────┴────────────┴──────────┘
● セールスポイント / 会社帯(下・全幅)
```

- **概要表(右1/3)**: 固定(現状どおり x≥`OVERVIEW_MIN_X_MM`)。
- **中央=間取り図/敷地図**: `id="floor-plan"` の image 要素。右端は概要表の左に近接、左端がユーザー可変。存在するときだけ中央列になる。
- **写真(左)**: `id="floor-plan"` 以外の image。写真ゾーンの右境界 = 中央の図の左端 − gap(図が無ければ従来どおり左2/3)。`packMosaic` で詰める。
- **適応**: 中央の図が無い物件は中央列を作らず、写真が左2/3を使う(現状と同じ)。

## 単位ごとの設計

### 1. layout-engine: `computeSpecSheetLayout`(中央列の既定レイアウト)

新規/レイアウト自動調整で使う **既定の** 3列 rect を返すよう変更(純関数・決定的)。

- `hasFloorPlan` のとき `floorPlan` を **中央列** として返す(現状の「写真域の上」から変更):
  - `x = FLOOR_PLAN_DEFAULT_X`(中央列の既定左端)、右端 = `overview.x − COLUMN_GAP_MM`、`y = MAIN_TOP_MM`、`h = photoBandBottom − MAIN_TOP_MM`(セールスポイント上まで=写真帯と同じ縦範囲)。
  - 既定幅は概ね「左2/3の残り半分」= バランス既定(モックの三等分寄り)。定数 `FLOOR_PLAN_DEFAULT_X` で表現。
- `photoArea`(写真域): 右端 = `hasFloorPlan ? floorPlan.x − COLUMN_GAP_MM : effectiveSplitX`。左端・上端・下端は現状の写真帯計算を流用。写真は上端から敷く(図の下ではなく **図の左**)。
- `photoSlots`: `packPhotoCells` を新しい写真域(左列)で計算(build-document 用の既定並び。実編集ではモザイクで上書きされる)。
- 非負ガード・既存の overview 幅/フォント計算は不変。

### 2. editor-document: `autoArrangePhotos`(写真ゾーン = 図の左)

現状は「floor-plan があるとゾーン上端を図の下へ」。これを **「floor-plan の左」** に変更:

- `floorPlanEl` があれば `rightBoundary = min(floorPlanEl.x − COLUMN_GAP相当, overview左 − 水平余白)`、無ければ従来 `boundaryX`。
- `zoneY = PHOTO_ZONE_Y_MM`(図の下へ寄せる処理を廃止)、`zoneW = rightBoundary − zoneX`、`zoneH` は現状どおり。
- 以降は現状のモザイク(`packMosaic`)・overview スナップ・冪等性ロジックを踏襲。floor-plan は整列対象外(現状どおり `TEMPLATE_ELEMENT_IDS` で除外)。

### 3. editor-document: 図の指定/解除(新規 reducer・純関数)

- `setAsFloorPlan(state, id)`:
  - 対象 image(`id !== "floor-plan"`)を中央の図にする。**既存の floor-plan があれば先に `safeRandomId()` の新 id へ改名して写真へ降格**(常に1枚)。対象要素の id を `"floor-plan"` に改名し、`fit:"contain"` に。位置は中央列の既定 rect(`computeSpecSheetLayout` 由来 or 現 overview から算出)へ。
  - その後 `autoArrangePhotos` を適用(写真を図の左へ詰め直す)。`selectedId` は改名後 id へ更新。dirty=true。
  - 非 image / 不明 id は no-op(同一参照)。
- `unsetFloorPlan(state, id)`:
  - `id === "floor-plan"` の要素を `safeRandomId()` の新 id へ改名(写真へ降格)→ `autoArrangePhotos`。`selectedId` を新 id へ。dirty=true。
- id 改名の影響(history/選択)は `selectedId` 更新で吸収。id は schema 上任意文字列(検証済み範囲)。

### 4. editor-document: `autoBalanceLayout`(3列化 + 写真モザイク統一)

- テンプレ枠・**中央列の floor-plan**・overview を `computeSpecSheetLayout` の新 rect へ再配置(現状の template loop を流用。floor-plan は中央列 rect へ)。
- 写真は **エディタ側で** `autoArrangePhotos`(モザイク)に委譲する(下記5)。`autoBalanceLayout` 自体は従来どおり `photoSlots` へ置くが、`handleAutoBalance` が続けてモザイクで上書きする=最終形はモザイク。これで「レイアウト自動調整」でも写真がモザイクになり、「写真を自動整列」と結果が揃う(先の実機フィードバックの解消)。

### 5. SalesSheetEditor(配線)

- **「間取り図にする」/「写真に戻す」**: `ElementPanelChange` に `setFloorPlan` / `unsetFloorPlan` を追加。ElementPanel の image セクションに、`id!=="floor-plan"` なら「間取り図にする」、`id==="floor-plan"` なら「写真に戻す」ボタン。ハンドラで `setAsFloorPlan`/`unsetFloorPlan` を dispatch。
- **ドラッグ確定で写真再整列**: `handleMove` / `handleResize`(= onDragEnd / onResizeEnd)で、対象 id が `"floor-plan"` のとき、move/resize 適用後に **実寸比を測って `autoArrangePhotos` を適用**(async・指を離した瞬間の反比例リフロー)。測定中に document が変わっていたら適用しない(既存 R3 と同じ stale ガード)。
- **`handleAutoBalance` を async 化**: 実寸比測定 → `autoBalanceLayout` → `autoArrangePhotos` の合成(1回の state 更新でなく2段でも可。冪等なので安全)。

### 6. build-document(新規テンプレ)

- `computeSpecSheetLayout` の新 rect に追従(floor-plan 中央列・photoSlots 左列)。`floorPlanImage` 未配線の現状は floor-plan 無し=2列(写真左2/3)。指定は編集画面の「間取り図にする」で行う。ビルダーの id/type/style は不変。

## 二重レンダラ

幾何(x/y/w/h)のみの変更で **新規 element 型・新規 id 種別は無い**。`SalesSheetRenderer.tsx` と `render-html.ts` は既存 image 描画をそのまま使う=parity 変更なし。floor-plan も従来から image として描画済み。

## 保存境界

`setAsFloorPlan`/`unsetFloorPlan`/`autoArrangePhotos` 後の全要素は `assertSavableDocument`(w/h>0・±10000mm・z≥0・A4)を満たす(位置・サイズは用紙内クランプ済み経路のみ)。id 改名は保存に影響しない。

## テスト

- `computeSpecSheetLayout`: hasFloorPlan 時 floorPlan が中央列(overview 左に近接・photoArea 右端が floorPlan 左)/hasFloorPlan=false で従来 2列。
- `autoArrangePhotos`: floor-plan があるとき写真ゾーン右端 = 図の左/図の下へ寄せない/図が無ければ従来。冪等。
- `setAsFloorPlan`/`unsetFloorPlan`: id 改名・1枚制約(既存図の降格)・selectedId 更新・写真再整列・no-op 条件・保存可能。
- 既存 autolayout/autobalance テストの回帰(3列化に伴う期待値更新)。
- 全ゲート(tsc/フル vitest/eslint/build)緑。

## 非目標(YAGNI)

- 図リサイズ時の縦横比自動ロック(自由リサイズ・`fit:contain` で吸収)。
- 中央の図を複数(常に1枚)。
- ドラッグ中の1px毎リフロー(離した時のみ)。
- 物件データからの間取り図自動配置(将来・別途)。

## 実装順序

1. layout-engine(中央列 rect)+テスト。
2. autoArrangePhotos(ゾーン=図の左)+テスト。
3. setAsFloorPlan/unsetFloorPlan(reducer)+テスト。
4. autoBalanceLayout の中央列追従(既存 loop 流用)+テスト回帰。
5. SalesSheetEditor/ElementPanel 配線(ボタン・ドラッグ確定リフロー・handleAutoBalance async)。
6. 全ゲート→提出前レビュー→PR→@codex。
