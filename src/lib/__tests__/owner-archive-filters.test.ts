/**
 * archived owner が通常の検索・dedup・候補リストに混入しないことの検証。
 * Phase 2-A で list/search/dedup の where に isArchived=false を追加した。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  default: {
    owner: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

import prisma from "@/lib/prisma";
import { findDuplicateOwner } from "../owner-dedup";

const pm = prisma as unknown as {
  owner: { findMany: Mock; findFirst: Mock };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("owner-dedup: archived owner を重複候補に含めない", () => {
  it("address 経路: findMany の where に isArchived=false を渡す", async () => {
    pm.owner.findMany.mockResolvedValue([]);
    await findDuplicateOwner({ name: "田中太郎", address: "東京都千代田区1-1" });

    expect(pm.owner.findMany).toHaveBeenCalledTimes(1);
    const call = pm.owner.findMany.mock.calls[0][0];
    expect(call.where).toEqual({
      address: { not: null },
      isArchived: false,
    });
  });

  it("phone 経路: findFirst の where に isArchived=false を渡す", async () => {
    pm.owner.findFirst.mockResolvedValue(null);
    await findDuplicateOwner({ name: "佐藤花子", phone: "090-1111-2222" });

    expect(pm.owner.findFirst).toHaveBeenCalledTimes(1);
    const call = pm.owner.findFirst.mock.calls[0][0];
    expect(call.where).toMatchObject({
      name: "佐藤花子",
      phone: "090-1111-2222",
      isArchived: false,
    });
  });
});
