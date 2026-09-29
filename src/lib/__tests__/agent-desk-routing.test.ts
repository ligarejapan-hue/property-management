import { describe, it, expect } from "vitest";
import { isPublicPath } from "@/proxy";
import { SIDEBAR_GROUPS } from "@/components/layout/sidebar-model";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("受付の窓への入口", () => {
  it("ログイン必須(公開パスではない)", () => {
    expect(isPublicPath("/inquiry-desk")).toBe(false);
  });
  it("サイドバーに「反響の受付」=名前付きの別窓で開く・全員に見える", () => {
    const item = SIDEBAR_GROUPS.flatMap((g) => g.items).find((i) => i.href === "/inquiry-desk");
    expect(item).toMatchObject({ label: "反響の受付", external: true, windowName: "pm-inquiry-desk", minRole: "field_staff" });
  });
  it("別窓の項目は windowName があればその名前の窓に開く", () => {
    const src = readFileSync(join(process.cwd(), "src/components/layout/sidebar.tsx"), "utf8");
    expect(src).toMatch(/target=\{item\.windowName \?\? "_blank"\}/);
  });
});
