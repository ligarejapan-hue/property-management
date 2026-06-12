/**
 * 物件CSV import の棟郵便番号取込（21-C タスク5）。
 *
 * 専用ヘッダ（棟郵便番号 / buildingPostalCode / building_postal_code）で、行が棟に
 * 解決される場合のみ Building.postalCode へ取り込む。Property.postalCode・Owner.zip とは
 * 完全分離。空欄は既存値を消さない・不正値は drop・行はエラーにしない。
 *
 * prisma は全面モック。recordChanges は spy（BUILDING_TRACKED_FIELDS は実物）。
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
    building: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
}));

import * as XLSX from "xlsx";
import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { recordChanges } from "@/lib/change-log";
import {
  POSTAL_CODE_HEADERS,
  BUILDING_POSTAL_CODE_HEADERS,
  OWNER_CSV_COLUMN_MAP,
} from "@/lib/csv-parser";
import { POST } from "../../app/api/import/csv/route";

const pm = prisma as unknown as {
  importJob: { create: Mock; update: Mock };
  importJobRow: { create: Mock };
  property: { findMany: Mock; findUnique: Mock; create: Mock; update: Mock };
  building: { findMany: Mock; findUnique: Mock; create: Mock; update: Mock };
};

const PERMS = [{ resource: "import", action: "write", granted: true }];

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/import/csv", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

function lastBuildingUpdate(): { where?: { id?: string }; data?: Record<string, unknown> } {
  return pm.building.update.mock.calls.at(-1)?.[0] ?? {};
}
function lastPropertyCreate(): Record<string, unknown> {
  return pm.property.create.mock.calls.at(-1)?.[0]?.data ?? {};
}

const EXISTING_BUILDING = {
  id: "b1",
  name: "パークタワー",
  address: "東京都港区1-1-1",
};

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
  pm.property.findMany.mockResolvedValue([]); // property dedupe index 空
  // 棟名一致で 1 件返す（resolveBuildingId が exact 一致で解決）
  pm.building.findMany.mockResolvedValue([EXISTING_BUILDING]);
  pm.building.findUnique.mockResolvedValue({ id: "b1", postalCode: null });
  pm.building.update.mockImplementation(
    ({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: "b1", ...data }),
  );
  pm.property.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({
      id: "p-new",
      address: data.address,
      roomNo: data.roomNo ?? null,
      buildingId: data.buildingId ?? null,
      realEstateNumber: data.realEstateNumber ?? null,
      externalLinkKey: data.externalLinkKey ?? null,
      ...data,
    }),
  );
});

/** ユニット行（棟名あり）の CSV を作る。 */
function unitCsv(postalHeader: string, postalValue: string): string {
  return (
    `住所,棟名,部屋番号,${postalHeader}\n` +
    `東京都港区1-1-1,パークタワー,101,${postalValue}\n`
  );
}

describe("POST /api/import/csv — 棟郵便番号取込（タスク5）", () => {
  it("棟郵便番号 valid + 既存棟マッチ → building.update(postalCode) + change-log", async () => {
    const csv = unitCsv("棟郵便番号", "100-0005");
    const res = await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(res.status).toBe(201);
    expect(pm.building.update).toHaveBeenCalledTimes(1);
    expect(lastBuildingUpdate().where?.id).toBe("b1");
    expect(lastBuildingUpdate().data?.postalCode).toBe("1000005");

    expect(recordChanges).toHaveBeenCalled();
    const buildingChange = vi
      .mocked(recordChanges)
      .mock.calls.map((c) => c[0])
      .find((a) => a.targetTable === "buildings");
    expect(buildingChange).toBeTruthy();
    expect((buildingChange!.newValues as Record<string, unknown>).postalCode).toBe("1000005");
    expect(buildingChange!.trackedFields).toContain("postalCode");
    expect(buildingChange!.source).toBe("csv_import");
  });

  it("英語ヘッダ building_postal_code も棟へ取り込む", async () => {
    const csv = unitCsv("building_postal_code", "0100492");
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(lastBuildingUpdate().data?.postalCode).toBe("0100492");
  });

  it("正規化: 棟郵便番号 010-0492 → 0100492 / 全角 ０１０−０４９２ → 0100492", async () => {
    await POST(makeRequest({ fileName: "a.csv", csvText: unitCsv("棟郵便番号", "010-0492") }));
    expect(lastBuildingUpdate().data?.postalCode).toBe("0100492");
    vi.clearAllMocks();
    // beforeEach 相当の再セット
    pm.importJob.create.mockResolvedValue({ id: "job-1" });
    pm.importJob.update.mockResolvedValue({ id: "job-1" });
    pm.importJobRow.create.mockResolvedValue({ id: "row-1" });
    pm.property.findMany.mockResolvedValue([]);
    pm.building.findMany.mockResolvedValue([EXISTING_BUILDING]);
    pm.building.findUnique.mockResolvedValue({ id: "b1", postalCode: null });
    pm.building.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: "b1", ...data }));
    pm.property.create.mockResolvedValue({ id: "p", address: "x", roomNo: null, buildingId: "b1", realEstateNumber: null, externalLinkKey: null });
    vi.mocked(getApiSession).mockResolvedValue({ id: "user-1", email: "a", name: "A", role: "admin" } as never);
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS as never);
    await POST(makeRequest({ fileName: "b.csv", csvText: unitCsv("棟郵便番号", "０１０−０４９２") }));
    expect(lastBuildingUpdate().data?.postalCode).toBe("0100492");
  });

  it("空欄 → 既存 Building.postalCode 維持（building.update 呼ばれない）", async () => {
    pm.building.findUnique.mockResolvedValue({ id: "b1", postalCode: "9999999" });
    const csv = unitCsv("棟郵便番号", "");
    const res = await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(res.status).toBe(201);
    expect(pm.building.update).not.toHaveBeenCalled();
  });

  it("不正値（桁不足）→ drop・building.update 呼ばれない・行は成功", async () => {
    const csv = unitCsv("棟郵便番号", "12345");
    const res = await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    const json = (await res.json()) as { successCount: number; errorCount: number };
    expect(json.successCount).toBe(1);
    expect(json.errorCount).toBe(0);
    expect(pm.building.update).not.toHaveBeenCalled();
  });

  it("既存値と同一 → building.update 呼ばれない（変化時のみ）", async () => {
    pm.building.findUnique.mockResolvedValue({ id: "b1", postalCode: "1000005" });
    const csv = unitCsv("棟郵便番号", "100-0005");
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(pm.building.update).not.toHaveBeenCalled();
  });

  it("同一棟の2行 → building.update は1回（once-per-building）", async () => {
    const csv =
      "住所,棟名,部屋番号,棟郵便番号\n" +
      "東京都港区1-1-1,パークタワー,101,100-0005\n" +
      "東京都港区1-1-1,パークタワー,102,100-0005\n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(pm.building.update).toHaveBeenCalledTimes(1);
  });

  it("棟が無い行（非ユニット）→ 棟郵便番号は drop・building 書込なし・行は成功", async () => {
    // 棟名なし=非ユニット。棟郵便番号だけ指定
    const csv = "住所,棟郵便番号\n東京都千代田区1-1,100-0005\n";
    const res = await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    const json = (await res.json()) as { successCount: number };
    expect(json.successCount).toBe(1);
    expect(pm.building.update).not.toHaveBeenCalled();
    // Property.postalCode にも漏れない（棟郵便番号は Property 用ではない）
    expect("postalCode" in lastPropertyCreate()).toBe(false);
  });

  it("Property.postalCode と棟郵便番号の分離: 両方指定で独立保存・Owner非関与", async () => {
    const csv =
      "住所,棟名,部屋番号,郵便番号,棟郵便番号\n" +
      "東京都港区1-1-1,パークタワー,101,160-0023,100-0005\n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    // Property 側 = 郵便番号
    expect(lastPropertyCreate().postalCode).toBe("1600023");
    // Building 側 = 棟郵便番号
    expect(lastBuildingUpdate().data?.postalCode).toBe("1000005");
  });

  it("棟郵便番号は Property.postalCode を汚染しない（棟のみ指定時）", async () => {
    const csv = unitCsv("棟郵便番号", "100-0005");
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    // Property 側 postalCode は未設定（棟郵便番号は Property に入らない）
    expect("postalCode" in lastPropertyCreate()).toBe(false);
  });

  it("XLSX 棟郵便番号 書式付き数値セル(0000000/値100492)→ .w回収→ 0100492 保存", async () => {
    const ws: Record<string, unknown> = { "!ref": "A1:D2" };
    ws["A1"] = { t: "s", v: "住所" };
    ws["B1"] = { t: "s", v: "棟名" };
    ws["C1"] = { t: "s", v: "部屋番号" };
    ws["D1"] = { t: "s", v: "棟郵便番号" };
    ws["A2"] = { t: "s", v: "東京都港区1-1-1" };
    ws["B2"] = { t: "s", v: "パークタワー" };
    ws["C2"] = { t: "s", v: "101" };
    ws["D2"] = { t: "n", v: 100492, z: "0000000" };
    const wb = { SheetNames: ["S"], Sheets: { S: ws } };
    const xlsxBase64 = (XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer).toString("base64");
    await POST(makeRequest({ fileName: "x.xlsx", xlsxBase64 }));
    expect(lastBuildingUpdate().data?.postalCode).toBe("0100492");
  });
});

describe("郵便番号ヘッダ集合の分離（Property / Building / Owner）", () => {
  it("BUILDING_POSTAL_CODE_HEADERS は棟3ヘッダを含む", () => {
    expect(BUILDING_POSTAL_CODE_HEADERS.has("棟郵便番号")).toBe(true);
    expect(BUILDING_POSTAL_CODE_HEADERS.has("buildingPostalCode")).toBe(true);
    expect(BUILDING_POSTAL_CODE_HEADERS.has("building_postal_code")).toBe(true);
  });

  it("POSTAL_CODE_HEADERS(Property用)は棟ヘッダを含まない", () => {
    expect(POSTAL_CODE_HEADERS.has("棟郵便番号")).toBe(false);
    expect(POSTAL_CODE_HEADERS.has("郵便番号")).toBe(true);
  });

  it("2集合は素である（Property と Building のヘッダが重複しない）", () => {
    for (const h of BUILDING_POSTAL_CODE_HEADERS) {
      expect(POSTAL_CODE_HEADERS.has(h)).toBe(false);
    }
  });

  it("Owner の郵便番号(zip)マップは非影響（bare 郵便番号→zip のまま）", () => {
    expect(OWNER_CSV_COLUMN_MAP["郵便番号"]).toBe("zip");
    expect(OWNER_CSV_COLUMN_MAP["棟郵便番号"]).toBeUndefined();
  });
});
