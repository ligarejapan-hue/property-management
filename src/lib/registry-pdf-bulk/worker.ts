import prisma from "@/lib/prisma";
import { buildPropertyIndex } from "./match";
import { processRegistryPdfBulkRow } from "./process-row";

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
    void runLoop().finally(() => {
      state().running = false;
    });
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
    select: { id: true, role: true },
  });
  if (!executor) {
    await prisma.importJob.update({
      where: { id: jobId },
      data: { status: "failed", completedAt: new Date() },
    });
    return;
  }

  // 物件indexはジョブ開始時に1回だけ構築(行ごとの全件スキャンを避ける)
  const properties = await prisma.property.findMany({
    select: { id: true, address: true, realEstateNumber: true },
  });
  const index = buildPropertyIndex(properties);

  const pendingRows = await prisma.importJobRow.findMany({
    where: { jobId, status: "pending" },
    orderBy: { rowNumber: "asc" },
    select: { id: true, rowNumber: true },
  });
  for (const row of pendingRows) {
    await processRegistryPdfBulkRow({
      jobId,
      rowId: row.id,
      index,
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
