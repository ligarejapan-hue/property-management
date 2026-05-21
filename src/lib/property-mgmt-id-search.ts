import type { PrismaClient } from "@/generated/prisma";

// 管理ID（取込元 fileName / rowNumber / __sourceRef）から候補 propertyId[] を解決する。
//
// 入力例:
//   "受付帳.xlsx:120行" → fileName + rowNumber AND
//   "受付帳.xlsx：120"   → 全角コロン許容
//   "120行" / "120"     → rowNumber 単独
//   "受付帳"             → fileName contains
//   "__sourceRef..."     → rawData.__sourceRef contains で常時フォールバック
//
// 候補 ImportJobRow を集めた後、Property として実在するものだけに絞る。
// owner_csv direct 行は createdId が Owner.id を指すので、ここで自然に除外される。

const FULLWIDTH_COLON = "："; // '：'
const DEFAULT_TAKE = 200;

type PrismaLike = Pick<PrismaClient, "importJobRow" | "property">;

export interface ResolveMgmtIdOptions {
  take?: number;
}

interface ParsedQ {
  fileNameHint: string | null;
  rowNumber: number | null;
}

export function parseMgmtIdQuery(rawQ: string): { normalized: string; parsed: ParsedQ } {
  const normalized = rawQ.replace(FULLWIDTH_COLON, ":").trim();
  if (!normalized) {
    return { normalized, parsed: { fileNameHint: null, rowNumber: null } };
  }

  const colonIdx = normalized.indexOf(":");
  if (colonIdx >= 0) {
    const left = normalized.slice(0, colonIdx).trim();
    const right = normalized.slice(colonIdx + 1).replace(/行$/, "").trim();
    const rowNumber = /^\d+$/.test(right) ? Number.parseInt(right, 10) : null;
    return {
      normalized,
      parsed: {
        fileNameHint: left || null,
        rowNumber,
      },
    };
  }

  const stripped = normalized.replace(/行$/, "").trim();
  if (/^\d+$/.test(stripped)) {
    return {
      normalized,
      parsed: { fileNameHint: null, rowNumber: Number.parseInt(stripped, 10) },
    };
  }

  return {
    normalized,
    parsed: { fileNameHint: normalized, rowNumber: null },
  };
}

export async function resolveMgmtIdToPropertyIds(
  prisma: PrismaLike,
  rawQ: string,
  options: ResolveMgmtIdOptions = {},
): Promise<string[]> {
  const take = options.take ?? DEFAULT_TAKE;
  const { normalized, parsed } = parseMgmtIdQuery(rawQ);
  if (!normalized) return [];

  const candidateIds = new Set<string>();
  const collect = (rows: { createdId: string | null }[]) => {
    for (const r of rows) {
      if (r.createdId) candidateIds.add(r.createdId);
    }
  };

  const baseWhere = { status: "success" as const, createdId: { not: null } };

  if (parsed.fileNameHint && parsed.rowNumber !== null) {
    collect(
      await prisma.importJobRow.findMany({
        where: {
          ...baseWhere,
          rowNumber: parsed.rowNumber,
          job: { fileName: { contains: parsed.fileNameHint, mode: "insensitive" } },
        },
        select: { createdId: true },
        take,
      }),
    );
  } else if (parsed.rowNumber !== null) {
    collect(
      await prisma.importJobRow.findMany({
        where: { ...baseWhere, rowNumber: parsed.rowNumber },
        select: { createdId: true },
        take,
      }),
    );
  } else if (parsed.fileNameHint) {
    collect(
      await prisma.importJobRow.findMany({
        where: {
          ...baseWhere,
          job: { fileName: { contains: parsed.fileNameHint, mode: "insensitive" } },
        },
        select: { createdId: true },
        take,
      }),
    );
  }

  if (candidateIds.size < take) {
    collect(
      await prisma.importJobRow.findMany({
        where: {
          ...baseWhere,
          rawData: { path: ["__sourceRef"], string_contains: normalized },
        },
        select: { createdId: true },
        take,
      }),
    );
  }

  if (candidateIds.size === 0) return [];

  const ids = Array.from(candidateIds).slice(0, take);
  const properties = await prisma.property.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  return properties.map((p) => p.id);
}
