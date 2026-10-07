import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const code = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const SELECT = /illustrationAsset:\s*\{\s*select:\s*\{\s*publicId:\s*true,\s*width:\s*true,\s*height:\s*true,\s*deletedAt:\s*true\s*\}\s*\}/;

describe("手紙のイラストの配線(印刷と見本が同じ形を使う)", () => {
  it("印刷: 型のイラストを読み、letterIllustrationFromAsset で渡す", () => {
    const s = code("src/app/api/properties/sale-dm/campaigns/[id]/print/route.ts");
    expect(s).toMatch(SELECT);
    expect(s).toMatch(/illustration:\s*letterIllustrationFromAsset\(d\.variant\.illustrationAsset\)/);
  });
  it("キャンペーン取得: 型ごとに illustration を付け、写真の行は返さない", () => {
    const s = code("src/app/api/properties/sale-dm/campaigns/[id]/route.ts");
    expect(s).toMatch(SELECT);
    expect(s).toMatch(/illustration:\s*letterIllustrationFromAsset\(illustrationAsset\)/);
  });
  it("見本: 選んだ型の illustration を renderLetterHtml へ渡す", () => {
    const s = code("src/app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx");
    expect(s).toMatch(/illustration:\s*selectedVariant\.illustration \?\? null/);
  });
  it("画面の型に illustration がある", () => {
    const s = code("src/lib/api-client.ts");
    const start = s.indexOf("export interface SaleDmVariant {");
    const v = s.slice(start, s.indexOf("\n}", start));
    expect(v).toMatch(/illustration\?:\s*\{\s*src:\s*string;\s*width:\s*number;\s*height:\s*number\s*\}\s*\|\s*null/);
  });
});
