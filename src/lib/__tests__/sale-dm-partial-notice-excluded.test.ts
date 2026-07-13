import { describe, it, expect } from "vitest";
import { buildSaleDmPartialNotice } from "@/lib/sale-dm-letter/list-ui";

describe("buildSaleDmPartialNotice: 対象外(住所なし等)の通知", () => {
  it("excluded>0 なら対象外件数を通知に含める", () => {
    const msg = buildSaleDmPartialNotice({ generated: 8, failed: 0, truncated: false, excluded: 4 }) ?? "";
    expect(msg).toContain("4 件");
    expect(msg).toContain("対象外");
  });

  it("除外0・失敗0・truncated無 なら通知しない(null)", () => {
    expect(
      buildSaleDmPartialNotice({ generated: 5, failed: 0, truncated: false, excluded: 0 }),
    ).toBeNull();
  });

  it("除外と失敗が両方あれば両方を通知に含める", () => {
    const msg = buildSaleDmPartialNotice({ generated: 6, failed: 2, truncated: false, excluded: 3 }) ?? "";
    expect(msg).toContain("3 件");
    expect(msg).toContain("2 件");
  });
});
