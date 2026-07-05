/**
 * 所有者事項PDF一括アップロードのクライアント側「割り振り」純関数。
 * DOM/File 非依存({ name, size } の軽量メタと元 index で扱う)。
 * サーバ(registry-pdf-bulk/route.ts)は無改修で、ここが複数バッチへの分割・
 * 再開スキップを担う。上限の正本はサーバ側。
 */
import { parseRegistryPdfBulkFilename } from "./filename";

export interface BulkFileMeta {
  name: string;
  size: number;
}

export type ExcludeReason = "too_large" | "not_pdf";

export interface ExcludedFile {
  index: number;
  name: string;
  reason: ExcludeReason;
}

export interface UploadPlan {
  excluded: ExcludedFile[];
  alreadySentCount: number;
  batches: number[][];
  sendableTotal: number;
}

// サーバ route.ts / wizard-progress.ts と同じ上限(正本はサーバ側)。
export const MAX_BULK_FILES = 100;
export const MAX_BULK_FILE_BYTES = 5 * 1024 * 1024;
// 1バッチのバイト目標。サーバ上限100MBに余裕を持たせる。
export const BATCH_TARGET_BYTES = 90 * 1024 * 1024;

/** 拡張子 .pdf 以外 / 5MB超 を除外し、残りを送信可 index 配列に。 */
export function classifyBulkFiles(files: BulkFileMeta[]): {
  sendable: number[];
  excluded: ExcludedFile[];
} {
  const sendable: number[] = [];
  const excluded: ExcludedFile[] = [];
  files.forEach((f, index) => {
    if (!f.name.toLowerCase().endsWith(".pdf")) {
      excluded.push({ index, name: f.name, reason: "not_pdf" });
    } else if (f.size > MAX_BULK_FILE_BYTES) {
      excluded.push({ index, name: f.name, reason: "too_large" });
    } else {
      sendable.push(index);
    }
  });
  return { sendable, excluded };
}

/** 送信可 index を「100件 or 90MB を超えたら区切る」で複数バッチに分割。 */
export function planBatches(
  sendable: number[],
  files: BulkFileMeta[],
): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let currentBytes = 0;
  for (const index of sendable) {
    const size = files[index]?.size ?? 0;
    const exceedsCount = current.length >= MAX_BULK_FILES;
    const exceedsBytes =
      current.length > 0 && currentBytes + size > BATCH_TARGET_BYTES;
    if (exceedsCount || exceedsBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(index);
    currentBytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** 再開キー: 請求番号が取れればそれ、無ければ正規化したファイル名。 */
export function bulkFileKey(name: string): string {
  const parsed = parseRegistryPdfBulkFilename(name);
  return parsed ? parsed.requestNumber : name.normalize("NFC").trim();
}

/** 送信済みキー集合に含まれる index を除外。 */
export function filterUnsent(
  sendable: number[],
  files: BulkFileMeta[],
  sentKeys: ReadonlySet<string>,
): number[] {
  return sendable.filter((i) => !sentKeys.has(bulkFileKey(files[i].name)));
}

/** UI 用のまとめ計画: 除外・送信済みスキップ・未送信バッチ列を一括算出。 */
export function buildUploadPlan(
  files: BulkFileMeta[],
  sentKeys: ReadonlySet<string>,
): UploadPlan {
  const { sendable, excluded } = classifyBulkFiles(files);
  const unsent = filterUnsent(sendable, files, sentKeys);
  return {
    excluded,
    alreadySentCount: sendable.length - unsent.length,
    batches: planBatches(unsent, files),
    sendableTotal: unsent.length,
  };
}
