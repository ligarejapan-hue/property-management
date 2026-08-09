import { Prisma } from "@/generated/prisma";
import { lockOwnersForUpdate, type RawTx } from "@/lib/dm-batch/locks";
import { applySyncReaction, jstCalendarDay, type ReactionFields } from "./core";

// 売却DMの draft 現在値からブリッジ行(draft_id 一致の全 PropertyDmLog)へ反響を同期する
// (設計§3・PR-B)。導出: returned_undeliverable→undeliverable / outcome=inquiry(LP・電話)→replied /
// どちらでもない→cleared。適用の優先規則・shadow ライフサイクルは core.applySyncReaction が担う。
//
// 【呼び出し規約】tx 内から呼ぶ。呼び出し元は親の物件行ロックを取得済みであること。
// terminal(undeliverable)を書き得る経路(outcome route・手動反響 PATCH)は、呼び出し元が
// 対象所有者集合を親行より先に FOR UPDATE していること(R47: Owner→親→子)。本関数内の
// lockOwnersForUpdate は取得済みロックの再取得(同一 tx では無害)=安全網であり、順序の
// 正しさは呼び出し元の構成で担保する。公開LP追跡のホットパスは allowTerminal:false で
// terminal 書込ごと回避する(Owner ロック不要を保証)。

type SyncDraftRow = {
  deliveryStatus: string | null;
  outcome: string | null;
  lpFirstAccessAt: Date | null;
  phoneInquiryAt: Date | null;
  returnedAt: Date | null;
  // 旧sale_dm行フォールバック(同一物件+JST暦日)の対応付けに使う(@codex #366 R1)
  propertyId?: string | null;
  sentAt?: Date | null;
};

type SyncLogRow = ReactionFields & {
  id: string;
  ownerId: string | null;
  logOwners: Array<{ ownerId: string }>;
};

export type ReactionSyncTx = RawTx & {
  dmRecipientDraft: {
    findUnique: (args: unknown) => Promise<SyncDraftRow | null>;
  };
  propertyDmLog: {
    findMany: (args: unknown) => Promise<SyncLogRow[]>;
    update: (args: unknown) => Promise<unknown>;
  };
};

export type SaleDmReactionEvent = {
  kind: "replied" | "undeliverable" | "cleared";
  at: Date;
};

/** draft の現在値から同期イベントを導出する(純関数)。 */
export function deriveSaleDmReactionEvent(
  draft: SyncDraftRow,
  fallbackAt: Date,
): SaleDmReactionEvent {
  if (draft.deliveryStatus === "returned_undeliverable") {
    return { kind: "undeliverable", at: draft.returnedAt ?? fallbackAt };
  }
  if (draft.outcome === "inquiry") {
    const times = [draft.lpFirstAccessAt, draft.phoneInquiryAt]
      .filter((d): d is Date => d != null)
      .map((d) => d.getTime());
    return {
      kind: "replied",
      at: times.length > 0 ? new Date(Math.min(...times)) : fallbackAt,
    };
  }
  return { kind: "cleared", at: fallbackAt };
}

function shadowToDb(
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null || value === undefined
    ? Prisma.DbNull
    : (value as Prisma.InputJsonValue);
}

export async function syncSaleDmReaction(
  tx: ReactionSyncTx,
  draftId: string,
  opts: { allowTerminal?: boolean } = {},
): Promise<void> {
  const allowTerminal = opts.allowTerminal !== false;
  const draft = await tx.dmRecipientDraft.findUnique({
    where: { id: draftId },
    select: {
      deliveryStatus: true,
      outcome: true,
      lpFirstAccessAt: true,
      phoneInquiryAt: true,
      returnedAt: true,
      propertyId: true,
      sentAt: true,
    },
  });
  // draft が消えていたらブリッジ行はそのまま残す(履歴は独立に保つ)。
  if (!draft) return;

  const event = deriveSaleDmReactionEvent(draft, new Date());
  // ホットパス(公開LP追跡)は terminal を書かない=Owner ロック不要を保証。
  // draft が返送済みのときの追跡ヒットは、outcome route 側の同期が既に undeliverable を
  // 書いているため取りこぼしにならない。
  if (event.kind === "undeliverable" && !allowTerminal) return;

  const REACTION_SELECT = {
    id: true,
    ownerId: true,
    reactionStatus: true,
    reactedAt: true,
    reactionNote: true,
    reactionSource: true,
    manualReactionShadow: true,
    logOwners: { select: { ownerId: true } },
  };

  const readLogs = () =>
    tx.propertyDmLog.findMany({
      where: { draftId },
      select: REACTION_SELECT,
    });

  // 旧sale_dm行(draft_idなし)への保守的フォールバック(@codex #366 R1 P1): 照合で曖昧の
  // まま残った旧行にも、稼働後の返戻・LP反響を同一物件+同一JST暦日で反映する。どのdraftの
  // 証拠か確定しないため cleared は適用せず、undeliverable を replied で弱めない(格下げなし)。
  // 旧行は所有者連関を持たない(R33/R34: 補完しない)ため、terminal のロック集合は増えない。
  const legacyDay = draft.sentAt ? jstCalendarDay(draft.sentAt) : null;
  const readLegacyLogs = () =>
    event.kind === "cleared" || legacyDay == null || !draft.propertyId
      ? Promise.resolve([] as Awaited<ReturnType<typeof readLogs>>)
      : tx.propertyDmLog.findMany({
          where: {
            method: "sale_dm",
            draftId: null,
            propertyId: draft.propertyId,
            sentAt: new Date(`${legacyDay}T00:00:00Z`),
          },
          select: REACTION_SELECT,
        });

  const collectChanged = (
    bridged: SyncLogRow[],
    legacyRows: SyncLogRow[],
  ): SyncLogRow[] => [
    // applySyncReaction は変化なしのとき同一参照を返す=書込対象の判定に使える。
    ...bridged.filter((log) => applySyncReaction(log, event) !== log),
    ...legacyRows.filter(
      (log) =>
        !(event.kind === "replied" && log.reactionStatus === "undeliverable") &&
        applySyncReaction(log, event) !== log,
    ),
  ];

  let logs = await readLogs();
  let legacyLogs = await readLegacyLogs();
  let changed = collectChanged(logs, legacyLogs);
  if (changed.length === 0) return;

  if (event.kind === "undeliverable") {
    // terminal 書込は Owner 先頭 FOR UPDATE(R47)。上記の呼び出し規約どおり通常は
    // 取得済みロックの再取得=無害。ロック後に再読取して最新値へ適用し直す。
    const ownerIds = [...logs, ...legacyLogs].flatMap((l) => [
      ...(l.ownerId ? [l.ownerId] : []),
      ...l.logOwners.map((o) => o.ownerId),
    ]);
    await lockOwnersForUpdate(tx, ownerIds);
    logs = await readLogs();
    legacyLogs = await readLegacyLogs();
    changed = collectChanged(logs, legacyLogs);
  }

  for (const log of changed) {
    const next = applySyncReaction(log, event);
    await tx.propertyDmLog.update({
      where: { id: log.id },
      data: {
        reactionStatus: next.reactionStatus,
        reactedAt: next.reactedAt,
        reactionNote: next.reactionNote,
        reactionSource: next.reactionSource,
        manualReactionShadow: shadowToDb(next.manualReactionShadow),
      },
    });
  }
}
