/**
 * DQ-04: テキスト衛生（制御文字/文字化け）candidates_list アクションが ACTION_EXTRA_KEYS に
 * 登録され、非PIIの監査メタデータ（type/resultCount/summary 子の件数/hasNextPage/truncated）が
 * [REDACTED] されずに残ること（監査が無価値化しない）を検証する。
 * stray な PII キー（name/address/note 等）は引き続き [REDACTED] されることも固定する。
 * （Codex P2: action 未登録だと summary 子件数 + hasNextPage/truncated が監査UIで redact される）
 */
import { describe, it, expect } from "vitest";
import { sanitizeAuditDetail, REDACTED } from "../audit-log-detail-safety";

const FULL_SUMMARY = {
  controlChars: 2,
  zeroWidth: 1,
  bidi: 0,
  replacementChar: 1,
  mojibake: 0,
  removableCandidates: 3,
  auditOnlyCandidates: 1,
  totalCandidates: 4,
};

describe("sanitizeAuditDetail: DQ-04 テキスト衛生 candidates_list の allowlist", () => {
  it("type/resultCount/summary(子件数)/hasNextPage/truncated は生存・stray PII は redact", () => {
    const out = sanitizeAuditDetail("owner_text_hygiene_candidates_list", {
      type: "all",
      resultCount: 4,
      summary: FULL_SUMMARY,
      hasNextPage: true,
      truncated: false,
      // 万一 detail に混入しても PII は redact されること（route 側では記録しない）。
      name: "漏洩太郎",
      address: "東京都港区PII住所",
      note: "秘密メモ",
    }) as Record<string, unknown>;
    expect(out.type).toBe("all");
    expect(out.resultCount).toBe(4);
    expect(out.summary).toEqual(FULL_SUMMARY);
    expect(out.hasNextPage).toBe(true);
    expect(out.truncated).toBe(false);
    expect(out.name).toBe(REDACTED);
    expect(out.address).toBe(REDACTED);
    expect(out.note).toBe(REDACTED);
  });

  it("未登録 action では同じ summary 子件数が [REDACTED]（登録の効果を固定）", () => {
    const out = sanitizeAuditDetail("some_unregistered_action", {
      summary: { controlChars: 2, totalCandidates: 4 },
    }) as Record<string, unknown>;
    // summary コンテナは ALWAYS_SAFE で通るが、DQ-04 固有の件数キーは未登録 action では
    // allowlist 外ゆえ子の値が [REDACTED] になる（＝本 PR の登録があって初めて生存する）。
    const summary = out.summary as Record<string, unknown>;
    expect(summary.controlChars).toBe(REDACTED);
    expect(summary.totalCandidates).toBe(REDACTED);
  });
});
