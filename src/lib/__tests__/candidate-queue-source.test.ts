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
  it("変換成功で新しい物件ページへ直行する (一覧再読込でなく次アクションへ)", () => {
    // 謄本取得 / DM 判断は物件詳細にあるため、検索し直しの手間を無くす
    expect(queue).toMatch(/onConverted=\{\(propertyId\)/);
    expect(queue).toMatch(/router\.push\(`\/properties\/\$\{propertyId\}`\)/);
  });
});

describe("candidates page", () => {
  it("CandidateQueue を描画する", () => {
    expect(page).toContain("CandidateQueue");
  });
});
