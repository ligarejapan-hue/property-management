# 取引・帳票 段5c-1 書類確認書(契約時・決済時)と確認書の項目の設定

**Spec:** `docs/superpowers/specs/2026-10-23-deals-documents-design.md` §4.6(§4.6.1 謄本の連動は 段5c-2 で別 PR)

**Goal:** 取引の「書類」タブから書類確認書(契約時・決済時)を出す。項目は「取引の設定」で直せる(初めから一般的な項目入り)。

## Global Constraints
- DB の変更なし(`deal_settings.checklist_items` は段1で作ってある列を使う)。新しい部品なし。
- 金額は整数の円。持参する金額は決済の計算(`calc.settlement.paymentAtSettlement`)と取引の値をそのまま使う。
- 前職の文面は使わない(項目は一般的なものを新しく書く)。リースバックの項目は入れない。
- テストに実在の個人情報を入れない。

## Rulings
1. 書類の鍵は2つ(`checklist_contract`・`checklist_settlement`)。版(variant)にしない — 発行の道が業務書類を `default` 固定で持つため。書類タブに「書類確認書」のまとまりを足す。
2. 項目の形: `{id, phase: contract|settlement, group: prepare|bring|receive, label, note, scope: all|unit|land|oc, amount: deposit|payment|registration|cancellation|survey|null}`。金額は「持参するもの」だけ。`land` = 元の種別が戸建・土地・一棟。
3. 設定に保存した項目が空・壊れているときは初めの項目を使う。保存は1件以上(全部消して保存はできない=「初めの項目に戻す」ボタンで戻す)。
4. チェックは紙に手で付ける(チェック欄は空欄で出す)。払い方(現金/手付金から/残金から)は発行のときに選ぶ(段5a の読み替えと同じ=取引には保存しない・発行の履歴に残る)。`checklist_state` 列は今回使わない(後で使うときも列はある)。
5. 営業担当・業務担当の名前は、発行・確認の道でユーザーの名前を引いて渡す(`BusinessDocContext.staff`・無いときは「—」)。
6. 出す前の確認: 日時(契約日時/決済日時)・売主・買主。決済時で残代金・精算金の計算ができていなければ確認に出す(止めはしない=金額欄は「—」)。
7. 最後の行は承認欄(営業担当・業務担当・承認の3つの空欄)。

## Tasks
1. `src/lib/deals/checklist.ts`(項目の形・初めの項目・出し分け・金額)+テスト
2. 設定: `settings.ts`/`schemas.ts` に `checklistItems`+設定の画面に編集の部品+テスト
3. 書類: `business/checklist-doc.ts`+一覧表2行+`issue.ts`+担当者名+書類タブ(まとまり・払い方の選択)+テスト
4. 説明書(guide/manual)の更新
