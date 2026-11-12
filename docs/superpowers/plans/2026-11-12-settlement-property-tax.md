# 精算の固都税の作り直し Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 取引の精算で、土地・建物ごとの課税標準額(+持分)から固都税を自動で出し(手で直せる)、課税業者なら建物分の精算金に消費税を足し、日割りと消費税の円未満を四捨五入にする。

**Architecture:** 保存は今の `Deal.settlementTerms`(Json)に項目を足すだけ(migration なし)。税額の計算は新しい純関数 `calc/property-tax.ts`、精算の行は `calc/settlement.ts` が作る。課税業者かどうかは `sellerTaxable ?? 売主の当事者に isSelf がいるか` を `deal-calc.ts` で決めて渡す。

**Tech Stack:** Next.js / TypeScript / zod / Prisma / vitest(env=node・UI は renderToStaticMarkup とソース文字列)

**Spec:** `docs/superpowers/specs/2026-11-12-settlement-property-tax-design.md`

## Global Constraints

- migration・schema.prisma の変更なし。新しい依存なし。
- 税額の自動計算: `b = floor(base × shareNum ÷ shareDen ÷ 1000) × 1000`、`tax = floor(b × rateBp ÷ 10000 ÷ 100) × 100`、固定資産税 rateBp=140・都市計画税 rateBp=30。浮動小数を通さない(BigInt か整数の順序で)。
- 日割り(固都税・管理費等・賃料・事業計画の保有コスト)と建物分の消費税の円未満は四捨五入。売買代金の建物消費税・仲介手数料は変えない。
- 課税業者 かつ `taxInputMode="total"` は精算の欄からの保存で 422「売主が課税業者の取引は、土地・建物ごとに入力してください」。
- 精算金領収書に消費税額・税率・登録番号は載せない(行の名前が増えるだけ)。
- 行の表示名: 「固定資産税・都市計画税(土地)」「固定資産税・都市計画税(建物)」「建物分の消費税」。合計額のときは「固定資産税・都市計画税」。
- commit/PR に本物の住所・顧客情報を書かない(リポジトリは公開)。

## Review Focus

1. 持分の分母0・分子>分母・空の課税標準額 → zod で弾く/空は自動の値なし(0扱い)。Task 1・2 にテスト。
2. 手で入れた税額が 0 → 0 として使う(null=自動 と区別)。Task 1 にテスト。
3. 建物の行だけ手で直した精算金(`settlement.propertyTaxBuilding` の上書き)→ 消費税は上書き後の値に掛かる。Task 4 にテスト。
4. OC タブ(depositMode だけ変えて settlementTerms を送る)と管理費だけの保存が、課税業者+合計額の今の取引で止まらない(固都税の部分が変わったときだけ止める)。Task 5 にテスト。
5. .5 ちょうどの日割り(例 年税額 730円×183日÷365日=366.0…は整数・366×… で .5 になる組)→ 切り上げ。Task 3 にテスト。

---

### Task 1: 税額の自動計算(純関数)

**Files:**
- Create: `src/lib/deals/calc/property-tax.ts`
- Test: `src/lib/deals/calc/__tests__/property-tax.test.ts`

**Interfaces:**
- Produces:
  - `type TaxItem = { kind: "land" | "building"; label: string | null; fixedBase: number | null; cityBase: number | null; shareNum: number; shareDen: number; fixedTax: number | null; cityTax: number | null }`(Task 2 の zod の出力型と同じ形。Task 2 では `z.output` を使い、ここは型を import し直す)
  - `taxFromBase(base: number, shareNum: number, shareDen: number, rateBp: number): number`
  - `itemTaxes(item: TaxItem): { fixedAuto: number | null; cityAuto: number | null; fixed: number; city: number }`(auto は課税標準額が null なら null。fixed/city = 手で入れた値 ?? auto ?? 0)
  - `annualByKind(items: TaxItem[]): { land: number; building: number }`(各行 fixed+city を区分ごとに合計)
  - 定数 `FIXED_ASSET_RATE_BP = 140`、`CITY_PLANNING_RATE_BP = 30`

- [ ] **Step 1: 失敗するテスト**
  - `taxFromBase(10_000_999, 1, 1, 140) === 140_000`(10,000,000×1.4%)
  - `taxFromBase(1_234_567, 1, 1, 140) === 17_200`(1,234,000×1.4%=17,276→17,200)
  - `taxFromBase(1_234_567, 1, 1, 30) === 3_700`(1,234,000×0.3%=3,702→3,700)
  - 持分: `taxFromBase(50_000_000, 1234, 100000, 140) === 8_600`(617,000×1.4%=8,638→8,600)
  - `itemTaxes({...fixedBase:null, cityBase:null, fixedTax:null, cityTax:null})` → `{ fixedAuto:null, cityAuto:null, fixed:0, city:0 }`
  - 手で 0: `fixedTax:0` → `fixed === 0`(auto があっても)
  - `annualByKind` が土地2行・建物1行を区分ごとに足す
- [ ] **Step 2:** `npx vitest run src/lib/deals/calc/__tests__/property-tax.test.ts` → FAIL(モジュールが無い)
- [ ] **Step 3:** 実装(BigInt で `base*shareNum/(shareDen*1000)` を切り捨て)
- [ ] **Step 4:** 同じコマンドで PASS
- [ ] **Step 5:** commit `feat(deals): 課税標準額から固都税を出す計算`

### Task 2: 入力の型と読み込み

**Files:**
- Modify: `src/lib/deals/schemas.ts:97-128`(settlementTermsSchema・DEFAULT_TERMS・OVERRIDE_KEYS)
- Modify: `src/lib/deals/inputs.ts`(readTerms)
- Modify: `src/lib/deals/money-forms.ts`(SETTLEMENT_OVERRIDE_KEYS)
- Test: `src/lib/deals/__tests__/inputs.test.ts`

**Interfaces:**
- Consumes: Task 1 の `TaxItem` の形
- Produces: `SettlementTerms` に `taxInputMode: "items" | "total"`、`taxItems: TaxItem[]`(max 40)、`sellerTaxable: boolean | null`。`taxItemSchema`(label=text(100)・base=yenInt.nullable・shareNum int≥1・shareDen int≥shareNum・≤10億 程度・tax=yenInt.nullable・.strict())。OVERRIDE_KEYS に `"settlement.propertyTaxLand"`, `"settlement.propertyTaxBuilding"`, `"settlement.propertyTaxBuildingVat"`。DEFAULT_TERMS: `taxInputMode:"items", taxItems:[], sellerTaxable:null`。

- [ ] **Step 1: 失敗するテスト**(inputs.test.ts)
  - 古い JSON `{fixedAssetTax:120000, cityPlanningTax:30000}`(taxInputMode 無し)→ `readTerms(...).taxInputMode === "total"`、年税額はそのまま
  - 古い JSON で年税額が両方 null → `"items"`
  - 新しい JSON の taxItems が読み戻せる
  - `shareDen < shareNum`・`shareDen=0` の行は schema で失敗(`settlementTermsSchema.safeParse(...).success === false`)
  - `readOverrides({"settlement.propertyTaxBuildingVat": 100})` が値を残す
- [ ] **Step 2:** `npx vitest run src/lib/deals/__tests__/inputs.test.ts` → FAIL
- [ ] **Step 3:** 実装。readTerms は `obj(json)` に `taxInputMode` が無いとき、`fixedAssetTax`/`cityPlanningTax` のどちらかが number なら `"total"` を補ってから DEFAULT と合わせる
- [ ] **Step 4:** PASS + `npx tsc --noEmit`(型の波及を見る。ここで落ちる呼び出し元は後のタスクで直すので、エラーの一覧を控えるだけ)
- [ ] **Step 5:** commit

### Task 3: 日割りを四捨五入に

**Files:**
- Modify: `src/lib/deals/calc/proration.ts`、`src/lib/deals/calc/business-plan.ts:112-116`(固都税と管理費の日割り。利息は変えない)
- Test: `src/lib/deals/calc/__tests__/proration.test.ts`、`settlement.test.ts`、`business-plan.test.ts`

**Interfaces:**
- Produces: `roundDiv(num: number, den: number): number`(整数どうし・四捨五入・`Math.floor((2*num + den) / (2*den))`)を `calc/format.ts` か `proration.ts` から export。Task 4 の消費税もこれを使う。

- [ ] **Step 1:** 失敗するテスト: .5 で切り上がる組(例 `prorateMonthly(31, "2026-01-17", 0)` → 15日分 31×15÷31=15 は割り切れるので不可。割り切れず .5 になる組を選ぶ: 年税額 1 円 ×183日÷366日 = 0.5 → 1)。既存の期待値 `60_493`(120,000×184÷365=60,493.15…)は変わらないことも確かめる。事業計画の固都税日割りの期待値を四捨五入で直す
- [ ] **Step 2:** `npx vitest run src/lib/deals/calc` → FAIL
- [ ] **Step 3:** 実装(docコメントの「切り捨て」も「四捨五入」に)
- [ ] **Step 4:** PASS
- [ ] **Step 5:** commit

### Task 4: 精算の行(土地・建物・消費税)

**Files:**
- Modify: `src/lib/deals/calc/settlement.ts`、`src/lib/deals/calc/deal-calc.ts`
- Test: `src/lib/deals/calc/__tests__/settlement.test.ts`

**Interfaces:**
- Consumes: Task 1 `annualByKind`、Task 3 `roundDiv`
- Produces:
  - `SettlementInput` に `sellerTaxable: boolean`、`taxRateBp: number`
  - `SettlementResult` に `taxableTotalConflict: boolean`(課税業者かつ total。画面の注意に使う)
  - `sellerTaxableOf(deal: Pick<DealView, "settlementTerms" | "parties">): boolean`(`settlementTerms.sellerTaxable ?? parties.some(p => p.role === "seller" && p.isSelf)`)を `calc/settlement.ts` に置き、deal-calc から使う
  - 行の key: `propertyTaxLand` / `propertyTaxBuilding` / `propertyTaxBuildingVat`(items)、`propertyTax`(total)

- [ ] **Step 1:** 失敗するテスト
  - items・土地 年税額120,000・建物 36,500・決済 2026-07-01・1/1起算 → 行2つ(土地 60,493 / 建物 `roundDiv(36500*184,365)`=18,400)、課税業者でないので消費税行なし
  - 同じで `sellerTaxable:true, taxRateBp:1000` → 消費税行 1,840、合計に入る
  - 建物の上書き `settlement.propertyTaxBuilding: 20000` → 消費税 2,000
  - 土地だけの取引(建物0)→ 建物・消費税の行なし
  - total+課税業者 → 1行・消費税なし・`taxableTotalConflict === true`
  - total の既存テスト(60_493・式・期間)はそのまま通る
  - 消費税行の formula `"18,400円×10%"`
- [ ] **Step 2:** `npx vitest run src/lib/deals/calc/__tests__/settlement.test.ts` → FAIL
- [ ] **Step 3:** 実装
- [ ] **Step 4:** PASS
- [ ] **Step 5:** commit

### Task 5: 保存の検証・段取り・事業計画の年税額

**Files:**
- Modify: `src/app/api/deals/[id]/route.ts`(PATCH: cur に parties の role/isSelf を読む・検証)、`src/lib/deals/schedule-sync.ts`(taxesEnteredOf)、`src/lib/deals/calc/business-plan.ts`(annualPropertyTax)
- Create/Modify: 判定の純関数は `src/lib/deals/calc/settlement.ts` に
- Test: `src/lib/deals/calc/__tests__/settlement.test.ts`、`schedule-sync` のテスト(既存のファイルに)、`business-plan.test.ts`

**Interfaces:**
- Produces:
  - `taxPartChanged(prev: SettlementTerms, next: SettlementTerms): boolean`(taxInputMode・sellerTaxable・fixedAssetTax・cityPlanningTax・taxItems のどれかが違う)
  - `annualPropertyTaxOf(t: SettlementTerms): number`(items=行の fixed+city 合計、total=2つの合計)— business-plan と taxesEntered で使う
- 検証: `patch.settlementTerms` があり、`taxPartChanged(cur, next)` かつ `next.taxInputMode==="total"` かつ `sellerTaxableOf({settlementTerms: next, parties: cur.parties})` → `ApiError(422, 文言, "TAXABLE_TOTAL_NOT_ALLOWED")`
- `taxesEnteredOf`: items なら `itemTaxes` の fixed+city>0 の行が1つ以上、total なら今のまま

- [ ] **Step 1:** 失敗するテスト: taxPartChanged(OC の depositMode だけ違う → false / taxItems が違う → true)、annualPropertyTaxOf(両モード)、taxesEnteredOf(items で課税標準額だけ入った行 → true・空の行だけ → false)
- [ ] **Step 2:** 対象のテストを実行 → FAIL
- [ ] **Step 3:** 実装(API は既存の ApiError の形に合わせる)
- [ ] **Step 4:** PASS
- [ ] **Step 5:** commit

### Task 6: 精算の画面

**Files:**
- Modify: `src/components/deals/deal-settlement-panel.tsx`
- Test: `src/lib/deals/__tests__/detail-source.test.ts`(ソースの文字列)+ 見た目の部品を切り出すならその SSR テスト

**Interfaces:**
- Consumes: Task 1 `itemTaxes`(行の自動の値を画面でも出す)、Task 2 の型、Task 4 の `taxableTotalConflict`・行の key、Task 2 の新しい OVERRIDE_KEYS

画面の決まり:
- 「入力のしかた」: 「土地・建物ごと」/「合計額だけ」(課税業者のときは「合計額だけ」を選べない+一言)
- 「売主は課税業者」チェック(表示は `sellerTaxableOf` の値。触ったら明示の値を保存)
- 行: 区分(土地/建物)・名前(任意)・固定資産税課税標準額・都市計画税課税標準額・持分(分子/分母)・固定資産税の税額・都市計画税の税額。税額の箱は空なら自動の値を薄く見せ(placeholder)、入れたら手入力。「土地を足す」「建物を足す」「消す」
- 一言: 「税額は課税標準額×1.4%(都市計画税0.3%)で出します。納税通知書と違うときは税額を直してください。」
- `taxableTotalConflict` のとき注意「課税業者の取引です。土地・建物ごとに入力し直してください」
- 手で直す欄: items なら 土地・建物・(課税業者なら)消費税 の3つ。total なら今の1つ
- 金額の欄は今と同じく文字のまま持ち、保存時に `invalidYenLabels` で検査(持分は整数)
- スマホで横にはみ出さない(行は sm 以上で横並び、それ未満は縦)

- [ ] **Step 1:** detail-source.test.ts に期待する文字(「固定資産税課税標準額」「都市計画税課税標準額」「持分」「売主は課税業者」「土地を足す」「建物を足す」「合計額だけ」)を足して FAIL
- [ ] **Step 2:** 実装
- [ ] **Step 3:** PASS + `npx eslint src/components/deals/deal-settlement-panel.tsx`
- [ ] **Step 4:** commit

### Task 7: 帳票と控えファイル

**Files:**
- Modify(必要なら): `src/lib/deals/documents/business/settlement-statement.ts`・`settlement-guide.ts`・`receipts.ts`・`checklist-doc.ts`・`src/lib/deals/request-drafts/values.ts`(key `propertyTax` 決め打ちの箇所を grep して新しい key にも対応)
- Test: `src/lib/deals/documents/__tests__/business-docs*.test.ts`、`__snapshots__/receipt-*`

- [ ] **Step 1:** `grep -rn "propertyTax" src/lib/deals/documents src/lib/deals/request-drafts` で key 決め打ちを洗い出す
- [ ] **Step 2:** items の取引(土地・建物・消費税)で精算書・ご案内・領収書の内訳に3行が出るテストを足して FAIL
- [ ] **Step 3:** 直す。領収書の控えファイルは、四捨五入と新しい行の名前を反映した出力で作り直す(差分が行名と金額だけであることを目で確かめる)
- [ ] **Step 4:** PASS
- [ ] **Step 5:** commit

### Task 8: 全ゲート

- [ ] `npx tsc --noEmit` exit 0
- [ ] `npx vitest run`(フルスイート)exit 0
- [ ] `npx eslint <変更したファイル>` exit 0
- [ ] `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build` exit 0
