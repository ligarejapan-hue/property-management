import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const SIDEBAR = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/layout/sidebar.tsx"),
  "utf8",
);

describe("sidebar: 物件化の完成待ち nav", () => {
  it("/field-survey/candidates への nav item がある", () => {
    expect(SIDEBAR).toMatch(/href:\s*"\/field-survey\/candidates"/);
    expect(SIDEBAR).toMatch(/物件化の完成待ち/);
  });

  it("重複追加しない(1回のみ)", () => {
    const m = SIDEBAR.match(/\/field-survey\/candidates/g) ?? [];
    expect(m.length).toBe(1);
  });
});
