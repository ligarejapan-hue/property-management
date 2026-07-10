# 販売図面 レイアウト磨き込み 設計書（レイアウト自動最適化 + 下部の帯）

**日付:** 2026-07-10 / **状態:** ブレスト承認済み（設計方針OK・順序 A→B）

## 目的
販売図面（マイソク）を、物件ごとの内容（写真枚数・項目数・文字サイズ）に合わせて**自動でバランス良く**組み、下部の会社帯を**御社の実物ひな型どおり**に作り込む。現状は `buildSpecSheetDocument` が座標・文字サイズを**固定**で置くため、写真が少ない/多い・項目が多い種別でも同じ割合になり、手で微調整が要る。

2つの独立した機能に分割し、**A→B の順**で実装する。

---

## 機能A：レイアウト最適化エンジン（要望①＋②）

### 決まったこと（ブレスト）
- **起動タイミング**：(1)図面の**作成時に自動**、(2)エディタの**「レイアウト自動調整」ボタン**。〔実装時の変更〕(3)**文字サイズ変更時の自動発火は見送り**（下記②注記）＝再バランスはボタンで明示的に行う。
- **目標**：ページ（A4横）を気持ちよく埋める。写真が少ない→項目表を広く、写真が多い→写真域を広く。余白/間抜けを出さない。

### アーキテクチャ
**共有の純関数** `computeSpecSheetLayout(input): SpecSheetLayout` を新設し、ビルダーとエディタの**両方**が同じロジックを使う（写像がずれない）。

- **入力** `SpecSheetLayoutInput`：
  - `photoCount`（0–3）、`floorPlanPresent`（bool）
  - `specRowCount`（スペック表の行数＝`buildSheetRows` の結果長）
  - `overviewFontPt`（任意・省略時は行数から算出）：概要表フォント。〔実装時の変更〕当初案の `fontSizes:{overview?,heading?,price?}` は、レイアウトを駆動する概要表フォントのみ（`overviewFontPt`）に縮小。`heading`/`price` 等 text 要素フォントを入力に取り込むのは②follow-up（下記注記）。
  - `hasCatchCopy` / `hasSalesPoints` / `footerHeight`（Bの帯の高さ・下記）
- **出力** `SpecSheetLayout`：各領域の矩形＋文字サイズ
  - `photoArea`（左カラム矩形）＋ `photoSlots[]`（枚数に応じた各写真の x/y/w/h）
  - `specTable`（右の全項目表の矩形＋fontSizePt）
  - `heading` / `price` / `catchBand` / `catchCopy` / `salesPoints` / `floorPlan` / `footer` の各矩形
- **バランス規則（ルールベース比例配分）**：
  - 左右分割線 `splitX` を、写真域必要幅と項目表必要幅から決定。`photoCount` が少ない→ `splitX` を左へ（表を広く）、多い→右へ（写真を広く）。
  - 縦：`specRowCount` が多い→表の fontSizePt を段階的に下げて全行を収める（下限あり）。写真域は `photoCount` に応じ `PHOTO_LAYOUTS` を一般化して面積いっぱいに敷く。
  - 不変条件：**要素同士が重ならない・A4横（297×210mm）内・下部帯の高さを侵さない**。

### 2つの実行文脈
1. **ビルダー（作成時）**：`buildSpecSheetDocument(parts)` が先頭で `computeSpecSheetLayout` を呼び、固定座標の代わりに算出値で要素を置く。**出力の要素種別・id は不変**（`catch-band`/`heading`/`price`/`overview`/`photo-N`/`sales-points`/`company*`/`floor-plan`）＝二重レンダラ・保存境界に影響なし。
2. **エディタ（ボタン＋文字変更）**：純reducer `autoBalanceLayout(document): document` を新設（既存 `autoArrangePhotos` と同じ流儀）。**id で役割を判定**した既存テンプレ要素のみを対象に、現在の各要素 `style.fontSizePt` を入力へ渡して `computeSpecSheetLayout` で再計算→座標/サイズ更新。**ユーザーが手で足した独自要素は触らない**。no-op時は同一参照（dirtyにしない）。
   - ボタン：toolbarに「レイアウト自動調整」（`autoArrangePhotos` の隣）。
   - 文字変更：〔実装時に見送り〕テンプレ text 要素の文字サイズ変更では `autoBalanceLayout` を**自動発火しない**。理由＝レイアウトを駆動するのは概要表フォント（editText 対象外）で、見出し等 text フォントはエンジン未考慮＝自動発火しても枠は最適化されず、手で動かした要素がグリッドへ戻る害だけが残るため（@codex P2/レビュー3件が指摘）。②「文字→枠の最適化」を本来の形にするには**エンジンが text 要素フォントを考慮する追加設計**が必要（follow-up）。当面は「レイアウト自動調整」ボタンで内容に合わせ再配置する。

### テスト（TDD）
- `computeSpecSheetLayout`：純関数。ケース＝写真0/1/2/3×項目 少/多、文字大/小。検証＝重なり無し・A4内・帯高さ非侵食・「写真少→表広い」等の比例が満たされる（矩形の不変条件をassert）。
- `autoBalanceLayout` reducer：document入→再バランスdocument出（既知idのみ変更・独自要素不変・no-opは同一参照）。
- パリティ：二重レンダラ（`SalesSheetRenderer.tsx`/`render-html.ts`）は**無改修**（座標/サイズのみ変化）＝既存parityテスト緑。
- 非回帰：mansion/land/house/building の各 `build-*.test.ts`（座標assertは緩めが前提だが、必要なら固定値→不変条件へ更新）。

---

## 機能B：下部の帯の作り込み（要望③・御社ひな型を再現）

### ひな型（ユーザー提供PDFより・2026-07-10）
現状の「会社名+TEL の1行 + 取引態様等の1行」を、**下記の多ブロック帯**へ作り直す。

- **会社ブロック（固定＝内蔵定数 `COMPANY_INFO`。将来F4で設定画面化）**：
  - 社名：`株式会社リガーレジャパン Ligare Japan`（"Ligare Japan" は色付き強調）
  - 宅建免許：`東京都知事免許(1)第108344号`
  - 保証協会：`(公社)全国宅地建物取引業保証協会`／所属協会：`(公社)東京都宅地建物取引業協会`
  - TEL `03-6823-2760`／FAX `03-6823-2761`／Email `info@ligarejapan.com`／HP `https://ligarejapan.com/`
  - 所在地：`154-0011 東京都世田谷区上馬4-36-15`
- **取引条件テーブル（図面ごと）**：取引態様／広告／報酬（`overrides.transactionType`/`adType`/`compensation` から流し込み。例：仲介／不可／相談）
- **担当ブロック（図面ごと・有無で帯幅可変）**：担当者／取引士／特記事項（`overrides.staff`/`agent`/`specialNotes`。空なら省略＝ひな型のコンパクト版）

### 実装
- `buildSpecSheetDocument` のフッター領域を、`companyFooterDetails` の1行テキストから**会社ブロック(text群)＋取引条件table＋担当table**の構成に置換。**既存 element 種別のみ（text/table/shape、社名の色強調は text style、ロゴ画像は当面なし＝色付きテキストで代替）**。
- 帯の**高さ**は担当ブロック有無で2段階（フル/コンパクト）＝機能Aの `footerHeight` 入力に反映（AがメインエリアをこのfooterHeight分よけて配置）。
- 会社情報は `src/lib/sales-sheet/company-info.ts` の定数に集約（F4での差し替え口）。
- テスト：`build-*.test.ts` に帯の行（会社名/免許番号/取引態様/担当）が出ること＋担当空でコンパクト版になること。二重レンダラparity。

### 依存
- B の帯領域の座標は A の `computeSpecSheetLayout`（`footer` 矩形）を使う＝**A先行**。ロゴ画像・会社設定画面(F4)・QRは対象外。

---

## スコープ外（今回やらない）
- F4：会社情報の設定画面化・ロゴ画像アップロード（帯は当面固定値＋色付きテキスト）。
- QRコードの帯内配置（QRは既存のエディタ要素として別途）。
- 反復フィット（実測ベース）レイアウト＝案2は不採用（案1ルールベース採用）。

## 順序
**A（レイアウトエンジン）→ B（帯）**。各機能は 1PR・TDD・@codex・ユーザーマージ。実装計画は writing-plans で機能Aから作成。
