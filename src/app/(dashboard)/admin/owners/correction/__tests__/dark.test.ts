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

  // --- bulk result banner dark bg ---
  it("bulk result banner has dark:bg-emerald-500/15 for dark-bg readability", () => {
    expect(src).toContain("dark:bg-emerald-500/15");
  });

  it("bulk result banner has dark:border-emerald-500/30 for dark-bg border", () => {
    expect(src).toContain("dark:border-emerald-500/30");
  });

  // --- accent readability on dark backgrounds (P2) ---
  it("active tab has dark:text-indigo-400 for readability on dark bg", () => {
    expect(src).toContain("dark:text-indigo-400");
  });

  it("active tab styling is delegated to the shared Tabs component (第3弾⑪)", () => {
    expect(src).toContain('from "@/components/ui/tabs"');
  });

  it("select-all button has dark:text-emerald-400 for readability on dark bg", () => {
    expect(src).toContain("dark:text-emerald-400");
  });

  it("bulk result heading has dark:text-emerald-300 for readability on dark bg", () => {
    expect(src).toContain("dark:text-emerald-300");
  });

  // --- color-locked classification tag non-touch checks ---
  // TYPE_BADGE and ACTION_BADGE constants must not gain dark: variants on their color-lock classes.
  // We verify the badge constant strings stay unchanged (no dark: prefix inserted).

  // orphan classification badge = "bg-orange-100 text-orange-700" — must remain exactly as-is
  it("TYPE_BADGE orphan stays color-locked (no dark: prefix on the badge string)", () => {
    // The constant line must still contain the original badge value without dark: additions.
    expect(src).toContain('orphan: "bg-orange-100 text-orange-700"');
  });

  // address_null classification badge = "bg-yellow-100 text-yellow-700" — must remain exactly as-is
  it("TYPE_BADGE address_null stays color-locked (no dark: prefix on the badge string)", () => {
    expect(src).toContain('address_null: "bg-yellow-100 text-yellow-700"');
  });

  // duplicate classification badge in TYPE_BADGE = "bg-purple-100 text-purple-700" — must remain as-is
  it("TYPE_BADGE duplicate stays color-locked (no dark: prefix on the badge string)", () => {
    expect(src).toContain('duplicate: "bg-purple-100 text-purple-700"');
  });

  // ACTION_BADGE merge_candidate badge = "bg-purple-100 text-purple-700" — must remain as-is
  it("ACTION_BADGE merge_candidate stays color-locked (no dark: prefix on the badge string)", () => {
    expect(src).toContain('merge_candidate: "bg-purple-100 text-purple-700"');
  });

  // --- accent-on-dark readability fixes (P2) ---
  // duplicate group label text should be readable on dark card bg
  it("duplicate group label has dark:text-purple-300 for readability on dark bg", () => {
    expect(src).toContain("text-purple-700 dark:text-purple-300");
  });

  // matched-by chip inside duplicate group card should be readable on dark bg
  it("matched-by chip has dark:bg-purple-500/20 for dark bg", () => {
    expect(src).toContain("dark:bg-purple-500/20");
  });

  // DuplicateGroupSummary container should have dark bg
  it("DuplicateGroupSummary container has dark:bg-purple-500/10", () => {
    expect(src).toContain("dark:bg-purple-500/10");
  });

  // bulk select all/deselect button has dark hover bg to prevent bright emerald flash
  it("bulk select button has dark:hover:bg-emerald-500/20", () => {
    expect(src).toContain("dark:hover:bg-emerald-500/20");
  });

  // registry type chips (removable) readable on dark bg
  it("registry removable type chip has dark:bg-emerald-500/20 dark:text-emerald-300", () => {
    expect(src).toContain("dark:bg-emerald-500/20");
    expect(src).toContain("dark:text-emerald-300");
  });

  // registry manual review chip readable on dark bg
  it("registry manual review chip has dark:bg-amber-500/20 dark:text-amber-300", () => {
    expect(src).toContain("dark:bg-amber-500/20");
    expect(src).toContain("dark:text-amber-300");
  });
});
