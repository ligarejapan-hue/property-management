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
// 重要な不変条件:
// - 最終的に Property として実在する id のみを返す（owner_csv direct や、
//   reception-owner の owner.id を指す行など、Property でない createdId は除外）。
//   jobType だけでは判定できない（reception-owner は jobType="owner_csv" だが
//   createdId は Property.id を指す）ため、Property.findMany で実在チェックする。
// - options.take は「Property 実在チェック後の最終結果件数」の上限。
//   ImportJobRow 側は内部ページサイズでページングし、非 Property 候補が大量に
//   先頭を占有しても実在 Property を取りこぼさないようにする。
// - rowNumber は 32-bit signed int の範囲のみ有効。範囲外は 0 件扱い。

const FULLWIDTH_COLON_RE = /：/g;
// 解決した propertyId の返却上限。
//
// ⚠200 件だった頃の不具合 (総点検 2026-07-27): 一覧の where が
// `id: { in: [200件] }` に縮退し、件数表示も 200 になるうえ、CSV 出力 /
// DM差込CSV も **警告なく 200 行だけ**出力されていた。CSV 側は本来
// 「全件出す or 上限超過なら 400 で中止」の契約なのに、その判定に到達しない
// (= 送付対象 6,000 件のうち 200 件分しか宛先が出ず、残りへ DM が届かない)。
//
// 上限を CSV の安全上限 (10,000) + 1 に合わせることで、超過時は切り捨てでは
// なく CSV 側の 400「絞り込んでください」に必ず倒れる。内部スキャン上限
// (INTERNAL_PAGE_SIZE * MAX_PAGES_PER_BRANCH = 10,000 候補/branch) とも整合する。
const DEFAULT_TAKE = 10_001;
const INTERNAL_PAGE_SIZE = 500;
const MAX_PAGES_PER_BRANCH = 20; // 500 * 20 = 10,000 候補/branch 上限
const PRISMA_INT_MIN = 1;
const PRISMA_INT_MAX = 2147483647; // Prisma Int (PostgreSQL int4) の上限

type PrismaLike = Pick<PrismaClient, "importJobRow" | "property">;

export interface ResolveMgmtIdOptions {
  take?: number;
}

interface ParsedQ {
  fileNameHint: string | null;
  rowNumber: number | null;
  invalidRowNumber: boolean;
}

function parseRowNumberSafe(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n)) return null;
  if (n < PRISMA_INT_MIN || n > PRISMA_INT_MAX) return null;
  return n;
}

export function parseMgmtIdQuery(rawQ: string): { normalized: string; parsed: ParsedQ } {
  const normalized = rawQ.replace(FULLWIDTH_COLON_RE, ":").trim();
  if (!normalized) {
    return {
      normalized,
      parsed: { fileNameHint: null, rowNumber: null, invalidRowNumber: false },
    };
  }

  const colonIdx = normalized.indexOf(":");
  if (colonIdx >= 0) {
    const left = normalized.slice(0, colonIdx).trim();
    const right = normalized.slice(colonIdx + 1).replace(/行$/, "").trim();
    if (/^\d+$/.test(right)) {
      const rowNumber = parseRowNumberSafe(right);
      if (rowNumber === null) {
        return {
          normalized,
          parsed: { fileNameHint: left || null, rowNumber: null, invalidRowNumber: true },
        };
      }
      return {
        normalized,
        parsed: { fileNameHint: left || null, rowNumber, invalidRowNumber: false },
      };
    }
    return {
      normalized,
      parsed: { fileNameHint: left || null, rowNumber: null, invalidRowNumber: false },
    };
  }

  const stripped = normalized.replace(/行$/, "").trim();
  if (/^\d+$/.test(stripped)) {
    const rowNumber = parseRowNumberSafe(stripped);
    if (rowNumber === null) {
      return {
        normalized,
        parsed: { fileNameHint: null, rowNumber: null, invalidRowNumber: true },
      };
    }
    return {
      normalized,
      parsed: { fileNameHint: null, rowNumber, invalidRowNumber: false },
    };
  }

  return {
    normalized,
    parsed: { fileNameHint: normalized, rowNumber: null, invalidRowNumber: false },
  };
}

// 1 つの branch を id cursor ベースでページングし、各ページで Property 実在
// チェックを実施して verifiedIds に積み上げる。target に達したら早期 return。
async function paginatedCollect(
  prisma: PrismaLike,
  branchWhere: Record<string, unknown>,
  verifiedIds: Set<string>,
  target: number,
): Promise<void> {
  let cursor: string | undefined = undefined;
  for (let page = 0; page < MAX_PAGES_PER_BRANCH; page++) {
    if (verifiedIds.size >= target) return;

    const where = cursor
      ? { ...branchWhere, id: { gt: cursor } }
      : branchWhere;
    const rows = (await prisma.importJobRow.findMany({
      where,
      select: { id: true, createdId: true },
      orderBy: { id: "asc" },
      take: INTERNAL_PAGE_SIZE,
    })) as { id: string; createdId: string | null }[];

    if (rows.length === 0) return;
    cursor = rows[rows.length - 1].id;

    const newCandidates = Array.from(
      new Set(
        rows
          .map((r) => r.createdId)
          .filter((id): id is string => !!id && !verifiedIds.has(id)),
      ),
    );

    if (newCandidates.length > 0) {
      const props = await prisma.property.findMany({
        where: { id: { in: newCandidates } },
        select: { id: true },
      });
      for (const p of props) {
        verifiedIds.add(p.id);
        if (verifiedIds.size >= target) return;
      }
    }

    if (rows.length < INTERNAL_PAGE_SIZE) return;
  }
}

export async function resolveMgmtIdToPropertyIds(
  prisma: PrismaLike,
  rawQ: string,
  options: ResolveMgmtIdOptions = {},
): Promise<string[]> {
  const take = options.take ?? DEFAULT_TAKE;
  const { normalized, parsed } = parseMgmtIdQuery(rawQ);
  if (!normalized) return [];
  // 範囲外・不正な rowNumber は 0 件扱い（Prisma Int 範囲外を渡すと
  // runtime error/500 になり得るため、他 branch にも進まない）。
  if (parsed.invalidRowNumber) return [];

  const verifiedIds = new Set<string>();
  const baseWhere = { status: "success" as const, createdId: { not: null } };

  if (parsed.fileNameHint && parsed.rowNumber !== null) {
    await paginatedCollect(
      prisma,
      {
        ...baseWhere,
        rowNumber: parsed.rowNumber,
        job: { fileName: { contains: parsed.fileNameHint, mode: "insensitive" } },
      },
      verifiedIds,
      take,
    );
  } else if (parsed.rowNumber !== null) {
    await paginatedCollect(
      prisma,
      { ...baseWhere, rowNumber: parsed.rowNumber },
      verifiedIds,
      take,
    );
  } else if (parsed.fileNameHint) {
    await paginatedCollect(
      prisma,
      {
        ...baseWhere,
        job: { fileName: { contains: parsed.fileNameHint, mode: "insensitive" } },
      },
      verifiedIds,
      take,
    );
  }

  if (verifiedIds.size < take) {
    await paginatedCollect(
      prisma,
      {
        ...baseWhere,
        rawData: { path: ["__sourceRef"], string_contains: normalized },
      },
      verifiedIds,
      take,
    );
  }

  return Array.from(verifiedIds).slice(0, take);
}
