import type { Prisma } from "@/generated/prisma";
import type { WritebackResult } from "./build-writeback";

/**
 * 物件・棟の列を更新し、変更履歴(ChangeLog)を1欄1行残す(仕様書 §6)。
 * 呼び出し側のトランザクションの中で使う。行のロックは呼び出し側で済ませておくこと。
 */
export async function applyWriteback(
  tx: Prisma.TransactionClient,
  args: {
    propertyId: string;
    buildingId: string | null;
    result: WritebackResult;
    before: { property: Record<string, unknown>; building: Record<string, unknown> | null };
    userId: string;
  },
): Promise<void> {
  const logs: Prisma.ChangeLogCreateManyInput[] = [];

  const propertyData = args.result.property;
  if (Object.keys(propertyData).length > 0) {
    await tx.property.update({
      where: { id: args.propertyId },
      data: { ...propertyData, version: { increment: 1 } },
    });
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
    await tx.building.update({
      where: { id: args.buildingId },
      data: { ...buildingData, version: { increment: 1 } },
    });
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
}

function toLogValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}
