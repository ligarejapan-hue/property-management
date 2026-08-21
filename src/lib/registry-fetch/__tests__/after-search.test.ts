import { describe, expect, it } from "vitest";
import { decideAfterSearch } from "@/lib/registry-fetch/after-search";

/**
 * 所在検索が終わったあと、**そのまま有料取得へ進んでよいか**の判断。
 *
 * 発注者指示(2026-08-21): 候補が1件なら「選ぶ」「確認」を挟まず**そのまま取得へ**。
 * 複数件のときは**エラーで止める**(取り違えて別の筆を買わない)。
 * ⚠**検索中に中止したら次へ進まない**。課金の後は取り消せないので、
 *   止まれるのは課金の前だけ＝ここが唯一の砦。
 * ⚠この判断は**お金が動く分岐**なので、画面の文字列ではなく純関数として固定する。
 */
const c = (ref: string) => ({
  candidateRef: ref,
  address: "東京都世田谷区三宿２丁目１８０－１",
  lotNumber: "１８０－１",
  buildingNumber: null,
});

describe("decideAfterSearch", () => {
  it("候補1件なら、そのまま取得へ進む", () => {
    const d = decideAfterSearch({
      candidates: [c("a")],
      cancelRequested: false,
      purchaseEnabled: true,
    });
    expect(d.action).toBe("obtain");
    expect(d.action === "obtain" && d.candidate.candidateRef).toBe("a");
  });

  it("⚠中止が押されていたら、候補1件でも進まない(課金前の唯一の砦)", () => {
    expect(
      decideAfterSearch({
        candidates: [c("a")],
        cancelRequested: true,
        purchaseEnabled: true,
      }).action,
    ).toBe("cancelled");
  });

  it("⚠中止は他のどの条件よりも優先する(複数件でも中止が勝つ)", () => {
    expect(
      decideAfterSearch({
        candidates: [c("a"), c("b")],
        cancelRequested: true,
        purchaseEnabled: true,
      }).action,
    ).toBe("cancelled");
  });

  it("複数件は取得せずエラーで止める(取り違え防止)", () => {
    const d = decideAfterSearch({
      candidates: [c("a"), c("b"), c("x")],
      cancelRequested: false,
      purchaseEnabled: true,
    });
    expect(d.action).toBe("too_many");
    expect(d.action === "too_many" && d.count).toBe(3);
  });

  it("0件は従来どおり結果表示(取得しない)", () => {
    expect(
      decideAfterSearch({
        candidates: [],
        cancelRequested: false,
        purchaseEnabled: true,
      }).action,
    ).toBe("show_results");
  });

  it("⚠有料取得が止まっている環境では自動で進まない(必ず501になるため)", () => {
    expect(
      decideAfterSearch({
        candidates: [c("a")],
        cancelRequested: false,
        purchaseEnabled: false,
      }).action,
    ).toBe("show_results");
  });
});
