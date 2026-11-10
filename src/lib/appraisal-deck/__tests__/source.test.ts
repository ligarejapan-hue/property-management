import { describe, it, expect } from "vitest";
import { isGeneralAppraisalPdf } from "../source";

describe("isGeneralAppraisalPdf(直接付けた査定報告書か)", () => {
  it("一般の書類で種類が査定報告書の PDF だけ", () => {
    expect(isGeneralAppraisalPdf({ type: "general", docKind: "appraisal_report", mimeType: "application/pdf" })).toBe(true);
    expect(isGeneralAppraisalPdf({ type: "general", docKind: "appraisal_report", mimeType: "image/png" })).toBe(false);
    expect(isGeneralAppraisalPdf({ type: "general", docKind: "sales_contract", mimeType: "application/pdf" })).toBe(false);
    expect(isGeneralAppraisalPdf({ type: "general", docKind: null, mimeType: "application/pdf" })).toBe(false);
    // 受け取り箱の report は受け取り箱の添付で作る(ここでは二重に予約しない)
    expect(isGeneralAppraisalPdf({ type: "report", docKind: "appraisal_report", mimeType: "application/pdf" })).toBe(false);
    expect(isGeneralAppraisalPdf({ type: "registry", docKind: null, mimeType: "application/pdf" })).toBe(false);
  });
});
