import { describe, it, expect, vi } from "vitest";
import { Prisma } from "@/generated/prisma";
import {
  deriveSaleDmReactionEvent,
  syncSaleDmReaction,
  SyncOwnerSetChangedError,
  type ReactionSyncTx,
} from "../sync";

// 売却DM draft→ブリッジ行(送付記録)の反響同期(設計§3)。
// 導出・適用(優先規則/shadow)は core で担保済み。ここは同期の配線を検証する:
//  - 導出(returned→undeliverable / inquiry→replied / どちらでもない→cleared)
//  - terminal(undeliverable)書込時のみ Owner FOR UPDATE(SQL捕捉)+ロック後の再読取
//  - 変化なしなら書込もロックもしない(冪等・ホットパス)
//  - allowTerminal:false(公開LP追跡)は terminal を書かない

const T_RET = new Date("2026-08-03T05:00:00.000Z");
const T_LP = new Date("2026-08-04T05:00:00.000Z");
const T_PHONE = new Date("2026-08-05T05:00:00.000Z");

function draftRow(over: Record<string, unknown> = {}) {
  return {
    deliveryStatus: "unknown",
    outcome: "none",
    lpFirstAccessAt: null,
    phoneInquiryAt: null,
    returnedAt: null,
    ...over,
  };
}

function logRow(over: Record<string, unknown> = {}) {
  return {
    id: "log-1",
    ownerId: "own-1",
    reactionStatus: "no_response",
    reactedAt: null,
    reactionNote: null,
    reactionSource: null,
    manualReactionShadow: null,
    logOwners: [{ ownerId: "own-2" }],
    ...over,
  };
}

function makeTx(draft: unknown, logs: unknown[], legacyLogs: unknown[] = []) {
  const tx = {
    dmRecipientDraft: { findUnique: vi.fn(async () => draft) },
    propertyDmLog: {
      // 2種類の読取を where で振り分ける: draftId 一致=ブリッジ行 / draftId:null=旧行フォールバック
      findMany: vi.fn(async (args: unknown) => {
        const where = (args as { where: { draftId: string | null } }).where;
        return where.draftId === null ? legacyLogs : logs;
      }),
      update: vi.fn(async (args: unknown) => {
        void args; // 呼び出し引数は mock.calls で検証する
        return {};
      }),
    },
    $queryRaw: vi.fn(async () => []),
  };
  return tx as typeof tx & ReactionSyncTx;
}

/** $queryRaw の呼び出しから owners への FOR UPDATE 文を探す(ロック順序SQL捕捉)。 */
function ownerLockCalls(tx: { $queryRaw: ReturnType<typeof vi.fn> }): number {
  return tx.$queryRaw.mock.calls.filter((call) => {
    const sql = (call[0] as readonly string[]).join("?");
    return /FROM owners/.test(sql) && /FOR UPDATE/.test(sql);
  }).length;
}

describe("deriveSaleDmReactionEvent(導出)", () => {
  it("returned_undeliverable → undeliverable(at=returnedAt)", () => {
    const e = deriveSaleDmReactionEvent(
      draftRow({ deliveryStatus: "returned_undeliverable", returnedAt: T_RET }) as never,
      new Date(),
    );
    expect(e).toEqual({ kind: "undeliverable", at: T_RET });
  });

  it("outcome=inquiry → replied(at=LP/電話の早い方)", () => {
    const e = deriveSaleDmReactionEvent(
      draftRow({ outcome: "inquiry", lpFirstAccessAt: T_LP, phoneInquiryAt: T_PHONE }) as never,
      new Date(),
    );
    expect(e).toEqual({ kind: "replied", at: T_LP });
  });

  it("返送は inquiry より優先(両方あれば undeliverable)", () => {
    const e = deriveSaleDmReactionEvent(
      draftRow({
        deliveryStatus: "returned_undeliverable",
        returnedAt: T_RET,
        outcome: "inquiry",
        lpFirstAccessAt: T_LP,
      }) as never,
      new Date(),
    );
    expect(e.kind).toBe("undeliverable");
  });

  it("どちらでもない → cleared", () => {
    const e = deriveSaleDmReactionEvent(draftRow() as never, T_LP);
    expect(e).toEqual({ kind: "cleared", at: T_LP });
  });
});

describe("syncSaleDmReaction(配線)", () => {
  it("draft が無ければ何もしない(ログを読まない)", async () => {
    const tx = makeTx(null, []);
    await syncSaleDmReaction(tx, "d1");
    expect(tx.propertyDmLog.findMany).not.toHaveBeenCalled();
    expect(tx.propertyDmLog.update).not.toHaveBeenCalled();
  });

  it("ブリッジ行なし(findMany 空)なら書き込まない", async () => {
    const tx = makeTx(draftRow({ outcome: "inquiry", lpFirstAccessAt: T_LP }), []);
    await syncSaleDmReaction(tx, "d1");
    expect(tx.propertyDmLog.update).not.toHaveBeenCalled();
  });

  it("LP反響(inquiry)→ ブリッジ行が replied/sale_dm_sync になる(Ownerロックなし)", async () => {
    const tx = makeTx(
      draftRow({ outcome: "inquiry", lpFirstAccessAt: T_LP }),
      [logRow()],
    );
    await syncSaleDmReaction(tx, "d1");
    const upd = tx.propertyDmLog.update.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(upd.where).toEqual({ id: "log-1" });
    expect(upd.data).toMatchObject({
      reactionStatus: "replied",
      reactedAt: T_LP,
      reactionSource: "sale_dm_sync",
    });
    expect(upd.data.manualReactionShadow).toBe(Prisma.DbNull);
    expect(ownerLockCalls(tx)).toBe(0);
  });

  it("返戻 → 手動 replied を上書きし shadow 退避・Owner FOR UPDATE+再読取(R47)", async () => {
    const manual = logRow({
      reactionStatus: "replied",
      reactedAt: T_LP,
      reactionNote: "電話あり",
      reactionSource: "manual",
    });
    const tx = makeTx(
      draftRow({ deliveryStatus: "returned_undeliverable", returnedAt: T_RET }),
      [manual],
    );
    await syncSaleDmReaction(tx, "d1");
    expect(ownerLockCalls(tx)).toBe(1);
    // ロック後に再読取してから適用する
    expect(tx.propertyDmLog.findMany).toHaveBeenCalledTimes(2);
    const upd = tx.propertyDmLog.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(upd.data).toMatchObject({
      reactionStatus: "undeliverable",
      reactedAt: T_RET,
      reactionSource: "sale_dm_sync",
    });
    expect(upd.data.manualReactionShadow).toEqual({
      status: "replied",
      reactedAt: T_LP.toISOString(),
      note: "電話あり",
    });
  });

  it("既に同期済み(変化なし)なら書込もロックもしない(冪等)", async () => {
    const synced = logRow({
      reactionStatus: "undeliverable",
      reactedAt: T_RET,
      reactionSource: "sale_dm_sync",
    });
    const tx = makeTx(
      draftRow({ deliveryStatus: "returned_undeliverable", returnedAt: T_RET }),
      [synced],
    );
    await syncSaleDmReaction(tx, "d1");
    expect(tx.propertyDmLog.update).not.toHaveBeenCalled();
    expect(ownerLockCalls(tx)).toBe(0);
    expect(tx.propertyDmLog.findMany).toHaveBeenCalledTimes(1);
  });

  it("allowTerminal:false(公開LP追跡)は返戻でも書かない(Ownerロック不要を保証)", async () => {
    const tx = makeTx(
      draftRow({ deliveryStatus: "returned_undeliverable", returnedAt: T_RET }),
      [logRow()],
    );
    await syncSaleDmReaction(tx, "d1", { allowTerminal: false });
    expect(tx.propertyDmLog.findMany).not.toHaveBeenCalled();
    expect(tx.propertyDmLog.update).not.toHaveBeenCalled();
    expect(ownerLockCalls(tx)).toBe(0);
  });

  it("訂正(cleared)は shadow から手動値を復元する", async () => {
    const overwritten = logRow({
      reactionStatus: "undeliverable",
      reactedAt: T_RET,
      reactionSource: "sale_dm_sync",
      manualReactionShadow: {
        status: "replied",
        reactedAt: T_LP.toISOString(),
        note: "電話あり",
      },
    });
    const tx = makeTx(draftRow(), [overwritten]);
    await syncSaleDmReaction(tx, "d1");
    const upd = tx.propertyDmLog.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(upd.data).toMatchObject({
      reactionStatus: "replied",
      reactedAt: T_LP,
      reactionNote: "電話あり",
      reactionSource: "manual",
    });
    expect(upd.data.manualReactionShadow).toBe(Prisma.DbNull);
    expect(ownerLockCalls(tx)).toBe(0);
  });

  it("手動値は cleared で消えない(同期の消失は手動記録を保護)", async () => {
    const manual = logRow({
      reactionStatus: "refused",
      reactedAt: T_LP,
      reactionSource: "manual",
    });
    const tx = makeTx(draftRow(), [manual]);
    await syncSaleDmReaction(tx, "d1");
    expect(tx.propertyDmLog.update).not.toHaveBeenCalled();
  });
});

describe("syncSaleDmReaction: 旧sale_dm行への保守的フォールバック(#366 R1)", () => {
  // draft.sentAt=UTC 7/31 20:00 = JST 8/1 05:00 → 旧行の sentAt(@db.Date)=8/1 と対応(R37境界)
  const SENT_AT = new Date("2026-07-31T20:00:00.000Z");
  const legacyDraft = (over: Record<string, unknown> = {}) =>
    draftRow({ propertyId: "p1", sentAt: SENT_AT, ...over });
  const legacyRow = (over: Record<string, unknown> = {}) =>
    logRow({ id: "legacy-1", ownerId: null, logOwners: [], ...over });

  it("LP反響: 同一物件+同一JST暦日の未リンク旧行にも replied を反映(where をピン)", async () => {
    const tx = makeTx(
      legacyDraft({ outcome: "inquiry", lpFirstAccessAt: T_LP }),
      [],
      [legacyRow()],
    );
    await syncSaleDmReaction(tx, "d1");
    const legacyCall = tx.propertyDmLog.findMany.mock.calls
      .map((c) => (c[0] as { where: Record<string, unknown> }).where)
      .find((w) => w.draftId === null);
    expect(legacyCall).toEqual({
      method: "sale_dm",
      draftId: null,
      propertyId: "p1",
      sentAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    const upd = tx.propertyDmLog.update.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(upd.where).toEqual({ id: "legacy-1" });
    expect(upd.data).toMatchObject({
      reactionStatus: "replied",
      reactionSource: "sale_dm_sync",
    });
  });

  it("返戻: 旧行にも undeliverable を反映(旧行は連関なし=ロック集合は増えない)", async () => {
    const tx = makeTx(
      legacyDraft({ deliveryStatus: "returned_undeliverable", returnedAt: T_RET }),
      [],
      [legacyRow()],
    );
    await syncSaleDmReaction(tx, "d1");
    const upd = tx.propertyDmLog.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(upd.data).toMatchObject({
      reactionStatus: "undeliverable",
      reactedAt: T_RET,
    });
    expect(ownerLockCalls(tx)).toBe(0); // legacyRow は ownerId=null・連関0
  });

  it("cleared は旧行に適用しない(どの draft の証拠か確定しない=格下げなし)", async () => {
    const synced = legacyRow({
      reactionStatus: "replied",
      reactedAt: T_LP,
      reactionSource: "sale_dm_sync",
    });
    const tx = makeTx(legacyDraft(), [], [synced]);
    await syncSaleDmReaction(tx, "d1");
    // cleared のときは旧行を読みにすら行かない
    expect(
      tx.propertyDmLog.findMany.mock.calls
        .map((c) => (c[0] as { where: Record<string, unknown> }).where)
        .filter((w) => w.draftId === null),
    ).toHaveLength(0);
    expect(tx.propertyDmLog.update).not.toHaveBeenCalled();
  });

  it("replied で旧行の undeliverable を弱めない(別 draft の返戻証拠かもしれない)", async () => {
    const undeliv = legacyRow({
      reactionStatus: "undeliverable",
      reactedAt: T_RET,
      reactionSource: "sale_dm_sync",
    });
    const tx = makeTx(
      legacyDraft({ outcome: "inquiry", lpFirstAccessAt: T_LP }),
      [],
      [undeliv],
    );
    await syncSaleDmReaction(tx, "d1");
    expect(tx.propertyDmLog.update).not.toHaveBeenCalled();
  });

  it("draft に propertyId/sentAt が無ければ旧行フォールバックはしない", async () => {
    const tx = makeTx(
      draftRow({ outcome: "inquiry", lpFirstAccessAt: T_LP }),
      [],
      [legacyRow()],
    );
    await syncSaleDmReaction(tx, "d1");
    expect(tx.propertyDmLog.update).not.toHaveBeenCalled();
  });
});

describe("syncSaleDmReaction: 所有者集合の再検証(#366 R2)", () => {
  it("ロック後の再読取で所有者が変わっていたら中止(SyncOwnerSetChangedError)・書かない", async () => {
    // 先読み: own-1+own-2 をロック → ロック後: 名寄せで own-9 へ付け替え済み
    const before = [logRow()];
    const after = [logRow({ ownerId: "own-9", logOwners: [] })];
    let call = 0;
    const tx = {
      dmRecipientDraft: {
        findUnique: vi.fn(async () =>
          draftRow({ deliveryStatus: "returned_undeliverable", returnedAt: T_RET }),
        ),
      },
      propertyDmLog: {
        findMany: vi.fn(async () => (call++ === 0 ? before : after)),
        update: vi.fn(async (args: unknown) => {
          void args;
          return {};
        }),
      },
      $queryRaw: vi.fn(async () => []),
    } as unknown as ReactionSyncTx & {
      propertyDmLog: { update: ReturnType<typeof vi.fn> };
    };
    await expect(syncSaleDmReaction(tx, "d1")).rejects.toBeInstanceOf(
      SyncOwnerSetChangedError,
    );
    expect(tx.propertyDmLog.update).not.toHaveBeenCalled();
  });
});
