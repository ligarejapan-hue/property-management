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

  it("自己レビュー修正が入っている(誤警告/エラー表示/件数/解除選択)", () => {
    const vm = read("../../components/sale-dm/variant-manager.tsx");
    // 型編集の確認は option が実際に変わったときだけ(label のみで誤った作り直し警告を出さない)。
    expect(vm).toContain("optionChanged");

    const adjust = read("../../components/sale-dm/adjust-panel.tsx");
    // 保存/型変更/再生成の失敗を握り潰さずパネルに表示する。
    expect(adjust).toContain("setError");

    const workspace = read("../../app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx");
    // 「確定(N)」件数は本文ありに限定(空本文は confirm route が除外するため件数を一致させる)。
    expect(workspace).toContain('r.status === "draft" && r.body !== ""');

    const list = read("../../app/(dashboard)/properties/page.tsx");
    // 宛先不明 解除後の DM 状態を選択(送付可に戻す / 現状維持)。
    expect(list).toContain("送付可」に戻しますか");
    expect(list).toContain('restore ? { restoreDmStatus: "send" } : undefined');
  });

  it("Codex R31 + 追加自己レビューの修正が入っている(空下書き可視化 / a11y / 解除文言)", () => {
    // 宛先リスト: 本文が空(型変更/auto割当でクリア)= 要再生成 と分かるバッジを出す。一括クリア後に
    // 「半分空の A/B バッチ」を完了と誤認しないため(サーバーは空letterの郵送を防ぐが UI も明示する)。
    const recipientList = read("../../components/sale-dm/recipient-list.tsx");
    expect(recipientList).toContain("要再生成");
    expect(recipientList).toContain('r.status === "draft" && r.body === ""');

    // A/B型管理: 並び順 select と 型名 input にアクセシブルなラベルを付ける(icon/placeholder のみに頼らない)。
    const vm = read("../../components/sale-dm/variant-manager.tsx");
    expect(vm).toContain('aria-label="割り当て順"');
    expect(vm).toContain('aria-label="型の名前"');

    // 宛先不明 解除の確認文言: dmStatus は独立に編集可ゆえ「(送付しない)」と断定しない(現状維持と表現)。
    const list = read("../../app/(dashboard)/properties/page.tsx");
    expect(list).toContain("現在のDM状態のまま");
    expect(list).not.toContain("送付しない)のまま");
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
