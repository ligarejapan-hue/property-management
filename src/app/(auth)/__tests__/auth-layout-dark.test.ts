import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "layout.tsx"),
  "utf8",
);

describe("(auth)/layout.tsx ダークmode (source-assertion)", () => {
  it("ライト背景 bg-gray-50 が維持されている", () => {
    expect(src).toContain("bg-gray-50");
  });
  it("ダーク背景 dark:bg-gray-950 が追加されている", () => {
    expect(src).toContain("dark:bg-gray-950");
  });
});
