import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn(async () => undefined) }));
vi.mock("@/lib/dm-reaction/sync", () => ({ syncSaleDmReaction: vi.fn(async () => undefined) }));

import { recordInquiry } from "@/lib/sale-dm-letter/inquiry-record";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { syncSaleDmReaction } from "@/lib/dm-reaction/sync";

const INPUT = { name: "山田", phone: "090-1234-5678", email: null, contactPref: null, contactTime: null, message: "相談したい" };
const NOW = new Date("2026-09-20T01:00:00.000Z");

function makeClient(draft: { id: string; propertyId: string; status: string } | null, lockedStatus = draft?.status, claims = { form: 1, lp: 0 }) {
  const calls: string[] = [];
  const tx = {
    $queryRaw: vi.fn(),
    dmRecipientDraft: {
      findUnique: vi.fn(async () => { calls.push("tx.findUnique"); return draft ? { status: lockedStatus } : null; }),
      updateMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        calls.push(`tx.updateMany:${Object.keys(args.where).join(",")}`);
        return { count: "formInquiryFirstAt" in args.where ? claims.form : claims.lp };
      }),
      update: vi.fn(async () => { calls.push("tx.update"); return {}; }),
    },
    dmInquiry: {
      create: vi.fn(async () => { calls.push("tx.dmInquiry.create"); return { id: "inq1" }; }),
    },
  };
  const client = {
    dmRecipientDraft: { findUnique: vi.fn(async () => draft) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { client, tx, calls };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("recordInquiry", () => {
  it("未知 token は unknown(何も書かない)", async () => {
    const { client } = makeClient(null);
    expect(await recordInquiry(client as never, "x", INPUT, NOW)).toEqual({ kind: "unknown" });
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it("送付前は not_sent(何も書かない)", async () => {
    const { client } = makeClient({ id: "d1", propertyId: "p1", status: "confirmed" });
    expect(await recordInquiry(client as never, "t", INPUT, NOW)).toEqual({ kind: "not_sent" });
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it("ロック後に読み直して送付済みでなければ not_sent(INSERT しない)", async () => {
    const { client, tx } = makeClient({ id: "d1", propertyId: "p1", status: "sent" }, "confirmed");
    expect(await recordInquiry(client as never, "t", INPUT, NOW)).toEqual({ kind: "not_sent" });
    expect(tx.dmInquiry.create).not.toHaveBeenCalled();
  });

  it("送付済み: 親行ロック→読み直し→INSERT→初回→QR読み取りの補い→アプリ内ページ表示の補い→計数+outcome→同期(allowTerminal:false)", async () => {
    const { client, tx, calls } = makeClient({ id: "d1", propertyId: "p1", status: "sent" });
    const r = await recordInquiry(client as never, "t", INPUT, NOW);
    expect(r).toEqual({ kind: "recorded", inquiryId: "inq1", draftId: "d1", first: true });
    expect(lockPropertyRow).toHaveBeenCalledWith(tx, "p1");
    expect(calls).toEqual([
      "tx.findUnique",
      "tx.dmInquiry.create",
      "tx.updateMany:id,formInquiryFirstAt",
      "tx.updateMany:id,lpFirstAccessAt",
      "tx.updateMany:id,lpPageFirstAt",
      "tx.update",
    ]);
    expect(tx.dmInquiry.create).toHaveBeenCalledWith({
      data: { draftId: "d1", submittedAt: NOW, name: "山田", phone: "090-1234-5678", email: null, contactPref: null, contactTime: null, message: "相談したい" },
      select: { id: true },
    });
    expect(tx.dmRecipientDraft.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "d1", formInquiryFirstAt: null },
      data: { formInquiryFirstAt: NOW },
    });
    expect(tx.dmRecipientDraft.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "d1", lpFirstAccessAt: null },
      data: { lpFirstAccessAt: NOW },
    });
    expect(tx.dmRecipientDraft.updateMany).toHaveBeenNthCalledWith(3, {
      where: { id: "d1", lpPageFirstAt: null },
      data: { lpPageFirstAt: NOW },
    });
    expect(tx.dmRecipientDraft.update).toHaveBeenCalledWith({
      where: { id: "d1" },
      data: { formInquiryCount: { increment: 1 }, outcome: "inquiry" },
    });
    expect(syncSaleDmReaction).toHaveBeenCalledWith(tx, "d1", { allowTerminal: false });
  });

  it("2回目の申込は first=false(初回時刻は条件付き updateMany の count で決める)", async () => {
    const { client } = makeClient({ id: "d1", propertyId: "p1", status: "sent" }, "sent", { form: 0, lp: 0 });
    expect(await recordInquiry(client as never, "t", INPUT, NOW)).toMatchObject({ kind: "recorded", first: false });
  });

  it("DB エラーは投げる(申込を黙って捨てない)", async () => {
    const { client, tx } = makeClient({ id: "d1", propertyId: "p1", status: "sent" });
    tx.dmInquiry.create.mockRejectedValueOnce(new Error("db down"));
    await expect(recordInquiry(client as never, "t", INPUT, NOW)).rejects.toThrow("db down");
  });
});
