# 販売図面 自社様式化 F2-B(売戸建) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** 売戸建の販売図面ひな型を、F1(マンション)/F2-A(土地)と同じ自社マイソク様式に作り直す。共通機構(`buildSpecSheetDocument`・`FIELDS_BY_KIND`・`buildSheetRows`・option-master・occupancy)は F2-A で整備済みなので、戸建は **HOUSE_FIELDS 定義 + 戸建ビルダー作り直し + FIELDS_BY_KIND への house 追加 + route house schema 総入れ替え** の横展開。土地と違い **消費税(課税/不課税)あり**=マンションの tax パターンを再利用。

**Architecture:** `buildSaleHouseDocument` を `HOUSE_FIELDS`(field-model)+`buildHouseValues`+`buildSpecSheetDocument` で自社様式化。現況は OCCUPANCY 語彙(居住中/空家/賃貸中/未完成)=マンションと同一ゆえ `mapOccupancyStatusToMansionOccupancy` を再利用。消費税は tax(controlOnly)+taxAmount(showWhen 課税)=マンションと同一パターン。ダイアログは `FIELDS_BY_KIND.house = HOUSE_FIELDS` にするだけで F2-A の汎用描画に乗る。**新規element型/schema/migration/依存なし。**

**Tech Stack:** F1/F2-A と同一(Next.js/TS/Zod/vitest env=node/既存sales-sheet機構)。

## Global Constraints
- **既存ドキュメント部品のみ**・schema/migration/依存なし。
- **決め事(戸建・入力方式マップ準拠)**: 消費税=課税/不課税(課税時のみ「うち消費税」行)。複数選択併記(" / ")= 地目・接道方向・都市計画・用途地域・地域地区。用途地域=自動(zoningDistrict)+手動追加。プルダウン=御社Excel準拠。
- **F2-A/F1機構を再利用**(`buildSpecSheetDocument`/`buildSheetRows`/`FIELDS_BY_KIND`/汎用widget描画/`companyFooterDetails`/`fmtManYen`/`fmtAreaWithMethod`/`fmtValueWithUnit`/`mapOccupancyStatusToMansionOccupancy`/`photoElements`)。**新規は極力作らない。**
- **他ビルダー(マンション/土地/一棟)・他ダイアログ経路を壊さない**(mansion/land 出力不変・build test 緑維持)。
- 自動反映は現行 house builder に準拠: `layout`=auto(property.layoutType)、`structure`/`builtYearMonth`=**手入力**(house に建物relationを配線しない=現行踏襲)、`occupancy`=auto(occupancyStatus)、`useDistrict`=auto(zoningDistrict)、`coverageRatio`/`floorRatio`=auto、`roadKind`/`roadWidth`=auto(roadType/roadWidth)。
- 全ゲート: tsc0 / full vitest 緑 / build / eslint 差分0。commit trailer 必須。
- worktree=`property-management-worktrees/sales-sheet-f2-house`・branch=`feat/sales-sheet-f2-house`(**f2-land にスタック**=base は f2-land)。

## HOUSE_FIELDS 確定仕様
section = 価格/所在/土地/建物/法令/設備/会社。

| key | label | widget | section | options | unit | autoFrom | 備考 |
|---|---|---|---|---|---|---|---|
| propertyType | 物件種目 | select | 価格 | PROPERTY_TYPE_HOUSE | | | 手入力 |
| price | 価格 | number | 価格 | | 万円 | | |
| tax | 消費税 | select | 価格 | TAX | | | controlOnly |
| taxAmount | うち消費税 | number | 価格 | | 万円 | | showWhen tax=課税 |
| address | 所在地 | text | 所在 | | | address | |
| access | 交通 | text | 所在 | | | | |
| landArea | 土地面積 | number | 土地 | | | | areaMethod合成(㎡) |
| areaMethod | 面積計測方式 | select | 土地 | AREA_METHOD_LAND | | | controlOnly |
| landRight | 土地権利 | select | 土地 | LAND_RIGHT | | | |
| privateRoad | 私道負担 | number | 土地 | | ㎡ | | |
| landCategory | 地目 | multiselect | 土地 | LAND_CATEGORY | | | 併記 |
| setback | セットバック | number | 土地 | | | | setbackUnit合成 |
| setbackUnit | 単位 | select | 土地 | SETBACK_UNIT | | | controlOnly |
| terrain | 地勢 | select | 土地 | TERRAIN | | | |
| buildingArea | 建物面積(延べ) | number | 建物 | | ㎡ | | |
| floor1Area | 1階面積 | number | 建物 | | ㎡ | | |
| floor2Area | 2階面積 | number | 建物 | | ㎡ | | |
| floor3Area | 3階面積 | number | 建物 | | ㎡ | | 任意 |
| structure | 建物構造 | select | 建物 | BUILDING_STRUCTURE | | | 手入力 |
| aboveFloors | 地上階 | number | 建物 | | 階 | | |
| basementFloors | 地下階 | number | 建物 | | 階 | | |
| layout | 間取り | text | 建物 | | | layoutType | auto |
| parking | 駐車場 | select | 建物 | PARKING_HOUSE | | | |
| builtYearMonth | 築年月 | text | 建物 | | | | 手入力 |
| renovYearMonth | 増改築年月 | text | 建物 | | | | 手入力 |
| roadKind | 接道種別 | select | 法令 | ROAD_KIND | | roadType | auto |
| roadWidth | 接道幅員 | text | 法令 | | m | roadWidth | auto |
| roadDirections | 接道方向 | multiselect | 法令 | DIRECTION | | | 併記 |
| cityPlanning | 都市計画 | multiselect | 法令 | CITY_PLANNING | | | 併記 |
| useDistrict | 用途地域 | multiselect | 法令 | USE_DISTRICT | | zoningDistrict | 自動1+追加・併記 |
| areaZone | 地域地区 | multiselect | 法令 | AREA_ZONE | | | 併記 |
| coverageRatio | 建蔽率 | number | 法令 | | ％ | buildingCoverageRatio | auto |
| floorRatio | 容積率 | number | 法令 | | ％ | floorAreaRatio | auto |
| buildingConfirm | 建築確認区分 | select | 法令 | BUILDING_CONFIRM | | | |
| rebuild | 再建築 | select | 法令 | REBUILD_STATUS | | | |
| legalRestriction | その他法令上の制限 | text | 法令 | | | | 自由 |
| equipment | 設備・条件 | text | 設備 | | | | 自由 |
| occupancy | 現況 | select | 設備 | OCCUPANCY | | occupancyStatus | mansion map再利用 |
| delivery | 引渡時期 | select | 設備 | DELIVERY_TIMING | | | |
| remarks | 備考 | text | 設備 | | | | 自由 |
| transactionType | 取引態様 | select | 会社 | TRANSACTION_TYPE | | | フッター |
| compensation | 報酬 | select | 会社 | COMPENSATION | | | フッター |
| adType | 広告 | select | 会社 | AD_TYPE | | | フッター |
| staff | 担当者 | text | 会社 | | | | フッター |
| agent | 取引士 | text | 会社 | | | | フッター |
| specialNotes | 特記事項 | text | 会社 | | | | フッター |

---

### Task 1: option-master 戸建分
**Files:** Modify `src/lib/sales-sheet/option-master.ts` + test.
**Produces:** `PROPERTY_TYPE_HOUSE = ["新築戸建","中古戸建","新築テラスハウス","中古テラスハウス"]`・`BUILDING_CONFIRM = ["済","申請中"]`・`PARKING_HOUSE = ["有","無","近隣確保"]`・`REBUILD_STATUS = ["再建築可","再建築不可"]`。(既存 TAX/LAND_RIGHT/AREA_METHOD_LAND/LAND_CATEGORY/SETBACK_UNIT/TERRAIN/BUILDING_STRUCTURE/ROAD_KIND/DIRECTION/CITY_PLANNING/USE_DISTRICT/AREA_ZONE/OCCUPANCY/DELIVERY_TIMING/TRANSACTION_TYPE/COMPENSATION/AD_TYPE は再利用。)
- [ ] Step1: test 追記(4定数 toEqual)。Step2: RED。Step3: 4定数 as const 追加。Step4: GREEN。Step5: commit `feat(sales-sheet): 選択肢マスタに売戸建分を追加` + trailer。

### Task 2: HOUSE_FIELDS + 売戸建ビルダー作り直し
**Files:** Modify `field-model.ts`(HOUSE_FIELDS)・`build-document.ts`(`buildSaleHouseDocument` 作り直し+`SaleHouseInput`/`SaleHouseOverrides` 拡張+`buildHouseValues`) / Test `__tests__/build-house.test.ts`(新規)+`field-model.test.ts`。
**設計メモ:** F2-A の `buildSaleLandDocument`/`buildLandValues` と マンションの tax 実装を雛形に。上表どおり HOUSE_FIELDS を定義。`buildHouseValues`= auto(address/layoutType→layout/zoningDistrict→useDistrict先頭/ratios→coverage,floor/roadType→roadKind/roadWidth→roadWidth/occupancyStatus→occupancy[mapMansion]) + overrides。landArea=`fmtAreaWithMethod`、setback=`fmtValueWithUnit`、price=`fmtManYen`。HOUSE_SPEC_FIELDS=HOUSE_FIELDS.filter(section!=="会社")。heading="売戸建"、footer=`companyFooterDetails`。tax/taxAmount は sheet-rows の showWhen(tax=課税)で自動処理(マンション同様)。`SaleHouseInput` に photos?/floorPlanImage? 追加。**旧 house builder の呼び出し元(new/route.ts=Task3対象)を壊さないよう Overrides は加算的拡張**(deprecated deliveryTiming 等が現状 route から来るが Task3 で総入れ替え)。
- [ ] Step1: build-house.test を書く(table行に建物面積/用途地域/地目併記・**課税→うち消費税行あり/不課税→無し**・catch-band有・現況決定的・landArea合成)。field-model.test に HOUSE_FIELDS 要点(tax=select controlOnly・taxAmount showWhen・price number万円・useDistrict multiselect+autoFrom・landCategory multiselect)。Step2: RED。Step3: 実装。Step4: `vitest run src/lib/sales-sheet` フル緑+tsc0(mansion/land非回帰)。Step5: commit `feat(sales-sheet): 売戸建を自社マイソク様式に作り込み(field-model駆動)` + trailer。

### Task 3: FIELDS_BY_KIND house + route house 総入れ替え
**Files:** Modify `SalesSheetCreateButton.tsx`(`FIELDS_BY_KIND.house = HOUSE_FIELDS` + house の auto-only キー集合)・`new/route.ts`(`houseOverridesSchema` を HOUSE_FIELDS 手入力キーへ総入れ替え・buildSaleHouseDocument へ photos 渡す) / Test `__tests__/house-dialog.test.tsx`(SSR)+route house テスト更新。
**設計メモ:** F2-A の land 配線(`FIELDS_BY_KIND.land`+`LAND_AUTO_ONLY_KEYS`+land schema総入れ替え+seedPhotos)と全く同じ形を house に。house の auto-only キー = autoFrom があり Overrides に無いもの(address/layout/roadKind/coverageRatio/floorRatio/occupancy… occupancy は override 可なので除外・land と同基準で導出)。route: houseOverridesSchema を HOUSE_FIELDS 手入力キー(multiselect=array)へ・`buildSaleHouseDocument({property:{…, layoutType}, photos, overrides})`。mansion/land/building 経路不変。
- [ ] Step1: house-dialog SSR test(house で HOUSE_FIELDS widget=select/地目checkbox/number単位・消費税select・会社section)+route house test(新schemaで multiselect受理・課税で「うち消費税」行・用途地域併記)。Step2: RED。Step3: 実装。Step4: tsc0+**full vitest**緑+eslint0。Step5: commit `feat(sales-sheet): 売戸建をfield-model駆動ダイアログ/routeに配線` + trailer。

### Task 4: parity + 全ゲート + PR
- [ ] Step1: parity(renderers/schema 無変更・parityテスト緑)。Step2: フルゲート(tsc0/full vitest/build/eslint0[branch変更ファイル vs f2-land base])。Step3: 提出前レビュー feature-dev:code-reviewer(sonnet)=parity/保存境界/画像認可/tax条件/mansion・land非回帰/併記/テスト妥当性。Step4: push→`gh pr create --base feat/sales-sheet-f2-land --title "feat(sales-sheet): 売戸建を自社マイソク様式に(F2-B)"`(⚠**base=f2-land**=スタックPR。f2-landマージ後にGitHubが自動でmainへretarget)。Step5: `@codex review`→codex-triage。**マージはユーザー(順序=F2-A→F2-B)**。

## Self-Review
- Spec: option(T1)/HOUSE_FIELDS+builder:消費税・併記・建物面積・合成(T2)/dialog+route(T3)/parity・ゲート・PR(T4)。
- スコープ: 売戸建のみ。base=f2-land(スタック)。一棟=F2-C は別途。
- 割り切り: structure/builtYearMonth は手入力(house に建物relation非配線=現行踏襲)。接道方向のみ複数選択。areaMethod/setbackUnit は controlOnly合成。写真最大3。
