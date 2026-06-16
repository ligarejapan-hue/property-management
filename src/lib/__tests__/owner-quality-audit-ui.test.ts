/**
 * DQ-01/DQ-02 owner 品質監査 UI 用 純ヘルパのテスト。
 * - formatFixableFields: format_candidate 行の整形対象フィールド導出
 * - escapeControlForAudit: 監査セルの制御/双方向文字エスケープ（RLO 無害化）
 * - ラベル / フィルタ種別の drift ガード（route の issue コード / summary キーと整合）
 */
import { describe, it, expect } from "vitest";
import {
  formatFixableFields,
  escapeControlForAudit,
  NAME_ISSUE_LABEL,
  CONTACT_ISSUE_LABEL,
  NAME_TYPE_OPTIONS,
  CONTACT_TYPE_OPTIONS,
} from "../owner-quality-audit-ui";
import { emptyOwnerNameQualitySummary } from "../owner-name-quality";
import { emptyOwnerContactSummary } from "../owner-contact-format";

const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const NUL = String.fromCharCode(0x00);
const FFFD = String.fromCharCode(0xfffd);

describe("formatFixableFields", () => {
  it("zip_unformatted → [zip]", () => {
    expect(formatFixableFields(["zip_unformatted"])).toEqual(["zip"]);
  });
  it("phone_unnormalized → [phone]", () => {
    expect(formatFixableFields(["phone_unnormalized"])).toEqual(["phone"]);
  });
  it("両方 → [zip, phone]（順序固定）", () => {
    expect(
      formatFixableFields(["phone_unnormalized", "zip_unformatted"]),
    ).toEqual(["zip", "phone"]);
  });
  it("整形対象でない issue のみ → []", () => {
    expect(formatFixableFields(["zip_suspicious", "phone_non_phone"])).toEqual(
      [],
    );
  });
  it("空 → []", () => {
    expect(formatFixableFields([])).toEqual([]);
  });
});

describe("escapeControlForAudit", () => {
  it("制御 / ゼロ幅 / 双方向 / U+FFFD を \\uXXXX へ", () => {
    expect(escapeControlForAudit(`a${NUL}b`)).toBe("a\\u0000b");
    expect(escapeControlForAudit(`a${ZWSP}b`)).toBe("a\\u200Bb");
    expect(escapeControlForAudit(`a${RLO}b`)).toBe("a\\u202Eb");
    expect(escapeControlForAudit(`x${FFFD}y`)).toBe("x\\uFFFDy");
  });
  it("RLO を無害化（生の RLO を含まない＝表示順を改変できない）", () => {
    const out = escapeControlForAudit(`123${RLO}456`);
    expect(out).not.toContain(RLO);
    expect(out).toBe("123\\u202E456");
  });
  it("通常文字 / 全角 / 改行・タブ / 絵文字は不変", () => {
    expect(escapeControlForAudit("山田太郎")).toBe("山田太郎");
    expect(escapeControlForAudit("44225")).toBe("44225");
    expect(escapeControlForAudit("東京　都")).toBe("東京　都");
    expect(escapeControlForAudit("a\tb\nc")).toBe("a\tb\nc");
    expect(escapeControlForAudit("家🏠")).toBe("家🏠");
  });
  it("空 / null / undefined → 空文字", () => {
    expect(escapeControlForAudit("")).toBe("");
    expect(escapeControlForAudit(null)).toBe("");
    expect(escapeControlForAudit(undefined)).toBe("");
  });
});

describe("ラベル / フィルタ種別 drift ガード", () => {
  it("NAME_TYPE_OPTIONS（all 以外）は NAME_ISSUE_LABEL を網羅し過不足なし", () => {
    const optValues = NAME_TYPE_OPTIONS.filter((o) => o.value !== "all")
      .map((o) => o.value)
      .sort();
    const labelKeys = Object.keys(NAME_ISSUE_LABEL).sort();
    expect(optValues).toEqual(labelKeys);
  });
  it("CONTACT_TYPE_OPTIONS（all 以外）は CONTACT_ISSUE_LABEL を網羅し過不足なし", () => {
    const optValues = CONTACT_TYPE_OPTIONS.filter((o) => o.value !== "all")
      .map((o) => o.value)
      .sort();
    const labelKeys = Object.keys(CONTACT_ISSUE_LABEL).sort();
    expect(optValues).toEqual(labelKeys);
  });
  it("各 NAME_TYPE_OPTIONS の非 null summaryKey は実在の name summary キー（all は件数非表示=null）", () => {
    const summary = emptyOwnerNameQualitySummary();
    for (const opt of NAME_TYPE_OPTIONS) {
      if (opt.summaryKey == null) continue;
      expect(summary).toHaveProperty(opt.summaryKey);
    }
    // Codex P2: all は backend 述語と totalCandidates が不一致ゆえ件数非表示（null）。
    expect(
      NAME_TYPE_OPTIONS.find((o) => o.value === "all")?.summaryKey,
    ).toBeNull();
  });
  it("各 CONTACT_TYPE_OPTIONS の非 null summaryKey は実在の contact summary キー（all は件数非表示=null）", () => {
    const summary = emptyOwnerContactSummary();
    for (const opt of CONTACT_TYPE_OPTIONS) {
      if (opt.summaryKey == null) continue;
      expect(summary).toHaveProperty(opt.summaryKey);
    }
    expect(
      CONTACT_TYPE_OPTIONS.find((o) => o.value === "all")?.summaryKey,
    ).toBeNull();
  });
});
