import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, it, expect } from "vitest";

const src = readFileSync(
  resolve(
    __dirname,
    "../page.tsx",
  ),
  "utf-8",
);

describe("correction page dark mode", () => {
  // --- surface backgrounds ---
  it("has dark bg for white surface", () => {
    expect(src).toContain("bg-white dark:bg-gray-900");
  });

  it("has dark bg for gray-50 thead", () => {
    expect(src).toContain("bg-gray-50 dark:bg-gray-800");
  });

  it("has dark bg for gray-100 chip", () => {
    expect(src).toContain("bg-gray-100 dark:bg-gray-800");
  });

  // --- body text ---
  it("has dark text for gray-900 primary text", () => {
    expect(src).toContain("text-gray-900 dark:text-gray-100");
  });

  it("has dark text for gray-700", () => {
    expect(src).toContain("text-gray-700 dark:text-gray-200");
  });

  it("has dark text for gray-600", () => {
    expect(src).toContain("text-gray-600 dark:text-gray-300");
  });

  it("has dark text for gray-500", () => {
    expect(src).toContain("text-gray-500 dark:text-gray-400");
  });

  it("has dark text for gray-400", () => {
    expect(src).toContain("text-gray-400 dark:text-gray-500");
  });

  // --- borders ---
  it("has dark border for gray-200", () => {
    expect(src).toContain("border-gray-200 dark:border-gray-800");
  });

  it("has dark border for gray-300", () => {
    expect(src).toContain("border-gray-300 dark:border-gray-700");
  });

  // --- table thead ---
  it("has dark bg on table thead", () => {
    expect(src).toContain("bg-gray-50 dark:bg-gray-800 text-xs text-gray-500 dark:text-gray-400");
  });

  // --- tbody divider ---
  it("has dark divide on tbody", () => {
    expect(src).toContain("divide-y divide-gray-100 dark:divide-gray-800");
  });

  // --- row hover ---
  it("has dark hover on table row", () => {
    expect(src).toContain("hover:bg-gray-50 dark:hover:bg-gray-800");
  });

  // --- input 3-point (border, text, bg) ---
  it("has dark border for input/button gray-300", () => {
    expect(src).toContain("border-gray-300 dark:border-gray-700");
  });

  it("has dark bg-gray-900 for input/card bg-white", () => {
    expect(src).toContain("bg-white dark:bg-gray-900");
  });

  it("has dark text-gray-200 paired with gray-700 text (input text)", () => {
    expect(src).toContain("text-gray-700 dark:text-gray-200");
  });

  // --- hover readability on neutral buttons ---
  it("has dark hover bg on gray border buttons", () => {
    expect(src).toContain("hover:bg-gray-50 dark:hover:bg-gray-800");
  });

  // --- light classes still present (regression guard) ---
  it("preserves light bg-white class", () => {
    expect(src).toContain("bg-white");
  });

  it("preserves light text-gray-600 class", () => {
    expect(src).toContain("text-gray-600");
  });

  it("preserves light border-gray-300 class", () => {
    expect(src).toContain("border-gray-300");
  });

  it("preserves light bg-gray-50 class", () => {
    expect(src).toContain("bg-gray-50");
  });

  // --- color-locked classification tag non-touch checks ---
  // orphan tag uses orange; must NOT have dark:bg-orange or dark:text-orange
  it("does not add dark: to orange (orphan) classification tag", () => {
    const forbiddenOrBg = "dark:bg-" + "orange";
    const forbiddenOrText = "dark:text-" + "orange";
    expect(src).not.toContain(forbiddenOrBg);
    expect(src).not.toContain(forbiddenOrText);
  });

  // address_null tag uses yellow; must NOT have dark:bg-yellow or dark:text-yellow
  it("does not add dark: to yellow (address_null) classification tag", () => {
    const forbiddenYBg = "dark:bg-" + "yellow";
    const forbiddenYText = "dark:text-" + "yellow";
    expect(src).not.toContain(forbiddenYBg);
    expect(src).not.toContain(forbiddenYText);
  });

  // duplicate tag uses purple; must NOT have dark:bg-purple or dark:text-purple
  it("does not add dark: to purple (duplicate) classification tag", () => {
    const forbiddenPBg = "dark:bg-" + "purple";
    const forbiddenPText = "dark:text-" + "purple";
    expect(src).not.toContain(forbiddenPBg);
    expect(src).not.toContain(forbiddenPText);
  });
});
