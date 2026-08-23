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
import {
  classifyPropertySearch,
  toMgmtIdQuery,
} from "../property-search-classify";

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

  it("拡張子で終わるファイル名 → mgmtId(取込ファイル単位の絞り込み・@codex #404 R5)", () => {
    // 「受付帳.xlsx」だけで、そのファイルから取り込んだ物件全部に絞る旧機能を守る。
    // 拡張子で終わる文字列は住所・地番ではあり得ないので曖昧さは無い。
    expect(classifyPropertySearch("受付帳.xlsx")).toBe("mgmtId");
    expect(classifyPropertySearch("data.csv")).toBe("mgmtId");
    expect(classifyPropertySearch("台帳.XLS")).toBe("mgmtId");
  });

  it("⚠拡張子の無いファイル名だけは keyword(住所の一部であり得る)", () => {
    expect(classifyPropertySearch("受付帳")).toBe("text");
    // 拡張子が途中にある(後ろに住所などが続く)場合も keyword。
    expect(classifyPropertySearch("受付帳.xlsxの物件")).toBe("text");
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

describe("不完全な構文は keyword(@codex #404 R8 P2)", () => {
  it("「120行目」「◯.xlsx:120行目」「◯.xlsx:120abc」は mgmtId にしない", () => {
    // server の parseMgmtIdQuery はこれらを行番号と解釈できず、ファイル名ヒント
    // 扱い=**そのファイル全部**という別の絞り込みに化ける。CSV/DM もこの
    // 絞り込みを使うため、分類は server が解釈できる完全形だけに絞る。
    expect(classifyPropertySearch("120行目")).toBe("text");
    expect(classifyPropertySearch("受付帳.xlsx:120行目")).toBe("text");
    expect(classifyPropertySearch("受付帳.xlsx:120abc")).toBe("text");
    expect(classifyPropertySearch("abc 120行")).toBe("text");
  });

  it("完全形は従来どおり mgmtId", () => {
    expect(classifyPropertySearch("受付帳.xlsx:120行")).toBe("mgmtId");
    expect(classifyPropertySearch("120 行")).toBe("mgmtId");
  });
});

describe("明示の接頭辞(@codex #404 R6 P2)", () => {
  it("「id:◯◯」「管理ID:◯◯」は任意の値を mgmtId へ通す", () => {
    // CSV出力の「管理ID」列の生値(例: MGMT-001)は構文を持たないため、
    // 接頭辞で明示して通す(コピー&ペースト運用)。
    expect(classifyPropertySearch("id:MGMT-001")).toBe("mgmtId");
    expect(classifyPropertySearch("管理ID：MGMT-001")).toBe("mgmtId");
    expect(classifyPropertySearch("ID: 受付帳分の何か")).toBe("mgmtId");
  });

  it("接頭辞だけ(中身なし)は、なりかけ=保留(R9で text から変更)", () => {
    expect(classifyPropertySearch("id:")).toBe("mgmtIdPartial");
    expect(classifyPropertySearch("管理ID：  ")).toBe("mgmtIdPartial");
  });

  it("toMgmtIdQuery は接頭辞を剥がし、他の構文はそのまま返す", () => {
    expect(toMgmtIdQuery("id:MGMT-001")).toBe("MGMT-001");
    expect(toMgmtIdQuery("管理ID： MGMT-001")).toBe("MGMT-001");
    expect(toMgmtIdQuery("120行")).toBe("120行");
    expect(toMgmtIdQuery("受付帳.xlsx:120")).toBe("受付帳.xlsx:120");
  });
});

describe("なりかけの形は保留(@codex #404 R9 P2)", () => {
  it("拡張子の断片・コロン待ち・接頭辞の途中は mgmtIdPartial", () => {
    expect(classifyPropertySearch("受付帳.")).toBe("mgmtIdPartial");
    expect(classifyPropertySearch("受付帳.x")).toBe("mgmtIdPartial");
    expect(classifyPropertySearch("受付帳.xl")).toBe("mgmtIdPartial");
    expect(classifyPropertySearch("受付帳.xlsx:")).toBe("mgmtIdPartial");
    expect(classifyPropertySearch("id")).toBe("mgmtIdPartial");
    expect(classifyPropertySearch("id:")).toBe("mgmtIdPartial");
    expect(classifyPropertySearch("管理ID：")).toBe("mgmtIdPartial");
  });

  it("完全形はなりかけにならない(先に mgmtId 判定)", () => {
    expect(classifyPropertySearch("受付帳.xls")).toBe("mgmtId");
    expect(classifyPropertySearch("受付帳.csv")).toBe("mgmtId");
  });

  it("普通の住所・名前はなりかけ扱いにならない", () => {
    expect(classifyPropertySearch("世田谷区三宿")).toBe("text");
    expect(classifyPropertySearch("山田太郎")).toBe("text");
  });
});
