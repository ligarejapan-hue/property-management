import { describe, it, expect, vi } from "vitest";
import {
  jstCalendarDay,
  decideLegacyLink,
  reconcileLegacySaleDmLog,
  reconcileSaleDmReactions,
} from "../reconcile";

// 旧 sale_dm 行(draft_id なし)の反響照合(設計§3・冪等・R16/R4/R37)。
// - 対応付け: propertyId+JST暦日(log.sentAt=UTC00:00=JST暦日 / draft.sentAt=実時刻→+9h)
// - 一意なら draft_id を永続化して同期・曖昧(同日複数)は「反響あり側に倒す」(格下げなし)

const NOW = new Date("2026-08-09T03:00:00.000Z");

function draft(over: Record<string, unknown> = {}) {
  return {
    id: "d1",
    propertyId: "p1",
    sentAt: new Date("2026-07-31T20:00:00.000Z"), // JST 2026-08-01 05:00
    deliveryStatus: "unknown",
    outcome: "none",
    lpFirstAccessAt: null,
    phoneInquiryAt: null,
    returnedAt: null,
    ...over,
  };
}

// log.sentAt は @db.Date: UTC00:00 が JST 暦日を表す
const LOG_DAY = new Date("2026-08-01T00:00:00.000Z");

describe("jstCalendarDay(JST暦日変換)", () => {
  it("JST 深夜(0-9時)は UTC 前日でも当日扱い(R37)", () => {
    expect(jstCalendarDay(new Date("2026-07-31T20:00:00.000Z"))).toBe("2026-08-01");
    expect(jstCalendarDay(new Date("2026-08-01T14:59:59.000Z"))).toBe("2026-08-01");
    expect(jstCalendarDay(new Date("2026-08-01T15:00:00.000Z"))).toBe("2026-08-02");
  });
});

describe("decideLegacyLink(対応付けの決定・純関数)", () => {
  it("propertyId が無い行は skipped(対応付け不能)", () => {
    const r = decideLegacyLink({ propertyId: null, sentAt: LOG_DAY }, [draft()], NOW);
    expect(r).toEqual({ kind: "skipped", reason: "no_property" });
  });

  it("同日 draft がゼロなら skipped", () => {
    const r = decideLegacyLink(
      { propertyId: "p1", sentAt: LOG_DAY },
      [draft({ sentAt: new Date("2026-08-01T15:00:00.000Z") })], // JST 08-02
      NOW,
    );
    expect(r).toEqual({ kind: "skipped", reason: "no_candidate" });
  });

  it("一意な同日 draft は linked(draft_id を永続化=R16)・JST境界を跨いで一致", () => {
    const r = decideLegacyLink({ propertyId: "p1", sentAt: LOG_DAY }, [draft()], NOW);
    expect(r).toEqual({ kind: "linked", draftId: "d1" });
  });

  it("同日複数+証拠なしは skipped(触らない=格下げなし)", () => {
    const r = decideLegacyLink(
      { propertyId: "p1", sentAt: LOG_DAY },
      [draft(), draft({ id: "d2" })],
      NOW,
    );
    expect(r).toEqual({ kind: "skipped", reason: "ambiguous_no_evidence" });
  });

  it("同日複数で返戻ありは保守的に undeliverable を付与(反響あり側に倒す=R4)", () => {
    const returnedAt = new Date("2026-08-05T01:00:00.000Z");
    const r = decideLegacyLink(
      { propertyId: "p1", sentAt: LOG_DAY },
      [
        draft({ id: "d2", outcome: "inquiry", lpFirstAccessAt: NOW }),
        draft({ deliveryStatus: "returned_undeliverable", returnedAt }),
      ],
      NOW,
    );
    expect(r).toEqual({
      kind: "conservative",
      event: { kind: "undeliverable", at: returnedAt },
    });
  });

  it("同日複数で LP 反響のみは保守的に replied", () => {
    const lpAt = new Date("2026-08-04T02:00:00.000Z");
    const r = decideLegacyLink(
      { propertyId: "p1", sentAt: LOG_DAY },
      [draft({ id: "d2" }), draft({ outcome: "inquiry", lpFirstAccessAt: lpAt })],
      NOW,
    );
    expect(r).toEqual({ kind: "conservative", event: { kind: "replied", at: lpAt } });
  });
});

function reactionVirgin() {
  return {
    reactionStatus: "no_response",
    reactedAt: null,
    reactionNote: null,
    reactionSource: null,
    manualReactionShadow: null,
  };
}

function makeTx(opts: {
  drafts?: unknown[];
  syncDraft?: unknown;
  logRows?: unknown[];
}) {
  const tx = {
    dmRecipientDraft: {
      findMany: vi.fn(async () => opts.drafts ?? []),
      findUnique: vi.fn(async () => opts.syncDraft ?? null),
    },
    propertyDmLog: {
      findMany: vi.fn(async () => opts.logRows ?? []),
      update: vi.fn(async (args: unknown) => {
        void args;
        return {};
      }),
    },
    $queryRaw: vi.fn(async () => []),
  };
  return tx;
}

describe("reconcileLegacySaleDmLog(単一行版・PATCH フォールバック共用)", () => {
  it("一意一致: draft_id を永続化し同期(sync が draft を読む)", async () => {
    const tx = makeTx({
      drafts: [draft()],
      syncDraft: draft({ outcome: "inquiry", lpFirstAccessAt: NOW }),
      logRows: [{ id: "log-1", ownerId: null, logOwners: [], ...reactionVirgin() }],
    });
    await reconcileLegacySaleDmLog(
      tx as never,
      { id: "log-1", propertyId: "p1", sentAt: LOG_DAY },
      NOW,
    );
    const linkUpd = tx.propertyDmLog.update.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(linkUpd.where).toEqual({ id: "log-1" });
    expect(linkUpd.data).toEqual({ draftId: "d1" });
    // 同期が draft の現在値を読みに行く(実際の反響適用は sync/core のテストで担保)
    expect(tx.dmRecipientDraft.findUnique).toHaveBeenCalled();
  });

  it("曖昧+証拠あり: 保守的に反響のみ付与(draft_id は書かない)", async () => {
    const returnedAt = new Date("2026-08-05T01:00:00.000Z");
    const tx = makeTx({
      drafts: [
        draft({ deliveryStatus: "returned_undeliverable", returnedAt }),
        draft({ id: "d2" }),
      ],
      logRows: [{ id: "log-1", ownerId: null, logOwners: [], ...reactionVirgin() }],
    });
    await reconcileLegacySaleDmLog(
      tx as never,
      { id: "log-1", propertyId: "p1", sentAt: LOG_DAY },
      NOW,
    );
    const upd = tx.propertyDmLog.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(upd.data.draftId).toBeUndefined();
    expect(upd.data).toMatchObject({
      reactionStatus: "undeliverable",
      reactedAt: returnedAt,
      reactionSource: "sale_dm_sync",
    });
  });

  it("曖昧の replied で既存の undeliverable を弱めない(別 draft の返戻証拠かもしれない=#366 R4)", async () => {
    const tx = makeTx({
      drafts: [
        draft({ outcome: "inquiry", lpFirstAccessAt: NOW }),
        draft({ id: "d2" }),
      ],
      logRows: [
        {
          id: "log-1",
          ownerId: null,
          logOwners: [],
          reactionStatus: "undeliverable",
          reactedAt: new Date("2026-08-05T01:00:00.000Z"),
          reactionNote: null,
          reactionSource: "sale_dm_sync",
          manualReactionShadow: null,
        },
      ],
    });
    await reconcileLegacySaleDmLog(
      tx as never,
      { id: "log-1", propertyId: "p1", sentAt: LOG_DAY },
      NOW,
    );
    expect(tx.propertyDmLog.update).not.toHaveBeenCalled();
  });

  it("曖昧+証拠ありでも現在値が同じなら書かない(冪等)", async () => {
    const returnedAt = new Date("2026-08-05T01:00:00.000Z");
    const tx = makeTx({
      drafts: [
        draft({ deliveryStatus: "returned_undeliverable", returnedAt }),
        draft({ id: "d2" }),
      ],
      logRows: [
        {
          id: "log-1",
          ownerId: null,
          logOwners: [],
          reactionStatus: "undeliverable",
          reactedAt: returnedAt,
          reactionNote: null,
          reactionSource: "sale_dm_sync",
          manualReactionShadow: null,
        },
      ],
    });
    await reconcileLegacySaleDmLog(
      tx as never,
      { id: "log-1", propertyId: "p1", sentAt: LOG_DAY },
      NOW,
    );
    expect(tx.propertyDmLog.update).not.toHaveBeenCalled();
  });

  it("対応付け不能(候補ゼロ)は何もしない", async () => {
    const tx = makeTx({ drafts: [] });
    await reconcileLegacySaleDmLog(
      tx as never,
      { id: "log-1", propertyId: "p1", sentAt: LOG_DAY },
      NOW,
    );
    expect(tx.propertyDmLog.update).not.toHaveBeenCalled();
  });
});

describe("reconcileSaleDmReactions(全行照合・件数レポート)", () => {
  function makeClient(logs: unknown[], drafts: unknown[]) {
    const client: Record<string, unknown> = {
      propertyDmLog: {
        findMany: vi.fn(async (args: unknown) => {
          // 外側の全行スキャンのみ(この mock は tx 内の再読取と共用)
          void args;
          return logs;
        }),
        update: vi.fn(async () => ({})),
      },
      dmRecipientDraft: {
        findMany: vi.fn(async () => drafts),
        findUnique: vi.fn(async (args: unknown) => {
          const id = (args as { where: { id: string } }).where.id;
          return (drafts as Array<{ id: string }>).find((d) => d.id === id) ?? null;
        }),
      },
      $queryRaw: vi.fn(async () => []),
    };
    client.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(client));
    return client as Record<string, unknown> & {
      $transaction: ReturnType<typeof vi.fn>;
      propertyDmLog: { findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    };
  }

  const legacyLog = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    propertyId: "p1",
    sentAt: LOG_DAY,
    draftId: null,
    ownerId: null,
    logOwners: [],
    ...reactionVirgin(),
    ...over,
  });

  it("dryRun: 件数のみ数えて書かない", async () => {
    const client = makeClient(
      [
        legacyLog("l-linked"),
        legacyLog("l-skip", { propertyId: "p-none" }),
        legacyLog("l-bridged", { draftId: "d1" }),
      ],
      [draft()],
    );
    const counts = await reconcileSaleDmReactions(client as never, {
      dryRun: true,
      now: NOW,
    });
    expect(counts).toEqual({
      scanned: 3,
      matched: 1,
      linked: 1,
      ambiguousConservative: 0,
      skipped: 1,
    });
    expect(client.$transaction).not.toHaveBeenCalled();
    expect(client.propertyDmLog.update).not.toHaveBeenCalled();
  });

  it("apply: 一意一致の旧行に draft_id を書き込む(tx 内)", async () => {
    const client = makeClient([legacyLog("l-linked")], [draft()]);
    const counts = await reconcileSaleDmReactions(client as never, { now: NOW });
    expect(counts.linked).toBe(1);
    expect(client.$transaction).toHaveBeenCalled();
    const updates = client.propertyDmLog.update.mock.calls.map(
      (c) => c[0] as { data: Record<string, unknown> },
    );
    expect(updates.some((u) => u.data.draftId === "d1")).toBe(true);
  });

  it("apply: ロック後の再読取で所有者が変わっていたら読み直して再試行する(#366 R3)", async () => {
    // 走査時: own-1(これをロック) → tx 内再読取: own-2(名寄せで付け替え済み)→ 中止 →
    // 外で読み直して own-2 をロックし直し → 2度目の tx 内再読取も own-2 → 成功
    const scanRow = legacyLog("l-race", { ownerId: "own-1" });
    const repointed = legacyLog("l-race", { ownerId: "own-2" });
    let idReads = 0;
    const client: Record<string, unknown> = {
      propertyDmLog: {
        findMany: vi.fn(async (args: unknown) => {
          const where = (args as { where: Record<string, unknown> }).where;
          if (where.method === "sale_dm") return [scanRow]; // 全行スキャン
          idReads += 1;
          return [repointed]; // id 再読取(tx 内・retry 前の読み直しとも own-2)
        }),
        update: vi.fn(async () => ({})),
      },
      dmRecipientDraft: {
        findMany: vi.fn(async () => [draft()]),
        findUnique: vi.fn(async () => draft()),
      },
      $queryRaw: vi.fn(async () => []),
    };
    client.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(client));
    const counts = await reconcileSaleDmReactions(client as never, { now: NOW });
    expect(counts.linked).toBe(1);
    // 1度目の tx は中止 → 読み直し → 2度目の tx で成功(tx は2回・id 読取は3回以上)
    expect((client.$transaction as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect(idReads).toBeGreaterThanOrEqual(3);
    const updates = (client.propertyDmLog as { update: ReturnType<typeof vi.fn> }).update.mock.calls.map(
      (c) => c[0] as { data: Record<string, unknown> },
    );
    expect(updates.some((u) => u.data.draftId === "d1")).toBe(true);
  });
});
