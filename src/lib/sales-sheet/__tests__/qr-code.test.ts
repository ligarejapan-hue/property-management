/**
 * TDD: QR コード生成ヘルパ（計画⑧）
 *   generateQrDataUrl: テキスト → data:image/ の dataURL（qrcode-generator・依存ゼロ）
 */
import { describe, it, expect } from "vitest";
import { generateQrDataUrl } from "../qr-code";
import { qrElementSchema } from "../document-schema";

describe("generateQrDataUrl", () => {
  it("URL から data:image/ で始まる dataURL を生成する", () => {
    const url = generateQrDataUrl(
      "https://example.com/properties/12345678-1234-1234-1234-123456789012",
    );
    expect(url).not.toBeNull();
    expect(url!.startsWith("data:image/")).toBe(true);
  });

  it("生成結果は保存境界の個別 data: 上限(8192)に収まる（長めの URL でも）", () => {
    const long = `https://example.com/p/${"a".repeat(120)}`;
    const url = generateQrDataUrl(long);
    expect(url).not.toBeNull();
    expect(url!.length).toBeLessThanOrEqual(8192);
  });

  it("空・空白のみは null", () => {
    expect(generateQrDataUrl("")).toBeNull();
    expect(generateQrDataUrl("   ")).toBeNull();
  });

  it("容量超過の巨大テキストは null（throw しない）", () => {
    expect(generateQrDataUrl("x".repeat(20000))).toBeNull();
  });

  it("非 ASCII（日本語等）は null（ライブラリ既定モードでは文字化けするため拒否）", () => {
    expect(generateQrDataUrl("https://example.com/物件")).toBeNull();
    expect(generateQrDataUrl("こんにちは")).toBeNull();
  });

  it("決定的: 同一入力から同一 dataURL", () => {
    const a = generateQrDataUrl("https://example.com");
    const b = generateQrDataUrl("https://example.com");
    expect(a).toBe(b);
  });

  it("生成 dataURL は qr 要素 schema の dataUrl 検証を満たす", () => {
    const url = generateQrDataUrl("https://example.com")!;
    const parsed = qrElementSchema.safeParse({
      id: "q-1", type: "qr", x: 0, y: 0, w: 30, h: 30, z: 1, dataUrl: url,
    });
    expect(parsed.success).toBe(true);
  });
});
