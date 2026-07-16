# 販売図面 写真「段組み詰め」＋元に戻す＋リサイズ修正 設計

2026-07-16 / branch `feat/sales-sheet-photo-pack`。前回(photo-autolayout・PR #292)への実機フィードバック対応。

## ユーザーフィードバック(2026-07-16)
1. 左2/3を使い切れていない。均等グリッド+contain の「枠内余白」が過大。**枠は写真の実寸縦横比で作り、敷き詰めてほしい**(段組み詰め方式=承認済・視覚提案 artifact e9802191)。
2. 概要表(物件種目)はもともと右1/3より左へ来ないのだから、**最初から定位置(右1/3)でレイアウト**してほしい(古い図面の表位置に写真側が引きずられない)。
3. **サイズ調整が不全**: 拡大ハンドル(□)を掴んだ瞬間、要素が最小サイズへ潰れる。
4. **元に戻す/やり直すボタン**が欲しい(複数回)。

## 設計

### A. 段組み詰め `justified-pack.ts`(新規・純関数)
`packJustifiedRows(aspects, W, H, gap): Rect[]`
- 写真を**現在の見た目順**(y→x)で行に分割し、行ごとに「行内の縦横比合計」で高さを決め、幅Wぴったりに敷く(Google写真の justified layout)。
- 行分割は k=1..n の各行数で linear-partition DP(行のΣaspectの最大を最小化=行高さの均一化)し、**無駄面積(W·H−写真面積合計)最小の k を採用**。総高がHを超える分割は全行を等率縮小して収める(比率不変・右に余り)。
- 決定的・順序保存(読み順)・n=0は[]。

### B. `autoArrangePhotos` v2(editor-document.ts)
- 写真ゾーン=**常に左2/3固定**: 右端 = `OVERVIEW_MIN_X_MM(188) − PHOTO_AREA_TO_OVERVIEW_GAP_MM(11)` = 177。overview 要素が無い版面のみ従来どおり page.width·2/3 − 11。
- **overview スナップ(要望2)**: overview 要素が定位置より左(x<188)なら x=188/w=99 へ移動(y/h維持)。
- 並び順=ボタン押下時点の視覚順(y中心を1mm丸め→x中心→配列index)。`appendedId` は末尾へ。
- 各写真の縦横比は `opts.aspects`(要素id→比)を優先、無ければ現枠 w/h。`fit:"contain"`(枠=写真比なので余白は出ない)。
- Hungarian(`min-movement-assignment.ts`)は**廃止・削除**(枠が写真比に紐づくため割当再配置は不成立。並び保持は視覚順ソートが担う)。
- floor-plan 除外/縦位置予約・純/決定的/no-op同一参照は維持。

### C. 元に戻す/やり直す `editor-history.ts`(新規・純関数)+ SalesSheetEditor を useReducer 化
- `{editor, past: SalesSheetDocument[], future: []}` を単一 reducer(純)で管理: `edit(fn)`=document が変わった時だけ past へ(上限50・future クリア)/`undo`/`redo`(selectedId は復元 doc に存在しなければ null・dirty=true)。
- ツールバー先頭に「元に戻す」「やり直す」(canUndo/canRedo で非活性)+ Ctrl+Z / Ctrl+Y(+Cmd)。input/textarea/contentEditable フォーカス中は無視。
- 既存の setEditorState(prev=>reducer(prev)) 呼び出しを dispatch({type:"edit", fn}) へ機械的に置換。markSavedIfCurrent は document 参照不変=履歴に積まれない。

### D. リサイズ「掴んだ瞬間に最小化」修正(EditorCanvas)【実測で確定した最終版】
Playwright 実測により根本原因は **2つの複合**と確定(bounds 仮説は position:"css" でも再現し棄却):
1. **ヒットボックスの寸法が mm 文字列**(`width:"167mm"`)で、Moveable のリサイズ量計算が壊れ、掴んだ瞬間に負のリサイズ=最小5mmへ潰れる → **px 単位に統一**(`el.w×mmToPx px`・見た目不変)。
2. **確定時の px→mm 変換で余計に zoom で割っていた** — Moveable のイベント値は CSS px(scale前空間・実測 drag.left=37.7953px=ちょうど10mm)なのに ÷0.75 して 10mm→13.33mm に化けていた → **mmToPx のみで割る**。
- `bounds` は廃止(client座標解釈で誤クランプの温床)。用紙内制約は確定時に reducer でクランプ: `resizeElement` に上限(現原点から用紙右端/下端)を追加=保存境界(A4内検証)を resize で破れない。
- 併せてリサイズ確定を **1回の state 更新**に統合(旧: サイズと位置が別 dispatch=履歴2つに割れ、Ctrl+Z 一回で戻り切らない・実測で発見)→ `onResize(id, {w,h,x?,y?})`。
- 実測検証(Playwright・zoom0.75): +80px ドラッグ→ +26.5mm(期待≈28.2mm・ハンドル中心オフセット分の差)・undo 1回で完全復元・redo 復元。

### E. 縦横比の実測(SalesSheetEditor)
- `new Image()` で naturalWidth/Height を読み(同一オリジン `/uploads/...`)、src→比を ref の Map にキャッシュ。自動整列/写真追加時に対象srcを測ってから dispatch(aspects を渡す)。schema 変更なし(二重レンダラ不変)・保存JSONにも比は持たない(開くたび実測)。

## 影響・非対象
- 作成時(サーバ)の初期配置は従来グリッドのまま(サーバは画像寸法を知らない)。エディタで自動整列した時点で敷き詰めに変わる。
- DB/route/zod/storage/認可 無改修。前回導入の「作成グリッドと一致なら no-op」テストは方式転換により削除(整列は写真優先レイアウトへ再流動が正)。

## テスト
- justified-pack: 空/1枚(横長=幅フィット・縦長=高さフィット比率不変)/同比3枚/混在比の行充填(各行右端≈W)/順序保存/決定性/H超過時の等率縮小。
- editor-history: record上限50/future クリア/undo/redo往復/空でnull/selectedId 消失時 null。
- autolayout v2: ゾーン右端177固定/overview x=120→188スナップ/視覚順保持/appendedId末尾/aspects反映(枠比=写真比)/floor-plan予約/no-op冪等。
- toolbar SSR: undo/redo ボタンと disabled。
- 実機: Playwright でリサイズ(掴んで拡大→潰れない)・自動整列・Ctrl+Z を検証。
