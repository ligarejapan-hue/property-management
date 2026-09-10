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
    it(`${f}: /uploads/ を書かない・dangerouslySetInnerHTML を使わない・img src は LP_ASSET_URL か figureDataUrl 経由・createObjectURL を使わない`, () => {
      expect(src).not.toContain("/uploads/");
      expect(src).not.toContain("dangerouslySetInnerHTML");
      expect(src).not.toContain("createObjectURL");
      const imgTags = [...src.matchAll(/<img\b/g)];
      const srcAttrs = [...src.matchAll(/\bsrc=\{([^}]+)\}/g)];
      expect(imgTags.length).toBeGreaterThan(0);
      // <img> の数と src={…} の数が一致すること(素の src="…" が紛れていない確認)。
      expect(srcAttrs.length).toBe(imgTags.length);
      for (const m of srcAttrs) expect(m[1]).toMatch(/LP_ASSET_URL\(|figureDataUrl\(/);
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
  it("LP型パネルは枠ごとに『外す』を持ち(ヒーロー・節)、LP型ごとに作り直される", () => {
    const panelSrc = readFileSync(path.resolve(process.cwd(), "src/components/sale-dm/lp-media-panel.tsx"), "utf8");
    const count = (panelSrc.match(/外す/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
    const managerSrc = readFileSync(path.resolve(process.cwd(), "src/components/sale-dm/lp-variant-manager.tsx"), "utf8");
    expect(managerSrc).toContain("key={mediaFor.id}");
  });
});
