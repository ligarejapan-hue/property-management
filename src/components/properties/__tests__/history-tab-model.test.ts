import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { caseStatusHistoryLabel, historyChangerLabel } from "../history-tab-model";

describe("変更履歴: 案件ステータスの表示", () => {
  it("今の値は画面の名前で出す", () => {
    expect(caseStatusHistoryLabel("new_case")).toBe("未着手");
    expect(caseStatusHistoryLabel("contracted")).toBe("契約完了");
    expect(caseStatusHistoryLabel("sold")).toBe("決済完了");
  });

  it("やめた古い値は（旧）付きの名前で出す", () => {
    expect(caseStatusHistoryLabel("dm_sent")).toBe("DM送付済（旧）");
  });

  it("空はそのまま・知らない値は内部の値のまま", () => {
    expect(caseStatusHistoryLabel(null)).toBeNull();
    expect(caseStatusHistoryLabel("zzz")).toBe("zzz");
  });
});

describe("変更履歴: 変更者の欄", () => {
  it("自動の切り替えは「自動」と出す(記録上の人の名前は出さない)", () => {
    expect(historyChangerLabel({ source: "auto", changer: { name: "山田" } })).toBe("自動");
  });

  it("手の変更は変更者の名前", () => {
    expect(historyChangerLabel({ source: "manual", changer: { name: "山田" } })).toBe("山田");
  });

  it("タブがこの2つの決まりと「自動」の出どころの名前を使っている", () => {
    const src = readFileSync(resolve(process.cwd(), "src/components/properties/history-tab.tsx"), "utf8");
    expect(src).toContain("historyChangerLabel(log)");
    expect(src).toContain("caseStatusHistoryLabel(");
    expect(src).toMatch(/auto:\s*"自動"/);
  });
});
