import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(
  path.resolve(process.cwd(), "src/components/field-survey/field-survey-map.tsx"),
  "utf-8",
);

describe("field-survey-map: canWriteProperty 配線", () => {
  it("property:write を granted で判定する導出を持つ", () => {
    expect(src).toMatch(/resource === "property"[\s\S]*action === "write"[\s\S]*granted === true/);
  });

  it("PinDetailPanel に canWriteProperty を渡す", () => {
    expect(src).toMatch(/canWriteProperty=\{canWriteProperty === true\}/);
  });
});
