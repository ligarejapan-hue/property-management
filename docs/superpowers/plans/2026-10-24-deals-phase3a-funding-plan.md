# 取引・帳票 段3前半(資金計画表の画面) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 取引ごとに資金計画表(購入/売却)を入力・計算し、ローン3パターンの比較と、PDF と同じ HTML のプレビューを画面で見られるようにする。

**Architecture:** 入力は `deals.plan_inputs.funding`(JSONB・DB 変更なし)。計算は `src/lib/deals/calc/funding-plan.ts` の純粋関数で、既存の `computeDealCalc`(手数料・印紙・精算)の結果を使う。書類の HTML は自動で無害化する小さな組み立て関数(`src/lib/deals/documents/html.ts`)で作り、画面のプレビュー(iframe srcDoc)と段3後半の PDF で同じものを使う。

**Tech Stack:** Next.js 16 app router / Prisma 7 / zod 4 / vitest 4(env=node)

**Spec:** `docs/superpowers/specs/2026-10-23-deals-documents-design.md`(§4・§5「資金計画表」・§6 段3)+ 発注者の依頼書 3.6・3.7・4.1

## 段3の分け方(Ruling)

段3は「前半=画面・計算・プレビュー(この計画)」「後半=PDF(何ページにもなる出し方)・Excel(ExcelJS・数式)・発行履歴・保存とファイルを開く権限・ロゴ/角印/文面の設定」の2つの PR に分ける。— 1つの PR が大きすぎるとレビューの往復が増えるため(設計 §6 は段5で同じ分け方を認めている)— 間違っていた場合の損: PR が1つ増えるだけ。

## Global Constraints

- DB の変更なし(`plan_inputs` 列は段1で作成済み)。新しい部品なし(ExcelJS は後半)。
- 金額は整数(円)・率は 1/100 %(bp)。端数は関数ごとにコメントで明記。
- テストは架空のデータだけ。前職 Excel の会社名・氏名・文面は使わない。
- リースバックは扱わない。
- 画面の文言は平易な日本語。画面名を書いたらリンク。

## Ruling: HTML は TSX でなく自動無害化の組み立て関数で作る

設計 §1 は「書類ごとに React 部品(TSX)をサーバーで HTML に」としたが、このリポは Next の route で `react-dom/server` を避けている(`src/lib/sales-sheet/render-html.ts` 冒頭の注記=react-server バンドルと衝突)。代わりに `html` タグ付きテンプレート(差し込む値はすべて自動でエスケープ・生の HTML は `raw()` を明示したときだけ)で組み立てる。無害化の約束(設計の理由)は保たれる。— 間違っていた場合の損: 後で TSX に移すなら書類ごとに書き換え。

## 入力の形(`plan_inputs.funding`)

```ts
fundingInputsSchema = z.object({
  mode: z.enum(["purchase", "sale"]),
  customerName: text(100),                 // お客様名(購入・売却で共通)
  stampShare: z.enum(["full", "half"]),    // 契約書の印紙: 全額/折半
  purchase: z.object({
    registrationTransfer: yenInt.nullable(),     // 所有権移転登記(空なら取引の「登記費用」)
    registrationPreservation: yenInt.nullable(), // 保存登記(土地は出さない)
    registrationMortgage: yenInt.nullable(),     // 抵当権設定登記
    scrivenerFee: yenInt.nullable(),             // 司法書士報酬
    loanFeeType: z.enum(["fixed", "rate"]),
    loanFeeFixed: yenInt.nullable(),
    loanFeeRateBp: z.number().int().min(0).max(10000).nullable(),
    loanGuarantee: yenInt.nullable(),
    fireInsurance: yenInt.nullable(),            // 土地は出さない
    acquisitionTax: yenInt.nullable(),           // 不動産取得税の目安(手入力・設計 §1)
    others: z.array(otherCostSchema).max(10),
    ownFunds: yenInt.nullable(),
    loanAmount: yenInt.nullable(),
    loans: z.array(z.object({ annualRateBp: 0..3000, years: 1..50 })).max(3),
  }),
  sale: z.object({
    mortgageCancellation: yenInt.nullable(),     // 空なら取引の「抹消費用」
    surveyFee: yenInt.nullable(),                // 空なら取引の「測量費」
    demolitionFee: yenInt.nullable(),            // 区分は出さない
    loanBalance: yenInt.nullable(),
    others: z.array(otherCostSchema).max(10),
    acquisitionCost: yenInt.nullable(),          // 空 = 不明(売却価格の5%)
    acquiredOn: isoDate.nullable(),              // 空なら譲渡所得税の目安は出さない
    residentialDeduction: z.boolean(),
  }),
})
```
読むときは `readFundingInputs(planInputs)`(足りない項目は初期値・壊れていれば初期値)。保存は PATCH `/api/deals/[id]` の `fundingPlan` 項目で、サーバーが `plan_inputs` の `funding` だけを差し替える(ほかの鍵=段4の事業計画書は触らない)。

## 計算の決め方(Ruling を含む)

`fundingPlanCalc(deal, dealCalc, inputs, capitalGainsRates | null)`:

**購入**
- 諸費用の行(当てはまらない行は出さない):
  仲介手数料(税込・`dealCalc.brokerage.incl`)/印紙(`stamp_contract` 表・全額か折半)/所有権移転登記(入力 ?? 取引の登記費用)/保存登記(土地以外)/抵当権設定登記/司法書士報酬/ローン事務手数料/ローン保証料/火災保険(土地以外)/固都税・管理費などの精算金(買主が払う向き=+、受け取る向き=−。決済日が無ければ行を出さず注記)/不動産取得税の目安/その他の自由行。
- 借入額 = 入力の借入額 → なければ「物件価格+事務手数料以外の諸費用−自己資金」(0未満は0)→ 自己資金も空なら物件価格。(Ruling: 定率の事務手数料は借入額で決まるので、自己資金から逆算するときは事務手数料を除いて循環を断つ — 損: 自己資金の表示が事務手数料の分だけ入力より多く出る。画面に注記する)
- 事務手数料(定率)= 借入額 × 率、円未満切り捨て。
- 合計 = 物件価格 + 諸費用合計。自己資金(表示)= 合計 − 借入額(表示は常に「合計=自己資金+借入額」が成り立つ)。
- ローンの比較: 各パターンの月返済額 = `loanPayment(借入額, 金利, 年数)`。区分のときは管理費・修繕積立金・その他の月額(精算タブの値)を足した「月々の支払総額」。

**売却**
- 費用の行: 仲介手数料(税込)/印紙/抵当権抹消(入力 ?? 取引の抹消費用)/測量費(入力 ?? 取引の測量費)/解体費(区分以外)/その他。
- ローン残債、精算金(売主が受け取る向き=+)。
- 手取り額(税引前)= 売却価格 − 費用合計 − ローン残債 + 精算金。
- 譲渡所得税の目安: 取得日があり、`capital_gains` の表が当たるときだけ。譲渡費用 = 仲介手数料+印紙+測量費+解体費+その他(Ruling: 抵当権抹消費用とローン残債は譲渡費用に入れない=税務の一般的な扱い — 損: 目安の額がずれる。注記「概算です…」を必ず付ける)。売却日 = 取引の基準日(契約日 → 決済日 → 今日)。
- 税引後の手取りの目安 = 税引前 − 税額合計。

## ファイル

- Create: `src/lib/deals/funding-schema.ts`(入力の型・初期値・`readFundingInputs`)
- Create: `src/lib/deals/calc/funding-plan.ts`(計算)+ テスト
- Create: `src/lib/deals/documents/html.ts`(`html`・`raw`・`esc`)+ テスト
- Create: `src/lib/deals/documents/layout.ts`(A4 縦の共通の型・会社情報の頭)
- Create: `src/lib/deals/documents/funding-plan.ts`(資金計画表の HTML)+ テスト
- Modify: `src/lib/deals/schemas.ts`(`dealUpdateSchema` に `fundingPlan`)・`change-values.ts`・`view.ts`(`planInputs` を読む)・`app/api/deals/[id]/route.ts`(funding だけ差し替え)
- Create: `src/app/api/deals/[id]/funding-plan/preview/route.ts`(POST: 保存前の入力で計算+HTML を返す)
- Create: `src/app/(dashboard)/deals/[id]/funding-plan/page.tsx`・`src/components/deals/funding-plan-form.tsx`
- Modify: 取引の詳しい画面に「資金計画表」へのリンク
- Modify: `public/docs/guide.html`・`manual.html`

## Tasks

### Task 1: 入力の形と読み込み
- [ ] テスト先行: 初期値・壊れた JSON は初期値・足りない項目の補い・`loans` は3つまで・金利 0〜30%・年数 1〜50 の範囲外は 422 相当(ZodError)。
- [ ] 実装 → 緑 → commit。

### Task 2: 資金計画の計算
- [ ] テスト先行(架空の取引):
  - 購入・区分・価格 30,000,000・税率10%・手数料の表あり → 仲介手数料 1,056,000。借入 40,000,000・年1.0%・35年 → 月 112,914(依頼書の例)。管理費 20,000+修繕 10,000 → 月々 142,914。
  - 借入額の入力なし・自己資金 5,000,000 → 借入額 = 価格+諸費用(事務手数料除く)− 5,000,000。合計 = 自己資金(表示)+借入額。
  - 自己資金も借入額も空 → 借入額 = 価格。
  - 定率 2.2% → 事務手数料 = floor(借入額×0.022)。
  - 土地 → 保存登記・火災保険の行が無い。区分以外 → 月々の支払総額に管理費が無い。
  - 決済日なし → 精算金の行なし+注記。
  - 売却・取得日 2015-03-01・売却 2026 年・取得費空 → 5% で計算・長期・注記付き。取得日なし → 税の目安なし。
  - 手取り = 価格 − 費用 − 残債 + 精算金。区分 → 解体費の行なし。
- [ ] 実装 → 緑 → commit。

### Task 3: 保存(PATCH の `fundingPlan`)
- [ ] route テスト先行: `fundingPlan` を送ると `plan_inputs.funding` だけ変わり、ほかの鍵は残る/版の番号で 409/監査は項目名だけ。
- [ ] 実装 → 緑 → commit。

### Task 4: 書類の HTML(無害化+資金計画表)
- [ ] テスト先行: `html` は差し込む値の `<>&"'` を必ずエスケープ・配列は連結・`raw` だけ素通し。資金計画表の HTML に、お客様名(記号入りでもエスケープ)・合計・月返済額・「概算です…」の注記が出る。購入/売却で出る行が変わる。外部 URL を含まない(`http` を含まない)。
- [ ] 実装 → 緑 → commit。

### Task 5: プレビュー API
- [ ] route テスト先行: 権限(deal:read)・404・入力の検証 422・返す `{ calc, html }`・no-store。
- [ ] 実装 → 緑 → commit。

### Task 6: 画面
- [ ] ソース走査テスト先行: 購入/売却の切り替えボタン・ローン3つまで(4つ目の追加ボタンを出さない)・プレビューは iframe の `srcDoc`+`sandbox`・保存は版の番号で 409 を知らせる・取引の画面からリンク。
- [ ] 実装(入力は文字のまま持ち保存時に検証=段2の `textify` の型)→ 緑 → commit。

### Task 7: 使い方ガイド・マニュアル+全部の確認
- [ ] `public/docs` に資金計画表の説明を足す。
- [ ] tsc / vitest 全部 / eslint 変更ファイル / build。

## Review Focus

1. 購入と売却を切り替えても、もう一方の入力とお客様名が消えない(保存も両方を持つ)。
2. 金額の欄に「3000万」など読めない値 → 保存せずに知らせる(0 にしない)。
3. 決済日・手数料の表・譲渡所得の表が無い取引でも画面が落ちず、無い理由が出る。
4. お客様名に `<script>` などが入っても、プレビューで実行されない(エスケープ+iframe sandbox)。
5. 取引のほかのタブでの保存と、資金計画表の保存がぶつかったら 409 で知らせる(黙って上書きしない)。
