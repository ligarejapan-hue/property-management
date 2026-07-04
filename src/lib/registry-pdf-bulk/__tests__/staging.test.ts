import { describe, it, expect } from "vitest";
import { registryPdfBulkStagingKey } from "../staging";

describe("registryPdfBulkStagingKey", () => {
  it("ジョブID/行番号からキーを組み立てる", () => {
    expect(
      registryPdfBulkStagingKey("11111111-2222-3333-4444-555555555555", 3),
    ).toBe(
      "import-staging/registry-pdf/11111111-2222-3333-4444-555555555555/3.pdf",
    );
  });

  it("不正な入力は throw(キーにtraversal要素を入れない)", () => {
    expect(() => registryPdfBulkStagingKey("../etc", 1)).toThrow();
    expect(() => registryPdfBulkStagingKey("", 1)).toThrow();
    expect(() =>
      registryPdfBulkStagingKey("11111111-2222-3333-4444-555555555555", 0),
    ).toThrow();
    expect(() =>
      registryPdfBulkStagingKey("11111111-2222-3333-4444-555555555555", 1.5),
    ).toThrow();
  });
});
