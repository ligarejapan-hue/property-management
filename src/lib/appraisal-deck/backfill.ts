/**
 * 反映前に添付した査定報告書から、「査定のご報告」の下書きを一括で作る(2026-11-11 発注者指示)。
 * 対象は source.ts の査定報告書(受け取り箱の type=report と、直接付けた種類「査定書・査定報告書」)。
 * 実体は buildAppraisalDraft(添付時と同じ処理)。1本ずつ順に読む(大きい PDF を同時に読まない)。
 * - dry-run(既定)は件数だけ数える(書き込まない・PDF も読まない)
 * - 既に下書きがある報告書・削除済みの添付は対象にしない(何度流しても同じ下書きを2つ作らない)
 * ⚠出すのは件数と添付の id だけ(所在地・数字・ファイルの場所は出さない)。
 */
import { appraisalSourceWhere } from "./source";
import type { AppraisalDraftResult } from "./create-draft";

export interface BackfillDeps {
  /** 物件に付いた査定報告書(削除されていない)。 */
  listReports: () => Promise<Array<{ id: string; targetId: string; uploadedBy: string }>>;
  /** 既に下書きがある報告書の id。 */
  listDeckSources: () => Promise<string[]>;
  build: (input: { attachmentId: string; propertyId: string; userId: string }) => Promise<AppraisalDraftResult>;
}

export interface BackfillReport {
  targets: number;
  created: number;
  existing: number;
  failed: Record<string, string[]>;
}

export async function backfillAppraisalDrafts(deps: BackfillDeps, opts: { apply: boolean }): Promise<BackfillReport> {
  const [reports, sources] = await Promise.all([deps.listReports(), deps.listDeckSources()]);
  const done = new Set(sources);
  const targets = reports.filter((r) => !done.has(r.id));
  const out: BackfillReport = { targets: targets.length, created: 0, existing: 0, failed: {} };
  if (!opts.apply) return out;
  for (const r of targets) {
    let res: AppraisalDraftResult;
    try {
      res = await deps.build({ attachmentId: r.id, propertyId: r.targetId, userId: r.uploadedBy });
    } catch {
      res = { ok: false, reason: "read_failed" };
    }
    if (res.ok) {
      if (res.created) out.created++;
      else out.existing++;
    } else {
      (out.failed[res.reason] ??= []).push(r.id);
    }
  }
  return out;
}

/** 本番の DB に向けた deps(scripts/appraisal-deck-backfill.ts から使う)。 */
export async function prismaBackfillDeps(): Promise<BackfillDeps> {
  const { default: prisma } = await import("@/lib/prisma");
  const { buildAppraisalDraft } = await import("./create-draft");
  return {
    listReports: () =>
      prisma.attachment.findMany({
        where: { targetType: "property", isDeleted: false, ...appraisalSourceWhere },
        select: { id: true, targetId: true, uploadedBy: true },
        orderBy: { createdAt: "asc" },
      }),
    listDeckSources: async () =>
      (
        await prisma.appraisalDeck.findMany({
          where: { sourceAttachmentId: { not: null } },
          select: { sourceAttachmentId: true },
        })
      ).map((d) => d.sourceAttachmentId as string),
    build: (input) => buildAppraisalDraft(input),
  };
}
