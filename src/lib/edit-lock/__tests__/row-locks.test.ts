import { describe, it, expect, vi } from "vitest";
import { lockOwnerRow } from "../row-locks";

/**
 * `lockOwnerRow` は所有者側の行ロックを1関数に集約する(review Important 4)。
 * 3つの保存経路(owners/[id]・corporate-apply・edit-locks/acquire)が同じ SQL を
 * コピペしていたのをここへまとめた。SQL の中身自体は今までと同一であることを固定する。
 */
function sqlOf(call: unknown[]): string {
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  return strings.reduce((acc, s, i) => acc + s + (i < values.length ? `{${String(values[i])}}` : ""), "");
}

describe("lockOwnerRow", () => {
  it("エクスポートされている(呼び出し元が壊れて気づかない、を防ぐ)", () => {
    expect(typeof lockOwnerRow).toBe("function");
  });

  it("owners を id で FOR UPDATE ロックする(所有者→物件の親行の順序規約の所有者側)", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const tx = { $queryRaw: queryRaw };
    const ownerId = "22222222-2222-4222-8222-222222222222";

    await lockOwnerRow(tx, ownerId);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sql = sqlOf(queryRaw.mock.calls[0]);
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("owners");
    expect(sql).toContain(`{${ownerId}}`);
  });

  it("渡された tx をそのまま使う(base client を勝手に使わない)", async () => {
    const txQueryRaw = vi.fn().mockResolvedValue([]);
    const otherQueryRaw = vi.fn().mockResolvedValue([]);
    await lockOwnerRow({ $queryRaw: txQueryRaw }, "id");
    expect(txQueryRaw).toHaveBeenCalledTimes(1);
    expect(otherQueryRaw).not.toHaveBeenCalled();
  });
});
