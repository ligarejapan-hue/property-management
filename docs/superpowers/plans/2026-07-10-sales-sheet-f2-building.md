# F2-C 販売図面 自社様式化：一棟（building）実装計画

**日付:** 2026-07-10 / **ブランチ:** `feat/sales-sheet-f2-building`（base=`main`。F2-A売土地/F2-B売戸建はmerge済のためstackせず直接main）

## 目的
販売図面（マイソク）の**一棟（一棟マンション／一棟アパート）**を、F2-A売土地・F2-B売戸建と同じ「自社Excelマイソク様式」で出力できるようにする。基盤は共通機構（`buildSpecSheetDocument`／`FIELDS_BY_KIND`／field-model駆動ダイアログ）を再利用。現行 `buildSaleBuildingDocument` は旧 `baseSheet` 骨組みのまま＝**作り直し対象**。

売戸建（HOUSE_FIELDS）にほぼ準拠しつつ、一棟に必要な**収益系項目（総戸数・想定利回り・満室想定収入・付帯権利）**を追加する。

## ⚠️ 要確認（御社Excel「物件情報項目リスト」に合わせる前提の暫定決定）
F2-A/F2-Bは事前に確定した項目表から着手した。今回はその確定表が無い状態でユーザー不在のため、**売戸建パターン＋メモリ記載の収益項目**から保守的な既定値で組む。以下4点は暫定＝**レビューで調整可**（値は文字列変更のみ・本番反映前にユーザー確認）：

1. **物件種目の選択肢** `PROPERTY_TYPE_BUILDING`（新規）= `["新築一棟マンション","中古一棟マンション","新築一棟アパート","中古一棟アパート","一棟ビル","その他"]` … 見出し（一棟マンション/一棟アパート）は propertyType(DB) から自動決定するが、種目行はより細かい表記用に残す（他種別と統一）。
2. **付帯権利** = `LAND_RIGHT`（土地権利と同じ選択肢）を再利用しラベルのみ「付帯権利」。専用リストが要る場合は別途。
3. **想定利回り**=数値＋単位「％」／**満室想定収入**=数値＋単位「万円/年」（年額）。月額運用なら要変更。
4. **付帯設備（EV有無等）** は明示要望・旧コードとも無いため今回は含めない。

## グローバル制約
- **既存ドキュメント部品のみ**（text/image/table/shape）。新規element型・schema・migration・依存・env は**足さない**。二重レンダラ（`SalesSheetRenderer.tsx`/`render-html.ts`）は無改修（parityテスト緑を確認するのみ）。
- **非回帰**：売マンション/売土地/売戸建の出力・テストを一切壊さない（フル `npx vitest run` で確認）。
- **ゲート**：`tsc --noEmit`=0 / フル vitest 緑 / `npm run build` / 変更ファイル eslint=0。
- **キャッシュ済みクライアント後方互換（今回は"実運用中"）**：一棟は**唯一まだ旧フラットダイアログのまま本番稼働**中。旧ダイアログが送る12キー（price/access/landArea/totalFloorArea/totalUnits/builtYearMonth/structure/grossYield/expectedIncome/transactionType/deliveryTiming/remarks）を**キー名互換のまま受理**し、`deliveryTiming` は `delivery` の `@deprecated` 別名として残す（builderで `o.delivery ?? o.deliveryTiming`）。＝旧タブからのPOSTを弾かない/空欄化しない。

## BUILDING_FIELDS 項目表（実装の正）
`kind` = `"building"`（`apartment_building`→一棟マンション / `apartment_block`→一棟アパート、両者とも building。マンション/アパートの別は `SaleBuildingInput.kind` でサーバ側決定＝見出し二分岐）。

| key | label | widget | section | options | unit | autoFrom | 備考 |
|---|---|---|---|---|---|---|---|
| propertyType | 物件種目 | select | 価格 | PROPERTY_TYPE_BUILDING(新) | | | 要確認① |
| price | 価格 | number | 価格 | | 万円 | | 旧キー互換 |
| tax | 消費税 | select | 価格 | TAX | | | controlOnly |
| taxAmount | うち消費税 | number | 価格 | | 万円 | | showWhen tax=課税 |
| address | 所在地 | text | 所在 | | | address | auto-only |
| access | 交通 | text | 所在 | | | | 旧キー互換 |
| landArea | 土地面積 | number | 土地 | | | | areaMethod合成(㎡)・旧キー互換 |
| areaMethod | 面積計測方式 | select | 土地 | AREA_METHOD_LAND | | | controlOnly |
| landRight | 付帯権利 | select | 土地 | LAND_RIGHT | | | 要確認② |
| privateRoad | 私道負担 | number | 土地 | | ㎡ | | |
| landCategory | 地目 | multiselect | 土地 | LAND_CATEGORY | | | 併記 |
| setback | セットバック | number | 土地 | | | | |
| setbackUnit | 単位 | select | 土地 | SETBACK_UNIT | | | controlOnly |
| terrain | 地勢 | select | 土地 | TERRAIN | | | |
| totalFloorArea | 延床面積 | number | 建物 | | ㎡ | | 旧キー互換 |
| structure | 構造 | select | 建物 | BUILDING_STRUCTURE | | | 旧キー互換（Building relation非配線＝手入力） |
| aboveFloors | 地上階 | number | 建物 | | 階 | | |
| basementFloors | 地下階 | number | 建物 | | 階 | | |
| builtYearMonth | 築年月 | text | 建物 | | | | 旧キー互換・手入力 |
| renovYearMonth | 増改築年月 | text | 建物 | | | | |
| parking | 駐車場 | select | 建物 | PARKING_HOUSE | | | |
| totalUnits | 総戸数 | number | 収益 | | 戸 | | 旧キー互換・手入力 |
| grossYield | 想定利回り | number | 収益 | | ％ | | 旧キー互換・要確認③ |
| expectedIncome | 満室想定収入 | number | 収益 | | 万円/年 | | 旧キー互換・要確認③ |
| roadKind | 接道種別 | select | 法令 | ROAD_KIND | | roadType | auto-only |
| roadWidth | 接道幅員 | text | 法令 | | m | roadWidth | auto-seed可 |
| roadDirections | 接道方向 | multiselect | 法令 | DIRECTION | | | 併記 |
| cityPlanning | 都市計画 | multiselect | 法令 | CITY_PLANNING | | | 併記 |
| useDistrict | 用途地域 | multiselect | 法令 | USE_DISTRICT | | zoningDistrict | 自動1+追加・併記 |
| areaZone | 地域地区 | multiselect | 法令 | AREA_ZONE | | | 併記 |
| coverageRatio | 建蔽率 | number | 法令 | | ％ | buildingCoverageRatio | auto-only |
| floorRatio | 容積率 | number | 法令 | | ％ | floorAreaRatio | auto-only |
| buildingConfirm | 建築確認区分 | select | 法令 | BUILDING_CONFIRM | | | |
| rebuild | 再建築 | select | 法令 | REBUILD_STATUS | | | |
| legalRestriction | その他法令上の制限 | text | 法令 | | | | |
| equipment | 設備・条件 | text | 設備 | | | | |
| occupancy | 現況 | select | 設備 | OCCUPANCY | | occupancyStatus | mansion mapper再利用 |
| delivery | 引渡時期 | select | 設備 | DELIVERY_TIMING | | | 旧 deliveryTiming を別名互換 |
| remarks | 備考 | text | 設備 | | | | 旧キー互換 |
| transactionType/compensation/adType/staff/agent/specialNotes | (会社=フッター・表行にしない) | | 会社 | | | | 全種別共通 |

**auto-only（自動反映のみ・override無し）** = `address, roadKind, coverageRatio, floorRatio`（売土地と同一）。
**occupancy** は select ゆえ seed 可（`mapOccupancyStatusToMansionOccupancy` 再利用＝現況語彙は居住中/空家/賃貸中/未完成）。
**二重単位**：grossYield(％)/expectedIncome(万円/年) 等は既存 `fmtValueWithUnit`/`sheet-rows.formatValue` の trailing-unit strip を通し、キャッシュ客の「7.8%」等でも二重化させない。

## タスク（TDD・F2-Bの4タスク形を踏襲。occupancy新規不要ゆえF2-Bより軽い）
- **Task 1**：本計画doc＋`option-master.ts` に `PROPERTY_TYPE_BUILDING` 追加（+test）。
- **Task 2**：`field-model.ts` に `BUILDING_FIELDS`／`build-document.ts` の builder 作り直し（`buildBuildingValues`＋`buildSaleBuildingDocument` を `buildSpecSheetDocument` 化・見出し二分岐・旧helper[baseSheet/row/formatRatio/formatRoad/fmtUnits]をgrep後に除去）。`build-building.test.ts` 新設＋field-model.test.ts追記＋`build-document-templates.test.ts` の旧building block削除。
- **Task 3**：`SalesSheetCreateButton.tsx`（FIELDS_BY_KIND.building 他6箇所）＋`new/route.ts`（building schema総入れ替え・deliveryTiming別名互換・kind派生維持）。`building-dialog.test.tsx` 新設＋`SalesSheetCreateButton.test.tsx` 旧building test置換＋route test更新。
- **Task 4**：parity確認＋フルゲート＋feature-dev:code-reviewer プレレビュー＋PR＋@codex。**マージはユーザー**。

## セルフレビュー観点
既存部品のみ・非回帰・型整合・後方互換（deliveryTiming別名＋旧キー名保持）・見出し二分岐（apartment_building/apartment_block）・二重単位ガード・会社セクションはフッター・現況determinism（サーバ側マップ）・auto-only disabledプレビュー。
