/**
 * src/lib/owner-corporate-import.ts の単体テスト（Phase D）。
 *
 * - 候補 0 / 1 / 複数の分岐
 * - 既存 corporateNumber が null / 同一 / 異なる の分岐
 * - 不正候補（12桁・全角ノイズなど）は detectCorporateNumberInOwnerLike が弾く想定
 * - summary 集計と message 文言が PII を含まない
 */
import { describe, it, expect } from "vitest";
import {
  decideCorporateImport,
  emptyCorporateImportSummary,
  tallyCorporateDecision,
  corporateImportMessage,
  appendImportMessage,
} from "../owner-corporate-import";

const CN = "1234567890123";
const CN_OTHER = "9876543210123";

describe("decideCorporateImport", () => {
  it("候補 0 件 → none", () => {
    const d = decideCorporateImport({ name: "山田太郎", address: "東京都" });
    expect(d.action).toBe("none");
    expect(d.corporateNumber).toBeNull();
  });

  it("候補 1 件 + 既存 null → save", () => {
    const d = decideCorporateImport({ name: `○○株式会社 法人番号:${CN}` });
    expect(d.action).toBe("save");
    expect(d.corporateNumber).toBe(CN);
  });

  it("候補 1 件 + 既存同一 → noop（書込不要）", () => {
    const d = decideCorporateImport(
      { name: `○○株式会社 ${CN}` },
      CN,
    );
    expect(d.action).toBe("noop");
    expect(d.corporateNumber).toBe(CN);
  });

  it("候補 1 件 + 既存異なる → conflict（自動上書きしない）", () => {
    const d = decideCorporateImport(
      { name: `○○株式会社 ${CN}` },
      CN_OTHER,
    );
    expect(d.action).toBe("conflict");
    expect(d.corporateNumber).toBeNull();
  });

  it("候補 2 件以上 → multi（自動保存しない）", () => {
    const d = decideCorporateImport({
      name: `A社 法人番号:${CN}`,
      note: `B社 ${CN_OTHER}`,
    });
    expect(d.action).toBe("multi");
    expect(d.corporateNumber).toBeNull();
  });

  it("12桁数字のみ → none（不正候補は検出されない）", () => {
    const d = decideCorporateImport({ name: "株式会社 法人番号:123456789012" });
    expect(d.action).toBe("none");
  });

  it("全角数字混じり 13桁 → save（normalize 経由で採用）", () => {
    const d = decideCorporateImport({
      name: "○○株式会社 法人番号:１２３４５６７８９０１２３",
    });
    expect(d.action).toBe("save");
    expect(d.corporateNumber).toBe(CN);
  });

  it("ハイフン混じり 13桁 → save（normalize 経由で採用）", () => {
    const d = decideCorporateImport({
      name: `○○株式会社 法人番号:${CN.slice(0, 4)}-${CN.slice(4, 8)}-${CN.slice(8)}`,
    });
    expect(d.action).toBe("save");
    expect(d.corporateNumber).toBe(CN);
  });

  it("address フィールドからも検出する", () => {
    const d = decideCorporateImport({
      name: "山田太郎",
      address: `東京都千代田区 法人番号:${CN}`,
    });
    expect(d.action).toBe("save");
    expect(d.corporateNumber).toBe(CN);
  });
});

describe("tallyCorporateDecision / summary", () => {
  it("各 action を正しく加算する", () => {
    const s = emptyCorporateImportSummary();
    tallyCorporateDecision(s, { action: "save", corporateNumber: CN });
    tallyCorporateDecision(s, { action: "save", corporateNumber: CN });
    tallyCorporateDecision(s, { action: "noop", corporateNumber: CN });
    tallyCorporateDecision(s, { action: "multi", corporateNumber: null });
    tallyCorporateDecision(s, { action: "conflict", corporateNumber: null });
    tallyCorporateDecision(s, { action: "none", corporateNumber: null });
    expect(s).toEqual({
      detected: 5,
      saved: 2,
      skippedMulti: 1,
      skippedConflict: 1,
    });
  });

  it("none は detected を加算しない", () => {
    const s = emptyCorporateImportSummary();
    tallyCorporateDecision(s, { action: "none", corporateNumber: null });
    expect(s).toEqual({
      detected: 0,
      saved: 0,
      skippedMulti: 0,
      skippedConflict: 0,
    });
  });
});

describe("corporateImportMessage", () => {
  it("multi → 非PIIメッセージ", () => {
    const msg = corporateImportMessage({ action: "multi", corporateNumber: null });
    expect(msg).toBe("corporate_number: 複数候補のためスキップ");
    expect(msg).not.toContain(CN);
  });

  it("conflict → 非PIIメッセージ", () => {
    const msg = corporateImportMessage({
      action: "conflict",
      corporateNumber: null,
    });
    expect(msg).toBe("corporate_number: 既存値と競合のためスキップ");
    expect(msg).not.toContain(CN);
  });

  it("save / noop / none → null（追記しない）", () => {
    expect(
      corporateImportMessage({ action: "save", corporateNumber: CN }),
    ).toBeNull();
    expect(
      corporateImportMessage({ action: "noop", corporateNumber: CN }),
    ).toBeNull();
    expect(
      corporateImportMessage({ action: "none", corporateNumber: null }),
    ).toBeNull();
  });
});

describe("appendImportMessage", () => {
  it("base のみ → base を返す", () => {
    expect(appendImportMessage("既存メッセージ", null)).toBe("既存メッセージ");
  });
  it("extra のみ → extra を返す", () => {
    expect(appendImportMessage(null, "追加メッセージ")).toBe("追加メッセージ");
  });
  it("両方 → スラッシュ区切りで連結", () => {
    expect(appendImportMessage("既存", "追加")).toBe("既存 / 追加");
  });
  it("両方 null → null", () => {
    expect(appendImportMessage(null, null)).toBeNull();
  });
  it("空文字は null と同じ扱い", () => {
    expect(appendImportMessage("", "追加")).toBe("追加");
    expect(appendImportMessage("既存", "")).toBe("既存");
  });
});
