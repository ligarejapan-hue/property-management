import { describe, expect, it } from "vitest";
import { matchAssignee } from "../assignee-match";

// 従業員の指摘⑨(2026-10-25): Excel の担当者の列をシステムの担当者に当てる。迷ったら当てない。
const users = [
  { id: "u-katsuchi", name: "勝地 太郎" },
  { id: "u-murayama", name: "村山　花子" },
  { id: "u-sato1", name: "佐藤 一郎" },
  { id: "u-sato2", name: "佐藤 次郎" },
  { id: "u-admin", name: "Claude作業用" },
];

describe("Excel の担当者 → システムの担当者", () => {
  it("★名字だけでも1人に決まれば当てる(全角空白・半角空白どちらの氏名でも)", () => {
    expect(matchAssignee("勝地", users)).toBe("u-katsuchi");
    expect(matchAssignee("村山", users)).toBe("u-murayama");
    expect(matchAssignee(" 村山 ", users)).toBe("u-murayama");
  });

  it("★氏名がそのまま同じなら当てる(空白の違い・様/さんは無視)", () => {
    expect(matchAssignee("勝地太郎", users)).toBe("u-katsuchi");
    expect(matchAssignee("佐藤 次郎", users)).toBe("u-sato2");
    expect(matchAssignee("勝地さん", users)).toBe("u-katsuchi");
  });

  it("★同じ名字が2人いるときは当てない(人が選ぶ)", () => {
    expect(matchAssignee("佐藤", users)).toBeNull();
  });

  it("誰にも当たらない・空なら当てない", () => {
    expect(matchAssignee("田中", users)).toBeNull();
    expect(matchAssignee("", users)).toBeNull();
    expect(matchAssignee(null, users)).toBeNull();
    expect(matchAssignee("勝地", [])).toBeNull();
  });

  it("ユーザーの登録名が名字だけでも、表の氏名の頭が同じなら当てる", () => {
    expect(matchAssignee("勝地太郎", [{ id: "x", name: "勝地" }])).toBe("x");
  });
});
