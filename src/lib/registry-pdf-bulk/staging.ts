/**
 * 所有者事項PDF一括取込の staging 保存キー規約。
 *
 * アップロード直後のPDFは物件が決まるまで
 * `import-staging/registry-pdf/{jobId}/{rowNumber}.pdf` に置く。
 * 添付成功/重複スキップ時に削除し、要確認(needs_review)の間は
 * 手動添付に備えて保持する。
 *
 * jobId は Prisma の uuid、rowNumber は正の整数のみを許可し、
 * storage キーに traversal 要素が混ざらないことをここで保証する。
 */

const SAFE_JOB_ID = /^[0-9a-f-]{8,64}$/i;

export function registryPdfBulkStagingKey(
  jobId: string,
  rowNumber: number,
): string {
  if (!SAFE_JOB_ID.test(jobId)) {
    throw new Error(`Invalid jobId for staging key: ${jobId}`);
  }
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    throw new Error(`Invalid rowNumber for staging key: ${rowNumber}`);
  }
  return `import-staging/registry-pdf/${jobId}/${rowNumber}.pdf`;
}
