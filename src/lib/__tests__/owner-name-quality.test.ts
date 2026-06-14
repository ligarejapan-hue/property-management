/**
 * DQ-01: 数値・記号のみ氏名の検出と補正（純関数）テスト。
 *
 * 検証観点:
 * - classifyOwnerNameQuality: 数値のみ / 記号のみ / 空白のみ / 制御文字 / 長すぎ /
 *   短すぎ / 数字過多 の検出、および「正当な数字含み氏名・法人名を弾かない」誤検出回避。
 * - decideOwnerNameFix: 制御文字サニタイズで救える場合のみ sanitize、実体不明ゴミは manual。
 * - checkOwnerNameFixSafety: archived / version 不一致 / 空化 / 再ゴミ / 無変更 をブロック。
 * - summary 集計ヘルパー。
 */
import { describe, it, expect } from "vitest";
import {
  classifyOwnerNameQuality,
  decideOwnerNameFix,
  sanitizeOwnerName,
  checkOwnerNameFixSafety,
  emptyOwnerNameQualitySummary,
  tallyOwnerNameQuality,
  OWNER_NAME_MAX_LEN,
  OWNER_NAME_CORP_MAX_LEN,
} from "../owner-name-quality";

// 制御文字 / 文字化け文字はエディタ非表示のため fromCharCode で構成（ASCII ソース）。
const SOH = String.fromCharCode(0x01); // C0 制御文字
const REPL = String.fromCharCode(0xfffd); // U+FFFD 置換文字（文字化け）
const NAME_WITH_CONTROL = "Yamada" + SOH + "Taro"; // 文字あり + 制御文字
const NAME_WITH_REPL = "Sa" + REPL + "to";
const NUMERIC_WITH_CONTROL = "42" + SOH; // 数字のみ + 制御文字

describe("classifyOwnerNameQuality — 検出（error）", () => {
  it("数値のみ（半角）は numeric_only / error", () => {
    const r = classifyOwnerNameQuality({ name: "44225" });
    expect(r.issues).toContain("numeric_only");
    expect(r.severity).toBe("error");
  });

  it("数値のみ（全角）も NFKC 正規化後に numeric_only", () => {
    const r = classifyOwnerNameQuality({ name: "４４２２５" });
    expect(r.issues).toContain("numeric_only");
  });

  it("数字＋区切り（ハイフン/中黒/スペース）は numeric_only", () => {
    expect(classifyOwnerNameQuality({ name: "1-2-3" }).issues).toContain("numeric_only");
    expect(classifyOwnerNameQuality({ name: "090-1234-5678" }).issues).toContain("numeric_only");
    expect(classifyOwnerNameQuality({ name: "1・2・3" }).issues).toContain("numeric_only");
  });

  it("記号のみは symbol_only / error", () => {
    expect(classifyOwnerNameQuality({ name: "---" }).issues).toContain("symbol_only");
    expect(classifyOwnerNameQuality({ name: "／／" }).issues).toContain("symbol_only");
    expect(classifyOwnerNameQuality({ name: "***" }).severity).toBe("error");
  });

  it("空白のみ（全角空白・半角空白）は whitespace_only / error（min(1) を通過する値）", () => {
    expect(classifyOwnerNameQuality({ name: "　" }).issues).toContain("whitespace_only");
    expect(classifyOwnerNameQuality({ name: " " }).issues).toContain("whitespace_only");
    expect(classifyOwnerNameQuality({ name: "" }).issues).toContain("whitespace_only");
  });
});

describe("classifyOwnerNameQuality — 誤検出回避（正当値は issues 空）", () => {
  const legit = [
    "山田太郎",
    "3丁目ハイツ山田",
    "ABC商事",
    "株式会社１２３",
    "マンション302号 佐藤",
    "ｾﾌﾞﾝ-ｲﾚﾌﾞﾝ",
    "セブン-イレブン",
  ];
  for (const name of legit) {
    it(`「${name}」は数値/記号/空白ゴミと誤検出しない`, () => {
      const r = classifyOwnerNameQuality({ name });
      expect(r.issues).not.toContain("numeric_only");
      expect(r.issues).not.toContain("symbol_only");
      expect(r.issues).not.toContain("whitespace_only");
    });
  }

  it("法人格語を含む長い正式名称は too_long を出さない（緩和上限内）", () => {
    const longCorp = "株式会社" + "あ".repeat(OWNER_NAME_MAX_LEN + 5);
    const r = classifyOwnerNameQuality({ name: longCorp });
    expect(r.issues).not.toContain("too_long");
    expect(longCorp.length).toBeGreaterThan(OWNER_NAME_MAX_LEN);
    expect(longCorp.length).toBeLessThanOrEqual(OWNER_NAME_CORP_MAX_LEN);
  });

  it("corporateNumber がある owner は too_long 上限が緩和される", () => {
    const longName = "あ".repeat(OWNER_NAME_MAX_LEN + 5);
    expect(classifyOwnerNameQuality({ name: longName }).issues).toContain("too_long");
    expect(
      classifyOwnerNameQuality({ name: longName, corporateNumber: "1234567890123" }).issues,
    ).not.toContain("too_long");
  });
});

describe("classifyOwnerNameQuality — warning / info", () => {
  it("制御文字混入は control_chars / warning", () => {
    const r = classifyOwnerNameQuality({ name: NAME_WITH_CONTROL });
    expect(r.issues).toContain("control_chars");
  });

  it("U+FFFD（文字化け）は control_chars", () => {
    expect(classifyOwnerNameQuality({ name: NAME_WITH_REPL }).issues).toContain("control_chars");
  });

  it("既定上限超は too_long / warning", () => {
    const r = classifyOwnerNameQuality({ name: "あ".repeat(OWNER_NAME_MAX_LEN + 1) });
    expect(r.issues).toContain("too_long");
    expect(r.severity).toBe("warning");
  });

  it("1文字氏名は too_short（warning・正当もあるため error にしない）", () => {
    const r = classifyOwnerNameQuality({ name: "林" });
    expect(r.issues).toContain("too_short");
    expect(r.issues).not.toContain("numeric_only");
    expect(r.severity).toBe("warning");
  });

  it("文字を含むが数字過多は mostly_digits / info", () => {
    const r = classifyOwnerNameQuality({ name: "302山" });
    expect(r.issues).toContain("mostly_digits");
    expect(r.severity).toBe("info");
  });

  it("nameKana にカナ以外が混入すると kana_non_kana / info", () => {
    const r = classifyOwnerNameQuality({ name: "山田太郎", nameKana: "ヤマダ123" });
    expect(r.kanaIssues).toContain("kana_non_kana");
    expect(r.severity).toBe("info");
  });

  it("正しいカタカナ読みは kana 問題なし", () => {
    const r = classifyOwnerNameQuality({ name: "山田太郎", nameKana: "ヤマダ タロウ" });
    expect(r.kanaIssues).toHaveLength(0);
  });
});

describe("classifyOwnerNameQuality — severity は最大重大度", () => {
  it("error と warning が同時なら error", () => {
    const r = classifyOwnerNameQuality({ name: NUMERIC_WITH_CONTROL });
    expect(r.issues).toContain("numeric_only");
    expect(r.issues).toContain("control_chars");
    expect(r.severity).toBe("error");
  });

  it("問題なしは severity=null", () => {
    expect(classifyOwnerNameQuality({ name: "山田太郎" }).severity).toBeNull();
  });
});

describe("sanitizeOwnerName", () => {
  it("制御文字・U+FFFD を除去し空白を正規化する", () => {
    expect(sanitizeOwnerName("山田 太郎 ")).toBe("山田 太郎");
    expect(sanitizeOwnerName(NAME_WITH_REPL)).toBe("Sato");
    expect(sanitizeOwnerName(NAME_WITH_CONTROL)).toBe("YamadaTaro");
  });
});

describe("decideOwnerNameFix", () => {
  it("制御文字混入は sanitize で救える", () => {
    const p = decideOwnerNameFix(NAME_WITH_CONTROL);
    expect(p.action).toBe("sanitize");
    expect(p.cleanedName).toBe("YamadaTaro");
    expect(p.changedFields).toEqual(["name"]);
  });

  it("数値ゴミ（44225）は sanitize で救えず manual / no_safe_autofix", () => {
    const p = decideOwnerNameFix("44225");
    expect(p.action).toBe("manual");
    expect(p.manualReason).toBe("no_safe_autofix");
    expect(p.cleanedName).toBeNull();
  });

  it("除去すると空になる場合は manual / name_would_be_empty", () => {
    const p = decideOwnerNameFix(SOH + " ");
    expect(p.action).toBe("manual");
    expect(p.manualReason).toBe("name_would_be_empty");
  });

  it("空白のみ・空文字は manual / no_safe_autofix", () => {
    expect(decideOwnerNameFix("　").manualReason).toBe("no_safe_autofix");
    expect(decideOwnerNameFix("").manualReason).toBe("no_safe_autofix");
  });

  it("正当な氏名で変化なしは none", () => {
    const p = decideOwnerNameFix("山田太郎");
    expect(p.action).toBe("none");
    expect(p.changedFields).toEqual([]);
  });
});

describe("checkOwnerNameFixSafety", () => {
  const base = {
    isArchived: false,
    versionMatches: true,
    currentName: "44225",
    newName: "山田太郎",
  };

  it("正常な set は ok", () => {
    const r = checkOwnerNameFixSafety(base);
    expect(r.ok).toBe(true);
  });

  it("archived はブロック", () => {
    const r = checkOwnerNameFixSafety({ ...base, isArchived: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("owner_archived");
  });

  it("version 不一致はブロック", () => {
    const r = checkOwnerNameFixSafety({ ...base, versionMatches: false });
    if (!r.ok) expect(r.reasons).toContain("version_mismatch");
  });

  it("空化はブロック", () => {
    const r = checkOwnerNameFixSafety({ ...base, newName: "　" });
    if (!r.ok) expect(r.reasons).toContain("name_would_be_empty");
  });

  it("新値が再びゴミ（数値のみ）なら forbidden_value", () => {
    const r = checkOwnerNameFixSafety({ ...base, newName: "999" });
    if (!r.ok) expect(r.reasons).toContain("forbidden_value");
  });

  it("無変更は no_change", () => {
    const r = checkOwnerNameFixSafety({ ...base, currentName: "山田太郎", newName: "山田太郎" });
    if (!r.ok) expect(r.reasons).toContain("no_change");
  });
});

describe("summary helper", () => {
  it("issue 種別ごとに集計する", () => {
    const s = emptyOwnerNameQualitySummary();
    tallyOwnerNameQuality(s, classifyOwnerNameQuality({ name: "44225" }));
    tallyOwnerNameQuality(s, classifyOwnerNameQuality({ name: "---" }));
    tallyOwnerNameQuality(s, classifyOwnerNameQuality({ name: NAME_WITH_CONTROL }));
    expect(s.numericOnly).toBe(1);
    expect(s.symbolOnly).toBe(1);
    expect(s.controlChars).toBe(1);
    expect(s.totalCandidates).toBe(3);
  });

  it("問題なしは集計しない", () => {
    const s = emptyOwnerNameQualitySummary();
    tallyOwnerNameQuality(s, classifyOwnerNameQuality({ name: "山田太郎" }));
    expect(s.totalCandidates).toBe(0);
  });
});
