import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAssetReferenced, countAssetReferences, ASSET_REFERENCE_COUNT_SELECT } from "@/lib/sale-dm-letter/asset-references";

describe("写真の使用中判定(設計 §3.1)", () => {
  it("LP型か台帳のどちらかで使われていれば使用中", () => {
    expect(isAssetReferenced({ _count: { media: 0, scenarioMedia: 0 } })).toBe(false);
    expect(isAssetReferenced({ _count: { media: 1, scenarioMedia: 0 } })).toBe(true);
    expect(isAssetReferenced({ _count: { media: 0, scenarioMedia: 2 } })).toBe(true);
  });
  it("削除済みの台帳の割り付けは数えない(select の where)", () => {
    expect(ASSET_REFERENCE_COUNT_SELECT._count.select.scenarioMedia).toEqual({ where: { scenario: { deletedAt: null } } });
  });
  it("countAssetReferences は両方を足す", async () => {
    const tx = { dmLpVariantMedia: { count: vi.fn(async () => 1) }, dmScenarioMedia: { count: vi.fn(async () => 2) } };
    await expect(countAssetReferences(tx as never, "a1")).resolves.toBe(3);
    expect(tx.dmScenarioMedia.count).toHaveBeenCalledWith({ where: { assetId: "a1", scenario: { deletedAt: null } } });
  });
  it("走査: _count.media / dmLpVariantMedia.count を直接使うのは判定関数のファイルだけ", () => {
    const files = [
      "src/app/api/properties/sale-dm/lp-assets/route.ts",
      "src/app/api/properties/sale-dm/lp-assets/[assetId]/route.ts",
      "src/app/lp-assets/[publicId]/route.ts",
      "src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/media/route.ts",
      "src/app/api/properties/sale-dm/scenarios/[id]/media/route.ts",
    ];
    for (const f of files) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src, f).not.toMatch(/_count\.media\b|_count:\s*\{\s*select:\s*\{\s*media:\s*true\s*\}\s*\}|dmLpVariantMedia\.count\(/);
    }
  });
});
