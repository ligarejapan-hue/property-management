import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

describe("ログイン後の着地は /home", () => {
  it("root page は /home へ redirect する", () => {
    const src = readFileSync(join(root, "src/app/page.tsx"), "utf8");
    expect(src).toContain('redirect("/home")');
    expect(src).not.toContain('redirect("/properties")');
  });
  it("ログインの既定 fallback は /home", () => {
    const src = readFileSync(join(root, "src/app/(auth)/login/page.tsx"), "utf8");
    expect(src).toContain('const fallback = "/home"');
  });
});
