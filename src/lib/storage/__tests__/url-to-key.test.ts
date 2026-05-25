import { describe, it, expect } from "vitest";
import { extractStorageKeyFromUrl } from "../url-to-key";

describe("extractStorageKeyFromUrl", () => {
  describe("null / 空入力", () => {
    it("null → null", () => {
      expect(extractStorageKeyFromUrl(null)).toBeNull();
    });
    it("undefined → null", () => {
      expect(extractStorageKeyFromUrl(undefined)).toBeNull();
    });
    it("空文字 → null", () => {
      expect(extractStorageKeyFromUrl("")).toBeNull();
    });
    it("whitespace のみ → null", () => {
      expect(extractStorageKeyFromUrl("   ")).toBeNull();
      expect(extractStorageKeyFromUrl("\t\n")).toBeNull();
    });
  });

  describe("相対 /uploads/{key}", () => {
    it("通常 → key 抽出", () => {
      expect(
        extractStorageKeyFromUrl("/uploads/properties/abc/photos/1.jpg"),
      ).toBe("properties/abc/photos/1.jpg");
    });
    it("buildings 配下も同様", () => {
      expect(
        extractStorageKeyFromUrl("/uploads/buildings/xyz/photos/2.png"),
      ).toBe("buildings/xyz/photos/2.png");
    });
    it("?query は除去", () => {
      expect(
        extractStorageKeyFromUrl("/uploads/properties/x.jpg?v=1"),
      ).toBe("properties/x.jpg");
    });
    it("#hash は除去", () => {
      expect(
        extractStorageKeyFromUrl("/uploads/properties/x.jpg#a"),
      ).toBe("properties/x.jpg");
    });
    it("前後 whitespace は trim", () => {
      expect(
        extractStorageKeyFromUrl("  /uploads/properties/x.jpg  "),
      ).toBe("properties/x.jpg");
    });
  });

  describe("対象外（null 化）", () => {
    it("/uploads (prefix 単体) → null", () => {
      expect(extractStorageKeyFromUrl("/uploads/")).toBeNull();
      expect(extractStorageKeyFromUrl("/uploads")).toBeNull();
    });
    it("/uploads 以外の相対 → null", () => {
      expect(extractStorageKeyFromUrl("/api/foo.jpg")).toBeNull();
      expect(extractStorageKeyFromUrl("/static/x.jpg")).toBeNull();
      expect(extractStorageKeyFromUrl("foo.jpg")).toBeNull();
    });
    it("traversal (..) → null", () => {
      expect(
        extractStorageKeyFromUrl("/uploads/../etc/passwd"),
      ).toBeNull();
      expect(extractStorageKeyFromUrl("/uploads/a/../b")).toBeNull();
    });
    it("空 segment (//) → null", () => {
      expect(extractStorageKeyFromUrl("/uploads/a//b")).toBeNull();
    });
    it("backslash 混入 → null", () => {
      expect(
        extractStorageKeyFromUrl("/uploads/a\\b/c.jpg"),
      ).toBeNull();
    });

    it("data: → null", () => {
      expect(
        extractStorageKeyFromUrl("data:image/png;base64,iVBORw0K"),
      ).toBeNull();
    });
    it("blob: → null", () => {
      expect(
        extractStorageKeyFromUrl("blob:https://example.com/abcd"),
      ).toBeNull();
    });
    it("file: → null", () => {
      expect(
        extractStorageKeyFromUrl("file:///etc/passwd"),
      ).toBeNull();
    });

    it("外部 http URL → null", () => {
      expect(
        extractStorageKeyFromUrl("http://example.com/uploads/x.jpg"),
      ).toBeNull();
    });
    it("外部 https URL → null", () => {
      expect(
        extractStorageKeyFromUrl("https://other.com/uploads/x.jpg"),
      ).toBeNull();
    });
    it("旧データ風の同 host 絶対 URL でも null（安全側）", () => {
      // 旧 fileUrl で残っている可能性のある絶対 URL は誤削除回避のため対象外。
      // orphan ファイルは将来 cleanup バッチで回収する想定。
      expect(
        extractStorageKeyFromUrl("http://127.0.0.1:3000/uploads/x.jpg"),
      ).toBeNull();
      expect(
        extractStorageKeyFromUrl("http://localhost:3000/uploads/x.jpg"),
      ).toBeNull();
    });

    it("非 string → null", () => {
      expect(
        extractStorageKeyFromUrl(123 as unknown as string),
      ).toBeNull();
      expect(
        extractStorageKeyFromUrl({} as unknown as string),
      ).toBeNull();
    });
  });
});
