# 販売図面: 物件の地図QR(Googleマップ検索)を間取図の下に差し込む

2026-07-18。物件の場所を Google マップで検索するリンクを QR 化し、ワンクリックで間取図の下(無ければ右下)に差し込む。関連: [[sales-sheet-three-column]](間取図=中央列)、既存 QR 機能(`addQrElement`/`generateQrDataUrl`)。

## 要件(ブレスト確定)

- **リンク先**: 物件の住所で Google マップ検索する URL。GPS でなく**常に住所**(ユーザー選択)。
- **配置**: 間取図(中央列=id="floor-plan")があればその**真下**(中央列の幅内・中央寄せ)、無ければ**図面の右下**の既定位置。用紙内にクランプ。後からドラッグ移動/リサイズ可。
- **トリガー**: ツールバーに「地図QRを追加」ボタン(1クリック)。住所が無い物件では無効化。
- **住所**: 物件の canonical な `address`(概要表の編集値でなく物件レコードの住所)を編集ページから渡す。

## 単位ごとの設計

### 1. `buildMapsSearchUrl(address)`(純関数・新規 or qr-code.ts に併設)

- `https://www.google.com/maps/search/?api=1&query=<encodeURIComponent(address.trim())>` を返す。
- 空/空白のみ → `null`(QR を作らない)。
- 純・決定的。

### 2. `addMapQrElement(state, { id, address })`(editor-document.ts・新規 reducer)

- `buildMapsSearchUrl(address)` → `null` なら no-op(同一参照)。
- `generateQrDataUrl(url)` → `null`(容量超過等)なら no-op。
- QrElement を追加(既存 `addQrElement` と同型: content=URL・dataUrl・既定サイズ `DEFAULT_QR_SIZE_MM`・z=最大+1・自動選択・dirty)。
- **配置**:
  - floor-plan(id="floor-plan"・type=image)があれば: x = 図の中央 − QR幅/2(図幅内で中央寄せ)、y = 図の下端 + gap。用紙下端を超えないよう `Math.min` でクランプ、はみ出す場合は図の下端に収まる範囲へ。
  - 無ければ: 右下既定(x = page.width − w − 余白、y = page.height − h − 余白)。
  - いずれも用紙内 [0..page.width−w]×[0..page.height−h] にクランプ(負値なし)。
- 純・決定的。

### 3. edit ページ(server component)

- 物件 select に `address` を追加(現状 `{ id, createdBy, assignedTo }`)。`initial.propertyAddress = property.address` を SalesSheetEditor へ渡す(認可・DB 書き込みは不変)。

### 4. `SalesSheetEditor`

- props `initial.propertyAddress?: string` を受ける。
- `handleAddMapQr()`: `addMapQrElement(prev, { id: safeRandomId(), address: initial.propertyAddress ?? "" })` を dispatch(同期・既存 addQrElement と同流儀)。
- ツールバーへ `onAddMapQr` と `canAddMapQr = !!(propertyAddress && propertyAddress.trim())` を渡す。

### 5. `EditorToolbar`

- 「地図QRを追加」ボタン(既存 QR ボタンの隣)。`disabled={!canAddMapQr}`、無効時 title=「物件の住所が未登録です」。

## 保存境界・レンダラ

- QrElement は既存要素型(新規型なし)。二重レンダラ(SalesSheetRenderer/render-html)は QR 描画済みで不変。
- 追加要素は用紙内クランプ済み=`assertSavableDocument`(w/h>0・±10000mm・z≥0・A4)を満たす。

## テスト

- `buildMapsSearchUrl`: 通常/空白/エンコード(全角・記号)。
- `addMapQrElement`: floor-plan 有→図の下・幅内/floor-plan 無→右下/住所空→no-op/用紙内クランプ/schema 通過/z 最前面/selectedId。
- 全ゲート(tsc/フル vitest/eslint/build)緑。

## 非目標(YAGNI)

- GPS ピン(常に住所検索)。
- 住所変更時の QR 自動更新(都度追加・パネルで内容編集)。
- 複数地図QRの自動管理・重複防止。
