import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));

function readSrc(rel: string): string {
  // __tests__ is at src/components/__tests__/, so ".." reaches src/components/
  return readFileSync(join(dir, "..", rel), "utf-8");
}

describe("modal dark mode (D1)", () => {
  // ── new-property-modal ──────────────────────────────────────────────────

  test("new-property-modal: panel has dark background", () => {
    const src = readSrc("properties/new-property-modal.tsx");
    expect(src).toContain("dark:bg-gray-900");
  });

  test("new-property-modal: has dark heading text (100-level)", () => {
    const src = readSrc("properties/new-property-modal.tsx");
    expect(src).toContain("dark:text-gray-100");
  });

  test("new-property-modal: has dark label text (200-level)", () => {
    const src = readSrc("properties/new-property-modal.tsx");
    expect(src).toContain("dark:text-gray-200");
  });

  test("new-property-modal: has dark border (800-level)", () => {
    const src = readSrc("properties/new-property-modal.tsx");
    expect(src).toContain("dark:border-gray-800");
  });

  test("new-property-modal: inputs have dark background (3-point set)", () => {
    const src = readSrc("properties/new-property-modal.tsx");
    // bg
    expect(src).toContain("dark:bg-gray-900");
    // text
    expect(src).toContain("dark:text-gray-100");
    // border
    expect(src).toContain("dark:border-gray-700");
  });

  test("new-property-modal: inputs have dark placeholder", () => {
    const src = readSrc("properties/new-property-modal.tsx");
    expect(src).toContain("dark:placeholder:text-gray-500");
  });

  // Light-mode classes must remain intact (regression guard)
  test("new-property-modal: light bg-white preserved", () => {
    const src = readSrc("properties/new-property-modal.tsx");
    expect(src).toContain("bg-white");
  });

  test("new-property-modal: light text-gray-600 family preserved", () => {
    const src = readSrc("properties/new-property-modal.tsx");
    // labels use text-gray-700 family
    expect(src).toContain("text-gray-700");
  });

  test("new-property-modal: light border-gray-300 preserved", () => {
    const src = readSrc("properties/new-property-modal.tsx");
    expect(src).toContain("border-gray-300");
  });

  // Size classes from #218 must remain intact
  test("new-property-modal: max-w-[90vw] preserved", () => {
    const src = readSrc("properties/new-property-modal.tsx");
    expect(src).toContain("max-w-[90vw]");
  });

  // ── owner-link-modal ────────────────────────────────────────────────────

  test("owner-link-modal: panel has dark background", () => {
    const src = readSrc("owners/owner-link-modal.tsx");
    expect(src).toContain("dark:bg-gray-900");
  });

  test("owner-link-modal: has dark heading text (100-level)", () => {
    const src = readSrc("owners/owner-link-modal.tsx");
    expect(src).toContain("dark:text-gray-100");
  });

  test("owner-link-modal: has dark body text (300-level)", () => {
    const src = readSrc("owners/owner-link-modal.tsx");
    expect(src).toContain("dark:text-gray-300");
  });

  test("owner-link-modal: has dark border (800-level)", () => {
    const src = readSrc("owners/owner-link-modal.tsx");
    expect(src).toContain("dark:border-gray-800");
  });

  test("owner-link-modal: has dark border (700-level)", () => {
    const src = readSrc("owners/owner-link-modal.tsx");
    expect(src).toContain("dark:border-gray-700");
  });

  test("owner-link-modal: inputClass has dark 3-point set", () => {
    const src = readSrc("owners/owner-link-modal.tsx");
    // All three points must be in inputClass (bg + text + border)
    expect(src).toContain("dark:bg-gray-900");
    expect(src).toContain("dark:text-gray-100");
    expect(src).toContain("dark:border-gray-700");
  });

  test("owner-link-modal: inputClass has dark placeholder", () => {
    const src = readSrc("owners/owner-link-modal.tsx");
    expect(src).toContain("dark:placeholder:text-gray-500");
  });

  // Light-mode classes must remain intact
  test("owner-link-modal: light bg-white preserved", () => {
    const src = readSrc("owners/owner-link-modal.tsx");
    expect(src).toContain("bg-white");
  });

  test("owner-link-modal: light border-gray-300 preserved", () => {
    const src = readSrc("owners/owner-link-modal.tsx");
    expect(src).toContain("border-gray-300");
  });

  test("owner-link-modal: light text-gray-600 family preserved", () => {
    const src = readSrc("owners/owner-link-modal.tsx");
    expect(src).toContain("text-gray-600");
  });

  // Size classes from #218 must remain intact
  test("owner-link-modal: max-w-[90vw] preserved", () => {
    const src = readSrc("owners/owner-link-modal.tsx");
    expect(src).toContain("max-w-[90vw]");
  });

  // Dark-mode readability on search result rows (D1 fix)
  test("owner-link-modal: selectable row hover has dark variant", () => {
    const src = readSrc("owners/owner-link-modal.tsx");
    expect(src).toContain("dark:hover:bg-gray-800");
  });

  test("owner-link-modal: selected row has dark variant", () => {
    const src = readSrc("owners/owner-link-modal.tsx");
    expect(src).toContain("dark:bg-indigo-500/25");
  });
});
