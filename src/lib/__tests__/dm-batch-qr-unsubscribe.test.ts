import { vi, describe, it, expect, beforeEach } from "vitest";

// 宛名CSVの1通の配信停止(src/lib/dm-batch/qr-unsubscribe.ts)。prisma を状態つきの偽物にして、
// 1つの取引の中で「記録を作る/使う」「拒否を付ける」「控えの行に結ぶ」を確かめる。

vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn() }));
vi.mock("@/lib/dm-batch/locks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dm-batch/locks")>();
  return { ...actual, lockOwnersForUpdate: vi.fn() };
});

type Log = {
  id: string;
  ownerId: string | null;
  reactionStatus: string;
  reactedAt: Date | null;
  reactionNote: string | null;
  reactionSource: string | null;
  manualReactionShadow: unknown;
  logOwners: { ownerId: string }[];
};
type Item = {
  id: string;
  batchId: string;
  propertyId: string | null;
  ownerId: string | null;
  logId: string | null;
  itemOwners: { ownerId: string }[];
  batch: { downloadedAt: Date | null; confirmedAt: Date | null; createdBy: string };
};
const state: { item: Item | null; logs: Log[] } = { item: null, logs: [] };

vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    dmExportBatchItem: {
      findUnique: vi.fn(async () => (state.item ? structuredClone(state.item) : null)),
      update: vi.fn(async (a: { data: { logId: string } }) => {
        if (state.item) state.item.logId = a.data.logId;
        return a;
      }),
    },
    propertyDmLog: {
      findMany: vi.fn(async (a: { where: { id?: string } }) =>
        structuredClone(a.where.id ? state.logs.filter((l) => l.id === a.where.id) : state.logs),
      ),
      create: vi.fn(async (a: { data: { id: string; ownerId: string | null } }) => {
        state.logs.push({
          id: a.data.id,
          ownerId: a.data.ownerId,
          reactionStatus: "no_response",
          reactedAt: null,
          reactionNote: null,
          reactionSource: null,
          manualReactionShadow: null,
          logOwners: [],
        });
        return a;
      }),
      update: vi.fn(async (a: { where: { id: string }; data: Partial<Log> }) => {
        const l = state.logs.find((x) => x.id === a.where.id);
        if (l) Object.assign(l, a.data);
        return a;
      }),
    },
    propertyDmLogOwner: {
      createMany: vi.fn(async (a: { data: { logId: string; ownerId: string }[] }) => {
        for (const r of a.data) state.logs.find((l) => l.id === r.logId)?.logOwners.push({ ownerId: r.ownerId });
        return { count: a.data.length };
      }),
    },
    $queryRaw: vi.fn(async () => []),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import prisma from "@/lib/prisma";
import { lockOwnersForUpdate } from "@/lib/dm-batch/locks";
import { recordBatchItemUnsubscribe, BATCH_UNSUBSCRIBE_NOTE } from "@/lib/dm-batch/qr-unsubscribe";

const pm = prisma as unknown as {
  dmExportBatchItem: { findUnique: ReturnType<typeof vi.fn> };
  propertyDmLog: { create: ReturnType<typeof vi.fn> };
  $queryRaw: ReturnType<typeof vi.fn>;
};
const ITEM = "0b7e3c1a-5d2f-4a6b-9c8d-1e2f3a4b5c6d";
const BATCH = "9a9a9a9a-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-03T03:00:00Z"); // JST 12:00
const DL = new Date("2026-10-01T00:00:00Z");
const CONFIRMED = new Date("2026-10-02T00:00:00Z");

function baseItem(over: Partial<Item> = {}): Item {
  return {
    id: ITEM,
    batchId: BATCH,
    propertyId: "p1",
    ownerId: "o1",
    logId: null,
    itemOwners: [{ ownerId: "o1" }, { ownerId: "o2" }],
    batch: { downloadedAt: DL, confirmedAt: null, createdBy: "u-creator" },
    ...over,
  };
}
function logRow(over: Partial<Log> = {}): Log {
  return {
    id: "L1",
    ownerId: "o1",
    reactionStatus: "no_response",
    reactedAt: null,
    reactionNote: null,
    reactionSource: null,
    manualReactionShadow: null,
    logOwners: [{ ownerId: "o1" }, { ownerId: "o2" }],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.item = baseItem();
  state.logs = [];
});

describe("宛名CSVの1通の配信停止", () => {
  it("確定前: この1通の送付記録を作り(今日・作成者・連関)、拒否を付け、控えの行に結ぶ", async () => {
    const r = await recordBatchItemUnsubscribe(ITEM, NOW);
    expect(r).toEqual({ kind: "recorded", batchId: BATCH, createdLog: true });
    const created = pm.propertyDmLog.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      propertyId: "p1",
      ownerId: "o1",
      dmType: "owner_address",
      batchId: BATCH,
      draftId: null,
      method: "mail",
      sentBy: "u-creator",
      sentAt: new Date("2026-10-03T00:00:00Z"),
    });
    expect(state.logs[0].logOwners.map((o) => o.ownerId).sort()).toEqual(["o1", "o2"]);
    expect(state.logs[0].reactionStatus).toBe("refused");
    expect(state.logs[0].reactionNote).toBe(BATCH_UNSUBSCRIBE_NOTE);
    expect(state.item?.logId).toBe(state.logs[0].id);
    // 所有者は FOR UPDATE(拒否=terminal を書く)・控え行と控えの行も FOR UPDATE
    expect(lockOwnersForUpdate).toHaveBeenCalledWith(expect.anything(), ["o1", "o1", "o2"]);
    const sqls = pm.$queryRaw.mock.calls.map((c) => (c[0] as string[]).join("?"));
    expect(sqls[0]).toMatch(/FROM dm_export_batches .*FOR UPDATE/);
    expect(sqls[1]).toMatch(/FROM dm_export_batch_items .*FOR UPDATE/);
  });

  it("二度目の押下は already(記録は増えない)", async () => {
    await recordBatchItemUnsubscribe(ITEM, NOW);
    const r = await recordBatchItemUnsubscribe(ITEM, NOW);
    expect(r).toEqual({ kind: "already", batchId: BATCH });
    expect(state.logs).toHaveLength(1);
  });

  it("確定済み(確定で結んだ記録)には拒否だけ付ける・記録は作らない", async () => {
    state.logs = [logRow({ reactionNote: "前のメモ" })];
    state.item = baseItem({ logId: "L1", batch: { downloadedAt: DL, confirmedAt: CONFIRMED, createdBy: "u-creator" } });
    const r = await recordBatchItemUnsubscribe(ITEM, NOW);
    expect(r).toEqual({ kind: "recorded", batchId: BATCH, createdLog: false });
    expect(pm.propertyDmLog.create).not.toHaveBeenCalled();
    expect(state.logs[0].reactionStatus).toBe("refused");
    expect(state.logs[0].reactionNote).toBe(`前のメモ／${BATCH_UNSUBSCRIBE_NOTE}`);
  });

  it("未ダウンロードの控え(手紙が存在しない)は unsent・何も書かない", async () => {
    state.item = baseItem({ batch: { downloadedAt: null, confirmedAt: null, createdBy: "u-creator" } });
    expect(await recordBatchItemUnsubscribe(ITEM, NOW)).toEqual({ kind: "unsent", batchId: BATCH });
    expect(pm.propertyDmLog.create).not.toHaveBeenCalled();
  });

  it("控えの行が無い(控えの削除)は missing", async () => {
    state.item = null;
    expect(await recordBatchItemUnsubscribe(ITEM, NOW)).toEqual({ kind: "missing" });
  });

  it("ロックの間に所有者が増えた(名寄せ)なら conflict・何も書かない", async () => {
    pm.dmExportBatchItem.findUnique
      .mockResolvedValueOnce(baseItem())
      .mockResolvedValueOnce(baseItem({ itemOwners: [{ ownerId: "o1" }, { ownerId: "o2" }, { ownerId: "o3" }] }));
    expect(await recordBatchItemUnsubscribe(ITEM, NOW)).toEqual({ kind: "conflict", batchId: BATCH });
    expect(pm.propertyDmLog.create).not.toHaveBeenCalled();
  });

  it("結んだ記録の所有者がロックの外(記録側だけ付け替えられた)なら conflict", async () => {
    state.logs = [logRow({ logOwners: [{ ownerId: "o1" }, { ownerId: "o9" }] })];
    state.item = baseItem({ logId: "L1", batch: { downloadedAt: DL, confirmedAt: CONFIRMED, createdBy: "u-creator" } });
    expect(await recordBatchItemUnsubscribe(ITEM, NOW)).toEqual({ kind: "conflict", batchId: BATCH });
    expect(state.logs[0].reactionStatus).toBe("no_response");
  });

  it("確定済みなのに結び付きが無い旧控え: 1件に引ければそれに付ける・2件以上なら unsent", async () => {
    state.item = baseItem({ batch: { downloadedAt: DL, confirmedAt: CONFIRMED, createdBy: "u-creator" } });
    state.logs = [logRow({ id: "OLD", logOwners: [{ ownerId: "o1" }] })];
    expect(await recordBatchItemUnsubscribe(ITEM, NOW)).toEqual({ kind: "recorded", batchId: BATCH, createdLog: false });
    expect(state.item?.logId).toBe("OLD");

    state.item = baseItem({ batch: { downloadedAt: DL, confirmedAt: CONFIRMED, createdBy: "u-creator" } });
    state.logs = [logRow({ id: "OLD", logOwners: [{ ownerId: "o1" }] }), logRow({ id: "OLD2", logOwners: [{ ownerId: "o1" }] })];
    expect(await recordBatchItemUnsubscribe(ITEM, NOW)).toEqual({ kind: "unsent", batchId: BATCH });
  });
});
