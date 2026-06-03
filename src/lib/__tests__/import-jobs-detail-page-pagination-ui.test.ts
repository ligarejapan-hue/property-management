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

  it("batch resolve は B2 では無効化（ページング表示中）＋ B3 注記", () => {
    // ページング判定
    expect(pageSrc).toMatch(
      /const isPaginated = \(job\?\.pagination\?\.totalPages \?\? 1\) > 1;/,
    );
    // ボタンは isPaginated で無効化
    expect(pageSrc).toMatch(
      /disabled=\{actionLoading === "batch" \|\| isPaginated\}/,
    );
    // handler 側ガード（現ページのみの一括処理にしない）
    expect(pageSrc).toMatch(
      /if \(\(job\?\.pagination\?\.totalPages \?\? 1\) > 1\) return;/,
    );
    // B3 対応予定の注記
    expect(pageSrc).toMatch(/B3 対応予定/);
  });
});
