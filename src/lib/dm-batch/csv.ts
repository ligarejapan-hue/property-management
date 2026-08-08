import { createHash } from "crypto";
import {
  DM_EXPORT_HEADERS,
  buildDmRow,
  type DmRowPropertyOwner,
} from "@/lib/dm-export";
import { encodeCsv, sanitizeCsvCellForExcel } from "@/lib/csv-encode";
import type { OwnerDisplayConfig } from "@/lib/api-helpers";
import type { PropertyStateForCheck } from "./eligibility";

// 控え(items)から宛名CSVを組み立てる(設計書§2.1)。
// CSV は常に items から生成する=検索条件の再実行はしない。列・無害化・BOM/CRLF は
// 旧 dm-export GET と同一(既存の差込テンプレ互換を壊さない)。

export interface BatchCsvItem {
  id: string;
  propertyId: string;
  ownerId: string;
  groupOwnerIds: string[];
}

export interface BatchCsvSource {
  items: BatchCsvItem[];
  properties: Map<string, PropertyStateForCheck & { address?: string | null; propertyType?: string }>;
  importSourceMap: Map<string, string>;
  ownerDisplayConfig: OwnerDisplayConfig;
}

type OwnerWithId = DmRowPropertyOwner & { owner: { id: string } };

export function buildBatchCsv(src: BatchCsvSource): string {
  const rows: Array<Record<string, string>> = [];
  for (const it of src.items) {
    const property = src.properties.get(it.propertyId);
    if (!property) continue;
    const saved = new Set(it.groupOwnerIds);
    // 資格検査(6)でグループ完全一致を確認済みの前提。描画は保存集合のメンバーを現在値で並べる。
    const group = (property.propertyOwners as OwnerWithId[]).filter((po) =>
      saved.has(po.owner.id),
    );
    if (group.length === 0) continue;
    rows.push(
      buildDmRow(
        {
          address: property.address ?? "",
          propertyType: property.propertyType ?? "unknown",
        },
        group,
        src.ownerDisplayConfig,
        src.importSourceMap.get(it.propertyId) ?? "",
      ),
    );
  }
  const sanitizedRows = rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        sanitizeCsvCellForExcel(value),
      ]),
    ),
  );
  return encodeCsv([...DM_EXPORT_HEADERS], sanitizedRows, { bom: true });
}

/** CSV の同一性検証用ハッシュ(R43)。PII そのものは保存しない。 */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
