import type { Prisma } from "@/generated/prisma";
import type { WritebackResult } from "./build-writeback";

/**
 * 物件・棟の列を更新し、変更履歴(ChangeLog)を1欄1行残す(仕様書 §6)。
 * 呼び出し側のトランザクションの中で使う。行のロック(FOR UPDATE)・version判定・
 * before の読み直しは呼び出し側で済ませておくこと(C1)。
 *
 * ⚠**条件は書き込み自体にも付ける**(@codex #394 R29 P1 と同じ考え方)。FOR UPDATE で
 * 保護されている前提でも、update ではなく updateMany({ where: { id, version } }) にし、
 * count===0 なら競合として書き込みを止め `{ ok: false }` を返す(防御的二重チェック)。
 */
export async function applyWriteback(
  tx: Prisma.TransactionClient,
  args: {
    propertyId: string;
    buildingId: string | null;
    result: WritebackResult;
    before: { property: Record<string, unknown>; building: Record<string, unknown> | null };
    /** 呼び出し側が FOR UPDATE 後に読み直した、書き込み条件に使う現在の version。 */
    propertyVersion: number;
    buildingVersion: number | null;
    userId: string;
  },
): Promise<{ ok: boolean }> {
  const logs: Prisma.ChangeLogCreateManyInput[] = [];

  const propertyData = args.result.property;
  if (Object.keys(propertyData).length > 0) {
    const updated = await tx.property.updateMany({
      where: { id: args.propertyId, version: args.propertyVersion },
      data: { ...propertyData, version: { increment: 1 } },
    });
    if (updated.count === 0) return { ok: false };
    for (const [field, value] of Object.entries(propertyData)) {
      logs.push({
        targetTable: "properties",
        targetId: args.propertyId,
        fieldName: field,
        oldValue: toLogValue(args.before.property[field]),
        newValue: toLogValue(value),
        source: "manual",
        changedBy: args.userId,
      });
    }
  }

  const buildingData = args.result.building;
  if (args.buildingId && Object.keys(buildingData).length > 0) {
    const updated = await tx.building.updateMany({
      where: { id: args.buildingId, version: args.buildingVersion ?? undefined },
      data: { ...buildingData, version: { increment: 1 } },
    });
    if (updated.count === 0) return { ok: false };
    for (const [field, value] of Object.entries(buildingData)) {
      logs.push({
        targetTable: "buildings",
        targetId: args.buildingId,
        fieldName: field,
        oldValue: toLogValue(args.before.building?.[field]),
        newValue: toLogValue(value),
        source: "manual",
        changedBy: args.userId,
      });
    }
  }

  if (logs.length > 0) await tx.changeLog.createMany({ data: logs });
  return { ok: true };
}

function toLogValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}
