import { describe, it, expect } from "vitest";
import { caseStatusForLeadExclusionChange } from "@/lib/lead-exclusion";
import { CASE_STATUS_LABELS, CASE_STATUS_VALUES, normalizeCaseStatusInput } from "@/lib/property-types";

// 2026-10-25 発注者「除外申請を申請したら案件ステータスは除外申請中・承認されたら除外・
// 除外されなかったらコンタクト中に戻す」。
describe("除外申請の状態が変わったときの案件ステータス", () => {
  it("★申請したら「除外申請中」", () => {
    expect(caseStatusForLeadExclusionChange(null, "requested", "contacting_owner")).toBe("lead_exclusion_requested");
  });

  it("★承認された(除外された)ら「除外」", () => {
    expect(caseStatusForLeadExclusionChange("requested", "approved", "lead_exclusion_requested")).toBe("lead_excluded");
  });

  it("★認められなかったら「コンタクト中」に戻す", () => {
    expect(caseStatusForLeadExclusionChange("requested", "rejected", "lead_exclusion_requested")).toBe("contact_attempting");
  });

  it("結果のあとに申請し直したら、また「除外申請中」", () => {
    expect(caseStatusForLeadExclusionChange("rejected", "requested", "contact_attempting")).toBe("lead_exclusion_requested");
  });

  it("状態が変わらない保存(申請した日だけを直す)では案件ステータスに触らない", () => {
    expect(caseStatusForLeadExclusionChange("requested", "requested", "negotiating")).toBeNull();
  });

  it("取り消したら、除外申請中・除外のままの案件だけ「コンタクト中」に戻す", () => {
    expect(caseStatusForLeadExclusionChange("requested", null, "lead_exclusion_requested")).toBe("contact_attempting");
    expect(caseStatusForLeadExclusionChange("approved", null, "lead_excluded")).toBe("contact_attempting");
    // 人が手で別の段階に動かしていたら、そのまま
    expect(caseStatusForLeadExclusionChange("requested", null, "negotiating")).toBeNull();
  });

  it("申請していない物件で「なし」を送っても触らない", () => {
    expect(caseStatusForLeadExclusionChange(null, null, "new_case")).toBeNull();
  });
});

describe("案件ステータスの「除外申請中」「除外」", () => {
  it("選べる値に入り、見送り・終了の後ろに並ぶ", () => {
    const i = CASE_STATUS_VALUES.indexOf("closed");
    expect(CASE_STATUS_VALUES.slice(i + 1)).toEqual(["lead_exclusion_requested", "lead_excluded"]);
    expect(CASE_STATUS_LABELS.lead_exclusion_requested).toBe("除外申請中");
    expect(CASE_STATUS_LABELS.lead_excluded).toBe("除外");
  });

  it("CSV の日本語の名前でも読める", () => {
    expect(normalizeCaseStatusInput("除外申請中")).toBe("lead_exclusion_requested");
    expect(normalizeCaseStatusInput("除外")).toBe("lead_excluded");
  });
});
