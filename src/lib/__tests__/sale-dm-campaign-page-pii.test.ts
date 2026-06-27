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

  it("プレビューの宛名敬称は composeAddresseeHonorific で合成(共有者は『他共有者様』=印刷/CSVと一致)", () => {
    // base honorific を直接渡すと、代表者のみ宛ての見た目で承認 → 実際は「他共有者様」で郵送、の食い違いになる。
    expect(src).toContain("composeAddresseeHonorific(selected.honorific, selected.coOwnerCount)");
  });
});
