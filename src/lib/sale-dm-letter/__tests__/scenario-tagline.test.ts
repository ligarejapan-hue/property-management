import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TAGLINE, taglineForAutoKey } from "../scenario-tagline";

describe("種類ごとの添え書き(2026-11-08 発注者決定)", () => {
  it("★相続・相続(マンション)=相続/空き家=空き家/古い家=住まい", () => {
    expect(taglineForAutoKey("inheritance")).toBe("相続・不動産のご相談窓口");
    expect(taglineForAutoKey("inheritance_unit")).toBe("相続・不動産のご相談窓口");
    expect(taglineForAutoKey("vacant")).toBe("空き家・不動産のご相談窓口");
    expect(taglineForAutoKey("old_house")).toBe("住まい・不動産のご相談窓口");
  });

  it("★どれでもない種類・種類なし・知らない値・継承のキーは住まい", () => {
    for (const k of [null, undefined, "", "unknown", "toString", "__proto__"]) {
      expect(taglineForAutoKey(k), String(k)).toBe(DEFAULT_TAGLINE);
    }
    expect(DEFAULT_TAGLINE).toBe("住まい・不動産のご相談窓口");
  });

  it("地域名は入れない(都内全域に出す可能性があるため)", () => {
    for (const k of ["inheritance", "inheritance_unit", "vacant", "old_house", null]) {
      expect(taglineForAutoKey(k)).not.toMatch(/城南|世田谷|東京/);
    }
  });
});

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("添え書きの配線(手紙とご案内ページが同じ種類から引く)", () => {
  it("★印刷と見本: 宛先の型が写した種類の autoKey から", () => {
    const print = src("src/app/api/properties/sale-dm/campaigns/[id]/print/route.ts");
    expect(print).toMatch(/scenario: \{ select: \{ autoKey: true \} \}/);
    expect(print).toMatch(/tagline: taglineForAutoKey\(d\.variant\.scenario\?\.autoKey\)/);
    const campaign = src("src/app/api/properties/sale-dm/campaigns/[id]/route.ts");
    expect(campaign).toMatch(/tagline: taglineForAutoKey\(scenario\?\.autoKey\)/);
  });
  it("★ご案内ページ: /t/・/lp/・プレビュー2本とも種類を渡す", () => {
    expect(src("src/lib/sale-dm-letter/lp-page-loader.ts")).toMatch(/scenario: row\.variant \? row\.variant\.scenario : \(v\.scenario \?\? null\)/);
    expect(src("src/lib/sale-dm-letter/lp-public-loader.ts")).toMatch(/scenario: \{ autoKey: s\.autoKey \}/);
    expect(src("src/app/api/properties/sale-dm/scenarios/[id]/preview/route.ts")).toMatch(/scenario: \{ autoKey: s\.autoKey \}/);
    expect(src("src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/preview/route.ts")).toMatch(/scenario: v\.scenario,/);
  });
  it("★固定の添え書きはもう無い(種類をまたいで同じ字を出さない)", () => {
    expect(src("src/lib/sale-dm-letter/lp-brand.ts")).not.toMatch(/tagline:/);
    expect(src("src/lib/sale-dm-letter/letter-layout.ts")).not.toMatch(/tagline:/);
    expect(src("src/lib/sale-dm-letter/templates/index.ts")).not.toMatch(/T\.tagline/);
  });
});
