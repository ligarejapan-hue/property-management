/**
 * 謄本 一括取得(PR-B・薄い版)の1件処理。
 *
 * 画面が process-next を直列に叩くたびに、この関数が **pending 項目を1件だけ原子的に掴み**、
 * 既存の単発取得(search → 候補解決 → runRegistryAutoFetch)を呼んで結果を項目へ確定する。
 *
 * ⚠課金の安全は単発から継承する(二重課金ガード=AuditLog・charged_but_failed・添付必須)。
 *   薄い版はここに独自の課金台帳・ロックトークン・口座ブレーカーを持たない(=設計の厚い版の見送り分)。
 *   万一同じ項目を再処理しても、単発側の30日ガードが REGISTRY_PURCHASE_ALREADY_DONE(=done扱い)を
 *   返すため二重課金にはならない。これが薄い版が安全な核心。
 *
 * ⚠掴みは `registry_fetch_jobs.active_item_id` の CAS(activeItemId が null の時だけ掴める)で直列化する。
 *   provider 呼び出しの最中はプロセスが1件だけを保持する。クラッシュ時は activeItemId が残って
 *   項目が processing のまま止まる=**自動再処理はしない**(課金済みかもしれない項目を勝手に再取得しない)。
 *   利用者は中止して確認する(単発と同じ復旧姿勢)。
 */
import { randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import { ApiError } from "@/lib/api-helpers";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { runRegistrySearch, resolveRegistryCandidate } from "@/lib/registry-fetch/search";
import { runRegistryAutoFetch } from "@/lib/registry-fetch/auto-fetch";
import type { RegistryFetchProvider } from "@/lib/registry-fetch";
import type { RegistryCertificateType } from "@/lib/registry-fetch/types";
import {
  classifyItemError,
  type BulkItemStatus,
  type BulkJobStatus,
  type ItemOutcome,
} from "./types";

interface BulkSession {
  id: string;
  role: string;
}

export interface ProcessNextResult {
  /**
   * この呼び出しで何が起きたか。
   *  processed   … 1件を最後まで処理した(done/failed/skipped/charged_but_failed)
   *  skipped     … 掴んだ項目が可視でない/物件削除で伏せた
   *  rate_limited… まだ順番待ち。項目は pending のまま(画面は間隔を空けて再試行)
   *  drained     … 残り pending なし=ジョブ完了
   *  busy        … 他の process が実行中(activeItemId 保持中)
   *  paused/cancelled … ジョブが停止中
   */
  outcome:
    | "processed"
    | "skipped"
    | "rate_limited"
    | "drained"
    | "busy"
    | "paused"
    | "cancelled";
  jobStatus: BulkJobStatus;
  itemId?: string;
  itemStatus?: BulkItemStatus;
  errorCode?: string | null;
  /** まだ pending 項目が残っているか(画面が次を叩くべきか)。 */
  morePending: boolean;
}

/** ジョブに pending 項目が残っているか。 */
async function hasPending(jobId: string): Promise<boolean> {
  const n = await prisma.registryFetchJobItem.count({
    where: { jobId, status: "pending" },
  });
  return n > 0;
}

/**
 * pending 項目を1件処理する。route が権限(registry:auto_fetch/property:read)と
 * readiness(課金スイッチ+校正=501判定)を通した後に呼ぶ。
 */
export async function processNextBulkItem(args: {
  session: BulkSession;
  jobId: string;
  provider: RegistryFetchProvider;
}): Promise<ProcessNextResult> {
  const { session, jobId, provider } = args;

  // 1) ジョブの事前確認(作成者本人のみ・状態)。
  const job0 = await prisma.registryFetchJob.findUnique({ where: { id: jobId } });
  if (!job0) {
    throw new ApiError(404, "ジョブが見つかりません", "NOT_FOUND");
  }
  if (job0.requestedById !== session.id) {
    throw new ApiError(403, "このジョブを操作する権限がありません", "FORBIDDEN");
  }
  if (job0.status === "cancelled") {
    return { outcome: "cancelled", jobStatus: "cancelled", morePending: false };
  }
  if (job0.status === "paused") {
    return { outcome: "paused", jobStatus: "paused", morePending: await hasPending(jobId) };
  }
  if (job0.status === "completed") {
    return { outcome: "drained", jobStatus: "completed", morePending: false };
  }

  // 2) ジョブロックを CAS で掴む(activeItemId が null の時だけ)。トークンを一旦置く。
  const lockToken = randomUUID();
  const claim = await prisma.registryFetchJob.updateMany({
    where: { id: jobId, activeItemId: null, status: { in: ["pending", "processing"] } },
    data: {
      activeItemId: lockToken,
      status: "processing",
      startedAt: job0.startedAt ?? new Date(),
    },
  });
  if (claim.count === 0) {
    // 他の process が実行中(activeItemId 非null)、または状態が変わった。
    return { outcome: "busy", jobStatus: job0.status as BulkJobStatus, morePending: await hasPending(jobId) };
  }

  try {
    // 3) 次の pending 項目を取る(古い順)。
    const item = await prisma.registryFetchJobItem.findFirst({
      where: { jobId, status: "pending" },
      orderBy: { createdAt: "asc" },
      include: {
        property: {
          select: {
            id: true,
            createdBy: true,
            assignedTo: true,
          },
        },
      },
    });

    if (!item) {
      // 残り pending なし → ジョブ完了。ロック解除。
      await prisma.registryFetchJob.update({
        where: { id: jobId },
        data: { activeItemId: null, status: "completed", completedAt: new Date() },
      });
      return { outcome: "drained", jobStatus: "completed", morePending: false };
    }

    // 3b) 物件が削除された/担当替えで見えなくなった → 伏せて skipped(次へ)。
    if (!item.property || !canAccessPropertyRecord(session, item.property)) {
      await prisma.$transaction([
        prisma.registryFetchJobItem.update({
          where: { id: item.id },
          data: { status: "skipped", errorCode: "property_unavailable", processedAt: new Date() },
        }),
        prisma.registryFetchJob.update({
          where: { id: jobId },
          data: { activeItemId: null },
        }),
      ]);
      return {
        outcome: "skipped",
        jobStatus: "processing",
        itemId: item.id,
        itemStatus: "skipped",
        errorCode: "property_unavailable",
        morePending: await hasPending(jobId),
      };
    }

    // 4) 項目を processing にし、activeItemId をトークン→実item.idへ差し替える。
    const propertyId = item.property.id;
    await prisma.$transaction([
      prisma.registryFetchJobItem.update({
        where: { id: item.id },
        data: { status: "processing", startedAt: new Date() },
      }),
      prisma.registryFetchJob.update({
        where: { id: jobId },
        data: { activeItemId: item.id },
      }),
    ]);

    // 5) 実処理: 検索 → 候補の自動選択 → 候補解決 → 単発取得。
    const certificateType = job0.certificateType as RegistryCertificateType;
    let outcome: ItemOutcome;
    let attachmentId: string | null = null;

    try {
      const search = (await runRegistrySearch(
        { session, propertyId, confirmed: true },
        provider,
      )) as
        | { searchable: false; reason: string }
        | {
            searchable: true;
            candidates: Array<{ candidateRef: string; [k: string]: unknown }>;
          };

      if (search.searchable === false) {
        // 番号あり/所在不足(作成後に物件が変わった等)= 要手動 skipped。
        outcome = { status: "skipped", errorCode: search.reason, pauseJob: false, leavePending: false, cancelled: false };
      } else {
        const candidates = search.candidates ?? [];
        if (candidates.length === 0) {
          outcome = { status: "skipped", errorCode: "no_candidate", pauseJob: false, leavePending: false, cancelled: false };
        } else if (candidates.length > 1) {
          // ⚠候補が複数=どれを買うか自動で決めない(要手動)。勝手に1つ選んで課金しない。
          outcome = { status: "skipped", errorCode: "ambiguous_candidate", pauseJob: false, leavePending: false, cancelled: false };
        } else {
          const ref = String(candidates[0].candidateRef ?? "").trim();
          const { candidate, fingerprint } = await resolveRegistryCandidate({
            session,
            propertyId,
            confirmed: true,
            candidateRef: ref,
          });
          const result = await runRegistryAutoFetch(
            {
              session,
              propertyId,
              confirmed: true,
              ...(candidate.kind === "number"
                ? { realEstateNumber: candidate.realEstateNumber }
                : {
                    locationCandidate: {
                      lotNumber: candidate.lotNumber,
                      buildingNumber: candidate.buildingNumber,
                    },
                    certificateType,
                  }),
              expectedFingerprint: fingerprint,
            },
            provider,
          );
          attachmentId =
            typeof result.attachmentId === "string" ? result.attachmentId : null;
          outcome = { status: "done", errorCode: null, pauseJob: false, leavePending: false, cancelled: false };
        }
      }
    } catch (err) {
      outcome = classifyItemError(err);
    }

    // 6) 結果を確定する(項目更新 + ロック解除 + ジョブ状態)。
    const jobStatus = await finalizeItem({
      jobId,
      itemId: item.id,
      outcome,
      attachmentId,
    });

    if (outcome.leavePending) {
      // rate_limited / cancelled: 項目は pending のまま。
      return {
        outcome: outcome.cancelled ? "cancelled" : "rate_limited",
        jobStatus,
        itemId: item.id,
        errorCode: outcome.errorCode,
        morePending: outcome.cancelled ? false : true,
      };
    }
    return {
      outcome: "processed",
      jobStatus,
      itemId: item.id,
      itemStatus: outcome.status,
      errorCode: outcome.errorCode,
      morePending: await hasPending(jobId),
    };
  } catch (err) {
    // 想定外の失敗(掴んだ後・実処理の外)。ロックだけは必ず外す(項目は processing のまま=
    // 次回は掴まれないので、利用者が中止 or 手当てする。課金前の可能性が高い経路)。
    await prisma.registryFetchJob
      .update({ where: { id: jobId }, data: { activeItemId: null } })
      .catch(() => {});
    throw err;
  }
}

/**
 * 1件の結果を確定する。項目 status を書き、ロック(activeItemId)を外し、ジョブ状態を決める。
 * ⚠課金済み失敗(pauseJob)は paused。中止済みジョブは cancelled のまま(課金済み項目の記録は残す)。
 * 件数の集計はここでは触らない(進捗は項目から都度再計算する=保存 counts は情報用)。
 */
async function finalizeItem(args: {
  jobId: string;
  itemId: string;
  outcome: ItemOutcome;
  attachmentId: string | null;
}): Promise<BulkJobStatus> {
  const { jobId, itemId, outcome, attachmentId } = args;

  return prisma.$transaction(async (tx) => {
    const jobNow = await tx.registryFetchJob.findUnique({ where: { id: jobId } });

    if (outcome.leavePending) {
      // まだ順番待ち/中止=処理していない。⚠掴んだ時に processing にしたので、
      // **pending へ戻す**(戻さないと processing のまま取り残され、二度と再試行されない)。
      await tx.registryFetchJobItem.update({
        where: { id: itemId },
        data: { status: "pending", startedAt: null, errorCode: outcome.errorCode },
      });
    } else {
      await tx.registryFetchJobItem.update({
        where: { id: itemId },
        data: {
          status: outcome.status,
          errorCode: outcome.errorCode,
          attachmentId,
          processedAt: new Date(),
        },
      });
    }

    // ジョブ状態の決定: 中止済みは維持 / 課金済み失敗は paused / それ以外は processing 継続。
    let nextStatus: BulkJobStatus = "processing";
    let pausedReason: string | null = null;
    if (jobNow?.status === "cancelled") {
      nextStatus = "cancelled";
    } else if (outcome.pauseJob) {
      nextStatus = "paused";
      pausedReason = outcome.errorCode;
    }

    await tx.registryFetchJob.update({
      where: { id: jobId },
      data: { activeItemId: null, status: nextStatus, pausedReason },
    });
    return nextStatus;
  });
}
