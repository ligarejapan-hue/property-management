# 取引・帳票 段3後半(資金計画表の発行=PDF・Excel・履歴・開く権限)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 資金計画表を PDF(何ページでも)と Excel(数式入り)で発行し、発行履歴に残し、取引を見る権限のある人だけが開けるようにする。

**Architecture:** 発行 API が 段3前半の `buildFundingPlan` の HTML を Chromium で PDF にし、同じ計算結果から ExcelJS で数式入りの xlsx を作る。ファイルは保存場所の `deals/<取引ID>/` に置き、`deal_documents` に1行足す。ファイルは `/uploads` からは配らず(`deals/` は 404)、取引の権限を確かめる専用の道 `/api/deals/[id]/documents/[docId]/file` だけで配る。

**Tech Stack:** Next.js 16 route handlers, Prisma 7, Playwright Chromium, ExcelJS 4.4.0(新規・承認済), vitest 4

**Spec:** `docs/superpowers/specs/2026-10-23-deals-documents-design.md`(§4.7〜4.9・§5・§6 段3)

## Global Constraints

- DB の変更なし(`deal_documents` は段1で作成済み)。
- 金額は整数の円。Excel の数式セルにはサーバーの計算値を結果として入れる(spec §4.8)。月返済額は `=ROUNDDOWN(PMT(...),0)`。
- ファイル名 `取引番号_書類名_YYYYMMDD`(日本時間の発行日)。保存先 `deals/<取引ID>/`。
- 開く権限: 取引を見る権限のある人だけ。そうでない人は 404。no-store。
- 監査には取引 ID・操作・書類の種類だけ。名前・住所・金額は残さない。
- 新しい部品は ExcelJS だけ。`npm audit` を 0 件に保つため uuid を overrides で固定(承認済)。
- 前職の Excel の名前・文面は使わない。テストに実在の個人情報を入れない。

## 読み替え(Rulings)

1. **段3後半をさらに2つに分ける。** この PR = 発行・保存・履歴・開く権限・書類タブ。次の PR = ロゴ・角印・文面の設定と書類への埋め込み。理由: 発行の道と権限だけでも面が広く、設定画面(画像のアップロード)を混ぜるとレビューの焦点がぼける。資金計画表は角印を使わない書類なので、順番を入れ替えても困らない。
2. **ファイルは `/uploads` で配らない。** 既存の `/uploads` の認可は記録の逆引きで、`deals/` のキーは今でも「見つからない」=404 になる。これを明示の 404 にして、取引専用の道で配る。理由: 権限の判定を1か所(取引の権限)に閉じ、既存の複雑な認可に枝を足さない。
3. **権限が無い人は 404。** 専用の道では、取引を見る権限が無いと 403 ではなく 404 を返す(spec §4.9)。
4. **発行は保存済みの入力で行う。** 画面の「発行」は、先に入力を保存(同じ PATCH)してから発行 API を呼ぶ。発行 API はリクエストの入力ではなく DB に保存された `plan_inputs.funding` を使う。理由: 履歴の入力と保存されている入力がずれない。改ざんした入力で発行させない。
4b. **(最終レビューで追加)発行の体に、画面が保存した直後の取引の版 `version` を入れる。** 今の版と違えば 409 で発行しない(保存→発行の間にほかの人が保存した入力を、自分の名前で発行しない)。
5. **版の番号は (取引, 書類, 購入/売却) ごとに 1 から。** 一意の鍵とぶつかったら数回やり直す。
6. **ファイルを先に保存し、記録に失敗したらファイルを消す。** 記録が無いファイルは誰も開けない(専用の道は記録から引く)ので、消し損ねても漏れない。

## Review Focus

1. 権限の無い人・別の取引の docId を混ぜた URL → 404(取引 A の URL に取引 B の書類 ID を入れても開けない)。
2. Chromium が混雑・無い → 503 で、記録もファイルも残らない。
3. 同時に2人が発行 → 版の番号がぶつからず両方残る。
4. Excel の数式の結果がサーバーの計算と一致する(区分の月々の合計・売却の手取り・税引後)。
5. ファイル名に取引番号以外の利用者入力(お客様名など)が入らない。

---

### Task 1: 何ページにもなる PDF

**Files:** Modify `src/lib/sales-sheet/output.ts` / Test `src/lib/sales-sheet/__tests__/output-document-pdf.test.ts`

- `renderHtmlToPdfDocument(html)` を足す: `page.pdf({ preferCSSPageSize: true, printBackground: true })`(pageRanges なし)。同じ RENDER_GATE とネットワークの遮断を使う。
- テスト: ソース走査(pageRanges を付けない・RENDER_GATE.run の中)。Chromium がある環境だけ、2ページの HTML から 2 ページの PDF が出ること(`/Type /Page` の数)。

### Task 2: ExcelJS を入れる・資金計画表の xlsx

**Files:** `package.json`(exceljs 4.4.0・overrides uuid)/ Create `src/lib/deals/documents/funding-plan-xlsx.ts` / Test `src/lib/deals/documents/__tests__/funding-plan-xlsx.test.ts`

- `buildFundingPlanXlsx({deal, inputs, calc, company, issuedOn}): Promise<Buffer>`
- 購入: 価格・各行(空欄は出さない)・諸費用の合計 `=SUM(..)`・必要な資金 `=価格+諸費用`・借入額(値)・自己資金 `=合計-借入額`・ローンごとに 金利(%)・年数・月返済 `=ROUNDDOWN(PMT(金利/12,年数*12,-借入額),0)`(金利 0 は `=ROUNDDOWN(借入額/(年数*12),0)`)・区分は月々の合計 `=月返済+管理費等`。
- 売却: 価格・各行・費用の合計 `=SUM`・残債・精算金・敷金相殺・手取り `=価格-費用-残債+精算金-敷金`・税の目安(値)・税引後 `=手取り-税`。
- すべての数式セルに `result` としてサーバーの値。
- テスト: 読み直して、数式が入っている/結果がサーバーの計算と一致/数式を JS で評価した値とも一致(PMT の実装で)/金利 0/売却の税引後/価格なし(数式の結果が null にならない形)/お客様名が文字のまま。

### Task 3: 発行 API・一覧 API・ファイルの道

**Files:** Create `src/lib/deals/documents/issue.ts`(純関数: ファイル名・キー・版), `src/app/api/deals/[id]/documents/route.ts`(GET 一覧・POST 発行), `src/app/api/deals/[id]/documents/[docId]/file/route.ts`(GET)/ Modify `src/app/uploads/[...path]/route.ts`(`deals/` は 404), `src/lib/audit-log-detail-safety.ts`, `src/app/(dashboard)/admin/audit-logs/page.tsx`
- 発行 POST `{docType:"funding_plan"}`: requireDeal("write") → 取引と保存済みの入力 → buildFundingPlan → PDF・xlsx → upload `deals/<id>/<uuid>.pdf|.xlsx` → 版を決めて create(ぶつかれば3回まで)→ 失敗時はファイルを消す → 監査 `deal_document_issue` {docType, variant, version, formats}。
- 一覧 GET: requireDeal("read") → 新しい順。発行者は表示名だけ。
- ファイル GET `?format=pdf|xlsx`: 権限なし・別の取引・記録なし・ファイルなし → すべて 404。`Cache-Control: no-store`・`Content-Disposition` は RFC 5987。
- テスト: route テストの型で 権限・404 の各経路・no-store・監査に名前が無い・版のやり直し・失敗時の後片付け・503。

### Task 4: 書類タブと発行ボタン

**Files:** Create `src/components/deals/deal-documents-panel.tsx` / Modify `src/app/(dashboard)/deals/[id]/page.tsx`, `src/components/deals/funding-plan-form.tsx`, `src/lib/deals/client.ts` / Test ソース走査
- 取引の画面に「書類」タブ: 発行履歴(書類名・購入/売却・版・発行日時・発行者・PDF/Excel のリンク)と「資金計画表を作る」リンク。
- 資金計画表の画面に「保存して発行」: 読めない欄があれば発行しない → 保存 → 発行 → 結果のリンクを出す。503 は「混み合っています」。

### Task 5: 説明書・仕上げ

- `public/docs/guide.html`・`manual.html` に発行と書類タブを足し、「PDF・Excel はこれから」を消す。
- 全ゲート: tsc・lint・フルの vitest・build・npm audit。
