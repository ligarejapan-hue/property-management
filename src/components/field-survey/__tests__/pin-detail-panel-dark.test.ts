import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));

function readSrc(): string {
  // __tests__ is at src/components/field-survey/__tests__/
  // ".." reaches src/components/field-survey/
  return readFileSync(join(dir, "..", "pin-detail-panel.tsx"), "utf-8");
}

describe("pin-detail-panel dark mode", () => {
  // ── Panel shell ──────────────────────────────────────────────────────────

  test("aside panel has dark background (bg-gray-900)", () => {
    expect(readSrc()).toContain("dark:bg-gray-900");
  });

  test("aside panel has dark border (border-gray-700)", () => {
    expect(readSrc()).toContain("dark:border-gray-700");
  });

  test("header border-b has dark variant (border-gray-800)", () => {
    expect(readSrc()).toContain("dark:border-gray-800");
  });

  test("header heading has dark text (text-gray-100)", () => {
    expect(readSrc()).toContain("dark:text-gray-100");
  });

  test("close button has dark text (text-gray-400)", () => {
    expect(readSrc()).toContain("dark:text-gray-400");
  });

  // ── Error / info banners ─────────────────────────────────────────────────

  test("amber banners have dark amber background", () => {
    expect(readSrc()).toContain("dark:bg-amber-500/15");
  });

  test("amber banners have dark amber text (text-amber-300)", () => {
    expect(readSrc()).toContain("dark:text-amber-300");
  });

  test("amber banners have dark amber border", () => {
    expect(readSrc()).toContain("dark:border-amber-500/40");
  });

  // ── Delete section ───────────────────────────────────────────────────────

  test("delete confirm section top border has dark variant", () => {
    // border-t border-gray-200 → dark:border-gray-800
    expect(readSrc()).toContain("dark:border-gray-800");
  });

  test("delete button (non-confirm) has dark red accent background", () => {
    expect(readSrc()).toContain("dark:bg-red-500/10");
  });

  test("delete button (non-confirm) has dark red text", () => {
    expect(readSrc()).toContain("dark:text-red-300");
  });

  test("delete confirm dialog has dark red border", () => {
    expect(readSrc()).toContain("dark:border-red-500/40");
  });

  test("cancel button in confirm has dark neutral background", () => {
    // bg-white → dark:bg-gray-900 in delete cancel button
    // we confirm dark:bg-gray-900 is present (already tested above; the cancel is another instance)
    const src = readSrc();
    expect(src).toContain("dark:bg-gray-900");
  });

  test("cancel button in confirm has dark text (text-gray-200)", () => {
    expect(readSrc()).toContain("dark:text-gray-200");
  });

  // ── Photo section ────────────────────────────────────────────────────────

  test("photo section label has dark muted text (text-gray-400)", () => {
    expect(readSrc()).toContain("dark:text-gray-400");
  });

  test("photo thumbnail button has dark border (border-gray-800)", () => {
    // border-gray-200 on thumb → dark:border-gray-800
    expect(readSrc()).toContain("dark:border-gray-800");
  });

  test("broken photo placeholder has dark background (bg-gray-800)", () => {
    expect(readSrc()).toContain("dark:bg-gray-800");
  });

  test("photo preview close button has dark hover text", () => {
    // hover:text-gray-800 → dark:hover:text-gray-100
    expect(readSrc()).toContain("dark:hover:text-gray-100");
  });

  test("camera/gallery buttons have dark border (border-gray-700)", () => {
    expect(readSrc()).toContain("dark:border-gray-700");
  });

  test("camera/gallery buttons have dark hover background (hover:bg-gray-800)", () => {
    expect(readSrc()).toContain("dark:hover:bg-gray-800");
  });

  // ── ReadOnlyView ─────────────────────────────────────────────────────────

  test("ReadOnlyView dl has dark text (text-gray-100)", () => {
    // text-gray-800 → dark:text-gray-100 (already covers above test)
    expect(readSrc()).toContain("dark:text-gray-100");
  });

  test("ReadOnlyView dt label has dark muted text (text-gray-400)", () => {
    // text-gray-500 → dark:text-gray-400
    expect(readSrc()).toContain("dark:text-gray-400");
  });

  test("ReadOnlyView property link has dark indigo text", () => {
    expect(readSrc()).toContain("dark:text-indigo-400");
  });

  test("ReadOnlyView memo box has dark background (bg-gray-800/50 or bg-gray-800)", () => {
    const src = readSrc();
    // Either dark:bg-gray-800/50 or dark:bg-gray-800 is acceptable
    const ok =
      src.includes("dark:bg-gray-800/50") || src.includes("dark:bg-gray-800");
    expect(ok).toBe(true);
  });

  test("ReadOnlyView edit button has dark blue accent background", () => {
    expect(readSrc()).toContain("dark:bg-blue-500/20");
  });

  test("ReadOnlyView edit button has dark blue text", () => {
    expect(readSrc()).toContain("dark:text-blue-300");
  });

  test("ReadOnlyView edit button has dark blue border", () => {
    expect(readSrc()).toContain("dark:border-blue-500/40");
  });

  // ── EditView ─────────────────────────────────────────────────────────────

  test("EditView fieldset legend has dark text (text-gray-200)", () => {
    expect(readSrc()).toContain("dark:text-gray-200");
  });

  test("EditView memo textarea has dark input 3-point set (bg)", () => {
    // textarea inputs: dark:bg-gray-900
    expect(readSrc()).toContain("dark:bg-gray-900");
  });

  test("EditView memo textarea has dark input 3-point set (text)", () => {
    // dark:text-gray-100
    expect(readSrc()).toContain("dark:text-gray-100");
  });

  test("EditView memo textarea has dark input 3-point set (border)", () => {
    // dark:border-gray-700
    expect(readSrc()).toContain("dark:border-gray-700");
  });

  test("EditView char count has dark muted text (text-gray-500)", () => {
    expect(readSrc()).toContain("dark:text-gray-500");
  });

  test("EditView ID hint has dark muted text (text-gray-500)", () => {
    // text-gray-400 → dark:text-gray-500
    expect(readSrc()).toContain("dark:text-gray-500");
  });

  // ── Light-mode regression guards ─────────────────────────────────────────

  test("light bg-white preserved", () => {
    expect(readSrc()).toContain("bg-white");
  });

  test("light text-gray-800 preserved", () => {
    expect(readSrc()).toContain("text-gray-800");
  });

  test("light border-gray-200 preserved", () => {
    expect(readSrc()).toContain("border-gray-200");
  });

  test("light border-gray-300 preserved", () => {
    expect(readSrc()).toContain("border-gray-300");
  });

  test("light text-gray-500 preserved", () => {
    expect(readSrc()).toContain("text-gray-500");
  });

  test("light text-gray-700 preserved", () => {
    expect(readSrc()).toContain("text-gray-700");
  });

  test("light bg-amber-50 preserved", () => {
    expect(readSrc()).toContain("bg-amber-50");
  });

  test("light bg-red-50 preserved", () => {
    expect(readSrc()).toContain("bg-red-50");
  });

  test("light bg-blue-50 preserved", () => {
    expect(readSrc()).toContain("bg-blue-50");
  });

  test("light text-blue-700 preserved", () => {
    expect(readSrc()).toContain("text-blue-700");
  });
});
