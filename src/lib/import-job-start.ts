import prisma from "@/lib/prisma";

/**
 * 取り込みを受け取った直後に、取り込みの記録(処理中)を作る。
 * ⚠表を読み終えてから作ると、通信が切れた画面が取り込み履歴で確かめるとき、
 *   サーバーがまだ前処理中で今回の分が見えず「取り込まれていない」と思わせてしまう(@codex P1)。
 *   受け取った時点で作れば、返事が届かなくても履歴にはすぐ出る。
 */
export async function startImportJob(input: {
  jobType: "property_csv" | "owner_csv";
  fileName: string;
  executedBy: string;
}): Promise<{ id: string }> {
  return prisma.importJob.create({
    data: {
      jobType: input.jobType,
      fileName: input.fileName,
      status: "processing",
      executedBy: input.executedBy,
      startedAt: new Date(),
    },
    select: { id: true },
  });
}

/**
 * 取り込みが途中で失敗した(入力の誤りで断った・処理中に落ちた)とき、処理中のままの記録を失敗にする。
 * ⚠済んだ記録(completed/failed)は書き換えない。ここでの失敗は元のエラーの返事を変えないよう握りつぶす
 *   (残っても「処理中のまま」の一覧から手で失敗にできる)。
 */
export async function failUnfinishedImportJob(jobId: string): Promise<void> {
  try {
    await prisma.importJob.updateMany({
      where: { id: jobId, status: "processing" },
      data: { status: "failed", completedAt: new Date() },
    });
  } catch {
    // ignore
  }
}
