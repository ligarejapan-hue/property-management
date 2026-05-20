/**
 * OwnerMergePreviewButton: execute UI / 2 段階確認 / onExecuted 連携の source assertion。
 *
 * 要件:
 *   - eligible=true のみ実行ボタンを表示
 *   - 2 段階確認 (confirm1 → confirm2 → executing)
 *   - 「この操作は元に戻せません」明示
 *   - 成功後 onExecuted? callback を呼ぶ
 *   - 通信エラー / blockReasons の表示
 *   - 実行ボタンは現在 pair (masterId / sourceId) に対応した preview 結果のみで有効
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const buttonSrc = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/components/owners/OwnerMergePreviewButton.tsx",
  ),
  "utf8",
);

const pageSrc = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/(dashboard)/admin/owners/correction/page.tsx",
  ),
  "utf8",
);

describe("OwnerMergePreviewButton: execute UI", () => {
  it("eligible=true のみ実行ボタンを表示する条件式が存在", () => {
    // result.eligible &&（result.masterId === masterId）&&（sourceId === sourceId）
    expect(buttonSrc).toMatch(/result\.eligible/);
    expect(buttonSrc).toMatch(/result\.masterId\s*===\s*masterId/);
    expect(buttonSrc).toMatch(/result\.sourceId\s*===\s*sourceId/);
  });

  it("eligible=false の場合は execute ボタンが表示されない（条件式に eligible 必要）", () => {
    // executeState !== "executed" や eligible のガードが入った div ブロックを確認
    const m = buttonSrc.match(
      /result\.eligible\s*&&[\s\S]*?result\.masterId\s*===\s*masterId[\s\S]*?result\.sourceId\s*===\s*sourceId[\s\S]*?statusFromReasons|result\.eligible\s*&&[\s\S]*?統合を実行/,
    );
    expect(m).not.toBeNull();
  });

  it("2 段階確認: confirm1 / confirm2 の state が存在", () => {
    expect(buttonSrc).toMatch(/executeState\s*===\s*["']confirm1["']/);
    expect(buttonSrc).toMatch(/executeState\s*===\s*["']confirm2["']/);
  });

  it("「この操作は元に戻せません」文言が含まれる", () => {
    expect(buttonSrc).toContain("元に戻せません");
  });

  it("execute API は POST /api/admin/owners/correction/merge を叩く", () => {
    expect(buttonSrc).toMatch(/\/api\/admin\/owners\/correction\/merge/);
    // dryRun=false を明示
    expect(buttonSrc).toMatch(/dryRun:\s*false/);
  });

  it("成功後 onExecuted callback を呼ぶ", () => {
    expect(buttonSrc).toMatch(/onExecuted\?\.\(\)/);
  });

  it("通信エラーは catch で result=null + executeErrorMsg を立てる", () => {
    expect(buttonSrc).toMatch(
      /catch\s*\([\s\S]*?setExecuteResult\(null\)[\s\S]*?setExecuteState\(["']execute_error["']\)/,
    );
  });

  it("execute_error 時に blockReasons / errorMsg を表示する", () => {
    expect(buttonSrc).toMatch(/executeBlockReasons/);
    expect(buttonSrc).toMatch(/reasonLabel\(r\)/);
  });

  it("pair 変更時に execute state も reset される useEffect", () => {
    // [masterId, sourceId] 依存の useEffect 内に execute 系 setter
    const m = buttonSrc.match(
      /useEffect\(\s*\(\)\s*=>\s*\{[\s\S]*?\}\s*,\s*\[\s*masterId\s*,\s*sourceId\s*\]/,
    );
    expect(m).not.toBeNull();
    if (m) {
      expect(m[0]).toMatch(/setExecuteState\(["']idle["']\)/);
      expect(m[0]).toMatch(/setExecuteResult\(null\)/);
    }
  });

  it("version_mismatch label が含まれる", () => {
    expect(buttonSrc).toContain("version_mismatch");
  });
});

describe("correction page: onExecuted → load(filterType) を呼ぶ", () => {
  it("DuplicateGroupSummary に onExecuted={() => load(filterType)} を渡している", () => {
    expect(pageSrc).toMatch(
      /<DuplicateGroupSummary[\s\S]*?onExecuted=\{\(\)\s*=>\s*load\(filterType\)\}/,
    );
  });

  it("OwnerMergePreviewButton 呼び出しに onExecuted prop を渡している", () => {
    expect(pageSrc).toMatch(
      /<OwnerMergePreviewButton[\s\S]*?onExecuted=\{onExecuted\}/,
    );
  });
});
