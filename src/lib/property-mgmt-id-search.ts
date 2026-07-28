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
/**
 * 管理ID 一致の既定上限。CSV / DM差込CSV の安全上限と同値。
 *
 * ⚠200 件だった頃の不具合 (総点検 2026-07-27): 一覧の where が
 * `id: { in: [200件] }` に縮退し、件数表示も 200 になるうえ、CSV 出力 /
 * DM差込CSV も **警告なく 200 行だけ**出力されていた (= 送付対象 6,000 件の
 * うち 200 件分しか宛先が出ず、残りへ DM が届かない)。
 *
 * ⚠「上限+1 件返せば CSV 側の行数ガードに引っかかる」で代用してはいけない
 * (@codex #330 R2)。CSV の where は管理ID に加えて案件状況・DM状況・日付・
 * field_staff スコープを **AND** するので、切り捨てた 10,001 件目以降にだけ
 * 条件を満たす行があると、最終行数は上限未満に収まりガードが発火しない。
 * 超過は行数ではなく **overflowed フラグで別途表現**し、呼び出し側が
 * 「切り捨てたまま出力する」経路を持てないようにする。
 */
export const MGMT_ID_MATCH_LIMIT = 10_000;
/**
 * 入力補完 (`/api/properties/suggest`) 用の上限。候補は 10 件しか返さないため、
 * 1 打鍵ごとに数千件の id を検証して巨大な IN 句を組むのは無駄 (@codex #330 R2)。
 * OR の一要素に足すだけなので、多少取りこぼしても補完としては成立する。
 */
export const MGMT_ID_SUGGEST_LIMIT = 50;
const INTERNAL_PAGE_SIZE = 500;
// 走査ページ数の下限 (従来値)。非 Property 行が先頭を大量に占有しても
// 実在 Property を取りこぼさないための最低保証。
const MIN_PAGES_PER_BRANCH = 20;
// take を満たすのに見込む入力行の倍率。1 行が生む id は最大 1 件で、
// createdId が無い行・重複も混ざるため余裕を持たせる。
const SCAN_ROW_MARGIN = 2;
// 暴走防止の絶対上限 (行数)。
const MAX_SCAN_ROWS_PER_BRANCH = 50_000;

/**
 * target を満たすために走査してよいページ数。
 *
 * ⚠固定 20 ページ (= 10,000 行) だと、上限 +1 件目 (超過判定用) に**到達できない**。
 * その結果「超過していないのに超過扱い」ではなく「超過しているのに気づけない」
 * 側へ倒れ、切り捨てたまま CSV/DM が出る (@codex #330 R1)。
 * target から必要ページ数を導出し、従来の下限は保ちつつ上限で暴走を防ぐ。
 */
function maxPagesForTake(target: number): number {
  const rows = Math.min(target * SCAN_ROW_MARGIN, MAX_SCAN_ROWS_PER_BRANCH);
  return Math.max(MIN_PAGES_PER_BRANCH, Math.ceil(rows / INTERNAL_PAGE_SIZE));
}
const PRISMA_INT_MIN = 1;
const PRISMA_INT_MAX = 2147483647; // Prisma Int (PostgreSQL int4) の上限

type PrismaLike = Pick<PrismaClient, "importJobRow" | "property">;

export interface ResolveMgmtIdOptions {
  take?: number;
}

export interface MgmtIdMatches {
  /** 上限までの一致 propertyId。 */
  ids: string[];
  /** 上限を超える一致があった (= ids は先頭 limit 件で、後続を切り捨てている)。 */
  overflowed: boolean;
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
/**
 * 1 branch の走査がどう終わったか。
 * - "exhausted": 入力行を最後まで見た (= この branch に取りこぼしは無いと**証明できた**)
 * - "target-reached": 目標件数に達した (= 超過が**証明できた**)
 * - "scan-cap": 走査上限で打ち切った (= 取りこぼしの有無が**判らない**)
 */
type CollectOutcome = "exhausted" | "target-reached" | "scan-cap";

async function paginatedCollect(
  prisma: PrismaLike,
  branchWhere: Record<string, unknown>,
  verifiedIds: Set<string>,
  target: number,
): Promise<CollectOutcome> {
  let cursor: string | undefined = undefined;
  const maxPages = maxPagesForTake(target);
  for (let page = 0; page < maxPages; page++) {
    if (verifiedIds.size >= target) return "target-reached";

    const where = cursor
      ? { ...branchWhere, id: { gt: cursor } }
      : branchWhere;
    const rows = (await prisma.importJobRow.findMany({
      where,
      select: { id: true, createdId: true },
      orderBy: { id: "asc" },
      take: INTERNAL_PAGE_SIZE,
    })) as { id: string; createdId: string | null }[];

    if (rows.length === 0) return "exhausted";
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
        if (verifiedIds.size >= target) return "target-reached";
      }
    }

    if (rows.length < INTERNAL_PAGE_SIZE) return "exhausted";
  }
  return "scan-cap";
}

/**
 * 管理ID 一致を解決し、**上限超過を件数と別に**返す。
 *
 * 呼び出し側 (CSV / DM差込CSV / 有料の DM 生成) は overflowed が true なら、
 * 他の絞り込み条件で最終行数が上限未満に収まっていても出力してはいけない
 * (切り捨てた id にだけ条件を満たす行があり得るため・@codex #330 R2)。
 *
 * ⚠overflowed は「超えたと判った」だけでなく「**超えていないと証明できなかった**」
 * ときも true にする (fail closed・@codex #330 R3)。走査は ImportJobRow 側の
 * 行数で上限を切るため、1 物件が 3 行以上の取込行を持つ / 非 Property 行が
 * 混在すると、10,000 件を超える物件があっても走査窓に収まらず
 * 「超過していない」と誤って報告し得る。証明できたのは
 * 「入力行を最後まで見た (exhausted)」ときだけ。
 */
export async function resolveMgmtIdMatches(
  prisma: PrismaLike,
  rawQ: string,
  options: { limit?: number } = {},
): Promise<MgmtIdMatches> {
  const limit = options.limit ?? MGMT_ID_MATCH_LIMIT;
  // 上限より 1 件多く探し、超えたかどうかを判定する。
  const { ids, indeterminate } = await collectMgmtIdMatches(
    prisma,
    rawQ,
    limit + 1,
  );
  return {
    ids: ids.slice(0, limit),
    overflowed: ids.length > limit || indeterminate,
  };
}

/**
 * 管理ID 一致の propertyId[] だけを返す薄いラッパ。
 * 上限超過を知る必要がある経路 (CSV/DM) は resolveMgmtIdMatches を使うこと。
 */
export async function resolveMgmtIdToPropertyIds(
  prisma: PrismaLike,
  rawQ: string,
  options: ResolveMgmtIdOptions = {},
): Promise<string[]> {
  const { ids } = await collectMgmtIdMatches(
    prisma,
    rawQ,
    options.take ?? MGMT_ID_MATCH_LIMIT,
  );
  return ids;
}

async function collectMgmtIdMatches(
  prisma: PrismaLike,
  rawQ: string,
  take: number,
): Promise<{ ids: string[]; indeterminate: boolean }> {
  const { normalized, parsed } = parseMgmtIdQuery(rawQ);
  if (!normalized) return { ids: [], indeterminate: false };
  // 範囲外・不正な rowNumber は 0 件扱い（Prisma Int 範囲外を渡すと
  // runtime error/500 になり得るため、他 branch にも進まない）。
  if (parsed.invalidRowNumber) return { ids: [], indeterminate: false };

  const verifiedIds = new Set<string>();
  const baseWhere = { status: "success" as const, createdId: { not: null } };
  // どれか 1 branch でも走査上限で打ち切っていたら、全体として
  // 「取りこぼしが無いと証明できていない」。
  let indeterminate = false;
  const note = (outcome: CollectOutcome): void => {
    if (outcome === "scan-cap") indeterminate = true;
  };

  if (parsed.fileNameHint && parsed.rowNumber !== null) {
    note(
      await paginatedCollect(
        prisma,
        {
          ...baseWhere,
          rowNumber: parsed.rowNumber,
          job: {
            fileName: { contains: parsed.fileNameHint, mode: "insensitive" },
          },
        },
        verifiedIds,
        take,
      ),
    );
  } else if (parsed.rowNumber !== null) {
    note(
      await paginatedCollect(
        prisma,
        { ...baseWhere, rowNumber: parsed.rowNumber },
        verifiedIds,
        take,
      ),
    );
  } else if (parsed.fileNameHint) {
    note(
      await paginatedCollect(
        prisma,
        {
          ...baseWhere,
          job: {
            fileName: { contains: parsed.fileNameHint, mode: "insensitive" },
          },
        },
        verifiedIds,
        take,
      ),
    );
  }

  if (verifiedIds.size < take) {
    note(
      await paginatedCollect(
        prisma,
        {
          ...baseWhere,
          rawData: { path: ["__sourceRef"], string_contains: normalized },
        },
        verifiedIds,
        take,
      ),
    );
  }

  return { ids: Array.from(verifiedIds).slice(0, take), indeterminate };
}
