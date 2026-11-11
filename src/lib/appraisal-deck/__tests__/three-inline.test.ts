/**
 * 3D の部品(three)を資料に埋め込む形にする(2026-11-11)。入っている three で実際に組み立てて動かす。
 */
import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { buildThreeClassicScript, slimThreeSource, threeInlineScript } from "../map/three-inline";

describe("threeInlineScript", () => {
  it("入っている three から window.THREE を作るスクリプトになる(資料で使う部品がそろう)", () => {
    const js = threeInlineScript();
    expect(js).not.toMatch(/<\/script/i);
    expect(js).not.toMatch(/^\s*(import|export)\s/m);
    const ctx: { window: { THREE?: Record<string, unknown> } } = { window: {} };
    vm.createContext(ctx);
    vm.runInContext(js, ctx);
    const T = ctx.window.THREE!;
    for (const k of [
      "WebGLRenderer",
      "Scene",
      "Fog",
      "PerspectiveCamera",
      "CatmullRomCurve3",
      "ShapeUtils",
      "BufferGeometry",
      "Float32BufferAttribute",
      "CanvasTexture",
      "MeshLambertMaterial",
      "HemisphereLight",
      "DirectionalLight",
      "ConeGeometry",
      "RingGeometry",
      "LinearSRGBColorSpace",
    ]) {
      expect(T[k], k).toBeDefined();
    }
    expect(js.length).toBeLessThan(1_600_000); // 軽くしてある(元は約2.1MB)
  });
  it("想定と違う形(three の版が変わった等)なら例外=壊れた資料を出さない", () => {
    expect(() => buildThreeClassicScript("export default 1;", "")).toThrow();
    expect(() => buildThreeClassicScript("const a=1;\nexport { a };", "import x from 'y';")).toThrow();
  });
  it("小さな ES モジュールの組を組み立てられる", () => {
    const core = "const A=1;const B=2;\nexport { A, B as Bee };";
    const mod = "import { A as a } from './three.core.js';\nexport { Bee } from './three.core.js';\nconst C=a+1;\nexport { C };";
    const js = buildThreeClassicScript(core, mod);
    const ctx: { window: { THREE?: Record<string, number> } } = { window: {} };
    vm.createContext(ctx);
    vm.runInContext(js, ctx);
    expect({ ...ctx.window.THREE }).toEqual({ A: 1, Bee: 2, C: 2 });
  });
  it("行まるごとの説明コメントと字下げだけを除く", () => {
    expect(slimThreeSource("\t/**\n\t * doc\n\t */\n\tconst a = '/** x */';\n")).toBe("const a = '/** x */';\n");
  });
});
