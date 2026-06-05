# DM 差込 CSV 出力 — 本番運用チェックリスト

DM 差込 CSV 出力（`GET /api/properties/dm-export`）を実運用する前後に確認する項目をまとめる。
コード仕様は test（`src/lib/__tests__/properties-dm-export-route.test.ts` / `csv-encode.test.ts`）で
ロック済みのため、ここでは **実データ・本番環境でしか確認できない運用観点** を中心に列挙する。

> 取り扱い注意: DM 差込 CSV には所有者の氏名・郵便番号・住所など個人情報が含まれる。
> 本チェックリストに沿って確認する際も、**実値を PR 本文・Issue・チャット・ログ・スクリーンショットに残さない**こと（詳細は末尾「6. 実データ取扱い」）。

関連実装:

- API: `src/app/api/properties/dm-export/route.ts`
- 純ロジック: `src/lib/dm-export.ts`（ヘッダ定義・行マッピング・敬称・表示レベル判定）
- CSV エンコード: `src/lib/csv-encode.ts`（RFC4180 escape・CRLF・BOM・formula injection 無害化）
- UI 起動: 物件一覧画面 `src/app/(dashboard)/properties/page.tsx`「DM差込CSV出力」ボタン
  （現在の検索条件を引き継いで `window.location.href = /api/properties/dm-export?<query>`）

CSV 列順（`DM_EXPORT_HEADERS`）:
`管理ID, 物件住所, 所有者名, 敬称, 郵便番号, 所有者住所, 物件種別, 所有者名カナ, 代表者, 続柄, 部屋番号, DM判断`

---

## 1. 本番実行前の権限確認

DM 出力は所有者個人情報を含むため、UI ボタン表示とサーバ side で **二重に** ゲートされている。
実行ユーザーの権限テンプレートで以下を確認する。

- [ ] `property:read` を保持（欠如すると 403・`findMany`/`writeAuditLog` 未実行）
- [ ] `csv_export:read` を保持（欠如で 403）
- [ ] `csv_export_personal:read` を保持（欠如で 403）
- [ ] `owner:read` を保持（欠如で 403）
- [ ] owner の **表示レベルが「生値」**（`full` / `read` / `edit` のいずれか）であること
  - `partial`（先頭3文字+***） / `masked`（末尾4文字） / `hidden`（null）では **氏名・郵便番号・住所のいずれかが生値でない → 403**
  - 判定対象は owner の `name` / `zip` / `address`（`isPlainOwnerLevel`）
- [ ] UI ボタンの表示条件（`csv_export:read && csv_export_personal:read`）と API ゲートが一致していること
  - 想定: ボタンが見えるユーザーは出力でき、見えないユーザーは API でも 403

> NG 時の切り分け: 403 が返る場合は「どの権限/表示レベルが欠けているか」を本番 DB ではなく
> **権限テンプレート管理画面**（`/admin/users/[id]/permissions`・`/admin/templates/[id]`）で確認する。

---

## 2. 件数確認（dmStatus / archived / skipped / owner 行数）

サーバ側で `where.dmStatus = "send"` と `where.isArchived = false` を **強制**する
（クライアントが `?dmStatus=hold` 等を渡しても無視され `send` 固定）。

- [ ] **送付可（`dmStatus=send`）の物件のみ** 出力される（`no_send` / `hold` は1件も漏れない）
- [ ] **アーカイブ物件**（`isArchived=true`）は出力されない
- [ ] **アーカイブ所有者**（`owner.isArchived=true`）は行に含まれない（property の `propertyOwners.where.owner.isArchived=false`）
- [ ] **非アーカイブ所有者が 0 件の送付可物件**は行を生まず、`skippedCount` に計上される（CSV にはヘッダのみ）
- [ ] **owner 行数 ≠ 物件数** になり得ることを理解（owner 1 名 = 1 行のため、複数所有者物件で行数 > 物件数）
- [ ] 監査ログ（`property_dm_csv_export`）の件数が一致
  - `detail.count` = 送付可かつ owner≥1 の物件数（mailablePropertyCount）
  - `detail.resultCount` = CSV データ行数（= owner 行数）
  - `detail.skippedCount` = owner 0 件で除外した物件数
- [ ] **上限**: 最終 owner 行数 > `MAX_DM_EXPORT_ROWS`（10,000）の場合は切り捨てず **400**（`EXPORT_LIMIT_EXCEEDED`）。
  検索条件で絞ってから再実行する

確認手順（本番）:

1. 物件一覧で「DM判断: 送付可」で絞り込み、表示件数 X を控える
2. DM 差込 CSV 出力 → ダウンロードした CSV のデータ行数 Y（ヘッダ除く）を控える
3. `Y ≧ X − (owner0件物件) ` かつ `Y = Σ(各物件の非アーカイブ所有者数)` を概算で照合
4. 件数が合わない場合は、archived owner / owner 0 件物件 / 複数所有者物件の有無を疑う

---

## 3. owner 複数行確認

- [ ] **1 物件 × 複数 owner** → 所有者ごとに複数行（代表者が先頭・`isPrimary desc, createdAt asc` 順）
- [ ] **1 owner × 複数物件** → 物件ごとに 1 行（同一所有者が複数行に出る）
- [ ] **代表者**列: `isPrimary` の行のみ「代表」、それ以外は空欄
- [ ] **続柄**列: `relationship`（例「本人」「子」）がそのまま出る・未設定は空欄
- [ ] **敬称**列: 所有者の `corporateNumber` が非空 → 「御中」、それ以外 → 「様」
- [ ] **管理ID**列: 取込元（受付帳 CSV の `__sourceRef`）が出る・無ければ空
- [ ] **null / 未設定フィールドは空文字**（"null" / "undefined" という文字列は出力されない）

---

## 4. CSV 文字化け・エスケープ確認（Excel 互換）

- [ ] **UTF-8 BOM** 付きで始まる（Excel が CP932 と誤判定して文字化けするのを防止）
- [ ] 行区切りが **CRLF**（`\r\n`）
- [ ] **Excel で直接開いて** 日本語（氏名・住所）が文字化けしない
- [ ] 値に **カンマ** を含む場合 → フィールドが `"..."` で囲われ、列がズレない
- [ ] 値に **ダブルクォート** を含む場合 → 内部の `"` が `""` にエスケープされる
- [ ] 値に **改行** を含む住所等 → フィールドが `"..."` で囲われ、行が割れない（埋め込み改行は CSV 1 セル内に保持）
- [ ] **formula injection 無害化**: `=` `+` `-` `@` / タブ / 全角 `＝＋－＠` などで始まる値は先頭に `'` が付き、Excel/Sheets で数式実行されない
- [ ] 数式起動文字を含んでも **PII 本体は壊れず**読める（`'` プレフィックスのみ付与）

> 上記の escape ロジック自体は `csv-encode.test.ts` と `properties-dm-export-route.test.ts`(08/09 + Phase 1 追加3ケース)で
> 単体ロック済み。本番では「実際の Excel で開いて崩れないか」の最終目視のみ行う。

---

## 5. 本番画面/運用での確認手順

1. **出力画面**: 物件一覧（`/properties`）→ 検索条件を設定 →「DM差込CSV出力」ボタン
   - ボタンは現在の検索条件（キーワード/管理ID/各フィルタ）をそのまま引き継ぐ
   - サーバ側で `dmStatus=send` / `isArchived=false` は強制されるため、画面のDM判断フィルタが send 以外でも送付可のみ出力される
2. **出力後に見る列**:
   - `所有者名` / `郵便番号` / `所有者住所` が生値で出ているか（マスクされていないか＝権限/表示レベル）
   - `敬称`（御中/様）が法人/個人で正しいか
   - `代表者` / `続柄` が複数所有者物件で正しく分かれているか
   - `DM判断` が全行「送付可」か
   - `管理ID` が取込物件で埋まっているか
3. **NG 時の切り分け**:
   - 403 → 「1. 権限確認」へ（どの権限/表示レベル欠如か）
   - 文字化け → BOM 落ち/別アプリで開いた可能性。BOM 付きのまま Excel で開く
   - 列ズレ → カンマ/改行を含む値が escape されているか（test で担保済のため、まず開き方を疑う）
   - 件数不一致 → 「2. 件数確認」へ（archived/owner0件/複数所有者）
   - 数式が実行された → `'` プレフィックスの有無（test で担保済）。古い CSV を開いていないか
4. **再実行**: 上限 400 が出たら検索条件を絞る。条件変更後は必ず件数を再確認

---

## 6. 実データ取扱い（個人情報の禁止事項）

- [ ] **PR 本文・Issue・コミットメッセージ・チャットに実所有者名/住所/郵便番号を書かない**
- [ ] **ログ・コンソール出力に CSV 本文（行データ）を貼らない**
  - サーバの監査ログ（AuditLog）は設計上 **非 PII**（`count`/`resultCount`/`skippedCount`/`filters`/`exportedAt` のみ・氏名/住所/CSV本文は残さない）
- [ ] **スクリーンショットに PII を写さない**（撮る場合はマスク or 架空データ画面で）
- [ ] **テスト fixture に実個人情報を使わない**（架空名「所有 花子」「田中, "太郎"」等を使う）
- [ ] ダウンロードした CSV は**業務端末内で管理し、共有ストレージ/チャットに添付しない**
- [ ] 検証目的で値を共有する必要がある場合は、**件数・列名・エラーコードなどの非 PII メタ情報のみ**を共有する

---

## 付録: 既存テストでロック済みの仕様（再確認不要・回帰検知用）

| 観点 | テスト |
|---|---|
| `dmStatus=send` 強制・hold/no_send 除外 | dm-export route 01/02/03 |
| owner 複数行（1物件×複数owner / 1owner×複数物件） | dm-export route 04 / Phase1-① |
| archived property / owner 除外 | dm-export route 06/07 |
| owner 0 件 → skippedCount | dm-export route 05 |
| 件数整合（count/resultCount/skippedCount） | dm-export route 17 / Phase1-① |
| 代表者 / 続柄 / 非代表空欄 | dm-export route 04 / Phase1-② |
| 敬称（御中/様） | dm-export route 20 |
| null/undefined → 空文字 | dm-export route「null/undefined…」 |
| UTF-8 BOM + CRLF | dm-export route 09 / csv-encode |
| カンマ/クォート/改行 escape | csv-encode / Phase1-③ |
| formula injection 無害化 | dm-export route 08 / csv-encode |
| 権限 403（property/csv_export/csv_export_personal/owner/表示レベル） | dm-export route 10〜15 |
| 監査 detail 非 PII | dm-export route 16 |
| 上限 400 | dm-export route 18 |

> 「Phase1-①②③」= `properties-dm-export-route.test.ts` の「Phase 1 追加ガード」describe（PR #131）。
