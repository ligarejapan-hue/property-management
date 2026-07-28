import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import {
  MGMT_ID_MATCH_LIMIT,
  MGMT_ID_SUGGEST_LIMIT,
  parseMgmtIdQuery,
  resolveMgmtIdMatches,
  resolveMgmtIdToPropertyIds,
} from "../property-mgmt-id-search";

type Row = { id?: string; createdId: string | null };

const INTERNAL_PAGE_SIZE = 500;

function withRowIds(rows: Row[], baseIdx = 0): { id: string; createdId: string | null }[] {
  return rows.map((r, i) => ({
    id: r.id ?? `row-${baseIdx + i}`,
    createdId: r.createdId,
  }));
}

// ImportJobRow.findMany モック。
// 各「branch」ごとに rows[] を返し、INTERNAL_PAGE_SIZE 以下なら単発返却で終了する。
// id cursor (where.id?.gt) ベースのページングを想定。
function makePrisma(opts: {
  // 各 ImportJobRow.findMany 呼び出しに対する rows。
  // ページング時は同一 branch の where が来るので、外側で配列を消費する。
  rowsByCall?: Row[][];
  propertyIds?: string[] | Set<string>;
}) {
  const rowsQueue = [...(opts.rowsByCall ?? [])];
  const findManyImportRow: Mock = vi.fn(async () => {
    const next = rowsQueue.shift() ?? [];
    return withRowIds(next);
  });
  const allowed =
    opts.propertyIds instanceof Set
      ? opts.propertyIds
      : new Set(opts.propertyIds ?? []);
  const findManyProperty: Mock = vi.fn(async ({ where }: any) => {
    const ids: string[] = where?.id?.in ?? [];
    return ids.filter((id) => allowed.has(id)).map((id) => ({ id }));
  });
  return {
    prisma: {
      importJobRow: { findMany: findManyImportRow },
      property: { findMany: findManyProperty },
    } as any,
    findManyImportRow,
    findManyProperty,
  };
}

function callArgs(mock: Mock, idx: number): any {
  return (mock.mock.calls as any[])[idx]?.[0];
}

describe("parseMgmtIdQuery", () => {
  it("colon split with fileName + rowNumber", () => {
    expect(parseMgmtIdQuery("受付帳.xlsx:120行").parsed).toEqual({
      fileNameHint: "受付帳.xlsx",
      rowNumber: 120,
      invalidRowNumber: false,
    });
  });

  it("末尾「行」省略", () => {
    expect(parseMgmtIdQuery("受付帳.xlsx:120").parsed).toEqual({
      fileNameHint: "受付帳.xlsx",
      rowNumber: 120,
      invalidRowNumber: false,
    });
  });

  it("全角コロン許容", () => {
    expect(parseMgmtIdQuery("受付帳.xlsx:120行").parsed.fileNameHint).toBe(
      "受付帳.xlsx",
    );
  });

  it("rowNumber のみ", () => {
    expect(parseMgmtIdQuery("120行").parsed).toEqual({
      fileNameHint: null,
      rowNumber: 120,
      invalidRowNumber: false,
    });
    expect(parseMgmtIdQuery("120").parsed).toEqual({
      fileNameHint: null,
      rowNumber: 120,
      invalidRowNumber: false,
    });
  });

  it("fileName のみ", () => {
    expect(parseMgmtIdQuery("受付帳").parsed).toEqual({
      fileNameHint: "受付帳",
      rowNumber: null,
      invalidRowNumber: false,
    });
  });

  it("trim + 空入力", () => {
    expect(parseMgmtIdQuery("   ").parsed).toEqual({
      fileNameHint: null,
      rowNumber: null,
      invalidRowNumber: false,
    });
  });

  it("rowNumber=2147483647 (Prisma Int 上限) は有効", () => {
    expect(parseMgmtIdQuery("2147483647").parsed).toEqual({
      fileNameHint: null,
      rowNumber: 2147483647,
      invalidRowNumber: false,
    });
  });

  it("rowNumber=2147483648 (上限超過) は invalidRowNumber=true", () => {
    expect(parseMgmtIdQuery("2147483648").parsed).toEqual({
      fileNameHint: null,
      rowNumber: null,
      invalidRowNumber: true,
    });
  });

  it("9999999999 / 9999999999行 / file:9999999999 はすべて invalidRowNumber", () => {
    expect(parseMgmtIdQuery("9999999999").parsed.invalidRowNumber).toBe(true);
    expect(parseMgmtIdQuery("9999999999行").parsed.invalidRowNumber).toBe(true);
    expect(parseMgmtIdQuery("受付帳.xlsx:9999999999").parsed.invalidRowNumber).toBe(true);
    expect(parseMgmtIdQuery("受付帳.xlsx:9999999999行").parsed.invalidRowNumber).toBe(true);
  });
});

describe("resolveMgmtIdToPropertyIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("受付帳.xlsx:120行 → fileName + rowNumber AND で hit", async () => {
    const { prisma, findManyImportRow } = makePrisma({
      rowsByCall: [
        [{ createdId: "p1" }], // (a) fileName + rowNumber
        [], // (d) __sourceRef fallback
      ],
      propertyIds: ["p1"],
    });
    const ids = await resolveMgmtIdToPropertyIds(prisma, "受付帳.xlsx:120行");
    expect(ids).toEqual(["p1"]);

    const firstCall = callArgs(findManyImportRow, 0);
    expect(firstCall.where).toMatchObject({
      status: "success",
      createdId: { not: null },
      rowNumber: 120,
      job: { fileName: { contains: "受付帳.xlsx", mode: "insensitive" } },
    });
  });

  it("受付帳.xlsx:120 → 末尾「行」なしでも hit", async () => {
    const { prisma } = makePrisma({
      rowsByCall: [[{ createdId: "p1" }], []],
      propertyIds: ["p1"],
    });
    const ids = await resolveMgmtIdToPropertyIds(prisma, "受付帳.xlsx:120");
    expect(ids).toEqual(["p1"]);
  });

  it("受付帳.xlsx:120行 → 全角コロンでも hit", async () => {
    const { prisma, findManyImportRow } = makePrisma({
      rowsByCall: [[{ createdId: "p1" }], []],
      propertyIds: ["p1"],
    });
    const ids = await resolveMgmtIdToPropertyIds(prisma, "受付帳.xlsx:120行");
    expect(ids).toEqual(["p1"]);
    const firstCall = callArgs(findManyImportRow, 0);
    expect(firstCall.where.rowNumber).toBe(120);
    expect(firstCall.where.job.fileName.contains).toBe("受付帳.xlsx");
  });

  it("120行 → rowNumber 単独", async () => {
    const { prisma, findManyImportRow } = makePrisma({
      rowsByCall: [[{ createdId: "p1" }], []],
      propertyIds: ["p1"],
    });
    const ids = await resolveMgmtIdToPropertyIds(prisma, "120行");
    expect(ids).toEqual(["p1"]);
    expect(callArgs(findManyImportRow, 0).where.rowNumber).toBe(120);
    expect(callArgs(findManyImportRow, 0).where.job).toBeUndefined();
  });

  it("120 → mgmtId 専用で rowNumber 単独 hit", async () => {
    const { prisma } = makePrisma({
      rowsByCall: [[{ createdId: "p1" }], []],
      propertyIds: ["p1"],
    });
    const ids = await resolveMgmtIdToPropertyIds(prisma, "120");
    expect(ids).toEqual(["p1"]);
  });

  it("受付帳 → fileName partial hit", async () => {
    const { prisma, findManyImportRow } = makePrisma({
      rowsByCall: [[{ createdId: "p1" }], []],
      propertyIds: ["p1"],
    });
    const ids = await resolveMgmtIdToPropertyIds(prisma, "受付帳");
    expect(ids).toEqual(["p1"]);
    const firstCall = callArgs(findManyImportRow, 0);
    expect(firstCall.where.job.fileName.contains).toBe("受付帳");
    expect(firstCall.where.rowNumber).toBeUndefined();
  });

  it("__sourceRef contains で hit するフォールバック経路", async () => {
    const { prisma, findManyImportRow } = makePrisma({
      // (c) fileName only → 0件、(d) __sourceRef contains → 1件
      rowsByCall: [[], [{ createdId: "p2" }]],
      propertyIds: ["p2"],
    });
    const ids = await resolveMgmtIdToPropertyIds(prisma, "受付帳特殊文字列");
    expect(ids).toEqual(["p2"]);
    const allCalls = findManyImportRow.mock.calls as any[];
    const lastCall = allCalls[allCalls.length - 1][0];
    expect(lastCall.where.rawData).toEqual({
      path: ["__sourceRef"],
      string_contains: "受付帳特殊文字列",
    });
  });

  it("status='success' / createdId NOT NULL の where を必ず含む", async () => {
    const { prisma, findManyImportRow } = makePrisma({
      rowsByCall: [[], []],
      propertyIds: [],
    });
    await resolveMgmtIdToPropertyIds(prisma, "120");
    for (const call of findManyImportRow.mock.calls as any[]) {
      expect(call[0].where.status).toBe("success");
      expect(call[0].where.createdId).toEqual({ not: null });
    }
  });

  it("Property として存在しない createdId は除外（owner_csv direct 行など）", async () => {
    const { prisma } = makePrisma({
      rowsByCall: [[{ createdId: "p1" }, { createdId: "o1" }], []],
      propertyIds: ["p1"], // o1 は Property に存在しない
    });
    const ids = await resolveMgmtIdToPropertyIds(prisma, "受付帳:120行");
    expect(ids).toEqual(["p1"]);
  });

  it("dedup される（複数経路で同じ createdId）", async () => {
    const { prisma } = makePrisma({
      rowsByCall: [
        [{ createdId: "p1" }, { createdId: "p1" }],
        [{ createdId: "p1" }],
      ],
      propertyIds: ["p1"],
    });
    const ids = await resolveMgmtIdToPropertyIds(prisma, "受付帳:120行");
    expect(ids).toEqual(["p1"]);
  });

  it("該当 0 件 → []", async () => {
    const { prisma } = makePrisma({
      rowsByCall: [[], []],
      propertyIds: [],
    });
    const ids = await resolveMgmtIdToPropertyIds(prisma, "存在しない");
    expect(ids).toEqual([]);
  });

  it("空入力 / 空白のみ → 早期 return []", async () => {
    const { prisma, findManyImportRow } = makePrisma({
      rowsByCall: [],
      propertyIds: [],
    });
    expect(await resolveMgmtIdToPropertyIds(prisma, "")).toEqual([]);
    expect(await resolveMgmtIdToPropertyIds(prisma, "   ")).toEqual([]);
    expect(findManyImportRow).not.toHaveBeenCalled();
  });

  // ── ページング / 非Property 大量混入 ────────────────────────────────────

  it("非Property createdId が先に200件以上あっても、後続ページの実在Propertyが返る", async () => {
    // Page 1: o1〜o500 (全て Owner.id で Property に存在しない)
    // Page 2: p1〜p10 (Property に存在)
    const page1: Row[] = Array.from({ length: INTERNAL_PAGE_SIZE }, (_, i) => ({
      id: `r-1-${i}`,
      createdId: `o${i}`,
    }));
    const page2: Row[] = Array.from({ length: 10 }, (_, i) => ({
      id: `r-2-${i}`,
      createdId: `p${i}`,
    }));
    const propertyIds = new Set(page2.map((r) => r.createdId!));

    const { prisma } = makePrisma({
      rowsByCall: [page1, page2, []],
      propertyIds,
    });
    const ids = await resolveMgmtIdToPropertyIds(prisma, "受付帳");
    expect(ids).toHaveLength(10);
    for (const id of ids) expect(propertyIds.has(id)).toBe(true);
  });

  it("最終返却件数が options.take を超えない（Property 実在チェック後）", async () => {
    // 全件 Property 実在。300件返るが take=100 で切り詰める
    const page1: Row[] = Array.from({ length: INTERNAL_PAGE_SIZE }, (_, i) => ({
      id: `r-${i}`,
      createdId: `p${i}`,
    }));
    const propertyIds = new Set(page1.map((r) => r.createdId!));
    const { prisma } = makePrisma({
      rowsByCall: [page1, []],
      propertyIds,
    });
    const ids = await resolveMgmtIdToPropertyIds(prisma, "受付帳", { take: 100 });
    expect(ids).toHaveLength(100);
  });

  it("dedup と Property 実在チェックを跨ぐページングで重複を排除する", async () => {
    // 同じ createdId が page1 / page2 で重複しても 1 件のみ
    const page1: Row[] = [{ id: "r-a", createdId: "p1" }];
    const page2: Row[] = [{ id: "r-b", createdId: "p1" }];
    const { prisma } = makePrisma({
      // (c) branch fileName partial pagination
      rowsByCall: [page1, page2, []],
      propertyIds: ["p1"],
    });
    // page1 が < INTERNAL_PAGE_SIZE で早期終了するため page2 は同じ branch では呼ばれない。
    // ここでは fallback (d) branch でもう1件返るシナリオを使う。
    const ids = await resolveMgmtIdToPropertyIds(prisma, "受付帳特殊文字列");
    expect(ids).toEqual(["p1"]);
  });

  // ── 範囲外 rowNumber: 0件扱い + Prisma に渡さない ─────────────────────

  it("9999999999 → invalidRowNumber 扱いで [] / DB を叩かない", async () => {
    const { prisma, findManyImportRow } = makePrisma({
      rowsByCall: [],
      propertyIds: [],
    });
    const ids = await resolveMgmtIdToPropertyIds(prisma, "9999999999");
    expect(ids).toEqual([]);
    expect(findManyImportRow).not.toHaveBeenCalled();
  });

  it("9999999999行 → []", async () => {
    const { prisma, findManyImportRow } = makePrisma({
      rowsByCall: [],
      propertyIds: [],
    });
    const ids = await resolveMgmtIdToPropertyIds(prisma, "9999999999行");
    expect(ids).toEqual([]);
    expect(findManyImportRow).not.toHaveBeenCalled();
  });

  it("受付帳.xlsx:9999999999 → []（rowNumber 範囲外なら fileName だけでもクエリしない）", async () => {
    const { prisma, findManyImportRow } = makePrisma({
      rowsByCall: [],
      propertyIds: [],
    });
    const ids = await resolveMgmtIdToPropertyIds(prisma, "受付帳.xlsx:9999999999");
    expect(ids).toEqual([]);
    expect(findManyImportRow).not.toHaveBeenCalled();
  });

  it("2147483647 (Prisma Int 上限) は有効に rowNumber 検索される", async () => {
    const { prisma, findManyImportRow } = makePrisma({
      rowsByCall: [[{ createdId: "p1" }], []],
      propertyIds: ["p1"],
    });
    const ids = await resolveMgmtIdToPropertyIds(prisma, "2147483647");
    expect(ids).toEqual(["p1"]);
    expect(callArgs(findManyImportRow, 0).where.rowNumber).toBe(2147483647);
  });

  it("2147483648 (上限超過) → []", async () => {
    const { prisma, findManyImportRow } = makePrisma({
      rowsByCall: [],
      propertyIds: [],
    });
    const ids = await resolveMgmtIdToPropertyIds(prisma, "2147483648");
    expect(ids).toEqual([]);
    expect(findManyImportRow).not.toHaveBeenCalled();
  });
});

describe("返却上限 (総点検 2026-07-27: CSV/DM の取りこぼし)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("200 件を超えても切り捨てない (旧実装は 200 で打ち切っていた)", async () => {
    // 6,000 行の受付帳をファイル名だけで絞った状況を模す。
    const many = Array.from({ length: 1500 }, (_, i) => `p${i}`);
    const { prisma } = makePrisma({
      rowsByCall: [many.map((id) => ({ createdId: id }))],
      propertyIds: many,
    });
    const ids = await resolveMgmtIdToPropertyIds(prisma, "受付帳.xlsx");
    // 旧実装ではここが 200 になり、一覧の件数も CSV の行数も 200 に化けていた。
    expect(ids.length).toBe(1500);
  });

  it("上限超過は件数でなく overflowed で表す (@codex #330 R2)", async () => {
    // ⚠「上限+1 件返して CSV の行数ガードに当てる」で代用してはいけない。
    // CSV の where は管理IDに加えて案件状況・DM状況・日付・field_staff スコープを
    // AND するため、切り捨てた 10,001 件目以降にだけ条件を満たす行があると、
    // 最終行数は上限未満に収まり行数ガードが発火しない(= 黙って取りこぼす)。
    const many = Array.from({ length: 10_050 }, (_, i) => `p${i}`);
    const { prisma } = makePrisma({
      rowsByCall: [many.map((id) => ({ createdId: id }))],
      propertyIds: many,
    });
    const res = await resolveMgmtIdMatches(prisma, "受付帳.xlsx");
    expect(res.overflowed).toBe(true);
    expect(res.ids.length).toBe(MGMT_ID_MATCH_LIMIT);
  });

  it("上限ちょうどは超過ではない (境界)", async () => {
    const many = Array.from({ length: MGMT_ID_MATCH_LIMIT }, (_, i) => `p${i}`);
    const { prisma } = makePrisma({
      rowsByCall: [many.map((id) => ({ createdId: id }))],
      propertyIds: many,
    });
    const res = await resolveMgmtIdMatches(prisma, "受付帳.xlsx");
    expect(res.overflowed).toBe(false);
    expect(res.ids.length).toBe(MGMT_ID_MATCH_LIMIT);
  });

  it("補完用の小さい上限を渡せる (1打鍵ごとの巨大 IN 句を防ぐ)", async () => {
    const many = Array.from({ length: 500 }, (_, i) => `p${i}`);
    const { prisma } = makePrisma({
      rowsByCall: [many.map((id) => ({ createdId: id }))],
      propertyIds: many,
    });
    const ids = await resolveMgmtIdToPropertyIds(prisma, "受付帳.xlsx", {
      take: MGMT_ID_SUGGEST_LIMIT,
    });
    expect(ids.length).toBe(MGMT_ID_SUGGEST_LIMIT);
  });

  it("take を明示すればその値が優先される (呼び出し側の上書きは維持)", async () => {
    const many = Array.from({ length: 100 }, (_, i) => `p${i}`);
    const { prisma } = makePrisma({
      rowsByCall: [many.map((id) => ({ createdId: id }))],
      propertyIds: many,
    });
    const ids = await resolveMgmtIdToPropertyIds(prisma, "受付帳.xlsx", {
      take: 10,
    });
    expect(ids.length).toBe(10);
  });
});

describe("走査上限は take から導出する (@codex #330 R1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("10,000 行を超えて走査でき、超過を検出できる", async () => {
    // 固定20ページ (=10,000行) のままだと上限+1 件目に到達できず、
    // 「超過しているのに気づけない」側へ倒れて切り捨てた CSV が出ていた。
    const pages: Array<Array<{ createdId: string }>> = [];
    let n = 0;
    // 1ページ500行 × 25ページ = 12,500 行を返せるようにする
    for (let p = 0; p < 25; p++) {
      pages.push(
        Array.from({ length: 500 }, () => ({ createdId: `p${n++}` })),
      );
    }
    const all = Array.from({ length: n }, (_, i) => `p${i}`);
    const { prisma } = makePrisma({ rowsByCall: pages, propertyIds: all });

    const res = await resolveMgmtIdMatches(prisma, "受付帳.xlsx");
    expect(res.overflowed).toBe(true);
  });

  it("小さい take でも従来の最低ページ数は下回らない (非Property行の占有対策)", async () => {
    // 先頭に createdId 無しの行が大量に並んでも、実在 Property を拾えること。
    const pages: Array<Array<{ createdId: string | null }>> = [];
    for (let p = 0; p < 19; p++) {
      pages.push(Array.from({ length: 500 }, () => ({ createdId: null })));
    }
    pages.push([{ createdId: "deep" }]);
    const { prisma } = makePrisma({
      rowsByCall: pages as never,
      propertyIds: ["deep"],
    });

    const ids = await resolveMgmtIdToPropertyIds(prisma, "受付帳.xlsx", {
      take: 5,
    });
    expect(ids).toEqual(["deep"]);
  });
});

describe("超過判定は fail closed (@codex #330 R3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("走査上限で打ち切ったら『超えていない』と言わない", async () => {
    // 1 物件あたり取込行が 3 行あると、10,000 件を超える物件が実在しても
    // 走査窓 (行数ベース) に収まらず、件数だけ見ると上限未満に見える。
    // ここで overflowed=false を返すと、CSV は取りこぼしたまま出てしまう。
    // 同じ物件 id が 3 行ずつ並ぶ (取込を 3 回やり直した受付帳を模す)。
    const pages = Array.from({ length: 60 }, (_, page) =>
      Array.from({ length: 500 }, (_, i) => ({
        createdId: `p${Math.floor((page * 500 + i) / 3)}`,
      })),
    );
    const all = Array.from({ length: 10_000 }, (_, i) => `p${i}`);
    const { prisma } = makePrisma({ rowsByCall: pages, propertyIds: all });

    const res = await resolveMgmtIdMatches(prisma, "受付帳.xlsx");
    // 走査上限に当たった = 取りこぼしの有無が判らない → 出力を止める側へ倒す
    expect(res.overflowed).toBe(true);
  });

  it("入力行を最後まで見られたら超過ではないと言い切れる", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ createdId: `p${i}` }));
    const { prisma } = makePrisma({
      rowsByCall: [rows],
      propertyIds: rows.map((r) => r.createdId),
    });
    const res = await resolveMgmtIdMatches(prisma, "受付帳.xlsx");
    expect(res.overflowed).toBe(false);
    expect(res.ids.length).toBe(30);
  });
});
