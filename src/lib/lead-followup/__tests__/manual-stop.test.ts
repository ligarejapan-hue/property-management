import { vi, describe, it, expect, beforeEach } from "vitest";
import { stopFollowupManually } from "@/lib/lead-followup/manual-stop";

const tx = { leadFollowup: { updateMany: vi.fn(), createMany: vi.fn() } };
const NOW = new Date("2026-11-18T03:00:00Z");
const P = { kind: "property" as const, propertyId: "p-1" };
const I = { kind: "inquiry" as const, inquiryId: "i-1" };

beforeEach(() => vi.clearAllMocks());

// 型は Prisma の TransactionClient の一部だけを使う(テストではその2つを差し替える)
const run = (t: typeof P | typeof I) => stopFollowupManually(tx as never, t, "u-1", NOW);

describe("stopFollowupManually(追客を止める)", () => {
  it("進行中の行があれば stopped/manual にして終わり(行は作らない)", async () => {
    tx.leadFollowup.updateMany.mockResolvedValueOnce({ count: 1 });
    await expect(run(P)).resolves.toBe("stopped");
    const arg = tx.leadFollowup.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ propertyId: "p-1", status: { in: ["active", "sending"] } });
    expect(arg.data).toEqual({ status: "stopped", stopReason: "manual", stoppedAt: NOW, stoppedById: "u-1", claimedAt: null });
    expect(tx.leadFollowup.createMany).not.toHaveBeenCalled();
  });

  it("行が無ければ止めた印の行を作る(アドレスは入れない・重複は無視)", async () => {
    tx.leadFollowup.updateMany.mockResolvedValueOnce({ count: 0 });
    tx.leadFollowup.createMany.mockResolvedValueOnce({ count: 1 });
    await expect(run(I)).resolves.toBe("created");
    expect(tx.leadFollowup.createMany).toHaveBeenCalledWith({
      data: [
        {
          targetType: "inquiry",
          inquiryId: "i-1",
          emailNormalized: null,
          status: "stopped",
          stopReason: "manual",
          stoppedAt: NOW,
          stoppedById: "u-1",
        },
      ],
      skipDuplicates: true,
    });
    expect(tx.leadFollowup.updateMany).toHaveBeenCalledTimes(1);
  });

  it("作る直前に送信の処理が進行中の行を作っていたら、もう一度止める", async () => {
    tx.leadFollowup.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    tx.leadFollowup.createMany.mockResolvedValueOnce({ count: 0 });
    await expect(run(P)).resolves.toBe("stopped");
    expect(tx.leadFollowup.updateMany).toHaveBeenCalledTimes(2);
  });

  it("すでに止まっている・送り終えた行は何もしない(already)", async () => {
    tx.leadFollowup.updateMany.mockResolvedValue({ count: 0 });
    tx.leadFollowup.createMany.mockResolvedValueOnce({ count: 0 });
    await expect(run(P)).resolves.toBe("already");
  });
});
