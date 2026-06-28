import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// バックエンド(variants / assign / clear-dm-undeliverable route)は各 route テストで検証済み。
// ここでは「A/B型管理UI と宛先不明 手動解除UI が、正しい client を呼び・権限でゲートされて配線されている」
// ことを source レベルで担保する(本リポジトリの page-pii テストと同方式。render 基盤は未導入)。
const dir = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(dir, rel), "utf8");

describe("売却DM 管理UI の配線", () => {
  it("A/B型管理パネルは 作成/更新/削除/割当 の client を呼ぶ", () => {
    const src = read("../../components/sale-dm/variant-manager.tsx");
    expect(src).toContain("createSaleDmVariant");
    expect(src).toContain("updateSaleDmVariant");
    expect(src).toContain("deleteSaleDmVariant");
    expect(src).toContain("assignSaleDmVariants");
    // options 変更/割当は未送付の本文を作り直し対象にし得るため確認ダイアログを出す。
    expect(src).toContain("window.confirm");
  });

  it("作業画面に A/B型管理パネルを組み込んでいる", () => {
    const src = read("../../app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx");
    expect(src).toContain("SaleDmVariantManager");
  });

  it("作業画面の調整パネルは『この宛先の型』を付け替えできる(手動割当)", () => {
    const src = read("../../components/sale-dm/adjust-panel.tsx");
    expect(src).toContain("changeVariant");
    expect(src).toContain("buildDraftPatch({ variantId })");
  });

  it("一覧の宛先不明 手動解除ボタンは property:write でゲートし clear client を呼ぶ", () => {
    const src = read("../../app/(dashboard)/properties/page.tsx");
    expect(src).toContain("clearSaleDmUndeliverable");
    expect(src).toContain("canWriteProperty");
    expect(src).toContain("宛先不明を解除");
    // write 権限の導出(action === "write")が存在する。
    expect(src).toContain('p.action === "write"');
  });

  it("client に A/B管理 + 宛先不明解除の関数が存在する", () => {
    const src = read("../api-client.ts");
    for (const fn of [
      "export async function createSaleDmVariant",
      "export async function updateSaleDmVariant",
      "export async function deleteSaleDmVariant",
      "export async function assignSaleDmVariants",
      "export async function clearSaleDmUndeliverable",
    ]) {
      expect(src).toContain(fn);
    }
  });
});
