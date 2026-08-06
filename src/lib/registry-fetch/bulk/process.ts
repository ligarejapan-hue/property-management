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
 * pending 項目を1件処理する。route が権限(registry:auto_fetch/property:read)を通した後に呼ぶ。
 *
 * ⚠**provider(有料 readiness)は「処理する item がある」と確定してから解決する**
 * (@codex #361 P2)。最後の項目の後の drain 呼び出しは provider を使わないので、課金スイッチが
 * その間に切られても drained→completed に確定できる(そうでないと 100% のまま止まる)。
 * resolveProvider が 501 を投げたら未処理のまま(item は掴まず)伝播する。
 */
export async function processNextBulkItem(args: {
  session: BulkSession;
  jobId: string;
  resolveProvider: () => Promise<RegistryFetchProvider>;
}): Promise<ProcessNextResult> {
  const { session, jobId, resolveProvider } = args;

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

  // fail-closed 判定用の局面フラグ(掴んだ item / provider 取得に入ったか)。
  let claimedItemId: string | null = null;
  let providerAttempted = false;

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
      // 残り pending なし → ジョブ完了。⚠**completed で cancelled を上書きしない**
      // (@codex #361 P2)。掴んだ後・findFirst 判定中に別タブが cancel した場合、
      // 無条件更新だと中止を completed に潰す。条件付き(status not cancelled)で立てる。
      await prisma.registryFetchJob.update({
        where: { id: jobId },
        data: { activeItemId: null },
      });
      await prisma.registryFetchJob.updateMany({
        where: { id: jobId, status: { not: "cancelled" } },
        data: { status: "completed", completedAt: new Date() },
      });
      const after = await prisma.registryFetchJob.findUnique({
        where: { id: jobId },
        select: { status: true },
      });
      return {
        outcome: "drained",
        jobStatus: (after?.status ?? "completed") as BulkJobStatus,
        morePending: false,
      };
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

    // 処理する item が確定したので、ここで初めて有料 readiness を解決する(drain は不要)。
    // 未 readiness なら 501 が投げられ、item は掴まないまま外側 catch がロックを外す。
    const provider = await resolveProvider();

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
    claimedItemId = item.id;

    // 5) 実処理: 検索 → 候補の自動選択 → 候補解決 → 単発取得。
    const certificateType = job0.certificateType as RegistryCertificateType;
    let outcome: ItemOutcome;
    let attachmentId: string | null = null;

    // ⚠これ以降は provider に到達し得る=課金が起き得る。finalize 失敗時に fail-closed にする。
    providerAttempted = true;
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
              // ⚠種別は**どちらの候補でも渡す**(@codex #361 P2)。number 候補で省くと
              // runRegistryAutoFetch が owner を既定にし、all を確認したのに owner 反映/
              // ラベルになる。処理・添付ラベルはジョブの種別に一致させる。
              certificateType,
              ...(candidate.kind === "number"
                ? { realEstateNumber: candidate.realEstateNumber }
                : {
                    locationCandidate: {
                      lotNumber: candidate.lotNumber,
                      buildingNumber: candidate.buildingNumber,
                    },
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
      // ⚠分類は classifyItemError に一本化(@codex #361 P1)。単発は RegistryFetchError を
      // ApiError に包んで投げるため、providerCode を見て charged_but_failed→paused /
      // rate_limited→pending を正しく拾う。既取得(ALREADY_DONE)は skipped(要確認)。
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
      // 項目は pending のまま。ジョブが paused に落ちた(口座/サービス全体の失敗)なら
      // それを表に出す(画面は待たずに停止する)。それ以外は rate_limited / cancelled。
      const leaveOutcome: ProcessNextResult["outcome"] =
        jobStatus === "paused" ? "paused" : outcome.cancelled ? "cancelled" : "rate_limited";
      return {
        outcome: leaveOutcome,
        jobStatus,
        itemId: item.id,
        errorCode: outcome.errorCode,
        morePending: leaveOutcome === "cancelled" ? false : true,
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
    // ⚠掴んだ後の想定外失敗(finalizeItem の commit 失敗など)。**fail-closed**にする
    // (@codex #361 P1)。ここでロックだけ外して継続可能にすると、provider 取得を跨いだ
    // (課金済みかもしれない)失敗が pause として表に出ず、進捗画面の再開が次の有料項目を
    // 掴む/完了扱いにして追加課金し得る。
    await failClosed(jobId, claimedItemId, providerAttempted);
    throw err;
  }
}

/**
 * 掴んだ後の失敗を fail-closed で締める。
 *  - provider に到達し得た(providerAttempted): 課金済みかもしれない=最悪を仮定し、項目を
 *    charged_but_failed に倒し、ジョブを **paused**(cancelled は尊重)。以降の課金を止める。
 *  - まだ provider 未到達: 課金なし=項目を pending へ戻し、ロックだけ外して継続可能にする。
 *  - ⚠DB 書き込みも不能なら activeItemId を**外さない**(=ロックしたまま=これ以上掴めない)。
 */
async function failClosed(
  jobId: string,
  claimedItemId: string | null,
  providerAttempted: boolean,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      if (claimedItemId && providerAttempted) {
        await tx.registryFetchJobItem.updateMany({
          where: { id: claimedItemId, status: "processing" },
          data: { status: "charged_but_failed", errorCode: "finalize_failed", processedAt: new Date() },
        });
        await tx.registryFetchJob.updateMany({
          where: { id: jobId, status: { not: "cancelled" } },
          data: { status: "paused", pausedReason: "finalize_failed", activeItemId: null },
        });
      } else {
        if (claimedItemId) {
          await tx.registryFetchJobItem.updateMany({
            where: { id: claimedItemId, status: "processing" },
            data: { status: "pending", startedAt: null },
          });
        }
        await tx.registryFetchJob.update({
          where: { id: jobId },
          data: { activeItemId: null },
        });
      }
    });
  } catch {
    // ここも失敗 → activeItemId を外さずロックしたまま止める(fail-closed)。
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

    // ⚠**ジョブ status を "processing" で上書きしない**(@codex #361 P1)。掴みで既に
    // processing にしてあるので、ここで書き直すと、別タブが finalize 中に走らせた中止
    // (cancelled)を**上書きして復活**させ、実行中タブが次の項目へ進んで追加課金し得る。
    // ロック(activeItemId)は常に外す(status とは別フィールドで安全)。
    await tx.registryFetchJob.update({
      where: { id: jobId },
      data: { activeItemId: null },
    });
    // 課金済み失敗のときだけ paused へ。⚠**cancelled は絶対に上書きしない**(条件付き更新)。
    if (outcome.pauseJob) {
      await tx.registryFetchJob.updateMany({
        where: { id: jobId, status: { not: "cancelled" } },
        data: { status: "paused", pausedReason: outcome.errorCode },
      });
    }
    // 実効 status を読み直して返す(中止/一時停止/継続のいずれか)。
    const after = await tx.registryFetchJob.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    return (after?.status ?? "processing") as BulkJobStatus;
  });
}
