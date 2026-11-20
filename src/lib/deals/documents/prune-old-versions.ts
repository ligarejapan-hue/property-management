/**
 * 発行の履歴は書類ごとに最新版だけ残す(2026-11-20 発注者「古いやつはいらない。最新版だけ残してあとは削除」)。
 * - 書類=書類の種類+書き分け(売主様用/買主様用・売却/購入など)。書き分けごとに最新版を1つ残す。
 * - 領収書(手付金・残金・精算金)は全部の版を残す(控えの保存が要る・発注者決定「領収書は除く」)。
 * - 記録を先に消し、そのあとファイル(PDF・Excel)を消す。ファイルが消せなくても記録は戻さない(開く道は記録から引くので誰も開けない)。
 * 経緯タブの古い版の発行の記録も一緒に消える(発注者了承)。監査の記録(deal_document_issue)は残る。
 */
import { RECEIPT_KINDS } from "./business/receipts";

/** 全部の版を残す書類(領収書)。 */
export const KEEP_ALL_VERSIONS_DOC_TYPES: ReadonlySet<string> = new Set(Object.keys(RECEIPT_KINDS));

export const keepsAllVersions = (docType: string): boolean => KEEP_ALL_VERSIONS_DOC_TYPES.has(docType);

interface PruneDb {
  dealDocument: {
    findMany(args: {
      where: { dealId: string; docType: string; variant: string; version: { lt: number } };
      select: { id: true; version: true; pdfKey: true; xlsxKey: true };
    }): Promise<{ id: string; version: number; pdfKey: string | null; xlsxKey: string | null }[]>;
    deleteMany(args: { where: { id: { in: string[] }; dealId: string } }): Promise<{ count: number }>;
  };
}
interface PruneStorage {
  delete(key: string): Promise<void>;
}

/**
 * 今発行した版より古い版の記録とファイルを消す。消した版の番号(古い順)と、消せなかったファイルの数を返す。
 * 領収書は何もしない。
 */
export async function pruneOlderVersions(
  db: PruneDb, storage: PruneStorage,
  target: { dealId: string; docType: string; variant: string; keepVersion: number },
): Promise<{ versions: number[]; fileErrors: number }> {
  if (keepsAllVersions(target.docType)) return { versions: [], fileErrors: 0 };
  const old = await db.dealDocument.findMany({
    where: { dealId: target.dealId, docType: target.docType, variant: target.variant, version: { lt: target.keepVersion } },
    select: { id: true, version: true, pdfKey: true, xlsxKey: true },
  });
  if (old.length === 0) return { versions: [], fileErrors: 0 };
  await db.dealDocument.deleteMany({ where: { id: { in: old.map((o) => o.id) }, dealId: target.dealId } });
  const keys = old.flatMap((o) => [o.pdfKey, o.xlsxKey]).filter((k): k is string => !!k);
  const results = await Promise.allSettled(keys.map((k) => storage.delete(k)));
  return {
    versions: old.map((o) => o.version).sort((a, b) => a - b),
    fileErrors: results.filter((r) => r.status === "rejected").length,
  };
}
