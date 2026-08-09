import { Prisma } from "@/generated/prisma";
// ⚠property-record-guard(lockPropertyRow)は使わない: api-helpers 経由で next-auth を
// 引き込み、one-shot スクリプト(tsx)から import できなくなる。親行ロックは依存なしの
// locks.ts(lockPropertiesForUpdate=同じ FOR UPDATE 文)で取る。
import {
  lockOwnersForUpdate,
  lockPropertiesForUpdate,
  type RawTx,
} from "@/lib/dm-batch/locks";
import { applySyncReaction, jstCalendarDay, type ReactionFields } from "./core";
import {
  deriveSaleDmReactionEvent,
  syncSaleDmReaction,
  type ReactionSyncTx,
  type SaleDmReactionEvent,
} from "./sync";

// 旧 sale_dm 行(draft_id なし)の反響照合(設計§3・冪等・稼働後に1回実行)。
// - 対応付け: propertyId+JST暦日。log.sentAt は @db.Date(UTC00:00=JST暦日)、
//   draft.sentAt は実時刻→+9h で JST 暦日に落として比較する(深夜0-9時の境界=R37)。
// - 一意なら draft_id を書き込んで永続化(R16)し、以後は通常のブリッジ同期に乗る。
// - 曖昧(同日複数)は「反響あり側に倒す」= inquiry/returned_undeliverable が1つでも
//   あれば保守的に付与(格下げ・消去はしない=R4)。証拠なしは触らない。
// - 手動反響 PATCH の旧行フォールバックは単一行版(reconcileLegacySaleDmLog)を共用する。

// JST 暦日ヘルパーは core へ移動(sync の旧行フォールバックと共用・循環import回避)。
// 既存の import 互換のためここから再exportする。
export { JST_OFFSET_MS, jstCalendarDay } from "./core";

export interface LegacyCandidateDraft {
  id: string;
  sentAt: Date | null;
  deliveryStatus: string | null;
  outcome: string | null;
  lpFirstAccessAt: Date | null;
  phoneInquiryAt: Date | null;
  returnedAt: Date | null;
}

export type LegacyLinkDecision =
  | { kind: "linked"; draftId: string }
  | { kind: "conservative"; event: SaleDmReactionEvent }
  | {
      kind: "skipped";
      reason: "no_property" | "no_candidate" | "ambiguous_no_evidence";
    };

/** 旧 sale_dm 行と同一物件の sent drafts から対応付けを決める純関数。 */
export function decideLegacyLink(
  log: { propertyId: string | null; sentAt: Date },
  drafts: LegacyCandidateDraft[],
  now: Date,
): LegacyLinkDecision {
  if (!log.propertyId) return { kind: "skipped", reason: "no_property" };
  const day = log.sentAt.toISOString().slice(0, 10);
  const sameDay = drafts.filter(
    (d) => d.sentAt != null && jstCalendarDay(d.sentAt) === day,
  );
  if (sameDay.length === 0) return { kind: "skipped", reason: "no_candidate" };
  if (sameDay.length === 1) {
    return { kind: "linked", draftId: sameDay[0].id };
  }
  // 曖昧(同日複数): 証拠(返戻・反響)のある draft から最も早い事象を保守的に採用。
  // 返戻(undeliverable)は inquiry(replied)より優先(導出の優先と同じ)。
  const events = sameDay
    .map((d) => deriveSaleDmReactionEvent(d, now))
    .filter((e) => e.kind !== "cleared");
  if (events.length === 0) {
    return { kind: "skipped", reason: "ambiguous_no_evidence" };
  }
  const undeliverable = events.filter((e) => e.kind === "undeliverable");
  const pool = undeliverable.length > 0 ? undeliverable : events;
  const chosen = pool.reduce((a, b) => (a.at.getTime() <= b.at.getTime() ? a : b));
  return { kind: "conservative", event: chosen };
}

const REACTION_SELECT = {
  id: true,
  ownerId: true,
  reactionStatus: true,
  reactedAt: true,
  reactionNote: true,
  reactionSource: true,
  manualReactionShadow: true,
  logOwners: { select: { ownerId: true } },
} as const;

export type LegacyReconcileTx = ReactionSyncTx & {
  dmRecipientDraft: ReactionSyncTx["dmRecipientDraft"] & {
    findMany: (args: unknown) => Promise<LegacyCandidateDraft[]>;
  };
};

/**
 * 旧 sale_dm 行1件の対応付け+反響適用。tx 内から呼ぶ。
 * 【呼び出し規約】terminal を書き得るため、呼び出し元は対象所有者集合を親行より先に
 * FOR UPDATE していること(R47。手動反響 PATCH は method="sale_dm" 行で Owner を先にロックする)。
 */
export async function reconcileLegacySaleDmLog(
  tx: LegacyReconcileTx,
  log: { id: string; propertyId: string | null; sentAt: Date },
  now: Date = new Date(),
): Promise<void> {
  if (!log.propertyId) return;
  const drafts = await tx.dmRecipientDraft.findMany({
    where: { propertyId: log.propertyId, status: "sent" },
    select: {
      id: true,
      sentAt: true,
      deliveryStatus: true,
      outcome: true,
      lpFirstAccessAt: true,
      phoneInquiryAt: true,
      returnedAt: true,
    },
  });
  const decision = decideLegacyLink(log, drafts, now);
  if (decision.kind === "linked") {
    await tx.propertyDmLog.update({
      where: { id: log.id },
      data: { draftId: decision.draftId },
    });
    await syncSaleDmReaction(tx, decision.draftId);
    return;
  }
  if (decision.kind === "conservative") {
    // 現在値へ適用(冪等: 変化なしなら書かない)。draft_id は書かない(どの draft か確定しない)。
    const rows = await tx.propertyDmLog.findMany({
      where: { id: log.id },
      select: REACTION_SELECT,
    });
    const current = rows[0] as (ReactionFields & { id: string }) | undefined;
    if (!current) return;
    const next = applySyncReaction(current, decision.event);
    if (next === current) return;
    await tx.propertyDmLog.update({
      where: { id: log.id },
      data: {
        reactionStatus: next.reactionStatus,
        reactedAt: next.reactedAt,
        reactionNote: next.reactionNote,
        reactionSource: next.reactionSource,
        manualReactionShadow:
          next.manualReactionShadow == null
            ? Prisma.DbNull
            : (next.manualReactionShadow as Prisma.InputJsonValue),
      },
    });
  }
}

export interface ReconcileCounts {
  scanned: number;
  /** draft_id 既存(ブリッジ済み)行を同期した数 */
  matched: number;
  /** draft_id を新たに永続化した数(R16) */
  linked: number;
  /** 曖昧・証拠ありで保守的に付与した数 */
  ambiguousConservative: number;
  /** 対応付け不能(物件なし・候補ゼロ・証拠なし曖昧) */
  skipped: number;
}

type ReconcileScanRow = ReactionFields & {
  id: string;
  propertyId: string | null;
  sentAt: Date;
  draftId: string | null;
  ownerId: string | null;
  logOwners: Array<{ ownerId: string }>;
};

export type ReconcileClientLike = {
  propertyDmLog: {
    findMany: (args: unknown) => Promise<ReconcileScanRow[]>;
  };
  dmRecipientDraft: {
    findMany: (
      args: unknown,
    ) => Promise<Array<LegacyCandidateDraft & { propertyId: string }>>;
  };
  $transaction: (fn: (tx: unknown) => Promise<void>) => Promise<void>;
};

/**
 * 全 sale_dm 行の照合(冪等・再実行可)。本番反映後に scripts/reconcile-sale-dm-reactions.ts
 * から1回実行する。書込は行ごとの tx で「Owner FOR UPDATE→物件親行→子行」(R47)。
 */
export async function reconcileSaleDmReactions(
  client: ReconcileClientLike,
  opts: { dryRun?: boolean; now?: Date } = {},
): Promise<ReconcileCounts> {
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? new Date();

  const logs = await client.propertyDmLog.findMany({
    where: { method: "sale_dm" },
    select: {
      ...REACTION_SELECT,
      propertyId: true,
      sentAt: true,
      draftId: true,
    },
  });

  // 旧行の候補 drafts を物件ごとにまとめて先読み(判定用。書込時は tx 内で読み直す)。
  const legacyPropertyIds = [
    ...new Set(
      logs
        .filter((l) => l.draftId == null && l.propertyId != null)
        .map((l) => l.propertyId as string),
    ),
  ];
  const draftsByProperty = new Map<
    string,
    Array<LegacyCandidateDraft & { propertyId: string }>
  >();
  if (legacyPropertyIds.length > 0) {
    const drafts = await client.dmRecipientDraft.findMany({
      where: { propertyId: { in: legacyPropertyIds }, status: "sent" },
      select: {
        id: true,
        propertyId: true,
        sentAt: true,
        deliveryStatus: true,
        outcome: true,
        lpFirstAccessAt: true,
        phoneInquiryAt: true,
        returnedAt: true,
      },
    });
    for (const d of drafts) {
      const list = draftsByProperty.get(d.propertyId) ?? [];
      list.push(d);
      draftsByProperty.set(d.propertyId, list);
    }
  }

  const counts: ReconcileCounts = {
    scanned: logs.length,
    matched: 0,
    linked: 0,
    ambiguousConservative: 0,
    skipped: 0,
  };

  for (const log of logs) {
    const ownerIds = [
      ...(log.ownerId ? [log.ownerId] : []),
      ...log.logOwners.map((o) => o.ownerId),
    ];

    if (log.draftId != null) {
      counts.matched += 1;
      if (!dryRun) {
        await client.$transaction(async (txRaw) => {
          const tx = txRaw as LegacyReconcileTx;
          await lockOwnersForUpdate(tx as RawTx, ownerIds);
          if (log.propertyId) {
            await lockPropertiesForUpdate(tx as RawTx, [log.propertyId]);
          }
          await syncSaleDmReaction(tx, log.draftId as string);
        });
      }
      continue;
    }

    const decision = decideLegacyLink(
      log,
      log.propertyId ? (draftsByProperty.get(log.propertyId) ?? []) : [],
      now,
    );
    if (decision.kind === "skipped") {
      counts.skipped += 1;
      continue;
    }
    if (decision.kind === "linked") counts.linked += 1;
    else counts.ambiguousConservative += 1;
    if (dryRun) continue;

    await client.$transaction(async (txRaw) => {
      const tx = txRaw as LegacyReconcileTx;
      await lockOwnersForUpdate(tx as RawTx, ownerIds);
      if (log.propertyId) {
        await lockPropertiesForUpdate(tx as RawTx, [log.propertyId]);
      }
      // tx 内で drafts を読み直して決定し直す(先読みとの差は稀だが、判定と書込を同一 tx に閉じる)
      await reconcileLegacySaleDmLog(tx, log, now);
    });
  }

  return counts;
}
