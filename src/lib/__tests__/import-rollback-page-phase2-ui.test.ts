/**
 * Phase 2: rollback UI source-assertion テスト
 *
 * - summary に restorable / restorableFieldCount を表示
 * - restoreDetails の折りたたみリストを表示
 * - 実行ボタンの表示条件が deletable > 0 OR restorable > 0
 * - 結果に restoredPropertyCount / restoredFieldCount を表示
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

describe("import/jobs/[jobId] rollback UI Phase 2", () => {
  it("summary に restorable / restorableFieldCount を表示する", () => {
    expect(pageSrc).toMatch(/rollbackPreview\.summary\.restorable\b/);
    expect(pageSrc).toMatch(/restorableFieldCount/);
  });

  it("dryRun の restoreDetails 折りたたみリストを描画する", () => {
    expect(pageSrc).toMatch(
      /data-testid=("|')rollback-restore-preview-list\1/,
    );
    expect(pageSrc).toMatch(/rollbackPreview\.restoreDetails/);
  });

  it("execute 結果に restoredPropertyCount / restoredFieldCount を表示する", () => {
    expect(pageSrc).toMatch(/rollbackResult\.restoredPropertyCount/);
    expect(pageSrc).toMatch(/rollbackResult\.restoredFieldCount/);
    expect(pageSrc).toMatch(
      /data-testid=("|')rollback-restore-result-list\1/,
    );
  });

  it("実行ボタンの表示条件に restorable > 0 を含める", () => {
    expect(pageSrc).toMatch(
      /summary\.deletable\s*>\s*0[\s\S]{0,80}summary\.restorable\s*>\s*0/,
    );
  });
});
