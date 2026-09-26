import prisma from "@/lib/prisma";
import { getUserPermissions } from "@/lib/api-helpers";
import { buildPropertyIndex } from "./match";
import { processRegistryPdfBulkRow } from "./process-row";
import {
  REGISTRY_OWNER_APPLY_JOB_TYPE,
  isRegistryOwnerApplyRow,
} from "@/lib/registry-owner-bulk/marker";
import { findMissingRegistryOwnerApplyPerm } from "@/lib/registry-owner-bulk/permissions";
import { processRegistryOwnerApplyRow } from "@/lib/registry-owner-bulk/process-row";

/**
 * 所有者事項PDF一括取込のインプロセス直列ワーカー。
 *
 * - 単一プロセス(systemd 1サービス)運用前提。render-gate と同じ思想で
 *   「同時に走る処理は常に1つ」に固定し、サーバ負荷を平準化する。
 * - 待機列は jobId の FIFO。行の処理状態は都度DBに永続化されるため、
 *   プロセス再起動で待機列が消えても「再開」(resume route)で復旧できる。
 * - HMR(next dev)でモジュールが再評価されても待機列を失わないよう、
 *   prisma.ts と同じ globalThis singleton イディオムを使う。
 */

interface WorkerState {
  queue: string[];
  running: boolean;
}

const globalForWorker = globalThis as unknown as {
  __registryPdfBulkWorker?: WorkerState;
};

function state(): WorkerState {
  if (!globalForWorker.__registryPdfBulkWorker) {
    globalForWorker.__registryPdfBulkWorker = { queue: [], running: false };
  }
  return globalForWorker.__registryPdfBulkWorker;
}

export function enqueueRegistryPdfBulkJob(jobId: string): void {
  const s = state();
  if (!s.queue.includes(jobId)) {
    s.queue.push(jobId);
  }
  if (!s.running) {
    s.running = true;
    // fire-and-forget: route ハンドラは 202 を即返す。
    void runLoop();
  }
}

export function isRegistryPdfBulkWorkerBusy(): boolean {
  const s = state();
  return s.running || s.queue.length > 0;
}

export function __resetRegistryPdfBulkWorkerForTest(): void {
  globalForWorker.__registryPdfBulkWorker = { queue: [], running: false };
}

async function runLoop(): Promise<void> {
  const s = state();
  try {
    while (s.queue.length > 0) {
      // 先頭を覗くだけで、まだ配列から取り除かない。processJob は最初の
      // await で同期実行が中断されるため、ここで即 shift() すると
      // 「処理中だが待機列上は空」の瞬間が生じ、その隙に入った重複enqueueが
      // 再度 push されて二重処理されてしまう(このジョブの完了までは
      // includes() チェックに引っかからせて重複を弾く必要がある)。
      const jobId = s.queue[0];
      try {
        await processJob(jobId);
      } catch (err) {
        console.error(`registry-pdf-bulk worker: job ${jobId} failed:`, err);
        try {
          await prisma.importJob.update({
            where: { id: jobId },
            data: { status: "failed", completedAt: new Date() },
          });
        } catch (updateErr) {
          console.error(
            "registry-pdf-bulk worker: job finalize failed:",
            updateErr,
          );
        }
      } finally {
        // 処理が完了(成功/失敗いずれも)してから待機列から取り除く。
        s.queue.shift();
      }
    }
  } finally {
    // while脱出と同一の同期継続内で解除する(外付け.finallyだと
    // マイクロタスク1個分の隙間ができ、その間のenqueueがループ未起動のまま
    // 取り残される=活性レース)。
    s.running = false;
  }
}

async function processJob(jobId: string): Promise<void> {
  const job = await prisma.importJob.findUnique({
    where: { id: jobId },
    select: { id: true, jobType: true, status: true, executedBy: true },
  });
  if (!job || job.jobType !== "registry_pdf_bulk") return;
  if (job.status === "completed" || job.status === "rolled_back") return;

  await prisma.importJob.update({
    where: { id: jobId },
    data: { status: "processing", startedAt: new Date() },
  });

  const executor = await prisma.user.findUnique({
    where: { id: job.executedBy },
    select: { id: true, role: true, isActive: true },
  });
  if (!executor) {
    await prisma.importJob.update({
      where: { id: jobId },
      data: { status: "failed", completedAt: new Date() },
    });
    return;
  }

  const pendingRows = await prisma.importJobRow.findMany({
    where: { jobId, status: "pending" },
    orderBy: { rowNumber: "asc" },
    select: { id: true, rowNumber: true, rawData: true },
  });

  // この取込記録には2種類の行が入りうる(→ registry-owner-bulk/marker.ts):
  //   (a) PDFを上げた一括取込の行  (b)「謄本から所有者をまとめて反映」の行(印つき)
  // ⚠待機列とワーカーは1本のまま(同時に走る処理を常に1つに保つ)。
  const isOwnerApply = (rawData: unknown) =>
    isRegistryOwnerApplyRow(REGISTRY_OWNER_APPLY_JOB_TYPE, rawData);

  /**
   * まとめて反映の行の**直前ごとに**、実行者が今も有効で権限があるかを読み直す。
   * ⚠最初に一度だけでは足りない。5,000件は長く走るので、途中で無効にした・権限を
   *   外した後も同じ控えで書き続けてしまう(@codex 第6R P1)。
   * ⚠無効にされた人(isActive=false=ログインの取り消し)の名前では書かない。
   *   権限の読み直しは役割の設定を見るだけで、有効かどうかは見ない(@codex 第5R P1)。
   */
  const loadOwnerApplyAuth = async () => {
    const fresh = await prisma.user.findUnique({
      where: { id: executor.id },
      select: { id: true, role: true, isActive: true },
    });
    if (!fresh) return { missing: "ユーザーが見つからない", fresh: null, perms: [] };
    const perms = await getUserPermissions(fresh.id);
    const missing = !fresh.isActive
      ? "有効なユーザーではない"
      : findMissingRegistryOwnerApplyPerm(fresh.role, perms);
    return { missing, fresh, perms };
  };

  /**
   * 権限切れで止めるとき、**残りのまとめて反映の行を理由つきの失敗で閉じる**。
   * ⚠未処理のまま残すと、受付は「再開できる失敗ジョブがある」として新しい実行を断り、
   *   再開は同じ実行者でまた止まる=無効にした人を戻すかDBを直すまで機能が塞がる
   *   (@codex 第6R P2)。閉じた物件は所有者が空のままなので、権限のある管理者が
   *   新しく実行すれば改めて拾われる。
   * ⚠行ごとに失敗を積まない(1,821件ぶんの処理を走らせない)。ここで一度に閉じる。
   */
  let ownerApplyStopped = false;
  const stopOwnerApply = async (missing: string, fromIndex: number) => {
    ownerApplyStopped = true;
    console.error(
      `[registry-owner-bulk] 実行者の権限が足りないため中止 jobId=${jobId} 不足=${missing}`,
    );
    const remainingIds = pendingRows
      .slice(fromIndex)
      .filter((r) => isOwnerApply(r.rawData))
      .map((r) => r.id);
    await prisma.importJobRow.updateMany({
      where: { jobId, id: { in: remainingIds }, status: "pending" },
      data: {
        status: "error",
        errorMessage:
          "実行した管理者が無効になったか、必要な権限が無くなったため中止しました。" +
          "この物件は、権限のある管理者がもう一度実行すると改めて処理されます",
      },
    });
  };

  // 物件indexは**PDFを上げた行があるときだけ**構築する(全件スキャンで重いため、
  // まとめて反映だけのジョブでは作らない)。
  let index: ReturnType<typeof buildPropertyIndex> | null = null;
  const propertyIndex = async () => {
    if (!index) {
      const properties = await prisma.property.findMany({
        select: { id: true, address: true, realEstateNumber: true },
      });
      index = buildPropertyIndex(properties);
    }
    return index;
  };

  for (const [i, row] of pendingRows.entries()) {
    if (isOwnerApply(row.rawData)) {
      if (ownerApplyStopped) continue;
      const auth = await loadOwnerApplyAuth();
      if (auth.missing || !auth.fresh) {
        await stopOwnerApply(auth.missing ?? "ユーザーが見つからない", i);
        continue;
      }
      await processRegistryOwnerApplyRow({
        jobId,
        rowId: row.id,
        executor: { id: auth.fresh.id, role: auth.fresh.role },
        perms: auth.perms,
      });
      continue;
    }
    await processRegistryPdfBulkRow({
      jobId,
      rowId: row.id,
      index: await propertyIndex(),
      executor,
    });
  }

  // カウンタ確定(reception-property と同じ規約:
  // status は error行>0 で failed、errorCount は error+needs_review 合算)
  const allRows = await prisma.importJobRow.findMany({
    where: { jobId },
    select: { status: true },
  });
  const successCount = allRows.filter((r) => r.status === "success").length;
  const errorRows = allRows.filter((r) => r.status === "error").length;
  const reviewRows = allRows.filter((r) => r.status === "needs_review").length;
  const stillPending = allRows.filter((r) => r.status === "pending").length;
  await prisma.importJob.update({
    where: { id: jobId },
    data: {
      successCount,
      errorCount: errorRows + reviewRows,
      ...(stillPending === 0
        ? {
            status: errorRows > 0 ? "failed" : "completed",
            completedAt: new Date(),
          }
        : {}),
    },
  });
}
