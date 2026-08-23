/**
 * 統合検索窓の入力の見分け (UI一貫性 第1弾 ①・発注者承認 2026-08-23)。
 *
 * 物件一覧の検索窓3連(住所・地番 / 管理ID / 所有者サジェスト)を1本に統合する。
 * 打った内容から行き先を自動で見分けるが、**曖昧な入力は必ず keyword(住所・地番)側**
 * に倒す:
 *   - 素の数字「120」は地番の一部でもあり得る(実在: 地番 180-1 等)
 *   - 「受付帳」はファイル名でも住所の一部でもあり得る
 *   → 管理ID扱いは**明確な構文のときだけ**(「120行」「◯.xlsx:120」「__sourceRef…」)。
 *     従来の管理ID窓が受けていた「素の数字」「ファイル名だけ」は、
 *     行サフィックスを付けてもらう(placeholder で例示)。
 */
import { describe, it, expect } from "vitest";
import { classifyPropertySearch } from "../property-search-classify";

describe("classifyPropertySearch", () => {
  it("空・空白のみ → empty", () => {
    expect(classifyPropertySearch("")).toBe("empty");
    expect(classifyPropertySearch("   ")).toBe("empty");
  });

  it("「120行」のような行サフィックス → mgmtId", () => {
    expect(classifyPropertySearch("120行")).toBe("mgmtId");
    expect(classifyPropertySearch("受付帳.xlsx:120行")).toBe("mgmtId");
  });

  it("全角コロンも許容(既存の管理ID検索と同じ) → mgmtId", () => {
    expect(classifyPropertySearch("受付帳.xlsx：120行")).toBe("mgmtId");
  });

  it("拡張子+コロン+数字(行なし)も管理IDの構文 → mgmtId", () => {
    expect(classifyPropertySearch("受付帳.xlsx:120")).toBe("mgmtId");
    expect(classifyPropertySearch("data.csv：45")).toBe("mgmtId");
  });

  it("__sourceRef 前置 → mgmtId", () => {
    expect(classifyPropertySearch("__sourceRef:abc")).toBe("mgmtId");
  });

  it("⚠素の数字は keyword(地番の一部であり得る)", () => {
    expect(classifyPropertySearch("120")).toBe("text");
    expect(classifyPropertySearch("180-1")).toBe("text");
  });

  it("⚠ファイル名だけ・拡張子だけは keyword(住所の一部であり得る)", () => {
    expect(classifyPropertySearch("受付帳")).toBe("text");
    expect(classifyPropertySearch("受付帳.xlsx")).toBe("text");
  });

  it("住所・氏名・電話は keyword(text)", () => {
    expect(classifyPropertySearch("世田谷区三宿")).toBe("text");
    expect(classifyPropertySearch("山田太郎")).toBe("text");
    expect(classifyPropertySearch("090-1234-5678")).toBe("text");
  });

  it("「行」が数字に続かない場合は keyword(例: 銀行前)", () => {
    expect(classifyPropertySearch("銀行前")).toBe("text");
    expect(classifyPropertySearch("三行半")).toBe("text");
  });

  it("前後の空白は無視して判定する", () => {
    expect(classifyPropertySearch("  120行  ")).toBe("mgmtId");
  });
});
