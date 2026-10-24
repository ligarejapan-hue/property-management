import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 従業員の指摘⑨(2026-10-25)「エクセルから入れたデータに担当者の振り分けをしてほしい」。
// 物件一覧の「まとめて変更」で担当者を付けられる(取り込み済みの物件にも)。
const src = readFileSync(join(__dirname, "..", "page.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("物件一覧のまとめて変更: 担当者", () => {
  it("★選んだ物件の担当者を bulk-update の assignedTo で変える", () => {
    expect(src).toContain("handleBulkUpdate({ assignedTo: v === BULK_UNASSIGN ? null : v })");
    expect(src).toContain("担当者変更...");
  });

  it("★「担当者なしにする」は null を送る(ユーザーの id と重ならない値で選ぶ)", () => {
    expect(src).toContain('const BULK_UNASSIGN = "__unassign__"');
    expect(src).toContain("担当者なしにする");
  });

  it("選べる人は担当者の絞り込みと同じユーザー一覧", () => {
    const at = src.indexOf("担当者変更...");
    expect(src.slice(at, at + 300)).toContain("users.map(");
  });
});
