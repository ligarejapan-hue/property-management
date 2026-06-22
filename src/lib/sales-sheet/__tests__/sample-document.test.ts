import { describe, it, expect } from "vitest";
import { salesSheetDocumentSchema } from "../document-schema";
import { sampleDocument } from "../__fixtures__/sample-document";

describe("sampleDocument fixture", () => {
  it("スキーマに適合する", () => {
    expect(salesSheetDocumentSchema.safeParse(sampleDocument).success).toBe(true);
  });
  it("text/image/table/badge を含む", () => {
    const types = sampleDocument.elements.map((e) => e.type);
    expect(types).toContain("text");
    expect(types).toContain("image");
    expect(types).toContain("table");
    expect(types).toContain("badge");
  });
});
