/**
 * import job 詳細ページの server-summary 配線（PR-A）ソース表明テスト。
 *
 * 本リポは vitest environment="node"（jsdom / RTL なし）のため、ページの
 * hooks 実行はテストできない。既存方針（import-rollback-page-phase2-ui.test.ts）
 * に倣い、page.tsx のソースを読み配線を表明する:
 *   - summary は job.summary を優先し、未提供時のみ calcImportSummary にフォールバック
 *   - ImportJob 型が optional summary を持つ
 *   - 「all」タブ件数も server summary (totalCount) 由来
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

describe("import job detail page — server summary 配線 (PR-A source-assertion)", () => {
  it("summary は job.summary を優先し calcImportSummary にフォールバックする", () => {
    expect(pageSrc).toMatch(
      /const summary = job\?\.summary \?\? calcImportSummary\(/,
    );
  });

  it("ImportJob 型に optional な summary フィールドを持つ", () => {
    expect(pageSrc).toMatch(/summary\?:\s*ImportSummary/);
  });

  it("ImportSummary 型を import している", () => {
    expect(pageSrc).toMatch(
      /import\s*\{[^}]*type ImportSummary[^}]*\}\s*from\s*"@\/lib\/import-summary"/,
    );
  });

  it("「all」タブ件数も server summary (totalCount) 由来", () => {
    expect(pageSrc).toMatch(/all:\s*summary\.totalCount/);
  });
});
