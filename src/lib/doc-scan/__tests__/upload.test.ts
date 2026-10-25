import { describe, expect, it } from "vitest";
import {
  LITTLE_TEXT_CHARS,
  MAX_SCAN_BODY_BYTES,
  MAX_SCAN_PAGE_BYTES,
  hasLittleText,
  scanFileName,
  sniffImage,
} from "../upload";

describe("sniffImage", () => {
  it("先頭のバイトで JPEG・PNG・WebP を見分ける(送られてきた種類の申告は信じない)", () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe("jpeg");
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
    expect(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"))).toBe("webp");
  });

  it("それ以外(PDF・HTML・空)は null", () => {
    expect(sniffImage(Buffer.from("%PDF-1.4"))).toBeNull();
    expect(sniffImage(Buffer.from("<html>"))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});

describe("上限", () => {
  it("1枚 2MB・全体は 30枚分に余白", () => {
    expect(MAX_SCAN_PAGE_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_SCAN_BODY_BYTES).toBeGreaterThanOrEqual(30 * MAX_SCAN_PAGE_BYTES);
  });
});

describe("scanFileName", () => {
  it("日本時間の日付と時刻で名前を付ける", () => {
    // 2026-10-25 15:30 UTC = 10-26 00:30 JST
    expect(scanFileName(new Date("2026-10-25T15:30:00Z"))).toBe("撮影した書類_20261026_0030.pdf");
  });
});

describe("hasLittleText", () => {
  it("読めた文字が少なければ写真の候補にする", () => {
    expect(LITTLE_TEXT_CHARS).toBe(30);
    expect(hasLittleText({ ocr: "done", ocrChars: 12 })).toBe(true);
    expect(hasLittleText({ ocr: "done", ocrChars: 30 })).toBe(false);
  });

  it("読み取り自体ができなかったときは写真の候補にしない(書類かどうか分からない)", () => {
    expect(hasLittleText({ ocr: "failed", ocrChars: 0 })).toBe(false);
    expect(hasLittleText({ ocr: "unavailable", ocrChars: 0 })).toBe(false);
  });
});
