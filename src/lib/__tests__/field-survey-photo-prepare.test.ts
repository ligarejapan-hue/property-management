/**
 * 調査ピン写真の端末内自動変換 (HEIC/大容量対策) の純ロジック検証。
 *
 * 背景: iPhone 既定の高効率 (HEIC) 形式はサーバー側 EXIF strip 未対応で 422、
 * 写真は 8MB 上限で最近のスマホ原寸は超過し得る。アップロード前に端末内で
 * JPEG へ変換・縮小して吸収し、変換できない端末でだけ「互換性優先」設定への
 * 平易な案内を出す。
 */
import { describe, it, expect } from "vitest";
import {
  classifyPhotoForUpload,
  fitWithinMaxEdge,
  convertedPhotoFileName,
  photoPrepareFailureMessage,
  PHOTO_TOO_LARGE_MESSAGE,
  PHOTO_CONVERT_ATTEMPTS,
  PHOTO_PASS_THROUGH_MIMES,
} from "@/lib/field-survey-photo-prepare";
import { MAX_FILE_SIZE } from "@/lib/storage/types";

describe("classifyPhotoForUpload", () => {
  it("上限内の JPEG/PNG/WebP はそのまま通す (画質無劣化)", () => {
    for (const t of ["image/jpeg", "image/png", "image/webp"]) {
      expect(classifyPhotoForUpload({ mimeType: t, size: 1024 })).toBe("pass");
      expect(
        classifyPhotoForUpload({ mimeType: t, size: MAX_FILE_SIZE }),
      ).toBe("pass");
    }
  });

  it("上限超過は対応形式でも変換に回す", () => {
    expect(
      classifyPhotoForUpload({ mimeType: "image/jpeg", size: MAX_FILE_SIZE + 1 }),
    ).toBe("convert");
  });

  it("HEIC/HEIF・不明形式・空 MIME は変換に回す", () => {
    expect(
      classifyPhotoForUpload({ mimeType: "image/heic", size: 1024 }),
    ).toBe("convert");
    expect(
      classifyPhotoForUpload({ mimeType: "image/heif", size: 1024 }),
    ).toBe("convert");
    expect(classifyPhotoForUpload({ mimeType: "", size: 1024 })).toBe("convert");
    expect(
      classifyPhotoForUpload({ mimeType: "application/pdf", size: 1024 }),
    ).toBe("convert");
  });

  it("大文字 MIME も通す (端末差異)", () => {
    expect(
      classifyPhotoForUpload({ mimeType: "IMAGE/JPEG", size: 1024 }),
    ).toBe("pass");
  });

  it("pass 対象は JPEG/PNG/WebP の 3 種のみ (HEIC は含めない)", () => {
    expect([...PHOTO_PASS_THROUGH_MIMES].sort()).toEqual(
      ["image/jpeg", "image/png", "image/webp"].sort(),
    );
  });
});

describe("fitWithinMaxEdge", () => {
  it("長辺が上限以下なら等倍", () => {
    expect(fitWithinMaxEdge(2000, 1500, 2560)).toEqual({
      width: 2000,
      height: 1500,
    });
  });

  it("横長は長辺基準で縮小 (アスペクト比維持)", () => {
    expect(fitWithinMaxEdge(5120, 2560, 2560)).toEqual({
      width: 2560,
      height: 1280,
    });
  });

  it("縦長も長辺基準で縮小", () => {
    expect(fitWithinMaxEdge(3000, 4000, 2000)).toEqual({
      width: 1500,
      height: 2000,
    });
  });

  it("拡大はしない", () => {
    expect(fitWithinMaxEdge(800, 600, 2560)).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("不正値 (0 / 負 / 非有限) は 1px に倒して例外を出さない", () => {
    expect(fitWithinMaxEdge(0, -5, 2560)).toEqual({ width: 1, height: 1 });
    expect(fitWithinMaxEdge(Number.NaN, 100, 2560).width).toBeGreaterThan(0);
  });
});

describe("convertedPhotoFileName", () => {
  it("拡張子を .jpg に差し替える (.HEIC 大文字含む)", () => {
    expect(convertedPhotoFileName("IMG_0001.HEIC")).toBe("IMG_0001.jpg");
    expect(convertedPhotoFileName("photo.heif")).toBe("photo.jpg");
    expect(convertedPhotoFileName("scan.png")).toBe("scan.jpg");
  });

  it("拡張子なし・空文字にも安全", () => {
    expect(convertedPhotoFileName("noext")).toBe("noext.jpg");
    expect(convertedPhotoFileName("")).toBe("photo.jpg");
    expect(convertedPhotoFileName(".heic")).toBe("photo.jpg");
  });
});

describe("変換の試行ラダー", () => {
  it("長辺・画質とも段階的に下げる 3 段構成", () => {
    expect(PHOTO_CONVERT_ATTEMPTS.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < PHOTO_CONVERT_ATTEMPTS.length; i++) {
      expect(PHOTO_CONVERT_ATTEMPTS[i].maxEdge).toBeLessThan(
        PHOTO_CONVERT_ATTEMPTS[i - 1].maxEdge,
      );
      expect(PHOTO_CONVERT_ATTEMPTS[i].quality).toBeLessThanOrEqual(
        PHOTO_CONVERT_ATTEMPTS[i - 1].quality,
      );
    }
  });
});

describe("案内文言 (平易な日本語)", () => {
  it("HEIC/HEIF は端末中立に案内する (iPhone=互換性優先 / Android=HEIFオフ)", () => {
    for (const input of [
      { mimeType: "image/heic", fileName: "a.heic" },
      { mimeType: "", fileName: "IMG_0001.HEIC" },
      { mimeType: "image/heif", fileName: "b" },
    ]) {
      const m = photoPrepareFailureMessage(input);
      expect(m).toMatch(/互換性優先/);
      expect(m).toMatch(/設定/);
      // HEIF は Android (Samsung 等) でも生成されるため iPhone 前提にしない
      expect(m).toMatch(/iPhone/);
      expect(m).toMatch(/Android/);
    }
  });

  it("HEIC 以外の読込失敗は形式の案内のみ (設定誘導は出さない)", () => {
    const m = photoPrepareFailureMessage({
      mimeType: "application/pdf",
      fileName: "doc.pdf",
    });
    expect(m).toMatch(/JPEG|写真/);
    expect(m).not.toMatch(/互換性優先/);
  });

  it("縮小不能の文言があり、技術用語を含まない", () => {
    expect(PHOTO_TOO_LARGE_MESSAGE).toMatch(/写真/);
    for (const m of [
      PHOTO_TOO_LARGE_MESSAGE,
      photoPrepareFailureMessage({ mimeType: "image/heic", fileName: "a.heic" }),
    ]) {
      expect(m).not.toMatch(/canvas|blob|mime|bitmap/i);
    }
  });
});
