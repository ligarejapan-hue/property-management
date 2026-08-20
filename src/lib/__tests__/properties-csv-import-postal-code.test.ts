/**
 * POST /api/import/csv（物件CSV取込）の郵便番号列取込に関する統合テスト（21-C PR-3c）。
 *
 * 確認項目:
 *  1. 「郵便番号」列ありCSVで Property.postalCode が保存される（create）
 *  2. `010-0492` が `0100492` として保存される（ハイフン正規化）
 *  3. `０１０−０４９２` が `0100492` として保存される（全角→半角＋ダッシュ正規化）
 *  4. 先頭0が保持される
 *  5. 空欄 create時は postalCode 未設定（createData に postalCode キーが乗らない）
 *  6. 空欄 update時は既存値を維持する（update データに postalCode を含めない）
 *  7. 不正値は drop され、行自体は成功する
 *  8. 旧CSV（郵便番号列なし）でも従来どおり取り込める
 *  9. columnMapping経由で「郵便番号」が取り込める
 * 10. columnMappingなしの自動マッピングでも「郵便番号」が取り込める
 * 11. export形式15列CSVを再取込できる
 * 12. update時に postalCode が change-log（recordChanges）へ渡される
 *
 * prisma は全面モック。recordChanges は spy（PROPERTY_TRACKED_FIELDS は実物を使用）。
 * 郵便番号正規化（normalizePostalCode / isValidPostalCode）と permissions は実物を使用する。
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

// recordChanges だけ spy にし、PROPERTY_TRACKED_FIELDS 等は実物を維持する。
vi.mock("@/lib/change-log", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/change-log")>();
  return { ...actual, recordChanges: vi.fn() };
});

vi.mock("@/lib/prisma", () => ({
  default: {
    importJob: { create: vi.fn(), update: vi.fn() },
    importJobRow: { create: vi.fn() },
    property: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      // 重複更新は scheduled ガード付きの updateMany 経由(@codex #394 R27)。
      updateMany: vi.fn(),
    },
    building: { findMany: vi.fn(), create: vi.fn() },
  },
}));

import * as XLSX from "xlsx";
import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { recordChanges } from "@/lib/change-log";
import { POST } from "../../app/api/import/csv/route";

const pm = prisma as unknown as {
  importJob: { create: Mock; update: Mock };
  importJobRow: { create: Mock };
  property: {
    findMany: Mock;
    findUnique: Mock;
    findUniqueOrThrow: Mock;
    create: Mock;
    update: Mock;
    updateMany: Mock;
  };
  building: { findMany: Mock; create: Mock };
};

const PERMS = [{ resource: "import", action: "write", granted: true }];

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/import/csv", {
    method: "POST",
    headers: { "content-type": "application/json" , "content-length": String(Buffer.byteLength(JSON.stringify(body))) },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

/** property.create に渡された data を取得（最後の呼び出し）。 */
function lastCreateData(): Record<string, unknown> {
  return pm.property.create.mock.calls.at(-1)?.[0]?.data ?? {};
}

/** 重複更新(updateMany)に渡された data を取得（最後の呼び出し）。 */
function lastUpdateData(): Record<string, unknown> {
  return pm.property.updateMany.mock.calls.at(-1)?.[0]?.data ?? {};
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
  pm.property.findMany.mockResolvedValue([]); // dedupe index は空（=新規作成）
  pm.building.findMany.mockResolvedValue([]);
  // create は渡された data を反映して返す（route が id/address 等を後続利用する）
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

describe("POST /api/import/csv — 郵便番号取込（create）", () => {
  it("1. 郵便番号列ありCSVで Property.postalCode が保存される", async () => {
    const csv = "住所,郵便番号\n東京都千代田区1-1,1000005\n";
    const res = await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(res.status).toBe(201);
    expect(pm.property.create).toHaveBeenCalledTimes(1);
    expect(lastCreateData().postalCode).toBe("1000005");
  });

  it("2. 010-0492 が 0100492 として保存される", async () => {
    const csv = "住所,郵便番号\n秋田県南秋田郡,010-0492\n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(lastCreateData().postalCode).toBe("0100492");
  });

  it("3. 全角 ０１０−０４９２ が 0100492 として保存される", async () => {
    const csv = "住所,郵便番号\n秋田県南秋田郡,０１０−０４９２\n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(lastCreateData().postalCode).toBe("0100492");
  });

  it("4. 先頭0が保持される", async () => {
    const csv = "住所,郵便番号\n秋田県南秋田郡,0100492\n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    const v = lastCreateData().postalCode as string;
    expect(v).toBe("0100492");
    expect(v.startsWith("0")).toBe(true);
  });

  it("5. 空欄 create時は postalCode 未設定（createData に postalCode キーなし）", async () => {
    const csv = "住所,郵便番号\n東京都千代田区1-1,\n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(pm.property.create).toHaveBeenCalledTimes(1);
    expect("postalCode" in lastCreateData()).toBe(false);
  });

  it("7. 不正値（桁不足）は drop され行は成功する", async () => {
    const csv = "住所,郵便番号\n東京都千代田区1-1,12345\n";
    const res = await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    const json = (await res.json()) as { successCount: number; errorCount: number };
    expect(json.successCount).toBe(1);
    expect(json.errorCount).toBe(0);
    expect("postalCode" in lastCreateData()).toBe(false);
  });

  it("8. 旧CSV（郵便番号列なし）でも従来どおり取り込める", async () => {
    const csv = "住所,地番\n東京都千代田区1-1,12-3\n";
    const res = await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    const json = (await res.json()) as { successCount: number };
    expect(json.successCount).toBe(1);
    expect("postalCode" in lastCreateData()).toBe(false);
    expect(lastCreateData().lotNumber).toBe("12-3");
  });

  it("9. columnMapping経由で郵便番号が取り込める", async () => {
    const csv = "Addr,Zip\n東京都千代田区1-1,1000005\n";
    await POST(
      makeRequest({
        fileName: "x.csv",
        csvText: csv,
        columnMapping: { Addr: "住所", Zip: "郵便番号" },
      }),
    );
    expect(lastCreateData().postalCode).toBe("1000005");
  });

  it("10. columnMappingなしの自動マッピング（英語 postal_code）でも取り込める", async () => {
    const csv = "address,postal_code\n東京都千代田区1-1,1000005\n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(lastCreateData().postalCode).toBe("1000005");
  });

  it("11. export形式15列CSVを再取込でき、郵便番号が保存される", async () => {
    const headers =
      "管理ID,物件種別,住所,地番,家屋番号,不動産番号,登記状況,DM判断,案件ステータス,導入ルート,担当者名,所有者名,更新日時,作成日時,郵便番号";
    const row =
      "M-001,土地,東京都千代田区1-1,12-3,,RE-9,未確認,保留,新規,受付CSV,担当 太郎,所有 花子,2026-05-01 12:00,2026-04-01 09:00,100-0005";
    const csv = `${headers}\n${row}\n`;
    const res = await POST(makeRequest({ fileName: "export.csv", csvText: csv }));
    const json = (await res.json()) as { successCount: number };
    expect(json.successCount).toBe(1);
    expect(lastCreateData().postalCode).toBe("1000005");
  });
});

describe("POST /api/import/csv — 郵便番号取込（update）", () => {
  // realEstateNumber 一致で update-eligible な重複をセットアップする。
  const existingForDedupe = {
    id: "p-existing",
    address: "東京都千代田区1-1",
    roomNo: null,
    buildingId: null,
    realEstateNumber: "RE-1",
    externalLinkKey: null,
  };

  beforeEach(() => {
    pm.property.findMany.mockResolvedValue([existingForDedupe]);
    pm.property.updateMany.mockResolvedValue({ count: 1 });
    pm.property.findUniqueOrThrow.mockResolvedValue({
      id: "p-existing",
      address: "東京都千代田区1-1",
      roomNo: null,
      buildingId: null,
      realEstateNumber: "RE-1",
      externalLinkKey: null,
    });
  });

  it("12. update時に postalCode が変更され change-log に渡される", async () => {
    pm.property.findUnique.mockResolvedValue({
      id: "p-existing",
      address: "東京都千代田区1-1",
      postalCode: null,
      realEstateNumber: "RE-1",
    });
    const csv = "住所,不動産番号,郵便番号\n東京都千代田区1-1,RE-1,100-0005\n";
    const res = await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(res.status).toBe(201);
    expect(pm.property.updateMany).toHaveBeenCalledTimes(1);
    expect(lastUpdateData().postalCode).toBe("1000005");

    expect(recordChanges).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(recordChanges).mock.calls[0][0];
    expect((arg.newValues as Record<string, unknown>).postalCode).toBe("1000005");
    expect(arg.trackedFields).toContain("postalCode");
    expect(arg.source).toBe("csv_import");
  });

  it("6. 空欄 update時は既存 postalCode を維持する（update データに postalCode を含めない）", async () => {
    pm.property.findUnique.mockResolvedValue({
      id: "p-existing",
      address: "東京都千代田区1-1",
      postalCode: "9999999",
      note: "old",
      realEstateNumber: "RE-1",
    });
    // note を変更して update 自体は発火させつつ、郵便番号は空欄
    const csv = "住所,不動産番号,郵便番号,備考\n東京都千代田区1-1,RE-1,,新メモ\n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(pm.property.updateMany).toHaveBeenCalledTimes(1);
    expect("postalCode" in lastUpdateData()).toBe(false);
    expect(lastUpdateData().note).toBe("新メモ");
  });
});

describe("POST /api/import/csv — XLSX 郵便番号 formatted-text 取込（タスク4）", () => {
  /** 住所 + 郵便番号(セル指定) の XLSX base64 を作る。 */
  function makeXlsx(
    postalCell: { t: string; v: unknown; z?: string },
    address = "秋田県南秋田郡",
  ): string {
    const ws: Record<string, unknown> = { "!ref": "A1:B2" };
    ws["A1"] = { t: "s", v: "住所" };
    ws["B1"] = { t: "s", v: "郵便番号" };
    ws["A2"] = { t: "s", v: address };
    ws["B2"] = postalCell.z
      ? { t: postalCell.t, v: postalCell.v, z: postalCell.z }
      : { t: postalCell.t, v: postalCell.v };
    const wb = { SheetNames: ["S"], Sheets: { S: ws } };
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    return buf.toString("base64");
  }

  it("郵便書式数値セル(0000000/値100492)→ .w回収→ 0100492 保存", async () => {
    const xlsxBase64 = makeXlsx({ t: "n", v: 100492, z: "0000000" });
    const res = await POST(makeRequest({ fileName: "x.xlsx", xlsxBase64 }));
    expect(res.status).toBe(201);
    expect(lastCreateData().postalCode).toBe("0100492");
  });

  it("ハイフン入り書式(000-0000/値100492)→ .w=010-0492→ normalize→ 0100492 保存", async () => {
    const xlsxBase64 = makeXlsx({ t: "n", v: 100492, z: "000-0000" });
    await POST(makeRequest({ fileName: "x.xlsx", xlsxBase64 }));
    expect(lastCreateData().postalCode).toBe("0100492");
  });

  it("General数値セル(値100492・Excel時点で0喪失)→ 回収不能→ drop（fail-closed維持）", async () => {
    const xlsxBase64 = makeXlsx({ t: "n", v: 100492 });
    const res = await POST(makeRequest({ fileName: "x.xlsx", xlsxBase64 }));
    expect(res.status).toBe(201);
    // 6桁ゆえ不正→ drop（左0詰めの誤補正をしない）
    expect("postalCode" in lastCreateData()).toBe(false);
  });

  it("テキストセル 010-0492 → 0100492 保存", async () => {
    const xlsxBase64 = makeXlsx({ t: "s", v: "010-0492" });
    await POST(makeRequest({ fileName: "x.xlsx", xlsxBase64 }));
    expect(lastCreateData().postalCode).toBe("0100492");
  });
});
