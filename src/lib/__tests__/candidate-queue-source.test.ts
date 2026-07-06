import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const queue = readFileSync(
  path.resolve(process.cwd(), "src/components/field-survey/candidate-queue.tsx"),
  "utf-8",
);
const page = readFileSync(
  path.resolve(process.cwd(), "src/app/(dashboard)/field-survey/candidates/page.tsx"),
  "utf-8",
);

describe("candidate-queue", () => {
  it("listCandidatePins で候補を取得する", () => {
    expect(queue).toContain("listCandidatePins");
  });
  it("ConvertPinToPropertyModal を使い、canWriteProperty で出し分ける", () => {
    expect(queue).toContain("ConvertPinToPropertyModal");
    expect(queue).toContain("canWriteProperty");
  });
  it("変換成功で一覧を再取得する", () => {
    expect(queue).toMatch(/onConverted[\s\S]*load|refetch|fetchList/i);
  });
});

describe("candidates page", () => {
  it("CandidateQueue を描画する", () => {
    expect(page).toContain("CandidateQueue");
  });
});
