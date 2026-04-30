import { describe, it, expect } from "vitest";
import { classifyImportError } from "../import-error-display";

describe("classifyImportError", () => {
  // ---------- empty ----------
  it("住所が空です → empty / 住所", () => {
    const r = classifyImportError("住所が空です", { 住所: "" });
    expect(r.type).toBe("empty");
    expect(r.field).toBe("住所");
    expect(r.label).toBe("住所が未入力");
    expect(r.hint).toContain("住所");
  });

  it("住所が空です + rawData が「所在地」キーを使っている → field=所在地 にシノニム解決", () => {
    const r = classifyImportError("住所が空です", { 所在地: "" });
    expect(r.field).toBe("所在地");
  });

  it("住所が空です + rawData=null → canonical 住所 を返す", () => {
    const r = classifyImportError("住所が空です", null);
    expect(r.field).toBe("住所");
  });

  it("氏名が空です → empty / 氏名", () => {
    const r = classifyImportError("氏名が空です", { 氏名: "", 電話: "0" });
    expect(r.type).toBe("empty");
    expect(r.field).toBe("氏名");
  });

  // ---------- building_not_found ----------
  it("「棟名が見つかりません」 → building_not_found / 棟名", () => {
    const r = classifyImportError(
      "棟名が見つかりません。棟を先に登録してください",
      { 棟名: "○○マンション", 住所: "..." },
    );
    expect(r.type).toBe("building_not_found");
    expect(r.field).toBe("棟名");
  });

  it("棟候補が複数の文言も building_not_found に分類", () => {
    const r = classifyImportError(
      "棟候補が複数あります: A棟 / B棟",
      { 建物名: "A棟" },
    );
    expect(r.type).toBe("building_not_found");
    expect(r.field).toBe("建物名");
  });

  // ---------- duplicate ----------
  it("「重複の可能性[住所一致]: 既存物件ID=...」 → duplicate", () => {
    const r = classifyImportError(
      "重複の可能性[住所一致（正規化比較）]: 既存物件ID=abc (東京都港区1-1-1)",
      { 住所: "東京都港区1-1-1" },
    );
    expect(r.type).toBe("duplicate");
    expect(r.label).toContain("重複");
    expect(r.label).toContain("住所一致");
    expect(r.field).toBeNull();
  });

  it("owner_csv の「重複の可能性: 既存所有者ID=...」も duplicate に分類", () => {
    const r = classifyImportError(
      "重複の可能性: 既存所有者ID=xyz (山田太郎)",
      { 氏名: "山田太郎" },
    );
    expect(r.type).toBe("duplicate");
  });

  // ---------- update ----------
  it("「更新[住所一致]: 既存物件ID=...」 → update", () => {
    const r = classifyImportError(
      "更新[住所一致]: 既存物件ID=abc (更新項目: 地番, 用途地域)",
      {},
    );
    expect(r.type).toBe("update");
    expect(r.field).toBeNull();
  });

  // ---------- review (reception-owner) ----------
  it.each([
    ["要レビュー（所有者未突合）", "所有者"],
    ["要レビュー（物件未特定）", "物件"],
    ["要レビュー（複数候補）", "候補"],
    ["要レビュー（キー不足）", "キー"],
  ])("%s → review", (msg, expectedLabelFragment) => {
    const r = classifyImportError(msg, {});
    expect(r.type).toBe("review");
    expect(r.label).toContain(expectedLabelFragment);
    expect(r.field).toBeNull();
  });

  it("「想定外の状態」 → unknown", () => {
    const r = classifyImportError("想定外の状態", {});
    expect(r.type).toBe("unknown");
    expect(r.label).toBe("想定外の状態");
  });

  // ---------- unknown / fallback ----------
  it("null/undefined/空文字 → unknown（不明なエラー扱い）", () => {
    expect(classifyImportError(null, null).type).toBe("unknown");
    expect(classifyImportError(undefined, null).type).toBe("unknown");
    expect(classifyImportError("", null).type).toBe("unknown");
  });

  it("「不明なエラー」 → unknown", () => {
    const r = classifyImportError("不明なエラー", null);
    expect(r.type).toBe("unknown");
    expect(r.label).toBe("不明なエラー");
  });

  it("Prisma 例外文言など未知パターンは type=unknown / 共通ラベル", () => {
    const r = classifyImportError(
      "Argument `propertyType` is invalid",
      { 種別: "ABCD" },
    );
    expect(r.type).toBe("unknown");
    expect(r.label).toBe("取込エラー");
    expect(r.field).toBeNull();
    expect(r.hint).toBeTruthy();
  });

  // ---------- hint は常に空でない ----------
  it("どのケースでも hint は非空文字列で返る", () => {
    const cases = [
      "住所が空です",
      "氏名が空です",
      "棟名が見つかりません",
      "重複の可能性[住所一致]: ...",
      "更新[住所一致]: ...",
      "要レビュー（所有者未突合）",
      "想定外の状態",
      "不明なエラー",
      "fooobar",
      null,
    ];
    for (const c of cases) {
      const r = classifyImportError(c, null);
      expect(typeof r.hint).toBe("string");
      expect(r.hint.length).toBeGreaterThan(0);
    }
  });
});
