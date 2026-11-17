import { vi, describe, it, expect, beforeEach } from "vitest";

// 配信停止の記録: アドレス単位のロック→配信停止の表へ1行(重複は無視)→そのアドレスの進行中の追客を全部止める。

const tx = {
  leadFollowup: { findUnique: vi.fn(), updateMany: vi.fn() },
  mailUnsubscribe: { createMany: vi.fn() },
  $executeRaw: vi.fn(),
};
vi.mock("@/lib/prisma", () => ({
  default: { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) },
}));

import { followupLockKey, recordFollowupUnsubscribe } from "@/lib/lead-followup/unsubscribe-record";

const ID = "2d9a5e3c-7f4b-4c8d-9e0f-3a4b5c6d7e8f";

beforeEach(() => {
  vi.clearAllMocks();
  tx.$executeRaw.mockResolvedValue(1);
});

describe("recordFollowupUnsubscribe", () => {
  it("初めての停止: 表へ入れ、同じアドレスの進行中を全部 unsubscribed で止める", async () => {
    tx.leadFollowup.findUnique.mockResolvedValue({ emailNormalized: "a@example.test" });
    tx.mailUnsubscribe.createMany.mockResolvedValue({ count: 1 });
    tx.leadFollowup.updateMany.mockResolvedValue({ count: 2 });
    await expect(recordFollowupUnsubscribe(ID)).resolves.toEqual({ kind: "recorded", stopped: 2 });

    // ロックは送る処理と同じ鍵(アドレス単位)
    const lockCall = tx.$executeRaw.mock.calls[0];
    expect(lockCall.slice(1)).toEqual([followupLockKey("a@example.test")]);
    expect(tx.mailUnsubscribe.createMany).toHaveBeenCalledWith({
      data: [{ emailNormalized: "a@example.test", source: "link", followupId: ID }],
      skipDuplicates: true,
    });
    const upd = tx.leadFollowup.updateMany.mock.calls[0][0];
    expect(upd.where).toEqual({ emailNormalized: "a@example.test", status: { in: ["active", "sending"] } });
    expect(upd.data).toMatchObject({ status: "stopped", stopReason: "unsubscribed", claimedAt: null });
    // ロックは書き込みより先
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.mailUnsubscribe.createMany.mock.invocationCallOrder[0]);
  });

  it("2回目(すでに表にある)は already。進行中があれば止める", async () => {
    tx.leadFollowup.findUnique.mockResolvedValue({ emailNormalized: "a@example.test" });
    tx.mailUnsubscribe.createMany.mockResolvedValue({ count: 0 });
    tx.leadFollowup.updateMany.mockResolvedValue({ count: 0 });
    await expect(recordFollowupUnsubscribe(ID)).resolves.toEqual({ kind: "already", stopped: 0 });
  });

  it("行が無い・アドレスが無い行は missing(何も書かない)", async () => {
    tx.leadFollowup.findUnique.mockResolvedValueOnce(null);
    await expect(recordFollowupUnsubscribe(ID)).resolves.toEqual({ kind: "missing" });
    tx.leadFollowup.findUnique.mockResolvedValueOnce({ emailNormalized: null });
    await expect(recordFollowupUnsubscribe(ID)).resolves.toEqual({ kind: "missing" });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.mailUnsubscribe.createMany).not.toHaveBeenCalled();
    expect(tx.leadFollowup.updateMany).not.toHaveBeenCalled();
  });
});
