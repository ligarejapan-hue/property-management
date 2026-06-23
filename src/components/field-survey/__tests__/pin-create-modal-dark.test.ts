import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));

function readSrc(): string {
  // __tests__ is at src/components/field-survey/__tests__/
  // ".." reaches src/components/field-survey/
  return readFileSync(join(dir, "..", "pin-create-modal.tsx"), "utf-8");
}

describe("pin-create-modal dark mode", () => {
  // ── Modal card ───────────────────────────────────────────────────────────

  test("modal inner card has dark background (bg-gray-900)", () => {
    expect(readSrc()).toContain("dark:bg-gray-900");
  });

  test("modal heading has dark text (text-gray-100)", () => {
    expect(readSrc()).toContain("dark:text-gray-100");
  });

  test("coordinate dl has dark text (text-gray-200)", () => {
    // text-gray-700 → dark:text-gray-200
    expect(readSrc()).toContain("dark:text-gray-200");
  });

  // ── Current location button ──────────────────────────────────────────────

  test("use-current-location button has dark border (border-gray-700)", () => {
    expect(readSrc()).toContain("dark:border-gray-700");
  });

  test("use-current-location button has dark hover (hover:bg-gray-800)", () => {
    expect(readSrc()).toContain("dark:hover:bg-gray-800");
  });

  test("use-current-location button has dark text (text-gray-200)", () => {
    // text-gray-700 → dark:text-gray-200
    expect(readSrc()).toContain("dark:text-gray-200");
  });

  test("currentLocationError amber banner has dark amber background", () => {
    expect(readSrc()).toContain("dark:bg-amber-500/15");
  });

  test("currentLocationError amber banner has dark amber text", () => {
    expect(readSrc()).toContain("dark:text-amber-300");
  });

  test("currentLocationError amber banner has dark amber border", () => {
    expect(readSrc()).toContain("dark:border-amber-500/40");
  });

  // ── Pin type fieldset ────────────────────────────────────────────────────

  test("pin-type legend has dark text (text-gray-200)", () => {
    // text-gray-700 → dark:text-gray-200
    expect(readSrc()).toContain("dark:text-gray-200");
  });

  // ── Memo textarea ────────────────────────────────────────────────────────

  test("memo textarea has dark input bg (dark:bg-gray-900)", () => {
    expect(readSrc()).toContain("dark:bg-gray-900");
  });

  test("memo textarea has dark input text (dark:text-gray-100)", () => {
    expect(readSrc()).toContain("dark:text-gray-100");
  });

  test("memo textarea has dark input border (dark:border-gray-700)", () => {
    expect(readSrc()).toContain("dark:border-gray-700");
  });

  test("memo textarea has dark placeholder (dark:placeholder:text-gray-500)", () => {
    expect(readSrc()).toContain("dark:placeholder:text-gray-500");
  });

  test("memo char count has dark muted text (text-gray-500)", () => {
    // text-gray-400 → dark:text-gray-500
    expect(readSrc()).toContain("dark:text-gray-500");
  });

  // ── Photo section ────────────────────────────────────────────────────────

  test("photo label span has dark text (text-gray-200)", () => {
    // text-gray-700 → dark:text-gray-200
    expect(readSrc()).toContain("dark:text-gray-200");
  });

  test("photo camera button has dark border", () => {
    expect(readSrc()).toContain("dark:border-gray-700");
  });

  test("photo add button has dark hover", () => {
    expect(readSrc()).toContain("dark:hover:bg-gray-800");
  });

  test("photo thumbnail has dark border (border-gray-800)", () => {
    // border-gray-200 on thumb → dark:border-gray-800
    expect(readSrc()).toContain("dark:border-gray-800");
  });

  test("photo clear button has dark text (text-gray-400)", () => {
    // text-gray-500 → dark:text-gray-400
    expect(readSrc()).toContain("dark:text-gray-400");
  });

  test("photo clear button has dark hover text (hover:text-gray-100)", () => {
    expect(readSrc()).toContain("dark:hover:text-gray-100");
  });

  // ── Status banners ───────────────────────────────────────────────────────

  test("no-session amber banner has dark amber background", () => {
    expect(readSrc()).toContain("dark:bg-amber-500/15");
  });

  test("no-session amber banner has dark amber text", () => {
    expect(readSrc()).toContain("dark:text-amber-300");
  });

  test("serverError amber banner has dark amber border", () => {
    expect(readSrc()).toContain("dark:border-amber-500/40");
  });

  // ── Photo upload failed section ──────────────────────────────────────────

  test("photoUploadFailed container has dark amber background", () => {
    expect(readSrc()).toContain("dark:bg-amber-500/15");
  });

  test("photoUploadFailed 'pin saved' text has dark emerald color", () => {
    expect(readSrc()).toContain("dark:text-emerald-400");
  });

  test("'finish without photo' button has dark neutral bg", () => {
    expect(readSrc()).toContain("dark:bg-gray-900");
  });

  test("'finish without photo' button has dark text (text-gray-200)", () => {
    expect(readSrc()).toContain("dark:text-gray-200");
  });

  // ── Cancel button (main form) ────────────────────────────────────────────

  test("cancel button has dark neutral bg (bg-gray-900)", () => {
    expect(readSrc()).toContain("dark:bg-gray-900");
  });

  test("cancel button has dark text (text-gray-200)", () => {
    expect(readSrc()).toContain("dark:text-gray-200");
  });

  // ── Light-mode regression guards ─────────────────────────────────────────

  test("light bg-white preserved", () => {
    expect(readSrc()).toContain("bg-white");
  });

  test("light text-gray-700 preserved", () => {
    expect(readSrc()).toContain("text-gray-700");
  });

  test("light text-gray-800 preserved", () => {
    expect(readSrc()).toContain("text-gray-800");
  });

  test("light border-gray-300 preserved", () => {
    expect(readSrc()).toContain("border-gray-300");
  });

  test("light border-gray-200 preserved", () => {
    expect(readSrc()).toContain("border-gray-200");
  });

  test("light text-gray-500 preserved", () => {
    expect(readSrc()).toContain("text-gray-500");
  });

  test("light text-gray-400 preserved", () => {
    expect(readSrc()).toContain("text-gray-400");
  });

  test("light bg-amber-50 preserved", () => {
    expect(readSrc()).toContain("bg-amber-50");
  });

  test("light text-amber-900 preserved", () => {
    expect(readSrc()).toContain("text-amber-900");
  });

  test("solid indigo submit button preserved", () => {
    expect(readSrc()).toContain("bg-indigo-600");
  });

  test("light text-emerald-700 preserved", () => {
    expect(readSrc()).toContain("text-emerald-700");
  });
});
