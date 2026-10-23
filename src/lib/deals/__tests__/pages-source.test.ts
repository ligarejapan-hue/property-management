import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SIDEBAR_GROUPS } from "@/components/layout/sidebar-model";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("取引の画面", () => {
  it("左メニューの柱「取引」は物件の次・全員に出す", () => {
    const keys = SIDEBAR_GROUPS.map((g) => g.key);
    expect(keys.indexOf("deal")).toBe(keys.indexOf("prop") + 1);
    const g = SIDEBAR_GROUPS.find((x) => x.key === "deal");
    expect(g?.pillar).toBe(true);
    expect(g?.items).toEqual([expect.objectContaining({ label: "取引", href: "/deals", minRole: "field_staff" })]);
  });
  it("一覧の題名はメニューと同じ「取引」", () => {
    expect(read("src/app/(dashboard)/deals/page.tsx")).toContain('title="取引"');
  });
  it("新しい取引は物件から作れる(propertyId を受け取る)", () => {
    const src = read("src/app/(dashboard)/deals/new/page.tsx");
    expect(src).toContain('title="新しい取引"');
    expect(src).toContain('get("propertyId")');
  });
  it("物件の画面の「その他」に入口がある(取引を書ける人だけ)", () => {
    const src = read("src/app/(dashboard)/properties/[id]/page.tsx");
    expect(src).toContain('label: "この物件で取引を作る"');
    expect(src).toContain("/deals/new?propertyId=");
    expect(src).toMatch(/p\.resource === "deal" && p\.action === "write"/);
  });
  it("取引の画面は素の button を使わない", () => {
    for (const p of ["src/app/(dashboard)/deals/page.tsx", "src/app/(dashboard)/deals/new/page.tsx"]) {
      expect(existsSync(join(process.cwd(), p)), p).toBe(true);
      expect(read(p), p).not.toMatch(/<button[\s>]/);
    }
  });
});
