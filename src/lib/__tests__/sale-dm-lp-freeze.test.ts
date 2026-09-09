import { describe, it, expect, vi } from "vitest";
import { markLpVariantsFrozen } from "../sale-dm-letter/freeze";

describe("markLpVariantsFrozen", () => {
  it("未設定の LP型だけに印を立て、重複と null を除いて id 順に渡す", async () => {
    const updateMany = vi.fn(async () => ({ count: 2 }));
    const at = new Date("2026-09-09T00:00:00Z");
    const n = await markLpVariantsFrozen({ dmLpVariant: { updateMany } }, ["b", "a", "b"], at);
    expect(n).toBe(2);
    expect(updateMany).toHaveBeenCalledWith({ where: { id: { in: ["a", "b"] }, templateFrozenAt: null }, data: { templateFrozenAt: at } });
  });
  it("空なら DB を触らない", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    expect(await markLpVariantsFrozen({ dmLpVariant: { updateMany } }, [])).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
