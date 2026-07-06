# 販売図面 自社様式化 F2-A(売土地) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 売土地の販売図面ひな型を、F1(売マンション)と同じ自社マイソク様式(キャッチ帯/写真+セールスポイント/スペック表=field-model駆動/会社フッター)に作り直し、あわせてF1の版面レイアウトを全種別で再利用できる共通関数に抽出し、作成ダイアログを種別駆動へ一般化する(戸建・一棟のF2-B/Cが横展開だけで済む土台)。

**Architecture:** F1で作った `buildSaleMansionDocument` の版面(catch band/heading/price/spec table/sales points/company footer/floor-plan slot)を、種別非依存の `buildSpecSheetDocument(parts)` に抽出。売土地は新 `LAND_FIELDS`(field-model)+`buildSheetRows`+`buildSpecSheetDocument` で自社様式を生成。作成ダイアログ(`SalesSheetCreateButton.tsx`)は現在マンション専用の field-model 駆動を `FIELDS_BY_KIND` で土地にも適用。route の土地 override schema を field-model キーへ総入れ替え。**新規element型/schema/migration/依存の追加なし。**

**Tech Stack:** Next.js(App Router)/ React client / TypeScript / Zod / vitest(env=node)。既存 sales-sheet ドキュメントモデル(mm絶対配置A4横)+ F1機構(option-master/field-model/sheet-rows/occupancy)。

## Global Constraints

- **既存ドキュメント部品のみ**(text/image/table/shape/qr)。`document-schema.ts` 不変。**schema/migration/新規依存なし。**
- **F1機構を最大限再利用**: `sheet-rows.buildSheetRows`(単位付与/showWhenスキップ/multiselect併記" / "/controlOnly除外)、`field-model.SheetField`、`option-master`、`occupancy.ts`(決定的写像)、`build-document.ts` の `photoElements`/`fmtExclusiveArea`(→汎用化)/`fmtYen`/`NAVY,RED,FONT,COMPANY`。
- **売土地の決め事**(F1ブレストで確定・入力方式マップ準拠): **消費税欄なし**(土地は非課税)。単価は万円。**複数選択(チェック・図面へ" / "併記)= 地目・地域地区・都市計画・用途地域・接道方向**。プルダウン選択肢=御社Excel「物件情報項目リスト」準拠。用途地域は自動(zoningDistrict)1件+手動追加。
- **レイアウト**: F1マンションと同一の版面(キャッチ上帯/左=写真+セールスポイント/右=スペック表/下=会社フッター2行)。座標はマンションから抽出した共通関数をそのまま使う。
- **二重レンダラparity厳守**(`SalesSheetRenderer.tsx`/`render-html.ts`)。今回も既存element型のみ=レンダラ改修不要のはず・parityテスト緑を確認。
- **他ビルダー(売マンション/戸建/一棟)を壊さない**。特にマンションは抽出リファクタ後も出力不変(既存テスト緑維持)。
- 全ゲート: `tsc`0 / full `vitest run` 緑 / `next build` / eslint 差分0。commit末尾に Co-Authored-By + Claude-Session 行。
- worktree=`property-management-worktrees/sales-sheet-f2-types`・branch=`feat/sales-sheet-f2-land`。

## 売土地スペック表(LAND_FIELDS)— 確定仕様

`section` は 価格/所在/土地/法令/設備/会社。widget/options/unit/autoFrom/controlOnly は F1 の `SheetField` と同義。auto=物件データ自動反映。

| key | label | widget | section | options(master) | unit | autoFrom | 備考 |
|---|---|---|---|---|---|---|---|
| propertyType | 物件種目 | select | 価格 | PROPERTY_TYPE_LAND(売地/借地権/底地権) | | | 手入力(DB種別と非1:1) |
| bestUse | 最適用途 | select | 価格 | BEST_USE_LAND | | | 任意 |
| price | 価格 | number | 価格 | | 万円 | | |
| unitPrice | 坪/㎡単価 | number | 価格 | | 万円 | | 任意 |
| address | 所在地 | text | 所在 | | | address | |
| access | 交通 | text | 所在 | | | | |
| landArea | 土地面積 | number | 土地 | | | | **areaMethod と合成**="◯㎡（実測）"(unit無・buildLandValuesで組立) |
| areaMethod | 面積計測方式 | select | 土地 | AREA_METHOD_LAND(公簿/実測) | | | controlOnly(landAreaへ合成) |
| landCategory | 地目 | multiselect | 土地 | LAND_CATEGORY | | | 併記 |
| privateRoad | 私道負担 | number | 土地 | | ㎡ | | |
| terrain | 地勢 | select | 土地 | TERRAIN | | | |
| setback | セットバック | number | 土地 | | | | **setbackUnit と合成**="◯m"/"◯㎡" |
| setbackUnit | ｾｯﾄﾊﾞｯｸ単位 | select | 土地 | SETBACK_UNIT(m/㎡) | | | controlOnly(setbackへ合成) |
| buildCondition | 建築条件 | select | 土地 | PRESENCE(有/無) | | | |
| roadKind | 接道種別 | select | 法令 | ROAD_KIND(公道/私道) | | roadType | auto |
| roadWidth | 接道幅員 | text | 法令 | | m | roadWidth | auto |
| roadDirections | 接道方向 | multiselect | 法令 | DIRECTION(8方位) | | | 併記 |
| cityPlanning | 都市計画 | multiselect | 法令 | CITY_PLANNING | | | 併記 |
| landPermit | 国土法届出 | select | 法令 | LAND_ACT_NOTICE(要/届出中/不要) | | | |
| useDistrict | 用途地域 | multiselect | 法令 | USE_DISTRICT | | zoningDistrict | 自動1件+手動追加・併記 |
| areaZone | 地域地区 | multiselect | 法令 | AREA_ZONE | | | 併記 |
| coverageRatio | 建蔽率 | number | 法令 | | ％ | buildingCoverageRatio | auto |
| floorRatio | 容積率 | number | 法令 | | ％ | floorAreaRatio | auto |
| legalRestriction | その他法令上の制限 | text | 法令 | | | | 自由 |
| equipment | 設備・条件 | text | 設備 | | | | 自由 |
| occupancy | 現況 | select | 設備 | OCCUPANCY_LAND(更地/上物有) | | occupancyStatus | 決定的写像(下記) |
| delivery | 引渡時期 | select | 設備 | DELIVERY_TIMING | | | |
| remarks | 備考 | text | 設備 | | | | 自由 |
| transactionType | 取引態様 | select | 会社 | TRANSACTION_TYPE | | | フッター |
| compensation | 報酬 | select | 会社 | COMPENSATION | | | フッター |
| adType | 広告 | select | 会社 | AD_TYPE | | | フッター |
| staff | 担当者 | text | 会社 | | | | フッター |
| agent | 取引士 | text | 会社 | | | | フッター |
| specialNotes | 特記事項 | text | 会社 | | | | フッター |

**現況の決定的写像(occupancy.ts に追加)**: `mapOccupancyStatusToLandOccupancy(status)` = vacant→"更地" / occupied→"上物有" / その他(unknown・null)→undefined(手動)。ビルダーは `o.occupancy ?? mapLand(occupancyStatus)`(mansion と同じくタイミング非依存)。ダイアログの現況プレビュー seed も同関数。

---

### Task 1: 版面レイアウトを種別非依存に抽出(mansion リファクタ・出力不変)

**Files:** Modify `src/lib/sales-sheet/build-document.ts` / Test 既存 `__tests__/build-mansion.test.ts`(緑維持) + 新規 `__tests__/spec-sheet-document.test.ts`

**Interfaces — Produces:**
- `interface SpecSheetParts { heading: string; priceText: string; rows: {label:string;value:string}[]; photos?: {fileUrl:string}[]; catchCopy?: string; salesPoints?: string[]; footerDetails?: string; floorPlanImage?: {fileUrl:string}|null }`
- `function buildSpecSheetDocument(parts: SpecSheetParts): SalesSheetDocument` — F1マンションの要素構成(catch-band/catch-copy/heading/price/overview table/sales-points/company/company-details/photos/floor-plan)をそのまま生成する純関数。座標・スタイルは現行 `buildSaleMansionDocument`(build-document.ts:405-438)と同一。

- [ ] **Step 1: 抽出前に mansion 出力のスナップショット的テストを足す(RED不要・現状固定)** — `build-mansion.test.ts` に「catch-band/heading/price/overview/sales-points/company/company-details 要素が存在し座標が既知値」アサートを追加(未あれば)。実行して緑。
- [ ] **Step 2: `buildSpecSheetDocument` を新設** — 現行 `buildSaleMansionDocument` の要素生成部(catchCopy/heading/priceText/rows/salesPoints/footerDetails/floorPlanImage/photos を引数化)を切り出す。`spec-sheet-document.test.ts` で「与えた rows がtable要素に入る/catchCopy空でもshape出る/floorPlanImage指定時のみimage」を検証。
- [ ] **Step 3: `buildSaleMansionDocument` を `buildSpecSheetDocument` 呼び出しに置換** — `values`→`rows`算出は既存のまま、要素構成のみ委譲。heading/priceText/footerDetails/salesPoints/floorPlanImage を渡す。
- [ ] **Step 4: 既存 mansion テスト + 新テストが全緑**(`npx vitest run src/lib/sales-sheet` フル)。出力不変を確認。
- [ ] **Step 5: Commit** `refactor(sales-sheet): 版面レイアウトを buildSpecSheetDocument に抽出(mansion出力不変)` + trailer。

---

### Task 2: 選択肢マスタに売土地分を追加(option-master 拡張・純定数)

**Files:** Modify `src/lib/sales-sheet/option-master.ts` / Test `__tests__/option-master.test.ts`(追記)

**Interfaces — Produces(readonly string[]):** `PROPERTY_TYPE_LAND`(売地/借地権/底地権)・`BEST_USE_LAND`(住宅用地/マンション用地/店舗用地/事務所用地/工業用地/その他)・`AREA_METHOD_LAND`(公簿/実測)・`SETBACK_UNIT`(m/㎡)・`DIRECTION`(北/北東/東/南東/南/南西/西/北西)・`LAND_ACT_NOTICE`(要/届出中/不要)・`OCCUPANCY_LAND`(更地/上物有)。既存(`USE_DISTRICT`/`LAND_CATEGORY`/`TERRAIN`/`CITY_PLANNING`/`AREA_ZONE`/`ROAD_KIND`/`DELIVERY_TIMING`/`TRANSACTION_TYPE`/`COMPENSATION`/`AD_TYPE`/`PRESENCE`)は再利用。

- [ ] **Step 1: テスト追記**(`option-master.test.ts`): 上記7定数の membership/length を `toEqual`。例 `expect(M.OCCUPANCY_LAND).toEqual(["更地","上物有"])`・`expect(M.DIRECTION.length).toBe(8)`・`expect(M.PROPERTY_TYPE_LAND).toEqual(["売地","借地権","底地権"])`。
- [ ] **Step 2: RED 確認**(`npx vitest run .../option-master.test.ts`)。
- [ ] **Step 3: 実装**(`as const` で7定数を追加)。
- [ ] **Step 4: GREEN**。
- [ ] **Step 5: Commit** `feat(sales-sheet): 選択肢マスタに売土地分を追加` + trailer。

---

### Task 3: LAND_FIELDS + 売土地ビルダー作り直し

**Files:** Modify `src/lib/sales-sheet/field-model.ts`(`LAND_FIELDS` 追加)・`src/lib/sales-sheet/occupancy.ts`(`mapOccupancyStatusToLandOccupancy`)・`src/lib/sales-sheet/build-document.ts`(`buildSaleLandDocument` 作り直し + `SaleLandInput`/`SaleLandOverrides` 拡張 + `buildLandValues`) / Test `__tests__/build-land.test.ts`(新規)・`field-model.test.ts`(LAND_FIELDS の要点)・`occupancy.test.ts`(land写像)

**Interfaces:**
- Consumes: `buildSpecSheetDocument`(T1)・`buildSheetRows`・option-master(T2)・`SheetField`。
- Produces: `LAND_FIELDS: readonly SheetField[]`(上表)。`buildSaleLandDocument(input)` が自社様式 document を返す(旧 baseSheet 版を置換)。`SaleLandInput` は `property{address,zoningDistrict,buildingCoverageRatio,floorAreaRatio,roadType,roadWidth,occupancyStatus}` + `photos?` + `floorPlanImage?` + `overrides?`(下記)。`SaleLandOverrides` は LAND_FIELDS の手入力キー全域(propertyType/bestUse/price/unitPrice/access/landArea/areaMethod/landCategory[]/privateRoad/terrain/setback/setbackUnit/buildCondition/roadDirections[]/roadWidth/cityPlanning[]/landPermit/useDistrict[]/areaZone[]/legalRestriction/equipment/occupancy/delivery/remarks/transactionType/compensation/adType/staff/agent/specialNotes/catchCopy/salesPoints[])。

**設計メモ(実装者向け):**
- **build-document.ts の mansion 実装(buildMansionValues/mansionFooterDetails/fmtExclusiveArea/buildSaleMansionDocument)を雛形として読む。** 土地版はほぼ写経+土地の項目差し替え。
- `fmtExclusiveArea(area,method)` を汎用 `fmtValueWithUnit`/`fmtAreaWithMethod` に一般化して landArea×areaMethod("◯㎡（実測）")・setback×setbackUnit("◯m") に使う(DRY・sheet-rows二重付与回避のため landArea/setback フィールドは unit を持たせない)。
- `buildLandValues(input)`: auto(address/zoningDistrict→useDistrict先頭/buildingCoverageRatio→coverageRatio/floorAreaRatio→floorRatio/roadType→roadKind/roadWidth→roadWidth/occupancyStatus→occupancy[mapLand]) + overrides。useDistrict は `[zoningDistrict, ...o.useDistrict].filter(非空)`。
- 会社フッター2行目は mansion と同じ `footerDetails`(取引態様/報酬/広告/担当/取引士/特記)。土地は heading=「売土地」+(bestUse等は表側)・priceText=`${price}万円`。
- **消費税フィールドは持たない**(LAND_FIELDS に tax/taxAmount 無し)。
- 写真枚数は現行どおり(route が土地=1枚 seed だが、自社様式は最大3枚レイアウト対応の `photoElements` を使う=1枚でも可)。

- [ ] **Step 1: テスト(build-land.test.ts)を書く(要点)** — 入力(property+overrides)→ (a)table行に「用途地域」「地目」等が入る (b)地目の複数選択が" / "併記 (c)tax行が存在しない (d)catch-band要素が存在 (e)現況が override無で occupancyStatus から決定的("vacant"→"更地") (f)landArea が areaMethod と合成("150.5㎡（実測）")。field-model.test.ts に LAND_FIELDS の要点(priceはnumber/万円・useDistrictはmultiselect+autoFrom zoningDistrict・tax不在・landCategoryはmultiselect)。occupancy.test.ts に mapLand の3分岐。
- [ ] **Step 2: RED 確認**。
- [ ] **Step 3: 実装**(occupancy.ts の land写像 → field-model の LAND_FIELDS → build-document の fmt汎用化+buildLandValues+buildSaleLandDocument 置換)。旧 `buildInitialSalesSheetDocument`(land builder を包む legacy)が壊れないこと(型が合うよう SaleLandInput 後方互換 or 呼び出し側調整・使用箇所を grep 確認)。
- [ ] **Step 4: `npx vitest run src/lib/sales-sheet` フル緑**(mansion 非回帰含む)+ `tsc --noEmit` 0。
- [ ] **Step 5: Commit** `feat(sales-sheet): 売土地を自社マイソク様式に作り込み(field-model駆動)` + trailer。

---

### Task 4: 作成ダイアログを種別駆動へ一般化(土地) + route の土地 override 総入れ替え

**Files:** Modify `src/components/sales-sheet/SalesSheetCreateButton.tsx`・`src/app/api/properties/[id]/sales-sheets/new/route.ts` / Test `__tests__/land-dialog.test.tsx`(新規・SSR)・route テスト(land ケース更新)

**設計メモ:**
- **現状**: ダイアログはマンションのみ `MANSION_FIELDS` 駆動(widget描画・disabledプレビュー・showWhen・occupancySeed)、土地/戸建/一棟は旧 `FIELD_SETS`。route はマンションのみ field-model 総入れ替え済、土地は旧 `landOverridesSchema`。
- **一般化**: ダイアログに `FIELDS_BY_KIND: Record<kind, SheetField[]|null>`(land→LAND_FIELDS, mansion→MANSION_FIELDS, house/building→当面 null で旧FIELD_SETS)を導入。field-model がある種別は F1 の汎用 widget 描画(select/multiselect/number単位/text/showWhen/autoFrom初期値/disabledプレビュー/会社セクション)を通す。**マンションの既存挙動は不変**(回帰テスト緑)。戸建/一棟は今回 null=従来のまま(F2-B/Cで対応)。
- route: `landOverridesSchema` を LAND_FIELDS の手入力キー(multiselect=`z.array(z.string().max(100)).max(20)`・他 string.optional)へ総入れ替え。property select は現状の土地用スカラで足りる(建物relation不要)。`buildSaleLandDocument` へ overrides + photos(最大3) を渡すよう更新(現行は photo[0] 1枚 → 自社様式は photos 複数対応なので `seedPhotos(3)` に。land も3枚に統一)。
- occupancy: land の現況プレビュー seed は `mapOccupancyStatusToLandOccupancy`。ダイアログは占有を明示編集時のみ payload に送る(mansion と同方式=タイミング非依存)。
- env=node/no jsdom → SSR 構造テスト(land ダイアログが select/multiselectチェック/number単位/showは土地に無いが会社セクション等 を描画)。マンション既存 SSR テストが緑のままであること。

- [ ] **Step 1: SSR テストを書く**(land-dialog: land 種別で LAND_FIELDS の widget が出る・地目のcheckbox群・現況select・会社セクション)+ route land テスト(新schemaで multiselect 受理・生成documentに用途地域併記/tax行なし)。
- [ ] **Step 2: RED 確認**。
- [ ] **Step 3: 実装**(ダイアログ `FIELDS_BY_KIND` 一般化 + route land schema 総入れ替え + land builder 呼び出し更新 + seedPhotos land=3)。**マンション/戸建/一棟の既存経路を壊さない**。
- [ ] **Step 4: `tsc`0 + フル `vitest run` 緑 + eslint 変更ファイル0**。
- [ ] **Step 5: Commit** `feat(sales-sheet): 作成ダイアログを種別駆動化し売土地をfield-model駆動に配線` + trailer。

---

### Task 5: parity + 全ゲート + 提出前レビュー + PR

**Files:** Verify `render-html.ts`/`SalesSheetRenderer.tsx`(既存element型のみ=変更不要のはず・parityテスト緑確認)

- [ ] **Step 1: 二重レンダラ parity 確認**(両ファイル diff 無・`render-html-parity` 系テスト緑)。土地も shape/text/table/image のみ使用。
- [ ] **Step 2: フルゲート** — `npx tsc --noEmit`=0 / `npx vitest run`(フル)緑 / `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build`(route一覧に sales-sheet系健在) / `npx eslint <branch変更ファイル>`=0。
- [ ] **Step 3: 提出前レビュー** — `git add -A` 後 `feature-dev:code-reviewer`(sonnet)に branch 全体 diff を。ホットスポット: 二重レンダラparity / 保存境界(assertSavableDocument・座標≤bounds・z≥0) / 画像認可(seedPhotos) / occupancy 決定性(land) / mansion 非回帰(抽出リファクタ) / 複数選択併記・tax不在 / テスト妥当性。
- [ ] **Step 4: push & PR** — `git push -u origin feat/sales-sheet-f2-land` → `gh pr create --base main --title "feat(sales-sheet): 売土地を自社マイソク様式に(F2-A)" --body "<平易な日本語: 概要/実装/テスト/セキュリティ + 🤖行>"`。
- [ ] **Step 5: @codex** — `gh pr comment <PR> --body "@codex review"` → codex-triage。**マージはユーザー(F2-B/C=戸建・一棟は本PRマージ後 or 本ブランチ上に継続)**。

## Self-Review(計画作成者)
- Spec coverage: 版面抽出(T1)/選択肢(T2)/LAND_FIELDS+ビルダー:併記・tax不在・合成・occupancy決定性(T3)/ダイアログ種別駆動+route(T4)/parity・ゲート・PR(T5)。
- スコープ: 売土地のみ(F2-A)。戸建=F2-B・一棟=F2-C は本土台(buildSpecSheetDocument+FIELDS_BY_KIND)の上で横展開。住宅以外一部(店舗/事務所)はテンプレ種別が現状 null=別途マッピング判断(F3以降)。
- Type consistency: `buildSpecSheetDocument`/`SpecSheetParts`/`LAND_FIELDS`/`buildLandValues`/`SaleLandOverrides`/`mapOccupancyStatusToLandOccupancy`/option-master 追加定数名を T 間で一致。mansion 抽出後も `buildSaleMansionDocument` シグネチャ不変。
- 割り切り: 接道は種別/幅員/方向(方向のみ複数選択)を各行で表現(多方向×多幅員の完全表現はしない・実務は主接道1本が大半)。areaMethod/setbackUnit は controlOnly で値へ合成。写真は土地も最大3枚に統一。
