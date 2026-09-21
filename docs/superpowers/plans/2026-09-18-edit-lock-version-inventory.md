# Task 9: 版番号を進めない書き込みが無いことの確認(仕様 5.4) — 洗い出し結果

Step 1(`grep -rnE "(property|owner)\.(update|updateMany|upsert)\(|UPDATE \"?(properties|owners)\"?" src --include=*.ts | grep -v __tests__ | grep -v src/generated`)で検出した **54件**を1件ずつ開き、`data:` の中身そのもの(近くの行ではない)を読んで判定した。

判定は3つだけ:
- **要修正** = 編集画面で変えられる項目を書くのに版番号を進めていなかった → 本 Task で `version: { increment: 1 }` を追加した
- **対象外(許可)** = 編集画面で変えられない項目だけを書く(理由を明記)
- **対応済** = 元から版番号を進めていた

同じ内容を `src/lib/edit-lock/__tests__/version-increment-scan.test.ts` の `VERSIONED` / `ALLOWED_WITHOUT_VERSION` にも転記済み(走査テストは「検出した箇所が1件残らず一覧にあるか」「一覧の行がまだそこにあるか」「VERSIONED は実際に version increment を伴っているか」の3点だけを機械的に見る)。

## 要修正(本 Task で修正・11件)

Task 7 が直した「謄本取込が所有者の法人番号を版番号を進めずに埋めていた」バグと**同じ形の穴**。編集画面を開いていた人の保存が、これらの書き込みを黙って上書きしていた(修正前)。各行に対応する振る舞いテストを追加し、RED→GREEN を確認済み。

| # | ファイル:行 | 書く項目(編集画面で変えられるもの) | 修正内容 | 追加した振る舞いテスト |
|---|---|---|---|---|
| 1 | `src/app/api/import/csv/route.ts:750` | `finalUpdateData`(UPDATABLE_PROPERTY_FIELDS: address/postalCode/lotNumber/buildingNumber/note/…) | `data` に `version: { increment: 1 }` を追加 | `src/lib/__tests__/properties-csv-import-postal-code.test.ts`「13. update時にversionを進める」 |
| 2 | `src/app/api/import/jobs/[jobId]/rollback/route.ts:461` | `restoreData`(RESTORABLE_PROPERTY_FIELDS = UPDATABLE_PROPERTY_FIELDS ∩ PROPERTY_TRACKED_FIELDS) | `data` に `version: { increment: 1 }` を追加 | `src/lib/__tests__/import-rollback-restore-version.test.ts`(新規) |
| 3 | `src/app/api/import/jobs/[jobId]/rows/[rowId]/manual-link-reception-owner/route.ts:344` | `propertyUpdates`(lotNumber/buildingNumber。roomNoは対象外だが同じ更新に同居) | `data` に `version: { increment: 1 }` を追加 | `src/lib/__tests__/manual-link-archive-filter.test.ts`「物件の空欄補完は version を進める」 |
| 4 | `src/app/api/import/reception-owner/route.ts:354` | `updates`(lotNumber/buildingNumber/roomNo。同上) | `data` に `version: { increment: 1 }` を追加 | `src/lib/__tests__/reception-owner-archive-race.test.ts`「物件の空欄補完(lotNumber)は…」 |
| 5 | `src/app/api/import/reception-owner/route.ts:405` | `dmStatus`(hold→send昇格。PropertyEditForm「DM判断」で編集可能) | `data` に `version: { increment: 1 }` を追加 | 同上「DM○による dmStatus: hold→send の昇格は…」 |
| 6 | `src/app/api/import/reception-owner/route.ts:686` | `corporateNumber`(所有者編集カードの法人番号入力欄=`properties/[id]/page.tsx:1590`) | `data` に `version: { increment: 1 }` を追加 | `src/lib/__tests__/owner-corporate-import-integration.test.ts`「(Task 9) reuse パスの空欄埋めは…」(source-assertion。理由は本文末尾) |
| 7 | `src/app/api/import/reception-owner/route.ts:698` | `corporateNumber`/`companyRegistryNumber`(分断型復元。同上の入力欄) | `data` に `version: { increment: 1 }` を追加 | `src/lib/__tests__/corporate-import-guard-integration.test.ts`「(Task 9) 分断型復元の空欄埋めは…」(source-assertion) |
| 8 | `src/app/api/properties/sale-dm/drafts/[id]/outcome/route.ts:244` | `dmStatus`(no_send昇格。PropertyEditForm「DM判断」) | `data` に `version: { increment: 1 }` を追加 | `src/lib/__tests__/sale-dm-outcome-route.test.ts`「(Task 9) returned_undeliverable の物件連動は…」 |
| 9 | `src/app/api/properties/[id]/clear-dm-undeliverable/route.ts:64` | `dmStatus`(`restoreDmStatus` 指定時のみ。同上) | `restoreDmStatus` 指定時のみ `data.version = { increment: 1 }` を追加(dmUndeliverableAtのみのクリアは対象外のまま) | `src/lib/__tests__/sale-dm-clear-undeliverable-route.test.ts`「(Task 9) restoreDmStatus 指定時は…」 |
| 10 | `src/app/api/properties/[id]/dm-logs/[logId]/reaction/route.ts:276` | `dmStatus`(no_send昇格。同上) | `data` に `version: { increment: 1 }` を追加 | `src/lib/__tests__/dm-reaction-patch-route.test.ts`「(Task 9) undeliverable 連動は…」 |
| 11 | `src/lib/registry-fetch/auto-fetch.ts:238`(`releaseSchedulingLock`) | `registryStatus`(scheduled解除。PropertyEditForm「登記状況」で編集可能) | `data` に `version: { increment: 1 }` を追加 | `src/lib/__tests__/registry-auto-fetch-api.test.ts`「8. provider失敗時に…」に追記 |

**#6/#7 の補足**: `owner-corporate-import-integration.test.ts` / `corporate-import-guard-integration.test.ts` は、この2ファイル(reception-owner・registry-pdf・owner-csv の法人番号統合)を**最初から source-assertion(正規表現でコード片を固定)方式**で検証する既存方針を取っている(ファイル冒頭のコメントに明記)。他の9件は full prisma mock による振る舞いテストにしたが、#6/#7 はこの既存ファイル群の慣習(reception-owner の corporateNumber 書込は同ファイル内に既に同種の source-assertion が複数ある)に合わせ、同じ形式で「version increment を伴う」ことを固定した。

**#11 の補足**: この行は当初、`registryStatus` を「編集画面では変えられない運用フラグ」の例としてブリーフに挙げられていたが、実際に調べたところ **`registryStatus` は `src/components/properties/property-edit-form.tsx:129`(FORM_FIELDS の「登記状況」select)で編集画面から変更できる**。同じ `registryStatus` を書く他の2箇所(`src/lib/registry-pdf/process.ts:674`・`src/lib/registry-fetch/auto-fetch.ts:4294`)は既に version increment を伴っており、この解除処理(`releaseSchedulingLock`)だけが漏れていた。同じ資源・同じフィールドへの書き込みで一貫性が無かったため、要修正と判断し修正した。

## 対象外(許可・15件)

| ファイル:行 | 書く項目 | 編集画面で書けない理由 |
|---|---|---|
| `src/app/api/admin/owners/correction/merge/route.ts:437` | `owner.updatedAt` のみ | 行ロック獲得のための touch-update。`updatedAt` は `PATCH /api/owners/[id]` の `updateOwnerSchema` にも `property-edit-form.tsx`/所有者編集フォームにも無く、画面から送信できない |
| `src/app/api/admin/owners/correction/merge/route.ts:445` | 同上(source側) | 同上 |
| `src/app/api/admin/owners/correction/mislink/route.ts:406` | `owner.updatedAt` のみ | 同上 |
| `src/app/api/admin/owners/correction/mislink/route.ts:435` | `property.updatedAt` のみ | 同上。`updatedAt` は `updatePropertySchema` にも `property-edit-form.tsx` の FORM_FIELDS にも無い |
| `src/app/api/import/jobs/[jobId]/rows/[rowId]/manual-link-reception-owner/route.ts:262` | `owner.updatedAt` のみ | 同上(所有者行ロックtouch) |
| `src/app/api/import/jobs/[jobId]/rows/[rowId]/route.ts:180` | `owner.updatedAt` のみ | 同上 |
| `src/app/api/import/paste/commit/route.ts:406` | `owner.updatedAt` のみ | 同上(既存所有者へのリンク可否確認のための行ロックtouch) |
| `src/app/api/import/reception-owner/route.ts:589` | `owner.updatedAt` のみ | 同上 |
| `src/app/api/owners/[id]/memos/route.ts:241` | (コード本体ではない) | **正規表現の誤検出**。`owner.updateMany({ where: { id, isArchived: false } })` という文字列は、実際の呼び出しの使い方を説明する**コードコメント**であり、実行されるコードではない(実際の呼び出しは同ファイル252行目) |
| `src/app/api/owners/[id]/memos/route.ts:252` | `owner.updatedAt` のみ | メモ作成時の行ロックtouch(archive/mergeとの直列化用)。owner本体のフィールドは一切書かない |
| `src/app/api/properties/[id]/dm-logs/[logId]/reaction/route.ts:303` | `property.dmUndeliverableAt = null` のみ | 残数ゼロによる自動解除。`dmUndeliverableAt` は `updatePropertySchema` にも `property-edit-form.tsx` の FORM_FIELDS にも存在せず、編集画面から書けない(dmStatus自体は据え置きで触らない) |
| `src/app/api/properties/[id]/dm-logs/[logId]/route.ts:102` | `property.dmUndeliverableAt = null` のみ | 送付記録削除に伴う自動解除。理由は同上 |
| `src/app/api/properties/[id]/owners/route.ts:58` | `owner.updatedAt` のみ | 所有者リンク時の行ロックtouch |
| `src/app/api/properties/sale-dm/drafts/[id]/outcome/route.ts:267` | `property.dmUndeliverableAt = null` のみ | 訂正による自動解除。理由は上記2件と同じ |
| `src/lib/registry-pdf/process.ts:361` | `owner.updatedAt` のみ | 既存所有者再利用時の行ロックtouch |

`updatedAt` が編集画面から書けないことの根拠: `src/lib/validators.ts` の `updatePropertySchema`(200-241行)・`updateOwnerSchema`(266-283行)のどちらにも `updatedAt` フィールドが無く、`property-edit-form.tsx` の `FORM_FIELDS`(105-158行)にも該当キーが無い。`dmUndeliverableAt` も両スキーマ・両フォームどちらにも存在しない。

## 対応済(元から版番号を進めていた・28件)

| ファイル:行 | 書く項目 |
|---|---|
| `src/app/api/admin/owners/[id]/correction/address-fill/route.ts:275` | `owner.address`(空欄補完) |
| `src/app/api/admin/owners/[id]/correction/archive/route.ts:247` | `owner.isArchived` |
| `src/app/api/admin/owners/[id]/correction/contact-fix/route.ts:332` | `owner` の連絡先系動的フィールド |
| `src/app/api/admin/owners/[id]/correction/name-fix/route.ts:239` | `owner.name` |
| `src/app/api/admin/owners/[id]/correction/text-fix/route.ts:299` | `owner` の動的フィールド + `currentZip` |
| `src/app/api/admin/owners/[id]/registry-address-cleanup/route.ts:168` | `owner.address` |
| `src/app/api/admin/owners/correction/corporate-number-bulk-apply/route.ts:124` | `owner.corporateNumber` |
| `src/app/api/admin/owners/correction/corporate-restore-apply/route.ts:135` | `owner.name` |
| `src/app/api/admin/owners/correction/corporate-restore-apply/route.ts:208` | `owner.name`/`corporateNumber`/`companyRegistryNumber`/`address` |
| `src/app/api/admin/owners/correction/merge/route.ts:638` | `owner.isArchived`(source側の統合アーカイブ) |
| `src/app/api/admin/owners/correction/merge/route.ts:664` | `owner.currentAddress`/`currentZip`(master引き継ぎ) |
| `src/app/api/admin/owners/correction/mislink/route.ts:518` | `owner.version` のみ(付け替えのinvalidation) |
| `src/app/api/admin/owners/correction/mislink/route.ts:531` | `owner.version` のみ(target側) |
| `src/app/api/admin/owners/correction/mislink/route.ts:545` | `property.version` のみ |
| `src/app/api/import/jobs/[jobId]/rows/[rowId]/manual-link-reception-owner/route.ts:302` | `owner` の住所ペア空欄補完 |
| `src/app/api/import/jobs/[jobId]/rows/[rowId]/route.ts:214` | `owner` の住所ペア空欄補完 |
| `src/app/api/import/reception-owner/route.ts:629` | `owner` の住所ペア空欄補完 |
| `src/app/api/owners/[id]/corporate-apply/route.ts:368` | `owner` の法人番号適用フィールド(編集画面本体の保存窓口) |
| `src/app/api/owners/[id]/corporate-cleanup/route.ts:248` | `owner.name`/`address`/`note`/`corporateNumber` |
| `src/app/api/owners/[id]/route.ts:213` | `owner` の編集画面フィールド一式(編集画面本体の保存窓口) |
| `src/app/api/properties/[id]/actions/route.ts:157` | `property` のアクション実行結果フィールド |
| `src/app/api/properties/[id]/route.ts:366` | `property` の編集画面フィールド一式(編集画面本体の保存窓口) |
| `src/app/api/properties/bulk-update/route.ts:87` | `property.caseStatus`/`registryStatus`/`dmStatus`/`assignedTo` |
| `src/lib/investigation/fetch-investigation.ts:646` | `property.zoningDistrict`/`buildingCoverageRatio`/`floorAreaRatio` |
| `src/lib/registry-fetch/auto-fetch.ts:4294` | `property.registryStatus = scheduled`(有料取得の予約) |
| `src/lib/registry-fetch/auto-fetch.ts:4509` | `property.registryStatus = obtained`(有料取得の確定) |
| `src/lib/registry-pdf/process.ts:190` | `owner.corporateNumber`(Task 7 で修正済) |
| `src/lib/registry-pdf/process.ts:674` | `property.registryStatus`/`realEstateNumber`/`lotNumber`/`buildingNumber` |

合計: 要修正11 + 対象外15 + 対応済28 = **54件**(全件解決・unresolved行なし)。

## 判定の根拠にした資料

- 編集画面で変更可能なフィールドの一次資料: `src/lib/validators.ts` の `updatePropertySchema`(物件)・`updateOwnerSchema`(所有者)、および実際のフォーム定義 `src/components/properties/property-edit-form.tsx`(FORM_FIELDS)・`src/app/(dashboard)/properties/[id]/page.tsx`(所有者編集カード。`editableFields.corporateNumber` の入力欄含む)。
- `UPDATABLE_PROPERTY_FIELDS` / `RESTORABLE_PROPERTY_FIELDS` の定義: `src/lib/import-dedupe.ts` / `src/lib/import-rollback.ts`。
- Task 7 の先例(法人番号の版番号追加): commit `a5a9e05e`(`fix(registry-pdf): 法人番号の補完で版番号を進め、編集中は補完を見送る`)。

## 第2の走査: 所有者フィールド権限のドリフト検出

`src/lib/edit-lock/permissions.ts` の `OWNER_FIELD_RESOURCES`(「所有者の何らかのフィールドを書けるか」の判定に使う resource 一覧)は、`src/app/api/owners/[id]/route.ts` の `fieldWriteChecks`(実際の書込ゲート)の resource 集合と手作業で二重管理されている(既存コメントに明記)。

**authoritative source として `fieldWriteChecks` を採用した理由**: `src/lib/permissions.ts` の `resolveOwnerDisplayConfig` や `prisma/seed.ts` も `owner_*` resource の一覧を持つが、これらは「表示レベルの解決」「初期テンプレートへの割当」という別の関心事の副産物であり、"どの resource が所有者フィールドの書込を許可するか" を定義してはいない。それを実際に定義している唯一のコードが `fieldWriteChecks` であり、`OWNER_FIELD_RESOURCES` 自身の既存コメントも既にこれを正としている(controller決定・2026-09-18)。

`src/lib/edit-lock/__tests__/owner-field-permission-drift-scan.test.ts` を新設し、`fieldWriteChecks` の resource 集合(重複除去)と `OWNER_FIELD_RESOURCES` を自動比較する。片方だけに新しい resource が足された場合、差分を名指しして失敗する。`OWNER_FIELD_RESOURCES` はこのテストが import して直接比較できるよう `export` に変更した(振る舞いは変えていない)。

## 走査テストの構成(round 1 レビュー対応後)

`src/lib/edit-lock/__tests__/version-increment-scan.test.ts`(5テスト):
1. 検出した書き込み箇所が1件残らず `VERSIONED`/`ALLOWED_WITHOUT_VERSION` のどちらかに載っているか
2. 一覧に載っている行が今もそこに存在するか(行のずれ検出)
3. 検出パターン自体が空振りしていないか(健全性)
4. `VERSIONED` の各箇所が実際に `version: { increment: 1 }`(またはその代入形)を伴っているか
5. `ALLOWED_WITHOUT_VERSION` の各箇所(コメント誤検出を除く)が、許可した `keys` 以外を `data:` に書いていないか(review Minor 4)

**check 4 の設計変更(round 1 Important 1 対応)**: 当初は「見つけた increment 行を最も近い呼び出し行へ割り当てる(最近傍割当)」方式だったが、レビューが `src/lib/investigation/fetch-investigation.ts:646` で実際に空振りすることを実証した(同ファイルに `propertyInvestigation.*` 向けの increment が5個あり、うち1個(`:639`)が間隔の近い `property.updateMany`(`:646`)へ誤って割り当てられ、`:653` の本物の increment を消しても検出できなかった)。現在は**その呼び出し自身の引数の括弧バランス**(`extractBalancedSpan`)の中だけを見るように作り直した。`data` が裸の変数(`clear-dm-undeliverable/route.ts:64` の `data` / `corporate-restore-apply/route.ts:203` の `data`)を参照する2箇所だけは、その変数の宣言から呼び出し行までのテキストを遡り、**型注釈より後ろ**(`"} = {"` より後ろ)だけを見ることで、型注釈(`corporate-restore-apply/route.ts:184` の `version: { increment: 1 };` という型)を実行時の証拠として数えない。

**sweep 検証(round 1 で実施)**: `VERSIONED` の 39 箇所すべてについて、その箇所自身の increment を取り除いて `siteHasOwnVersionIncrement` が false を返すことを確認するスクリプトを実行した結果は **39/39 検出**(カバーできない箇所は無い)。加えて実ファイルへの実削除でも4パターン(素朴な空振り実証済みの `fetch-investigation.ts:653`・裸変数の `corporate-restore-apply/route.ts:203`・裸変数+代入形の `clear-dm-undeliverable/route.ts:64`・間隔の狭い3つ組の中央 `mislink/route.ts:531`)を個別に確認し、いずれも該当箇所だけが失敗し、`md5sum` でファイルを元に戻せることを確認した。

⚠**フォーマッタの脆さ**(review Minor 7): この一覧は54行を**行番号**で特定しており、`owner-corporate-import-integration.test.ts` の2つの source-assertion テスト(#6/#7)も1行の正確な整形(`data: { corporateNumber: cnDecision.corporateNumber, version: { increment: 1 } }` 等)に依存している。`npm run format`(`prettier --write .`)を実行すると、行の折り返しが変わってこの一覧の行番号と source-assertion の両方が同時にずれる可能性がある。**もし実行してしまったら**: (1) `npx vitest run src/lib/edit-lock/__tests__/version-increment-scan.test.ts` を実行し、「一覧の行が実際のコードからずれている」の失敗メッセージが新しい行番号を教えてくれるのでそれを本ドキュメントと `VERSIONED`/`ALLOWED_WITHOUT_VERSION` に反映する。(2) `owner-corporate-import-integration.test.ts`/`corporate-import-guard-integration.test.ts` の該当テストが失敗したら、正規表現を新しい改行位置に合わせて調整する(判定内容は変えない)。

## round 1 レビュー対応: 隠れていた「版番号は上がらない」という前提の記述(Important 2)

このタスクが version increment を足した後も、以下5箇所のコメント・1箇所のテストタイトルが「version を上げない書込経路がある」という**修正前の前提**をそのまま残しており、修正済みの経路を名指ししているものもあった(そのまま読むと defense-in-depth のガードを不要と誤解し、外してしまう恐れがあった)。**ガード自体はどれも削除しておらず**、根拠の記述だけを「version 単独に頼らない TOCTOU 対策」に書き直した:

- `src/lib/registry-fetch/auto-fetch.ts:143-149`(`recoverExpectedAddress` のコメント)
- `src/lib/registry-fetch/auto-fetch.ts:4414-4421`(貼付直前の再確認のコメント)
- `src/app/api/admin/owners/correction/corporate-restore-apply/route.ts:129-134`(name_fragment パスの楽観ロックコメント)
- 同ファイル `:202-207`(分断型パスの楽観ロックコメント。fix #6 の reception-owner reuse を名指ししていた)
- `src/lib/__tests__/registry-auto-fetch-api.test.ts:1546-1552`(テストタイトルと本文コメント)
