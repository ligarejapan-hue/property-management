import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import {
  parseMgmtIdQuery,
  resolveMgmtIdToPropertyIds,
} from "../property-mgmt-id-search";

type Row = { createdId: string | null };

function makePrisma(opts: {
  rowsByCall?: Row[][];
  propertyIds?: string[];
}) {
  const rows = [...(opts.rowsByCall ?? [])];
  const findManyImportRow: Mock = vi.fn(async () => {
    return rows.shift() ?? [];
  });
  const findManyProperty: Mock = vi.fn(async ({ where }: any) => {
    const allowed = new Set(opts.propertyIds ?? []);
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
    });
  });

  it("fullwidth colon と末尾「行」省略", () => {
    expect(parseMgmtIdQuery("受付帳.xlsx:120").parsed).toEqual({
      fileNameHint: "受付帳.xlsx",
      rowNumber: 120,
    });
    expect(parseMgmtIdQuery("受付帳.xlsx:120").parsed).toEqual({
      fileNameHint: "受付帳.xlsx",
      rowNumber: 120,
    });
  });

  it("全角コロン", () => {
    expect(parseMgmtIdQuery("受付帳.xlsx:120行").parsed.fileNameHint).toBe(
      "受付帳.xlsx",
    );
  });

  it("rowNumber のみ", () => {
    expect(parseMgmtIdQuery("120行").parsed).toEqual({
      fileNameHint: null,
      rowNumber: 120,
    });
    expect(parseMgmtIdQuery("120").parsed).toEqual({
      fileNameHint: null,
      rowNumber: 120,
    });
  });

  it("fileName のみ", () => {
    expect(parseMgmtIdQuery("受付帳").parsed).toEqual({
      fileNameHint: "受付帳",
      rowNumber: null,
    });
  });

  it("trim + 空入力", () => {
    expect(parseMgmtIdQuery("   ").parsed).toEqual({
      fileNameHint: null,
      rowNumber: null,
    });
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
      // ImportJobRow は p1 と o1 を返すが Property 実在は p1 のみ
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

  it("take 上限が ImportJobRow.findMany に伝わる", async () => {
    const { prisma, findManyImportRow } = makePrisma({
      rowsByCall: [[], []],
      propertyIds: [],
    });
    await resolveMgmtIdToPropertyIds(prisma, "120", { take: 50 });
    for (const call of findManyImportRow.mock.calls as any[]) {
      expect(call[0].take).toBe(50);
    }
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
});
