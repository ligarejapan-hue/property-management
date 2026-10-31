import { describe, it, expect } from "vitest";
import { composePlace, parsePlace, placeKindsFor, placeProblem, EMPTY_PLACE } from "../place";

describe("契約場所・決済場所の選択肢", () => {
  it("契約は5つ・決済は銀行を足した6つ", () => {
    expect(placeKindsFor(false)).toEqual(["当社事務所", "仲介事務所", "売主宅", "買主宅", "その他"]);
    expect(placeKindsFor(true)).toEqual(["当社事務所", "仲介事務所", "売主宅", "買主宅", "銀行", "その他"]);
  });
});

describe("保存した文字 → 入力欄", () => {
  it("空は未選択", () => {
    expect(parsePlace(null, true)).toEqual(EMPTY_PLACE);
    expect(parsePlace("  ", true)).toEqual(EMPTY_PLACE);
  });
  it("選択肢と同じ文字はその選択肢", () => {
    expect(parsePlace("売主宅", false)).toEqual({ ...EMPTY_PLACE, kind: "売主宅" });
  });
  it("今までの手入力の文字は「その他」の欄にそのまま残す", () => {
    expect(parsePlace("試験区の貸会議室", true)).toEqual({ ...EMPTY_PLACE, kind: "その他", other: "試験区の貸会議室" });
  });
  it("決済の「銀行名 支店名」は銀行に戻る", () => {
    expect(parsePlace("試験銀行　渋谷支店", true)).toEqual({ ...EMPTY_PLACE, kind: "銀行", bank: "試験銀行", branch: "渋谷支店" });
  });
  it("契約に銀行は無いので、同じ文字でも「その他」", () => {
    expect(parsePlace("試験銀行　渋谷支店", false)).toEqual({ ...EMPTY_PLACE, kind: "その他", other: "試験銀行　渋谷支店" });
  });
});

describe("入力欄 → 保存する文字", () => {
  it("選択肢はそのまま・その他は手入力・銀行は銀行名+支店名", () => {
    expect(composePlace({ ...EMPTY_PLACE, kind: "当社事務所" })).toBe("当社事務所");
    expect(composePlace({ ...EMPTY_PLACE, kind: "その他", other: " 試験区の貸会議室 " })).toBe("試験区の貸会議室");
    expect(composePlace({ ...EMPTY_PLACE, kind: "銀行", bank: " 試験銀行 ", branch: "渋谷支店" })).toBe("試験銀行　渋谷支店");
  });
  it("選び直す前の手入力は混ざらない", () => {
    expect(composePlace({ kind: "売主宅", other: "残り", bank: "残り", branch: "残り" })).toBe("売主宅");
    expect(composePlace({ kind: "", other: "残り", bank: "", branch: "" })).toBe("");
  });
  it("その他に全角の空白があっても、開き直して銀行にならない", () => {
    const saved = composePlace({ ...EMPTY_PLACE, kind: "その他", other: "試験区役所　会議室" });
    expect(parsePlace(saved, true)).toEqual({ ...EMPTY_PLACE, kind: "その他", other: saved });
  });
  it("銀行名の中の全角の空白で、開き直したときに区切りがずれない", () => {
    const saved = composePlace({ ...EMPTY_PLACE, kind: "銀行", bank: "試験　銀行", branch: "渋谷支店" });
    expect(parsePlace(saved, true)).toEqual({ ...EMPTY_PLACE, kind: "銀行", bank: "試験 銀行", branch: "渋谷支店" });
  });
  it("どの選び方も、保存して開き直すと同じ文字に戻る", () => {
    for (const v of ["当社事務所", "仲介事務所", "売主宅", "買主宅", "試験区の貸会議室", "試験銀行　渋谷支店", ""]) {
      expect(composePlace(parsePlace(v, true))).toBe(v);
    }
  });
  it("銀行名と支店名を一番長く入れても、列の上限(200字)に収まる", () => {
    const saved = composePlace({ ...EMPTY_PLACE, kind: "銀行", bank: "あ".repeat(90), branch: "い".repeat(90) });
    expect(saved.length).toBeLessThanOrEqual(200);
  });
});

describe("入れ忘れの確認", () => {
  it("未選択と選択肢は問題なし", () => {
    expect(placeProblem(EMPTY_PLACE)).toBeNull();
    expect(placeProblem({ ...EMPTY_PLACE, kind: "買主宅" })).toBeNull();
  });
  it("その他で空は止める", () => {
    expect(placeProblem({ ...EMPTY_PLACE, kind: "その他", other: "  " })).toBe("場所を入れてください");
    expect(placeProblem({ ...EMPTY_PLACE, kind: "その他", other: "試験" })).toBeNull();
  });
  it("銀行は銀行名と支店名の両方が要る", () => {
    const message = "銀行名と支店名を入れてください";
    expect(placeProblem({ ...EMPTY_PLACE, kind: "銀行" })).toBe(message);
    expect(placeProblem({ ...EMPTY_PLACE, kind: "銀行", bank: "試験銀行" })).toBe(message);
    expect(placeProblem({ ...EMPTY_PLACE, kind: "銀行", branch: "渋谷支店" })).toBe(message);
    expect(placeProblem({ ...EMPTY_PLACE, kind: "銀行", bank: "試験銀行", branch: "渋谷支店" })).toBeNull();
  });
});
