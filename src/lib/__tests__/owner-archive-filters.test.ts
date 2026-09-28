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

  it("phone 経路: 同じ氏名の候補を isArchived=false で取り出す", async () => {
    pm.owner.findMany.mockResolvedValue([]);
    await findDuplicateOwner({ name: "佐藤花子", phone: "090-1111-2222" });

    expect(pm.owner.findMany).toHaveBeenCalledTimes(1);
    const call = pm.owner.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ name: "佐藤花子", isArchived: false, phone: { not: null } });
  });

  // @codex P1 #455: 手で区切った番号を残すので、保存済みの書き方は決まった形にならない。
  // 両方を数字だけにして比べる(書き方を並べて照らすと取りこぼす)。
  it.each([
    ["0422-12-3456", "0422123456"],
    ["0422123456", "0422-12-3456"],
    ["042-212-3456", "0422-12-3456"],
  ])("phone 経路: 保存済み %s と入力 %s は同じ番号として見つかる", async (stored, incoming) => {
    pm.owner.findMany.mockResolvedValue([{ id: "o-1", name: "佐藤花子", phone: stored }]);
    const hit = await findDuplicateOwner({ name: "佐藤花子", phone: incoming });
    expect(hit).toEqual({ id: "o-1", name: "佐藤花子" });
  });

  it("phone 経路: 違う番号なら見つからない", async () => {
    pm.owner.findMany.mockResolvedValue([{ id: "o-1", name: "佐藤花子", phone: "0422-12-3457" }]);
    expect(await findDuplicateOwner({ name: "佐藤花子", phone: "0422-12-3456" })).toBeNull();
  });
});
