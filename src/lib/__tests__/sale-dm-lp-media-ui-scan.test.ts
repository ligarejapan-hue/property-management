import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const FILES = [
  "src/components/sale-dm/lp-asset-library.tsx",
  "src/components/sale-dm/lp-media-panel.tsx",
  "src/app/(dashboard)/admin/lp-assets/page.tsx",
].map((f) => [f, readFileSync(path.resolve(process.cwd(), f), "utf8").replace(/\r\n/g, "\n")] as const);

describe("LP写真の画面: 公開口だけを使い、生HTMLを流し込まない", () => {
  for (const [f, src] of FILES) {
    it(`${f}: /uploads/ を書かない・dangerouslySetInnerHTML を使わない・img src は LP_ASSET_URL か figureDataUrl 経由`, () => {
      expect(src).not.toContain("/uploads/");
      expect(src).not.toContain("dangerouslySetInnerHTML");
      const imgs = [...src.matchAll(/<img[^>]*\bsrc=\{([^}]+)\}/g)];
      expect(imgs.length).toBeGreaterThan(0);
      for (const m of imgs) expect(m[1]).toMatch(/LP_ASSET_URL\(|figureDataUrl\(/);
    });
  }
  it("ライブラリは貼り付け(Ctrl+V)とドロップを受け、端末側で縮小してから送る", () => {
    const src = FILES[0][1];
    expect(src).toContain("onPaste");
    expect(src).toContain("onDrop");
    expect(src).toContain("prepareLpAssetForUpload(");
  });
  it("サイドバーに管理者向け「LPの写真」がある", () => {
    const side = readFileSync(path.resolve(process.cwd(), "src/components/layout/sidebar-model.tsx"), "utf8");
    expect(side).toMatch(/href:\s*"\/admin\/lp-assets"[^}]*minRole:\s*"admin"/);
  });
});
