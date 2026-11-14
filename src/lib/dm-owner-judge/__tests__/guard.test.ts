import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/api-helpers", () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string, public code: string) {
      super(message);
    }
  },
}));

import { assertOwnersForDmSend, NO_OWNER_DM_SEND_MESSAGE } from "../guard";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("所有者が入っていない物件は手で「送付可」にできない(2026-11-14 発注者)", () => {
  it("所有者の無い物件が1件でもあれば 422 で断る", async () => {
    const db = { property: { count: vi.fn(async () => 1) } };
    await expect(assertOwnersForDmSend(db, ["p1", "p2"])).rejects.toMatchObject({
      status: 422,
      code: "NO_OWNER_DM_SEND",
      message: NO_OWNER_DM_SEND_MESSAGE,
    });
    expect(db.property.count).toHaveBeenCalledWith({ where: { id: { in: ["p1", "p2"] }, propertyOwners: { none: {} } } });
  });

  it("全部に所有者がいれば通す・空なら DB を引かない", async () => {
    const db = { property: { count: vi.fn(async () => 0) } };
    await expect(assertOwnersForDmSend(db, ["p1"])).resolves.toBeUndefined();
    await expect(assertOwnersForDmSend(db, [])).resolves.toBeUndefined();
    expect(db.property.count).toHaveBeenCalledTimes(1);
  });

  it("送付可にする入口3つ(ワンタッチ・まとめて変更・物件の編集)すべてで確かめる", () => {
    const actions = read("src/app/api/properties/[id]/actions/route.ts");
    expect(actions).toMatch(/action === "set_dm_send"[\s\S]{0,120}assertOwnersForDmSend\(prisma, \[propertyId\]\)/);
    const bulk = read("src/app/api/properties/bulk-update/route.ts");
    expect(bulk).toMatch(/updateFields\.dmStatus === "send"[\s\S]{0,160}assertOwnersForDmSend\(prisma, accessibleIds\)/);
    const patch = read("src/app/api/properties/[id]/route.ts");
    expect(patch).toMatch(/updateFields\.dmStatus === "send" && current\.dmStatus !== "send"[\s\S]{0,120}assertOwnersForDmSend\(prisma, \[id\]\)/);
  });
});
