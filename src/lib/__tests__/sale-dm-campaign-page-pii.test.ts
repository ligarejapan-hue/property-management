import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 売却DM 作業画面(キャンペーン)の手紙プレビューは宛名/住所/本文(PII)を表示する。
// ScreenProtectionGuard は [data-pii-protected] 領域内だけ copy/cut/contextmenu を抑止するため、
// プレビュー領域にも data-pii-protected を付ける(隣の宛先リスト/調整パネルは既に保護済み)。
const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  join(dir, "../../app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx"),
  "utf8",
);

describe("sale-dm キャンペーン画面 PII 保護", () => {
  it("手紙プレビュー(dangerouslySetInnerHTML)の要素に data-pii-protected が付く", () => {
    const tag = src.match(/<div[^>]*sale-dm-preview[^>]*>/);
    expect(tag).not.toBeNull();
    expect(tag![0]).toContain("data-pii-protected");
  });
});
