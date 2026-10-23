import { describe, it, expect } from "vitest";
import {
  INQUIRER_NAME_MAX_LENGTH,
  REDACTED_CHANGE_VALUE,
  inquirerNameForViewer,
  isInquirerNameTooLong,
  normalizeInquirerName,
  ownerColumnDisplay,
  redactPropertyChangeValue,
} from "@/lib/inquirer-name";

describe("normalizeInquirerName", () => {
  it("前後の空白を除く・空/空白だけ/文字列以外は null", () => {
    expect(normalizeInquirerName("  山田 太郎　")).toBe("山田 太郎");
    expect(normalizeInquirerName("   ")).toBeNull();
    expect(normalizeInquirerName("")).toBeNull();
    expect(normalizeInquirerName(null)).toBeNull();
    expect(normalizeInquirerName(123)).toBeNull();
  });
  it("長さは整えてから測る(上限ちょうど+前後の空白は通す)", () => {
    const max = "あ".repeat(INQUIRER_NAME_MAX_LENGTH);
    expect(isInquirerNameTooLong(`  ${max}  `)).toBe(false);
    expect(isInquirerNameTooLong(`${max}あ`)).toBe(true);
  });
});

describe("inquirerNameForViewer(API が返す値)", () => {
  it("owner:read が無ければキーごと出さない(undefined)", () => {
    expect(inquirerNameForViewer("山田太郎", null)).toBeUndefined();
  });
  it("所有者の氏名と同じ表示レベルで伏せる", () => {
    expect(inquirerNameForViewer("山田太郎", "full")).toBe("山田太郎");
    expect(inquirerNameForViewer("山田太郎様", "partial")).toBe("山田太***");
    expect(inquirerNameForViewer("山田太郎", "hidden")).toBeNull();
    expect(inquirerNameForViewer(null, "full")).toBeNull();
  });
});

describe("ownerColumnDisplay(一覧の 問い合わせ者／所有者 の列)", () => {
  it("問い合わせ者があればそれだけ(札=問合せ)", () => {
    expect(ownerColumnDisplay("山田花子", ["山田太郎"])).toEqual({ kind: "inquirer", label: "問合せ", names: ["山田花子"] });
  });
  it("無ければ所有者(札=所有者)", () => {
    expect(ownerColumnDisplay(null, ["山田太郎", "山田次郎"])).toEqual({
      kind: "owner",
      label: "所有者",
      names: ["山田太郎", "山田次郎"],
    });
    expect(ownerColumnDisplay("  ", ["山田太郎"]).kind).toBe("owner");
    expect(ownerColumnDisplay(undefined, ["山田太郎"]).kind).toBe("owner");
  });
  it("どちらも無ければ none", () => {
    expect(ownerColumnDisplay(null, [])).toEqual({ kind: "none", label: "", names: [] });
    expect(ownerColumnDisplay(undefined, undefined).kind).toBe("none");
  });
});

describe("redactPropertyChangeValue(変更履歴)", () => {
  it("問い合わせ者以外の欄はそのまま", () => {
    expect(redactPropertyChangeValue("note", "メモ", null)).toBe("メモ");
  });
  it("owner:read が無ければ「（非表示）」・空はそのまま", () => {
    expect(redactPropertyChangeValue("inquirerName", "山田太郎", null)).toBe(REDACTED_CHANGE_VALUE);
    expect(redactPropertyChangeValue("inquirerName", null, null)).toBeNull();
  });
  it("ある人には所有者の氏名と同じ表示レベル", () => {
    expect(redactPropertyChangeValue("inquirerName", "山田太郎", "full")).toBe("山田太郎");
    expect(redactPropertyChangeValue("inquirerName", "山田太郎様", "partial")).toBe("山田太***");
    expect(redactPropertyChangeValue("inquirerName", "山田太郎", "hidden")).toBe(REDACTED_CHANGE_VALUE);
  });
});
