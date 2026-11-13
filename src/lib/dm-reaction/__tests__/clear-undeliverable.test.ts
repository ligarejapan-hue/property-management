import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/dm-batch/locks", () => ({ lockOwnersForUpdate: vi.fn(async () => undefined) }));
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn(async () => undefined) }));

import { classifyUndeliverableLogs, clearOwnerUndeliverable } from "@/lib/dm-reaction/clear-undeliverable";
import { lockOwnersForUpdate } from "@/lib/dm-batch/locks";
import { lockPropertyRow } from "@/lib/property-record-guard";

/**
 * 宛先不明の解除(2026-11-13 発注者決定)。
 * 所有者の登記上の住所を替えたとき、古い住所あての「宛先不明」を、送付対象から外す理由に数えない。
 * ⚠拒否・裏に拒否が控える記録・物件の住所あて・共有でまとめて送った記録・担当できない物件の記録は解除しない。
 */
const OWNER = "owner-1";
const log = (over: Record<string, unknown> = {}) => ({
  id: "log-1",
  propertyId: "p1" as string | null,
  reactionStatus: "undeliverable" as string | null,
  undeliverableClearedAt: null as Date | null,
  manualReactionShadow: null as unknown,
  dmType: "owner_address" as string | null,
  ownerId: OWNER as string | null,
  logOwnerIds: [] as string[],
  accessible: true,
  ...over,
});

describe("classifyUndeliverableLogs(解除できる記録と、できない理由)", () => {
  it("その所有者だけに送った宛先不明は解除できる", () => {
    const r = classifyUndeliverableLogs([log()], OWNER);
    expect(r.clearable.map((l) => l.id)).toEqual(["log-1"]);
    expect([r.sharedSkipped, r.otherSkipped]).toEqual([0, 0]);
  });

  it("⚠共有でまとめて送った記録は解除せず、数だけ返す(発注者決定)", () => {
    const r = classifyUndeliverableLogs(
      [
        log({ id: "a", logOwnerIds: [OWNER, "owner-2"] }),
        log({ id: "b", ownerId: "owner-2", logOwnerIds: [OWNER] }),
      ],
      OWNER,
    );
    expect(r.clearable).toEqual([]);
    expect(r.sharedSkipped).toBe(2);
  });

  it("⚠裏に拒否が控える記録・物件の住所あて・担当できない物件の記録は解除しない", () => {
    const r = classifyUndeliverableLogs(
      [
        log({ id: "shadow", manualReactionShadow: { status: "refused", reactedAt: null, note: null } }),
        log({ id: "prop-addr", dmType: "property_address" }),
        log({ id: "out-of-scope", accessible: false }),
      ],
      OWNER,
    );
    expect(r.clearable).toEqual([]);
    expect(r.otherSkipped).toBe(3);
  });

  it("⚠拒否は対象にしない・解除済みやほかの人の記録は数えない", () => {
    const r = classifyUndeliverableLogs(
      [
        log({ id: "refused", reactionStatus: "refused" }),
        log({ id: "already", undeliverableClearedAt: new Date("2026-11-01T00:00:00Z") }),
        log({ id: "someone-else", ownerId: "owner-9" }),
      ],
      OWNER,
    );
    expect(r).toEqual({ clearable: [], sharedSkipped: 0, otherSkipped: 0 });
  });
});

type Row = {
  id: string;
  propertyId: string | null;
  reactionStatus: string;
  undeliverableClearedAt: Date | null;
  manualReactionShadow: unknown;
  dmType: string | null;
  ownerId: string | null;
  logOwners: { ownerId: string }[];
  property: { createdBy: string; assignedTo: string | null } | null;
};
const row = (over: Partial<Row> = {}): Row => ({
  id: "log-1",
  propertyId: "p1",
  reactionStatus: "undeliverable",
  undeliverableClearedAt: null,
  manualReactionShadow: null,
  dmType: "owner_address",
  ownerId: OWNER,
  logOwners: [],
  property: { createdBy: "u-office", assignedTo: null },
  ...over,
});

function makeTx(rows: Row[], opts: { remaining?: Record<string, number>; properties?: Record<string, { dmUndeliverableAt: Date | null; dmStatus: string }> } = {}) {
  const order: string[] = [];
  const tx = {
    propertyDmLog: {
      // 1回目=対象の記録 / それ以降=数え直しの「解除済みの記録につながる売却DMの宛先」
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        if ("OR" in args.where) {
          order.push("read-logs");
          return rows;
        }
        return [];
      }),
      updateMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
        order.push("mark-cleared");
        return { count: args.where.id.in.length };
      }),
      count: vi.fn(async (args: { where: { propertyId: string } }) => opts.remaining?.[args.where.propertyId] ?? 0),
    },
    dmRecipientDraft: { count: vi.fn(async () => 0) },
    property: {
      findUnique: vi.fn(async (args: { where: { id: string } }) =>
        opts.properties?.[args.where.id] ?? { dmUndeliverableAt: new Date("2026-10-01T00:00:00Z"), dmStatus: "no_send" },
      ),
      update: vi.fn(async () => ({})),
    },
    changeLog: { create: vi.fn(async () => ({})) },
  };
  (lockOwnersForUpdate as ReturnType<typeof vi.fn>).mockImplementation(async () => {
    order.push("lock-owner");
  });
  (lockPropertyRow as ReturnType<typeof vi.fn>).mockImplementation(async (_tx: unknown, id: string) => {
    order.push(`lock-property:${id}`);
  });
  return { tx, order };
}
const NOW = new Date("2026-11-13T03:00:00Z");
const OFFICE = { id: "u-office", role: "office_staff" };
const run = (tx: unknown, session = OFFICE) =>
  clearOwnerUndeliverable(tx as never, { ownerId: OWNER, session, now: NOW });

beforeEach(() => vi.clearAllMocks());

describe("clearOwnerUndeliverable", () => {
  it("★印を付け、物件の「宛先不明」の印を外し、DM 可否を「送付可」に戻す(変更履歴つき)", async () => {
    const { tx } = makeTx([row()]);
    const r = await run(tx);
    expect(r).toMatchObject({ cleared: 1, sharedSkipped: 0, otherSkipped: 0, flagsCleared: 1, dmStatusRestored: 1 });
    expect(tx.propertyDmLog.updateMany).toHaveBeenCalledWith({
      // ⚠押さえている間に別の反響へ書き換えられた記録には付けない(条件つき)
      where: { id: { in: ["log-1"] }, reactionStatus: "undeliverable", undeliverableClearedAt: null },
      data: { undeliverableClearedAt: NOW, undeliverableClearedBy: "u-office" },
    });
    expect(tx.property.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { dmUndeliverableAt: null, dmStatus: "send", version: { increment: 1 } },
    });
    expect(tx.changeLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ targetTable: "properties", targetId: "p1", fieldName: "dmStatus", oldValue: "no_send", newValue: "send", changedBy: "u-office" }),
    });
  });

  it("⚠ロックの順序=所有者 → 物件(id 順)→ 記録(拒否・宛先不明の書き手と同じ順)", async () => {
    const { tx, order } = makeTx([row({ id: "b", propertyId: "p2" }), row({ id: "a", propertyId: "p1" })]);
    await run(tx);
    expect(order).toEqual(["lock-owner", "read-logs", "lock-property:p1", "lock-property:p2", "mark-cleared"]);
  });

  it("その物件にまだ宛先不明が残っていれば、印も DM 可否もそのまま", async () => {
    const { tx } = makeTx([row()], { remaining: { p1: 1 } });
    const r = await run(tx);
    expect(r).toMatchObject({ cleared: 1, flagsCleared: 0, dmStatusRestored: 0 });
    expect(tx.property.update).not.toHaveBeenCalled();
  });

  it("⚠「宛先不明」の印が無い物件の「送らない」は人の判断=触らない", async () => {
    const { tx } = makeTx([row()], { properties: { p1: { dmUndeliverableAt: null, dmStatus: "no_send" } } });
    const r = await run(tx);
    expect(r).toMatchObject({ cleared: 1, flagsCleared: 0, dmStatusRestored: 0 });
    expect(tx.property.update).not.toHaveBeenCalled();
  });

  it("印はあるが DM 可否が「送らない」でない物件は、印だけ外す(DM 可否・version は触らない)", async () => {
    const { tx } = makeTx([row()], {
      properties: { p1: { dmUndeliverableAt: new Date("2026-10-01T00:00:00Z"), dmStatus: "hold" } },
    });
    const r = await run(tx);
    expect(r).toMatchObject({ flagsCleared: 1, dmStatusRestored: 0 });
    expect(tx.property.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { dmUndeliverableAt: null } });
    expect(tx.changeLog.create).not.toHaveBeenCalled();
  });

  it("⚠共有の記録しか無ければ何も書かない(数だけ返す)", async () => {
    const { tx } = makeTx([row({ logOwners: [{ ownerId: OWNER }, { ownerId: "owner-2" }] })]);
    const r = await run(tx);
    expect(r).toMatchObject({ cleared: 0, sharedSkipped: 1, flagsCleared: 0, dmStatusRestored: 0 });
    expect(tx.propertyDmLog.updateMany).not.toHaveBeenCalled();
    expect(lockPropertyRow).not.toHaveBeenCalled();
  });

  it("⚠現場担当は、担当する物件の記録だけ解除する(担当外の物件の DM 可否を動かさない)", async () => {
    const { tx } = makeTx([
      row({ id: "mine", propertyId: "p1", property: { createdBy: "u-field", assignedTo: null } }),
      row({ id: "others", propertyId: "p2", property: { createdBy: "u-office", assignedTo: null } }),
    ]);
    const r = await run(tx, { id: "u-field", role: "field_staff" });
    expect(r).toMatchObject({ cleared: 1, otherSkipped: 1 });
    expect(tx.propertyDmLog.updateMany.mock.calls[0][0].where.id).toEqual({ in: ["mine"] });
    expect(lockPropertyRow).toHaveBeenCalledTimes(1);
  });

  it("物件が消えている記録(propertyId なし)は、印だけ付ける", async () => {
    const { tx } = makeTx([row({ propertyId: null, property: null })]);
    const r = await run(tx);
    expect(r).toMatchObject({ cleared: 1, flagsCleared: 0 });
    expect(lockPropertyRow).not.toHaveBeenCalled();
  });
});
