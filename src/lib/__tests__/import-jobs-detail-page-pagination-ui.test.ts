/**
 * import job 詳細ページの B2（rows サーバーサイドページング配線）ソース表明テスト。
 *
 * 本リポは vitest environment="node"（jsdom / RTL なし）のため、ページの hooks を
 * 実行できない。既存方針（import-rollback-page-phase2-ui.test.ts 等）に倣い、page.tsx
 * のソースを読み配線を表明する。
 *
 * 検証:
 *  - fetchImportJobDetail(jobId, {page, limit, status}) で取得（status="all" は送らない）
 *  - page / status を URL query と同期（useSearchParams / router.replace）
 *  - status 変更で page=1 に戻す（changeFilter）
 *  - job.pagination で前へ/次へ UI
 *  - 全体判定は server 値（job.isReceptionOwnerJob / job.duplicateCount）を使い、
 *    job.rows.some() / job.rows.filter() を全体判定に使い続けない
 *  - mutation 後 refetch が page/limit/status を維持（fetchJob deps）＋ page>totalPages クランプ
 *  - batch resolve は B2 では無効化（ページング表示中）＋ B3 注記
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const pageSrc = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/(dashboard)/import/jobs/[jobId]/page.tsx",
  ),
  "utf8",
);

describe("import job detail page — B2 pagination 配線 (source-assertion)", () => {
  it("fetchImportJobDetail を page/limit/status 付きで呼ぶ（status=all は送らない）", () => {
    expect(pageSrc).toMatch(/fetchImportJobDetail\(jobId,\s*\{/);
    expect(pageSrc).toMatch(/page,/);
    expect(pageSrc).toMatch(/limit:\s*ROW_LIMIT/);
    expect(pageSrc).toMatch(
      /status:\s*filter === "all" \? undefined : filter/,
    );
  });

  it("ROW_LIMIT の既定は 50", () => {
    expect(pageSrc).toMatch(/const ROW_LIMIT = 50;/);
  });

  it("page / status を URL query と同期する（useSearchParams + router.replace）", () => {
    expect(pageSrc).toMatch(/useSearchParams/);
    expect(pageSrc).toMatch(/router\.replace\(/);
    expect(pageSrc).toMatch(/sp\.set\("status",\s*filter\)/);
    expect(pageSrc).toMatch(/sp\.set\("page",\s*String\(page\)\)/);
    // 初期値を URL から復元
    expect(pageSrc).toMatch(/searchParams\.get\("status"\)/);
    expect(pageSrc).toMatch(/searchParams\.get\("page"\)/);
  });

  it("status タブ変更で page=1 に戻す（changeFilter）", () => {
    expect(pageSrc).toMatch(
      /const changeFilter = \(next: FilterStatus\) => \{[\s\S]*?setFilter\(next\);[\s\S]*?setPage\(1\);/,
    );
    // タブは changeFilter を使う（setFilter 直叩きではない）
    expect(pageSrc).toMatch(/onClick=\{\(\) => changeFilter\(tab\.key\)\}/);
    expect(pageSrc).not.toMatch(/onClick=\{\(\) => setFilter\(tab\.key\)\}/);
  });

  it("job.pagination を使った前へ/次へ UI", () => {
    expect(pageSrc).toMatch(/job\.pagination\.hasPrevPage/);
    expect(pageSrc).toMatch(/job\.pagination\.hasNextPage/);
    expect(pageSrc).toMatch(/job\.pagination\.totalPages/);
    expect(pageSrc).toMatch(/前へ/);
    expect(pageSrc).toMatch(/次へ/);
  });

  it("全体判定は server 値を使う（isReceptionOwnerJob / duplicateCount）", () => {
    expect(pageSrc).toMatch(
      /const isReceptionOwnerJob = job\?\.isReceptionOwnerJob \?\? false;/,
    );
    expect(pageSrc).toMatch(/duplicate:\s*job\?\.duplicateCount \?\? 0/);
  });

  it("job.rows.some() / job.rows.filter() を全体判定に使い続けない", () => {
    expect(pageSrc).not.toMatch(/job\?\.rows\.some\(/);
    expect(pageSrc).not.toMatch(/job\?\.rows\.filter\(/);
    // filteredRows は server で絞られた現在ページ rows をそのまま使う
    expect(pageSrc).toMatch(/const filteredRows = job\?\.rows \?\? \[\];/);
  });

  it("mutation 後 refetch が page/limit/status を維持（fetchJob deps）", () => {
    expect(pageSrc).toMatch(/\}, \[jobId, page, filter\]\);/);
  });

  it("再取得後 page > totalPages を安全にクランプ", () => {
    expect(pageSrc).toMatch(/if \(page > totalPages\) setPage\(totalPages\);/);
  });

  it("batch resolve は B3 で bulk endpoint を呼び pagination 非依存で全件処理する", () => {
    // server-side bulk endpoint を呼ぶ（client は ID を持たない）
    expect(pageSrc).toMatch(
      /bulkResolveImportRows\(jobId,\s*\{\s*action,\s*scope\s*\}\)/,
    );
    // scope は現在の filter（needs_review / error）
    expect(pageSrc).toMatch(/const scope = filter;/);
    // 件数は server summary 由来（現ページ件数ではない）
    expect(pageSrc).toMatch(/summary\.needsReviewCount/);
    expect(pageSrc).toMatch(/summary\.errorCount/);
    // 確認文言は「全 N 件」
    expect(pageSrc).toMatch(/全 \$\{total\} 件を/);
    // 実行後に affectedCount を表示
    expect(pageSrc).toMatch(/res\.affectedCount/);
  });

  it("B2 の batch 無効化（isPaginated / B3 対応予定）は撤去されている", () => {
    expect(pageSrc).not.toMatch(/isPaginated/);
    expect(pageSrc).not.toMatch(/B3 対応予定/);
    // ボタンは pagination 非依存（actionLoading のみで無効化）
    expect(pageSrc).toMatch(/disabled=\{actionLoading === "batch"\}/);
    expect(pageSrc).not.toMatch(
      /disabled=\{actionLoading === "batch" \|\| isPaginated\}/,
    );
  });
});

describe("import job detail page — B4 重複候補のみスキップ (source-assertion)", () => {
  it("専用ハンドラが scope:'duplicate' で bulk endpoint を呼ぶ", () => {
    expect(pageSrc).toMatch(/const handleBulkResolveDuplicates = async \(\)/);
    expect(pageSrc).toMatch(
      /bulkResolveImportRows\(jobId,\s*\{[\s\S]*?action:\s*"skip",[\s\S]*?scope:\s*"duplicate"[\s\S]*?\}\)/,
    );
  });

  it("件数 N は job.duplicateActionableCount（counts.duplicateActionable）由来・現ページ件数ではない", () => {
    // Codex P2: actionable 件数を使う（skipped 重複を含む duplicateCount ではない）。
    expect(pageSrc).toMatch(/const total = counts\.duplicateActionable;/);
    expect(pageSrc).not.toMatch(/const total = counts\.duplicate;/);
    // counts.duplicateActionable は job.duplicateActionableCount 由来（安全側 ?? 0）。
    expect(pageSrc).toMatch(
      /duplicateActionable:\s*job\?\.duplicateActionableCount \?\? 0/,
    );
    // 確認文言は「重複候補 全 N 件」
    expect(pageSrc).toMatch(/重複候補 全 \$\{total\} 件を/);
    // 実行後に affectedCount を表示（既存方針を維持）
    expect(pageSrc).toMatch(/res\.affectedCount/);
  });

  it("ボタンは needs_review かつ counts.duplicateActionable>0 のときのみ表示（skipped済み重複だけなら出さない）", () => {
    expect(pageSrc).toMatch(
      /filter === "needs_review" &&\s*counts\.duplicateActionable > 0/,
    );
    expect(pageSrc).toMatch(
      /重複候補のみスキップ（\{counts\.duplicateActionable\}件）/,
    );
    // ハンドラ側も needs_review ガード
    expect(pageSrc).toMatch(
      /handleBulkResolveDuplicates = async \(\) => \{\s*if \(filter !== "needs_review"\) return;/,
    );
  });

  it("確認件数は duplicateCount（needs_review+skipped）を使わない＝過大表示にならない（Codex P2）", () => {
    // B4 の確認/ボタンは duplicateActionable のみを参照する。
    expect(pageSrc).toMatch(/counts\.duplicateActionable/);
    // 表示ヒント（内数）は従来どおり duplicateCount を残す（互換）。
    expect(pageSrc).toMatch(/\{counts\.duplicate\} 件/);
  });

  it("「全件スキップ」と「重複候補のみスキップ」を取り違えない（別操作・別 scope）", () => {
    // 全件スキップは従来どおり handleBatchResolve("skip")（= filter 全件）
    expect(pageSrc).toMatch(/handleBatchResolve\("skip"\)/);
    expect(pageSrc).toMatch(/全件スキップ/);
    // 重複候補のみスキップは専用ハンドラ（scope 固定 "duplicate"）で filter を scope に流用しない
    expect(pageSrc).toMatch(/onClick=\{handleBulkResolveDuplicates\}/);
    // 重複ハンドラ内で `const scope = filter` を使っていない（B3 全件用とは別系統）
    expect(pageSrc).not.toMatch(
      /handleBulkResolveDuplicates[\s\S]*?const scope = filter;/,
    );
  });
});
