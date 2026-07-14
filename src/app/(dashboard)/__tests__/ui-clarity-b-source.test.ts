import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// env=node(jsdom 無し)のため、UI 文言/配線の回帰はソース文字列で守る。
const read = (p: string) => readFileSync(path.resolve(process.cwd(), p), "utf-8");

describe("B-5: 現地調査マップの説明文から開発用語を排除(UI総点検)", () => {
  const src = read("src/app/(dashboard)/field-survey/map/page.tsx");

  it("フェーズ番号・実装メモの露出を消す", () => {
    expect(src).not.toContain("Phase 1-F-1");
    expect(src).not.toContain("UI のみ追加");
    expect(src).not.toContain("次フェーズで追加予定");
  });

  it("現状を平易な言葉で説明する", () => {
    expect(src).toContain("巡回の開始・終了");
  });

  it("巡回操作の案内は write 権限がある時だけ出す(read-only に不可能な操作を勧めない・@codex)", () => {
    expect(src).toContain('hasPermission(permissions, "field_survey", "write")');
    expect(src).toContain('{canWrite && "巡回の開始・終了');
  });
});

describe("B-9: 更新日フィルタの範囲逆転(開始>終了)を警告する(UI総点検)", () => {
  const src = read("src/app/(dashboard)/properties/page.tsx");

  it("開始>終了を検出する派生値がある", () => {
    expect(src).toContain("const dateRangeInvalid");
    expect(src).toContain("updatedFromFilter > updatedToFilter");
  });

  it("警告文を表示する", () => {
    expect(src).toContain("開始日が終了日より後です");
  });
});
