/**
 * 発行の履歴は書類ごとに最新版だけ残す(2026-11-20 発注者「古いやつはいらない。最新版だけ残してあとは削除」)。
 * - 書類=書類の種類+書き分け(売主様用/買主様用・売却/購入など)。書き分けごとに最新版を1つ残す。
 * - 領収書(手付金・残金・精算金)は全部の版を残す(控えの保存が要る・発注者決定「領収書は除く」)。
 * - 記録は、版の番号を決めて新しい版を書くのと同じトランザクション(取引の行を押さえた中)で消す。
 *   順番に処理しないと、消して空いた番号に、同時に発行していた別の版が入り込む(@codex #765 P2)。
 * - ファイル(PDF・Excel)は記録の確定のあとに消す。消せなくても記録は戻さない(開く道は記録から引くので誰も開けない)。
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
 * 今発行した版より古い版の記録を消す(新しい版を書いたのと同じトランザクションの中で呼ぶ)。
 * 消した版の番号(古い順)と、あとで消すファイルの鍵を返す。領収書は何もしない。
 */
export async function pruneOlderVersionRows(
  db: PruneDb,
  target: { dealId: string; docType: string; variant: string; keepVersion: number },
): Promise<{ versions: number[]; fileKeys: string[] }> {
  if (keepsAllVersions(target.docType)) return { versions: [], fileKeys: [] };
  const old = await db.dealDocument.findMany({
    where: { dealId: target.dealId, docType: target.docType, variant: target.variant, version: { lt: target.keepVersion } },
    select: { id: true, version: true, pdfKey: true, xlsxKey: true },
  });
  if (old.length === 0) return { versions: [], fileKeys: [] };
  await db.dealDocument.deleteMany({ where: { id: { in: old.map((o) => o.id) }, dealId: target.dealId } });
  return {
    versions: old.map((o) => o.version).sort((a, b) => a - b),
    fileKeys: old.flatMap((o) => [o.pdfKey, o.xlsxKey]).filter((k): k is string => !!k),
  };
}

/** 記録を消した版のファイルを消す(確定のあと)。消せなかった数を返す。 */
export async function deleteDocumentFiles(storage: PruneStorage, keys: readonly string[]): Promise<number> {
  const results = await Promise.allSettled(keys.map((k) => storage.delete(k)));
  return results.filter((r) => r.status === "rejected").length;
}
