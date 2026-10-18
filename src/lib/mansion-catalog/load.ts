/**
 * 名簿の読み込み(設計 2026-10-18 §4)。DB は CatalogStore 越しにだけ触る(テストで差し替える)。
 * ⚠同じ建物番号は**ファイル全体で**1件にまとめる(後の行が勝つ)。並びの同点で同じ建物が2ページに出るため。
 */
import { toCatalogRow, type CatalogRow } from "./parse";

export const LOAD_BATCH = 500;

export interface CatalogStore {
  upsertMany(rows: CatalogRow[]): Promise<{ inserted: number; updated: number }>;
}
export interface LoadResult { inserted: number; updated: number; skipped: number; duplicates: number }

export async function loadCatalogLines(
  lines: AsyncIterable<string> | Iterable<string>,
  store: CatalogStore,
): Promise<LoadResult> {
  const byId = new Map<string, CatalogRow>();
  let skipped = 0;
  let duplicates = 0;
  for await (const raw of lines) {
    const row = toCatalogRow(raw.trim());
    if (!row) {
      skipped++;
      continue;
    }
    const key = `${row.source}:${row.sourceId}`;
    if (byId.has(key)) {
      duplicates++;
      byId.delete(key); // 後の行を最後に並べ直す(Map の順)
    }
    byId.set(key, row);
  }
  const rows = [...byId.values()];
  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < rows.length; i += LOAD_BATCH) {
    const r = await store.upsertMany(rows.slice(i, i + LOAD_BATCH));
    inserted += r.inserted;
    updated += r.updated;
  }
  return { inserted, updated, skipped, duplicates };
}
