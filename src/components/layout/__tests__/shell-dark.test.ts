import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));

const dashboardLayout = readFileSync(
  join(dir, "..", "dashboard-layout.tsx"),
  "utf8"
);
const sidebar = readFileSync(join(dir, "..", "sidebar.tsx"), "utf8");

describe("dashboard-layout dark: 配色", () => {
  it("外枠に dark:bg-gray-950 がある", () => {
    expect(dashboardLayout).toContain("dark:bg-gray-950");
  });
});

describe("sidebar dark: 配色", () => {
  it("aside 背景に dark:bg-gray-900 がある", () => {
    expect(sidebar).toContain("dark:bg-gray-900");
  });
  it("aside 境界に dark:border-gray-700 または dark:border-gray-800 がある", () => {
    expect(sidebar).toMatch(/dark:border-gray-[78]00/);
  });
  it("メニューラベルに dark:text-gray-400 がある", () => {
    expect(sidebar).toContain("dark:text-gray-400");
  });
  it("通常リンクに dark:text-gray-300 がある", () => {
    expect(sidebar).toContain("dark:text-gray-300");
  });
  it("リンク hover に dark:hover:bg-gray-800 がある", () => {
    expect(sidebar).toContain("dark:hover:bg-gray-800");
  });
  it("active リンクに dark:bg-indigo-900 がある", () => {
    expect(sidebar).toContain("dark:bg-indigo-900");
  });
});
