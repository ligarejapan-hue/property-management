/**
 * 所有者補正候補の画面: 名前が自治体・国の所有者に「自治体」の印を出す(2026-11-24・表示だけ)。
 * 印は API の isPublicOwner(名前から public-owner-name.ts で決める)だけで出し、候補の決め方・操作は変えない。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const pageSrc = read("src/app/(dashboard)/admin/owners/correction/page.tsx");
const routeSrc = read("src/app/api/admin/owners/correction-candidates/route.ts");

describe("所有者補正候補: 自治体の印", () => {
  it("isPublicOwner のときだけ「自治体」の印を出す", () => {
    expect(pageSrc).toMatch(/\{c\.isPublicOwner\s*&&\s*\(/);
    expect(pageSrc).toContain('data-testid="public-owner-badge"');
    const section = pageSrc.match(/data-testid="public-owner-badge"[\s\S]{0,300}/)?.[0] ?? "";
    expect(section).toContain("自治体");
  });
  it("API は名前から isPublicOwnerName で決める(マスク前の名前で・真偽値だけ返す)", () => {
    expect(routeSrc).toContain('from "@/lib/public-owner-name"');
    expect(routeSrc).toContain("isPublicOwner: isPublicOwnerName(owner.name)");
  });
});
