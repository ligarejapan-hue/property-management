/**
 * 物件の画面を「タブを指定して」開くリンク(2026-10-28・ドライブ連携の紐づけ一覧 → 添付ファイル)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { initialPropertyTab, propertyDetailHref } from "../property-detail-tab";

const KEYS = ["basic", "owner", "attachments", "history"] as const;

describe("propertyDetailHref", () => {
  it("タブを付けると ?tab= が付く", () => {
    expect(propertyDetailHref("abc-123", "attachments")).toBe("/properties/abc-123?tab=attachments");
  });
  it("タブなしは物件の画面そのもの", () => {
    expect(propertyDetailHref("abc-123")).toBe("/properties/abc-123");
  });
  it("id は URL 用に符号化する", () => {
    expect(propertyDetailHref("a/b?c", "attachments")).toBe("/properties/a%2Fb%3Fc?tab=attachments");
  });
});

describe("initialPropertyTab", () => {
  it("知っているタブならそのタブ", () => {
    expect(initialPropertyTab("attachments", KEYS)).toBe("attachments");
  });
  it("指定なし・知らない値・配列は基本情報", () => {
    expect(initialPropertyTab(undefined, KEYS)).toBe("basic");
    expect(initialPropertyTab("", KEYS)).toBe("basic");
    expect(initialPropertyTab("toString", KEYS)).toBe("basic");
    expect(initialPropertyTab(["attachments", "owner"], KEYS)).toBe("basic");
  });
});

const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

describe("つなぎ込み", () => {
  it("物件の画面は ?tab= で最初のタブを決める", () => {
    const src = read("src/app/(dashboard)/properties/[id]/page.tsx");
    expect(src).toMatch(/searchParams/);
    expect(src).toMatch(/initialPropertyTab\(/);
  });
  it("ドライブ連携の紐づけ一覧は物件名から添付ファイルのタブへ飛べる", () => {
    const src = read("src/app/(dashboard)/admin/drive/page.tsx");
    expect(src).toMatch(/propertyDetailHref\(link\.propertyId,\s*"attachments"\)/);
  });
});
