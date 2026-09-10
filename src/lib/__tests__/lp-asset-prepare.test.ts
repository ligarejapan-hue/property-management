import { describe, it, expect } from "vitest";
import { classifyLpAsset, lpAssetFileName, LP_ASSET_MAX_EDGE } from "../lp-asset-prepare";

describe("classifyLpAsset", () => {
  it("JPEG で長辺1600以下・8MB以下なら無変換", () => {
    expect(classifyLpAsset({ mime: "image/jpeg", width: 1600, height: 900, size: 100 })).toBe("pass");
  });
  it("PNG/WebP は上限内でも常に変換(iTXt/XMP 等の付随情報を落とすため無変換にしない)", () => {
    expect(classifyLpAsset({ mime: "image/png", width: 100, height: 100, size: 100 })).toBe("convert");
    expect(classifyLpAsset({ mime: "image/webp", width: 100, height: 1600, size: 100 })).toBe("convert");
  });
  it("長辺が超える・大きすぎる・HEIC は変換", () => {
    expect(classifyLpAsset({ mime: "image/jpeg", width: 1601, height: 900, size: 100 })).toBe("convert");
    expect(classifyLpAsset({ mime: "image/png", width: 100, height: 100, size: 8 * 1024 * 1024 + 1 })).toBe("convert");
    expect(classifyLpAsset({ mime: "image/heic", width: 100, height: 100, size: 100 })).toBe("convert");
  });
  it("画像でないものは unsupported", () => {
    expect(classifyLpAsset({ mime: "application/pdf", width: 0, height: 0, size: 1 })).toBe("unsupported");
    expect(classifyLpAsset({ mime: "", width: 0, height: 0, size: 1 })).toBe("unsupported");
  });
  it("変換時のファイル名は .jpg・pass はそのまま", () => {
    expect(lpAssetFileName("IMG_001.HEIC", "convert")).toBe("IMG_001.jpg");
    expect(lpAssetFileName("a.png", "pass")).toBe("a.png");
    expect(lpAssetFileName("", "convert")).toBe("image.jpg");
    expect(LP_ASSET_MAX_EDGE).toBe(1600);
  });
});
