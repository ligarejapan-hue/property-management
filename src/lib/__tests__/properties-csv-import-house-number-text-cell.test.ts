/**
 * POST /api/import/csv — 地番・家屋番号のテキスト数式セル（="<値>"）取込の統合テスト。
 *
 * 背景: 物件CSV export は Excel の日付自動変換を防ぐため、地番・家屋番号を `="<値>"` という
 * テキスト数式で出力する。再取込時はこの数式を unwrap して元値に戻す（出力→再取込の往復一致）。
 * 手入力 / 外部 CSV の生値（4-2 等）は unwrap 対象外でそのまま通る＝既存の取込仕様は不変。
 *
 * prisma は全面モック。permissions / csv パーサ / unwrap は実物を使用。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response {}
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    handleApiError: vi.fn((error: unknown) => {
      const e = error as { status?: number; message?: string; code?: string };
      if (typeof e?.status === "number") {
        return Response.json(
          { error: { message: e.message, code: e.code } },
          { status: e.status },
        );
      }
      return Response.json(
        { error: { message: "Server error", code: "INTERNAL_ERROR" } },
        { status: 500 },
      );
    }),
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data, { status }),
    ),
  };
});

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

vi.mock("@/lib/change-log", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/change-log")>();
  return { ...actual, recordChanges: vi.fn() };
});

vi.mock("@/lib/prisma", () => ({
  default: {
    importJob: { create: vi.fn(), update: vi.fn() },
    importJobRow: { create: vi.fn() },
    property: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    building: { findMany: vi.fn(), create: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { POST } from "../../app/api/import/csv/route";
import { wrapCsvTextCell } from "@/lib/csv-encode";

const pm = prisma as unknown as {
  importJob: { create: Mock; update: Mock };
  importJobRow: { create: Mock };
  property: { findMany: Mock; findUnique: Mock; create: Mock; update: Mock };
  building: { findMany: Mock; create: Mock };
};

const PERMS = [{ resource: "import", action: "write", granted: true }];

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/import/csv", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

function lastCreateData(): Record<string, unknown> {
  return pm.property.create.mock.calls.at(-1)?.[0]?.data ?? {};
}

// CSV 1セルを RFC4180 で出力するヘルパ（export の escapeCsvField 相当）。
function csvField(v: string): string {
  if (/["\n\r,]/.test(v) || /^\s|\s$/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue({
    id: "user-1",
    email: "a@a",
    name: "A",
    role: "admin",
  } as never);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS as never);

  pm.importJob.create.mockResolvedValue({ id: "job-1" });
  pm.importJob.update.mockResolvedValue({ id: "job-1" });
  pm.importJobRow.create.mockResolvedValue({ id: "row-1" });
  pm.property.findMany.mockResolvedValue([]);
  pm.building.findMany.mockResolvedValue([]);
  pm.property.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({
      id: "new-1",
      address: data.address,
      roomNo: data.roomNo ?? null,
      buildingId: data.buildingId ?? null,
      realEstateNumber: data.realEstateNumber ?? null,
      externalLinkKey: data.externalLinkKey ?? null,
      ...data,
    }),
  );
});

describe("POST /api/import/csv — 地番・家屋番号のテキスト数式 unwrap", () => {
  it('地番/家屋番号 ="4-2" を 4-2 に戻して保存する', async () => {
    // export が出す行（地番/家屋番号は ="値" でテキスト固定 → RFC quoting される）。
    const lot = csvField(wrapCsvTextCell("4-2")); // "=""4-2"""
    const bldg = csvField(wrapCsvTextCell("1-2-3"));
    const csv = `住所,地番,家屋番号\n東京都千代田区1-1,${lot},${bldg}\n`;
    const res = await POST(makeRequest({ fileName: "export.csv", csvText: csv }));
    expect(res.status).toBe(201);
    expect(lastCreateData().lotNumber).toBe("4-2");
    expect(lastCreateData().buildingNumber).toBe("1-2-3");
  });

  it("先頭0や全角を含む表記も unwrap で元どおり（整形しない）", async () => {
    const lot = csvField(wrapCsvTextCell("0100492"));
    const bldg = csvField(wrapCsvTextCell("１２３-４"));
    const csv = `住所,地番,家屋番号\n秋田県,${lot},${bldg}\n`;
    await POST(makeRequest({ fileName: "export.csv", csvText: csv }));
    expect(lastCreateData().lotNumber).toBe("0100492");
    expect(lastCreateData().buildingNumber).toBe("１２３-４");
  });

  it("手入力/外部CSVの生値（4-2 など）はそのまま取り込む（unwrap対象外）", async () => {
    const csv = "住所,地番,家屋番号\n東京都千代田区1-1,12-3,5-6\n";
    await POST(makeRequest({ fileName: "manual.csv", csvText: csv }));
    expect(lastCreateData().lotNumber).toBe("12-3");
    expect(lastCreateData().buildingNumber).toBe("5-6");
  });

  it("空のテキスト数式相当（空欄）は地番/家屋番号 未設定（既存値を潰さない）", async () => {
    const csv = "住所,地番,家屋番号\n東京都千代田区1-1,,\n";
    await POST(makeRequest({ fileName: "export.csv", csvText: csv }));
    expect("lotNumber" in lastCreateData()).toBe(false);
    expect("buildingNumber" in lastCreateData()).toBe(false);
  });

  it("値内に \" を含む地番も往復で元どおり（二重化の復元）", async () => {
    const lot = csvField(wrapCsvTextCell('4"2'));
    const csv = `住所,地番\n東京都千代田区1-1,${lot}\n`;
    await POST(makeRequest({ fileName: "export.csv", csvText: csv }));
    expect(lastCreateData().lotNumber).toBe('4"2');
  });
});
