# 登記DM取込(登記情報自動化ツール連携) 設計書

作成: 2026-07-04 / ステータス: ユーザー承認済み設計(会話でパート1・2承認取得)

## 背景と目的

外部製Windowsツール「不動産登記情報自動化システム」(以下 exe)は、受付帳PDFをExcel化し、登記情報提供サービスから所有者事項PDFを一括ダウンロードし、DM差し込み印刷まで行う。本機能は exe の成果物(受付帳Excel・所有者Excel・取得済みPDF)を本システムへ取り込み、**物件+所有者の登録 → 謄本PDFの書庫化 → 売却促進DM機能への直結**を実現する(段階案の第1弾。第2弾=システム内蔵の自動取得+種別選択は別設計)。

Excel側の取込は既存機能が完備しているため(下記「再利用マップ」)、**新規開発の中核は「取得済みPDFの一括取込(サーバ側非同期ジョブ)」と「一気通貫ウィザード画面」**の2点。

## スコープ

- 新画面「登記DM取込」ウィザード(4ステップ): ①受付帳Excel取込(既存API) → ②所有者Excel取込(既存API) → ③取得済みPDF一括投入(新規) → ④結果サマリ+売却DM導線
- 新API: 取得済みPDFの一括アップロード+サーバ側非同期処理(ImportJob基盤に記録)
- 未突合PDFの手動紐付け(既存の手動紐付けパターン踏襲)
- DB変更はenum値2つの追加のみ(migration 1本・additive・詳細は後述)

### スコープ外(明示)

- システム内蔵の自動取得(所有者事項/全部事項の種別選択つき) = 第2弾
- exe本体の改修・受付帳PDF→Excel変換の内製化
- PDFからの所有者情報自動反映(検証の結果、所有者事項PDFから所有者住所を既存パーサで抽出不可[所在・氏名のみ可・信頼度0.6]。誤データ混入を避け、所有者データはExcelを正とする)
- PDFからの物件新規作成(物件は受付帳Excel由来を正とする。PDF側は添付のみ)

## アーキテクチャ

### ウィザード画面 `/import/registry-dm`

- `ImportSwitcher` に追加。ステップUI(1→2→3→4)。各ステップは独立して再実行可能(途中から入っても壊れない)。
- ステップ①②は既存の preview→execute API をそのまま呼ぶ(挙動・フィルタ[DL列〇/新既]は既存のまま)。
- ステップ③は複数ファイル選択/D&D → 新bulk APIへ1リクエストで送信 → jobId受領 → ジョブ進捗をポーリング表示。**アップロード完了後はブラウザを閉じても処理継続**(取込一覧/詳細から確認可)。
- ステップ④は当該ウィザード実行で作られたジョブの集計(物件n件/所有者n件/PDF添付n件/要確認n件/スキップn件)+売却DM作成への導線。

### 新API: `POST /api/import/registry-pdf-bulk`

- multipart。受付制限: **最大100ファイル/合計100MB/1ファイル5MB**。PDF以外(マジックバイト検査 `isPdfBuffer`)は当該ファイルのみ受付拒否として記録。超過は413/422で受付前拒否。
- 処理: `ImportJob`(新jobType `registry_pdf_bulk`)+ファイルごとの `ImportJobRow`(status=`pending`) を作成 → PDFを storage のstaging領域(`import-staging/registry-pdf/{jobId}/…`)へ保存 → **インプロセス非同期ワーカー**にジョブ投入 → 202 で jobId を即返す。
- 権限: `import:write`(既存importと同一)。監査: 既存ImportJob履歴+添付作成の既存監査に乗る。

### 非同期ワーカー(インプロセス・単一直列)

- next-server は systemd 常駐プロセスのため、モジュールスコープの単一ワーカーループで **1ファイルずつ直列処理**(販売図面PDF出力の同時実行ガードと同思想。並列化しない=負荷平準)。
- 複数ジョブはFIFO。処理状態は都度 `ImportJobRow` に永続化。
- **再起動耐性**: 再起動でワーカーが消えても行状態はDBに残る。ジョブ詳細画面に「未処理あり」を表示し、**「再開」ボタン**(新API `POST /api/import/jobs/[jobId]/resume-registry-pdf`)で未処理行のみ続行。staged PDFはディスクに残っているため再アップロード不要。

### 1ファイルの処理パイプライン(純関数中心)

1. **ファイル名解析**(新lib・純関数): `{所在}不動産登記（{土地|建物}所有者事項）{請求番号16桁}.PDF` を分解。パターン外は内容解析へフォールバック。
2. **重複スキップ**: 請求番号が既存 Attachment(type=registry) のメタデータ/ファイル名に存在 → 行status=`skipped`(理由「取得済み」。exeの「取得済みスキップ」と同発想。再投入・通信断後の再送でも二重添付されない)。
3. **物件突合**: `normalizeAddress(所在)` と `Property.address` の**正規化完全一致**(受付帳→物件作成と同じ元文字列由来のため高精度)。0件 or 複数件なら PDF内容 `extractTextFromPdf`→`parseRegistryText` の所在で再試行。それでも決まらなければ 行status=`needs_review`(部分一致では自動添付しない=誤紐付け防止)。
4. **添付**: 一致物件に `Attachment(type=registry)` として保存(既存の添付lib/storage/認可[ログイン+物件閲覧]/監査を再利用)。ファイル名に請求番号を保持。行status=`success`(createdId=Attachment id)。
5. 例外は 行status=`error`(errorMessage記録)。**1件の失敗は全体を止めない**。

### DB変更(migration 1本・additiveのみ)

- `ImportJobType` enum に `registry_pdf_bulk` を追加、`ImportRowStatus` enum に `pending`(未処理)を追加。**新テーブル/新列/backfillなし**=既存データ・既存コードに影響しない安全な追加。VPS反映時に `prisma migrate deploy` 1本。
- 行statusマッピング: 未処理=`pending` / 添付済=`success` / 要確認(未突合)=`needs_review` / 取得済みスキップ=`skipped` / 失敗=`error`。staged key・請求番号・突合根拠は `ImportJobRow.rawData`(JSONB) に記録。

### 未突合の手動紐付け

- ジョブ詳細の `unmatched` 行に「物件を指定して添付」操作(既存 manual-link-reception-owner のパターン踏襲・新API `POST /api/import/jobs/[jobId]/rows/[rowId]/manual-attach-registry-pdf`)。staged PDFから添付を作成し行を `attached` に更新。

### staging の後始末

- `success`/`skipped` 行の staged ファイルは処理完了時に削除。手動添付の成功時もその行の staged ファイルを削除。
- `needs_review`/`error` で残る staged ファイルは手動添付に備えてジョブ単位フォルダに保持する(1ジョブ合計100MB上限で有界。既存rollbackは受付帳CSV専用のため本ジョブには適用されず、自動削除の導線は第1弾では持たない。将来必要になれば添付お掃除(22F)と同様の定期回収に乗せる)。

## 再利用マップ(既存資産)

| 機能 | 既存実装 | 本設計での扱い |
|---|---|---|
| 受付帳Excel→物件作成 | `api/import/reception-property`(+preview)・`reception-owner-match.ts` | ステップ①がそのまま呼ぶ(変更なし) |
| 所有者Excel→所有者登録+紐付け | `api/import/reception-owner`(+preview)・`reception-owner-link.ts` | ステップ②がそのまま呼ぶ(変更なし) |
| PDFテキスト抽出/謄本パーサ | `pdf-extract.ts`・`pdf-registry-parser.ts` | 突合フォールバックで再利用(拡張しない) |
| 添付(type=registry) | 添付lib+`/uploads`認可+監査 | 添付作成で再利用 |
| ImportJob/Row・一覧/詳細・rollback | `ImportJob`基盤・`/import/jobs/[jobId]` | 新type行を記録・再開/手動紐付けを行操作として追加 |
| 正規化 | `normalize.ts` の `normalizeAddress` | 突合キーで再利用 |

## エラー処理・制限(承認済み)

- 合計サイズ/件数の超過=受付前拒否(413/422)。1ファイル5MB超過・非PDFは当該ファイルのみ error 行として記録し、受付自体は202で継続。
- 壊れたPDF=当該行 `failed`・継続 / 物件不明・複数候補=`unmatched`(手動紐付け) / 取込済み請求番号=`skipped_duplicate`。
- アップロード自体の失敗=ジョブ未作成 or 未処理残→再投入しても請求番号チェックで二重にならない。

## テスト方針(TDD)

- 実PII入りPDFはリポジトリに入れない。同レイアウトを模した**架空データのfixture**で、ファイル名解析・突合(一致/0件/複数/フォールバック)・重複スキップ・失敗継続・再開・手動紐付け・受付制限をユニット/routeテスト化。
- ウィザードはステップ遷移・ポーリング表示・サマリ集計をコンポーネントテスト。
- 実PDF6件(サンプル)での動作確認は実装後にローカルで実施し、結果要約のみ報告(PII非表示)。
- ゲート: `tsc` 0 / full `npx vitest run` 緑 / `next build` 成功 / eslint差分0。

## リスクと対応

- 所在文字列の表記揺れで unmatched が多発する可能性 → 受付帳由来の同一文字列前提で正規化完全一致から開始し、実データ確認で精度を測ってから緩和を検討(部分一致の自動化はしない)。**実データ検証(2026-07-05)で都道府県接頭辞と「外N」接尾辞の系統差により完全一致が0/6と判明したため、両側除去の正準化キー(`canonicalAddressKey`)へ変更済み(実データ6/6)。**
- 正準化で都道府県を除去するため、**県違い同名住所**(例: 東京都府中市と広島県府中市)が片側のみDB登録の場合に誤一致し得る(両方登録なら複数候補→要確認で安全側)。PDF側の所在に都道府県が付かない以上不可避のトレードオフで、単一都県中心の現運用では実質非発火。広域運用時は要再検討。
- インプロセスワーカーはプロセス再起動で停止 → 行状態永続化+「再開」ボタンで復旧(設計済み)。
- 大量投入時のメモリ → 直列処理+ファイル逐次読み込みで一定量に抑制。
- **enum ADD VALUE は取り消し不能**(Postgres は `ALTER TYPE ... ADD VALUE` を `DROP VALUE` できない)。そのため本番でコードだけをロールバックする場合、`registry_pdf_bulk` の `ImportJob`/`ImportJobRow` が新enum値(`jobType`/関連ステータス等)を持ったままだと、旧バージョンの Prisma クライアント(生成済み型が新enum値を知らない)がそれらの行を読んだ時点で取込画面(ジョブ一覧・詳細)が500になる。ロールバック手順には「新enum値を含む `import_jobs`/`import_job_rows` 行をSQLで退避(別テーブルやダンプ)してから削除する」を含めること。コードのみ戻してDB側の行を放置してはいけない。

## 第1弾スコープ外のフォローアップ候補(第三者レビュー由来)

第三者レビューで挙がった指摘のうち、第1弾の必須修正(staging削除・同時実行ガード・孤児添付除外・propertyId検証・ウィザードUX)には含めず、次弾以降の検討候補として残すもの。

- **needs_review行の再突合手段**: 一度 not_found/multiple で確定した行を、後から物件が追加/修正された後に再度自動突合し直す導線が無い(現状は手動添付のみ)。
- **売却DM導線の昇格件数可視化と絞り込みリンク**: ステップ④の「物件一覧へ」は無条件リンクで、実際に売却DM対象(所有者Excel DM列〇)になった件数や、その物件だけに絞り込むリンクが無い。
- **手動添付の請求番号重複ガード**: `manual-attach-registry-pdf` には自動処理側(`process-row.ts`)にある請求番号ベースの重複スキップが無く、同じPDFを手動で複数回添付できてしまう。
- **staging TTL回収(22F型)**: エラー/needs_review以外(正常処理中に異常終了した場合等)で残留した staging ファイルを、時間経過で自動回収する仕組みが無い(22F添付お掃除と同型の仕組みが未整備)。
- **stuck検知のpendingジョブ対応と再開導線**: 既存のstuck検知は processing 状態のジョブのみ対象で、行作成前後に孤児化した pending ジョブ(行0件のまま進まない等)は検知対象外。
- **アーカイブ物件の突合除外**: `buildPropertyIndex` はアーカイブ済み物件も含めて索引化しており、アーカイブ物件宛にPDFが誤って自動添付され得る。
- **pdf-parseタイムアウト**: `extractTextFromPdf` に処理時間の上限が無く、壊れた/巨大なPDFで内容フォールバックが長時間ブロックし得る。
- **ジョブ操作のexecutedByスコープ**: 一括解決(`bulk-resolve`)や手動添付等のジョブ操作に、実行者と`ImportJob.executedBy`の対応関係によるスコープ制限が無い(現状は`import:write`権限のみで判定)。
