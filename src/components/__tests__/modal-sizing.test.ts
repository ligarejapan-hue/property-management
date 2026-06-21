import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));

function readSrc(rel: string): string {
  // __tests__ is at src/components/__tests__/, so ".." reaches src/components/
  return readFileSync(join(dir, "..", rel), "utf-8");
}

describe("modal panel sizing (K1)", () => {
  test("new-property-modal: has max-w-[90vw], max-h-[90vh], overflow-y-auto", () => {
    const src = readSrc("properties/new-property-modal.tsx");
    expect(src).toContain("max-w-[90vw]");
    expect(src).toContain("max-h-[90vh]");
    expect(src).toContain("overflow-y-auto");
  });

  test("owner-link-modal: has max-w-[90vw], max-h-[90vh], overflow-y-auto", () => {
    const src = readSrc("owners/owner-link-modal.tsx");
    expect(src).toContain("max-w-[90vw]");
    expect(src).toContain("max-h-[90vh]");
    expect(src).toContain("overflow-y-auto");
  });

  test("OwnerMislinkModal: has max-w-[90vw], max-h-[90vh], overflow-y-auto", () => {
    const src = readSrc("owners/OwnerMislinkModal.tsx");
    expect(src).toContain("max-w-[90vw]");
    expect(src).toContain("max-h-[90vh]");
    expect(src).toContain("overflow-y-auto");
  });

  test("OwnerMergePreviewButton: has max-w-[90vw], max-h-[90vh], overflow-y-auto", () => {
    const src = readSrc("owners/OwnerMergePreviewButton.tsx");
    expect(src).toContain("max-w-[90vw]");
    expect(src).toContain("max-h-[90vh]");
    expect(src).toContain("overflow-y-auto");
  });

  test("pin-create-modal: has max-w-[90vw], max-h-[90vh], overflow-y-auto", () => {
    const src = readSrc("field-survey/pin-create-modal.tsx");
    expect(src).toContain("max-w-[90vw]");
    expect(src).toContain("max-h-[90vh]");
    expect(src).toContain("overflow-y-auto");
  });

  test("attachment-tab PreviewModal: has max-w-[90vw]", () => {
    const src = readSrc("properties/attachment-tab.tsx");
    expect(src).toContain("max-w-[90vw]");
  });
});
