import { describe, it, expect } from "vitest";
import { badgeIntentClass } from "../status-badge";

/**
 * StatusBadge dark variant unit tests (phase2a T1).
 * Verifies that badgeIntentClass() returns strings containing
 * the expected dark: Tailwind classes for each intent.
 * These are source-assertion tests on a pure function (no jsdom needed).
 */

describe("badgeIntentClass – dark variants present", () => {
  it("success includes dark background, text, and ring", () => {
    const result = badgeIntentClass("success");
    expect(result).toContain("dark:bg-green-500/10");
    expect(result).toContain("dark:text-green-300");
    expect(result).toContain("dark:ring-green-400/20");
  });

  it("warning includes dark background, text, and ring", () => {
    const result = badgeIntentClass("warning");
    expect(result).toContain("dark:bg-amber-500/10");
    expect(result).toContain("dark:text-amber-300");
    expect(result).toContain("dark:ring-amber-400/25");
  });

  it("error includes dark background, text, and ring", () => {
    const result = badgeIntentClass("error");
    expect(result).toContain("dark:bg-red-500/10");
    expect(result).toContain("dark:text-red-300");
    expect(result).toContain("dark:ring-red-400/20");
  });

  it("info includes dark background, text, and ring", () => {
    const result = badgeIntentClass("info");
    expect(result).toContain("dark:bg-blue-500/10");
    expect(result).toContain("dark:text-blue-300");
    expect(result).toContain("dark:ring-blue-400/20");
  });

  it("neutral includes dark background, text, and ring", () => {
    const result = badgeIntentClass("neutral");
    expect(result).toContain("dark:bg-gray-400/10");
    expect(result).toContain("dark:text-gray-300");
    expect(result).toContain("dark:ring-gray-400/20");
  });

  it("violet includes dark background, text, and ring", () => {
    const result = badgeIntentClass("violet");
    expect(result).toContain("dark:bg-violet-500/10");
    expect(result).toContain("dark:text-violet-300");
    expect(result).toContain("dark:ring-violet-400/20");
  });

  it("sky includes dark background, text, and ring", () => {
    const result = badgeIntentClass("sky");
    expect(result).toContain("dark:bg-sky-500/10");
    expect(result).toContain("dark:text-sky-300");
    expect(result).toContain("dark:ring-sky-400/20");
  });
});

describe("badgeIntentClass – light classes preserved (no replacement)", () => {
  it("success still contains original light classes", () => {
    const result = badgeIntentClass("success");
    expect(result).toContain("bg-green-50");
    expect(result).toContain("text-green-700");
    expect(result).toContain("ring-green-600/20");
  });

  it("warning still contains original light classes", () => {
    const result = badgeIntentClass("warning");
    expect(result).toContain("bg-amber-50");
    expect(result).toContain("text-amber-700");
    expect(result).toContain("ring-amber-600/25");
  });
});
