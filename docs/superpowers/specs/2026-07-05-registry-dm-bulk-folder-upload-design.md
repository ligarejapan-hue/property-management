# 登記DM取込 Step3 フォルダ一括アップロード 設計書

作成: 2026-07-05 / ステータス: ユーザー承認済み設計(会話で方針①承認)

## 背景と目的

登記DM取込ウィザード(`/import/registry-dm`)の Step3「取得済みPDFを一括で物件に添付」は、1回のアップロードが **最大100ファイル / 合計100MB / 1ファイル5MB** に制限されている(サーバが multipart body 全体をメモリにバッファする設計上の安全上限)。

実運用で、ユーザーの手元には **取得済み所有者事項PDFが6000件以上**あり、かつ整理されていない。現状のUIでは 100件ずつ約60回の手動アップロードが必要で、しかも「どの100件を投入済みか」を人手で管理しなければならず非現実的。

本機能は Step3 を **フォルダ丸ごと選択 → クライアント側で自動的に100件ずつのバッチへ分割 → 順次アップロード**する方式に作り直し、6000件規模の滞留を放置で取り込めるようにする。あわせて、見づらいと指摘のあった Step3 のファイル選択UI(標準の生 `<input type=file>`)を、リポジトリ既存の「hidden input + 明示ボタン」パターンに刷新する。

### 重要な前提: 冪等性

サーバの1ファイル処理パイプライン(`process-row.ts`)は **請求番号(ファイル名16桁)で既存 registry Attachment との重複を判定し、取得済みならスキップ**する。したがって:

- 同じPDFを二度投入しても二重添付は起きない。
- **6000件を事前に整理する必要はない**。フォルダ全体を通せば、済んだものは自動でスキップされる。
- 中断後に同じフォルダを再投入しても安全(重複は弾かれる)。

この冪等性が本設計の中断・再開の正当性の土台。

## スコープ

- Step3 UI を「フォルダ選択(または複数ファイル選択)」に刷新。ファイル選択部を既存パターン(hidden input + 明示ボタン)で読みやすくする。
- クライアント側で選択ファイルを分類(送信可 / 除外)し、100件・90MB 上限でバッチに分割し、**1バッチずつ順次**既存エンドポイントへ送信。
- 全体のアップロード進捗(送信 X / Y件・バッチ k / N)を表示。
- 中断・再開: 送信済みの請求番号を localStorage に記録し、同じフォルダ再選択時に未送信分だけに絞る。
- 送信前に除外ファイル(5MB超 / 非PDF)を理由つきで一覧表示。

### スコープ外(明示・v1では作らない)

- **サーバ側の一切の改修**。エンドポイント `/api/import/registry-pdf-bulk`・ワーカー・staging・突合・冪等判定は現状のまま流用する(5巡の @codex レビューで固めた面を触らない)。上限値(100件/100MB/5MB)も変更しない。
- バッチごとに生成される多数の ImportJob(6000件で約60ジョブ)の履歴上のグルーピング/集約表示。
- 全バッチ横断の「添付結果(添付済/既取得/要確認)ライブ集計」。各バッチの結果は従来どおり取込履歴・ジョブ詳細で確認する。
- サーバへフォルダを転送して一括処理する方式(案③)。将来、継続的に超大量を扱う必要が出た場合の別設計。
- Step1・Step2(受付帳/所有者Excel)には手を入れない。

## アーキテクチャ

変更は **クライアント側のみ**。サーバは無改修。

### 新規: 純ロジック `src/lib/registry-pdf-bulk/bulk-upload-plan.ts`

DOM/File 非依存の純関数群(env=node で単体テスト可能)。`{ name, size }` の軽量メタ配列を受け取り、元配列への **index** を返すことで、呼び出し側が実 `File[]` と対応づける。

```ts
export interface BulkFileMeta { name: string; size: number }
export type ExcludeReason = "too_large" | "not_pdf";
export interface ExcludedFile { index: number; name: string; reason: ExcludeReason }

// サーバ route.ts / wizard-progress.ts と同じ上限(正本はサーバ側)
export const MAX_BULK_FILES = 100;
export const MAX_BULK_FILE_BYTES = 5 * 1024 * 1024;
// 1バッチのバイト目標。サーバ上限100MBに対し余裕を取る。
export const BATCH_TARGET_BYTES = 90 * 1024 * 1024;

// 5MB超 or 拡張子が .pdf でないものを除外。残りを送信可 index 配列に。
export function classifyBulkFiles(files: BulkFileMeta[]): {
  sendable: number[];
  excluded: ExcludedFile[];
};

// 送信可 index を「100件 or BATCH_TARGET_BYTES を超えたら区切る」で分割。
// 5MB以下前提なので単一ファイルがバッチ上限を割ることはない。
export function planBatches(sendable: number[], files: BulkFileMeta[]): number[][];

// 再開キー: 請求番号(parseRegistryPdfBulkFilename)が取れればそれ、無ければファイル名。
export function bulkFileKey(name: string): string;

// 送信済みキー集合に含まれる index を除外。
export function filterUnsent(
  sendable: number[],
  files: BulkFileMeta[],
  sentKeys: ReadonlySet<string>,
): number[];

// 上記をまとめた計画。UI はこれ1つで内訳とバッチ列を得る。
export interface UploadPlan {
  excluded: ExcludedFile[];
  alreadySentCount: number;   // 再開で除外した件数
  batches: number[][];        // 送信対象(未送信)の index 配列群
  sendableTotal: number;      // batches の総件数
}
export function buildUploadPlan(
  files: BulkFileMeta[],
  sentKeys: ReadonlySet<string>,
): UploadPlan;
```

`bulkFileKey` は既存 `src/lib/registry-pdf-bulk/filename.ts` の `parseRegistryPdfBulkFilename` を再利用。

### 新規: 再開ストレージ `src/lib/registry-pdf-bulk/bulk-upload-resume.ts`

ブラウザ localStorage の薄いラッパ(`typeof window === "undefined"` をガード。SSR/テストで no-op)。送信成功したバッチのキーを蓄積する。請求番号はグローバルに一意なので、単一キー集合で運用する(フォルダ横断でも「送信済みは飛ばす」が成立)。

```ts
const STORAGE_KEY = "registry-pdf-bulk:sent-keys";
export function loadSentKeys(): Set<string>;      // 壊れた値は空集合にフォールバック
export function recordSentKeys(keys: string[]): void;  // 既存に追記して保存
export function clearSentKeys(): void;            // UI「記録をリセット」用
```

### 新規: UIコンポーネント `src/components/import/bulk-folder-upload.tsx`

Step3 の中身を担う自己完結コンポーネント。`page.tsx` はこれを差し込むだけにして肥大を防ぐ。

責務:
1. **入力**: 「フォルダを選択」(`webkitdirectory`)と「ファイルを選択(複数可)」の2ボタン。いずれもリポジトリ既存パターン(`className="hidden"` の `<input>` を ref 経由の明示ボタンで開く)。※`webkitdirectory` は TS型に無いため ref + `setAttribute`(または属性スプレッド)で付与する。
2. **計画表示**: 選択後 `buildUploadPlan` を呼び「対象 N件 / 除外 M件 / 送信済み(スキップ)K件 / → バッチ数」を表示。除外があれば理由つきで折りたたみ一覧。
3. **アップロードループ**: 「アップロード開始」で `batches` を **for-await で1件ずつ直列**送信。各バッチは対応 index から `File[]` を組み `uploadRegistryPdfBulk` を呼ぶ。202 受領でそのバッチのキーを `recordSentKeys` し、進捗(送信件数・バッチ番号)を更新。jobId は控える(履歴リンク用)。
4. **進捗**: プログレスバー + 「送信 1,200 / 6,000件(バッチ 12 / 60)」。
5. **完了**: 「受付 合計 X件 / 除外 Y件」+ 取込履歴リンク + 「別のフォルダ」「記録をリセット」。
6. **中断/失敗**: バッチ失敗で停止し、失敗理由と「これまでに送信 X件」を表示。「再開」で未送信の続きから(送信済みキーは永続化済み)。

`page.tsx` 側は Step3 の既存 `<input>`/`uploadRegistryPdfBulk`/ポーリング state を撤去し `<BulkFolderUpload onUploaded={...} />` に置換。Step4 の「PDF添付」サマリは、コンポーネントから受け取った受付件数(概況)を表示するに留める(詳細は履歴)。

## データフロー

```
フォルダ選択(webkitdirectory)
  → File[] を { name, size } メタ化
  → loadSentKeys()
  → buildUploadPlan(files, sentKeys)  … 除外/送信済み/バッチ列
  → [開始] → for batch of batches (直列):
        indexes → File[] → uploadRegistryPdfBulk(files)  (POST /api/import/registry-pdf-bulk)
        → 202 {jobId, acceptedCount, rejectedCount}
        → recordSentKeys(batch.map(i => bulkFileKey(files[i].name)))
        → 進捗更新・jobId 蓄積
  → 完了サマリ + 取込履歴リンク
（サーバ側は各ジョブを直列ワーカーで処理し、請求番号 dedup で二重添付を防止）
```

## エラー処理・制限

- **直列厳守**: バッチは同時送信しない。サーバの同時アップロードガード(最大2・超過は 503 `UPLOAD_BUSY`)と、100MB body のメモリ確保に整合させる。単一タブ直列なら自己衝突しない。
- **503 UPLOAD_BUSY**(別タブ等で混雑): 同一バッチを短いバックオフで最大3回リトライ。それでも駄目なら停止し「混み合っています。時間をおいて再開してください」。
- **その他のバッチ失敗**(ネットワーク/500等): そのバッチで停止。送信済みキーは永続化済みなので「再開」で続きから。同一PDFの再送はサーバ側 dedup で二重添付にならない。
- **除外ファイル**: 5MB超・非PDF はクライアントで送信前に弾き、理由つきで一覧表示(送信・記録の対象外)。所有者事項PDFは通常数百KBで、除外は基本発生しない想定。
- 単一バッチ内の needs_review / error(未突合・壊れPDF)は従来どおりジョブ詳細で対応。再開時は「送信済み」として飛ばす(未突合の解消は手動添付であって再送ではないため)。

## テスト方針(TDD)

- **`bulk-upload-plan.ts`(純関数)**: RED→GREEN で境界を固める。
  - `classifyBulkFiles`: ちょうど5MB=送信可 / 5MB+1=too_large、`.pdf`/`.PDF`=可・大文字小文字非依存 / `.xlsx`等=not_pdf、除外は元 index を保持。
  - `planBatches`: 100件=1バッチ / 101件=2バッチ、合計が BATCH_TARGET_BYTES を跨ぐ位置で分割、空入力=空配列。
  - `bulkFileKey`: 規約ファイル名→請求番号、非規約→ファイル名そのまま。
  - `filterUnsent` / `buildUploadPlan`: 送信済みキーの除外、除外+送信済みの内訳集計。
- **`bulk-upload-resume.ts`**: SSR(window無)で no-op、load/record/clear の集合演算、壊れた JSON からの空集合フォールバック。localStorage はテスト用に最小スタブ。
- **UI(`bulk-folder-upload.tsx`)**: env=node(jsdom無)のため送信ループ/クリックの単体テストは行わず、`renderToStaticMarkup` で初期表示(ボタン・対応形式の明示・除外一覧の文言)をアサート。ループの正しさは純ロジックのテスト + レビューで担保(リポ既存方針)。
- ゲート: `tsc` 0 / full `npx vitest run` 緑 / `next build` 成功 / eslint 差分0。

## リスクと対応

- **6000件のアップロード時間**: 小さいPDF(数百KB)前提で総量 1〜数GB。直列送信のため回線次第で数十分〜。放置で完了する一度きりの棚卸しなので許容。途中中断は再開で継続。
- **多数ジョブ(約60)による履歴の煩雑化**: v1では許容(一度きり)。将来グルーピングが必要ならバッチにまとめラベルを付す拡張(サーバ側で optional label 受領)を検討。
- **localStorage 記録の消失**(別PC/クリア): 再開効率は落ちるが、サーバ側 dedup が二重添付を防ぐため**正しさは保たれる**(再送は全スキップ)。二重の安全。
- **webkitdirectory 非対応環境**(一部モバイル): 「ファイルを選択(複数可)」でフォールバック。本作業は本来PC向け。
- **フォルダに所有者事項以外のPDFが混在**: v1では種別で絞らず全PDFを送る(所在で突合・冪等)。運用上フォルダは所有者事項の出力想定。必要なら種別フィルタは後日。

## 再利用マップ

| 機能 | 既存実装 | 本設計での扱い |
|---|---|---|
| PDF一括アップロード | `POST /api/import/registry-pdf-bulk` | 無改修で流用(クライアントが直列で複数回呼ぶ) |
| クライアント送信 | `uploadRegistryPdfBulk(files)`(api-client) | そのまま利用 |
| 請求番号解析 | `registry-pdf-bulk/filename.ts` `parseRegistryPdfBulkFilename` | 再開キー生成で再利用 |
| 進捗表示 | `wizard-progress.ts` | 上限定数の整合参照(必要なら定数を集約) |
| ファイル選択UIの型 | 既存の hidden input + 明示ボタン(import/page.tsx 等) | 同型を踏襲 |
