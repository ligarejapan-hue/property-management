/**
 * GET /api/properties/property-dm-export(物件宛DM 差込 CSV 出力)の統合テスト。
 *
 * 宛先=物件住所(Property.postalCode → Building.postalCode → 空欄 / NNN-NNNN)、
 * 宛名=代表所有者名+敬称(個人=様/法人=御中・複数は「様 他共有者様」)、1物件=1行。
 *
 * permissions / maskValue / csv-encode / property-list-query / property-types /
 * property-dm-export / address-lookup/normalize は実物を使用し、
 * 権限ゲート・マスキング・BOM/CRLF・行展開・郵便番号フォールバック・
 * formula injection 無害化を実挙動で検証する。
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
    getOwnerDisplayConfig: vi.fn(),
    handleApiError: vi.fn((error: unknown) => {
      if (error instanceof MockApiError) {
        return Response.json(
          { error: { message: error.message, code: error.code } },
          { status: error.status },
        );
      }
      return Response.json(
        { error: { message: "Server error", code: "INTERNAL_ERROR" } },
        { status: 500 },
      );
    }),
  };
});

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findMany: vi.fn(), count: vi.fn() },
    importJobRow: { findMany: vi.fn() },
    // export は CSV 生成であり送付履歴ではない。PropertyDmLog には一切書き込まない。
    propertyDmLog: { create: vi.fn(), createMany: vi.fn(), update: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { GET } from "../../app/api/properties/property-dm-export/route";

const pm = prisma as unknown as {
  property: { findMany: Mock; count: Mock };
  importJobRow: { findMany: Mock };
  propertyDmLog: { create: Mock; createMany: Mock; update: Mock };
};

const PERMS_FULL = [
  { resource: "property", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "csv_export", action: "read", granted: true },
  { resource: "csv_export_personal", action: "read", granted: true },
];
const PERMS_NO_PROPERTY = PERMS_FULL.filter((p) => p.resource !== "property");
const PERMS_NO_CSV_EXPORT = PERMS_FULL.filter((p) => p.resource !== "csv_export");
const PERMS_NO_CSV_PERSONAL = PERMS_FULL.filter((p) => p.resource !== "csv_export_personal");
const PERMS_NO_OWNER = PERMS_FULL.filter((p) => p.resource !== "owner");

const FULL_DISPLAY = {
  name: "full",
  nameKana: "full",
  phone: "full",
  zip: "full",
  address: "full",
  note: "full",
  email: "full",
  corporateNumber: "full",
};

function makeOwner(over: Record<string, unknown> = {}) {
  return { name: "所有 花子", corporateNumber: null, ...over };
}

function makePropertyOwner(over: Record<string, unknown> = {}) {
  const { owner, ...rest } = over;
  return {
    isPrimary: true,
    ...rest,
    owner: makeOwner((owner as Record<string, unknown>) ?? {}),
  };
}

function makeProp(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    address: "東京都千代田区1-1",
    postalCode: "100-0001",
    propertyType: "land",
    roomNo: null,
    building: null,
    propertyOwners: [makePropertyOwner()],
    ...over,
  };
}

function makeRequest(qs = "") {
  return new Request(`http://localhost/api/properties/property-dm-export${qs}`, {
    method: "GET",
  }) as unknown as import("next/server").NextRequest;
}

function lastAudit(): any {
  return vi.mocked(writeAuditLog).mock.calls.at(-1)?.[0];
}

async function readCsv(res: Response): Promise<string> {
  const buf = new Uint8Array(await res.arrayBuffer());
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf);
}

function headerIndex(csv: string, col: string): number {
  return csv.split("\r\n")[0].replace(/^﻿/, "").split(",").indexOf(col);
}
function rowCells(csv: string, needle: string): string[] {
  const line = csv
    .split("\r\n")
    .filter((l) => l.length > 0)
    .find((l) => l.includes(needle));
  if (!line) throw new Error(`row containing ${needle} not found`);
  return line.split(",");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue({
    id: "user-admin", email: "a@a", name: "A", role: "admin",
  } as any);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL as any);
  vi.mocked(getOwnerDisplayConfig).mockResolvedValue(FULL_DISPLAY as any);
  pm.property.findMany.mockResolvedValue([]);
  pm.property.count.mockResolvedValue(0);
  pm.importJobRow.findMany.mockResolvedValue([]);
});

describe("GET /api/properties/property-dm-export", () => {
  it("01. dmStatus=send / isArchived=false をサーバ側で強制(client の hold/no_send/includeArchived を無視)", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    await GET(makeRequest("?dmStatus=no_send&includeArchived=true"));
    const where = pm.property.findMany.mock.calls[0][0].where;
    expect(where.dmStatus).toBe("send");
    expect(where.isArchived).toBe(false);
  });

  it("02. 1物件=1行(単独所有者・宛名は様)", async () => {
    pm.property.findMany.mockResolvedValue([makeProp({ address: "住所A" })]);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const csv = await readCsv(res);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2); // ヘッダ + 1 行
    expect(csv).toContain("住所A");
    const cells = rowCells(csv, "所有 花子");
    expect(cells[headerIndex(csv, "敬称")]).toBe("様");
    expect(cells[headerIndex(csv, "DM判断")]).toBe("送付可");
  });

  it("03. 複数所有者でも 1物件=1行・敬称は『様 他共有者様』・共有者数2", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        propertyOwners: [
          makePropertyOwner({ owner: { name: "代表 太郎" }, isPrimary: true }),
          makePropertyOwner({ owner: { name: "共有 次郎" }, isPrimary: false }),
        ],
      }),
    ]);
    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const cells = rowCells(csv, "代表 太郎");
    expect(cells[headerIndex(csv, "敬称")]).toBe("様 他共有者様");
    expect(cells[headerIndex(csv, "共有者数")]).toBe("2");
    expect(csv).toContain("代表 太郎、共有 次郎");
  });

  it("04. 法人単独(法人番号あり)は御中", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        propertyOwners: [
          makePropertyOwner({ owner: { name: "法人A", corporateNumber: "1234567890123" } }),
        ],
      }),
    ]);
    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    expect(rowCells(csv, "法人A")[headerIndex(csv, "敬称")]).toBe("御中");
  });

  it("04b. 法人代表+複数所有者は『御中 他共有者様』(例:〇〇株式会社 御中 他共有者様)", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        propertyOwners: [
          makePropertyOwner({ owner: { name: "〇〇株式会社", corporateNumber: "1234567890123" }, isPrimary: true }),
          makePropertyOwner({ owner: { name: "共有 個人" }, isPrimary: false }),
        ],
      }),
    ]);
    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    const cells = rowCells(csv, "〇〇株式会社");
    expect(cells[headerIndex(csv, "所有者名")]).toBe("〇〇株式会社");
    expect(cells[headerIndex(csv, "敬称")]).toBe("御中 他共有者様");
  });

  it("04c. 法人番号なしの組織名（管理組合）→ 御中（DQ-05 配線・名称ベース判定で 様→御中）", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        propertyOwners: [
          makePropertyOwner({
            owner: { name: "〇〇マンション管理組合", corporateNumber: null },
          }),
        ],
      }),
    ]);
    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    const cells = rowCells(csv, "〇〇マンション管理組合");
    expect(cells[headerIndex(csv, "敬称")]).toBe("御中");
  });

  it("05. 非アーカイブ所有者0件の物件は出力されず skippedCount に反映", async () => {
    // some 述語で fetch 対象外だが、race 防御で空所有者が返っても行にしない。
    pm.property.findMany.mockResolvedValue([makeProp({ propertyOwners: [] })]);
    pm.property.count.mockResolvedValue(3);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const csv = await readCsv(res);
    expect(csv.split("\r\n").filter((l) => l.length > 0)).toHaveLength(1); // ヘッダのみ
    const audit = lastAudit();
    expect(audit.detail.resultCount).toBe(0);
    expect(audit.detail.skippedCount).toBe(3);
  });

  it("06. fetch は非アーカイブ所有者を1名以上持つ物件に限定 + take=MAX+1、select は非アーカイブ所有者のみ", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    await GET(makeRequest());
    const call = pm.property.findMany.mock.calls[0][0];
    expect(call.where.AND).toContainEqual({
      propertyOwners: { some: { owner: { isArchived: false } } },
    });
    expect(call.take).toBe(10001);
    expect(call.select.propertyOwners.where).toEqual({ owner: { isArchived: false } });
    // 郵便番号フォールバック用に building.postalCode と property.postalCode を select する
    expect(call.select.postalCode).toBe(true);
    expect(call.select.building.select.postalCode).toBe(true);
  });

  it("07. 郵便番号フォールバック: Property.postalCode 空 → Building.postalCode を NNN-NNNN で出力", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({ postalCode: null, building: { postalCode: "1000001" } }),
    ]);
    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    expect(rowCells(csv, "所有 花子")[headerIndex(csv, "郵便番号")]).toBe("100-0001");
  });

  it("08. 郵便番号は Property.postalCode を Building より優先", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({ postalCode: "2000002", building: { postalCode: "1000001" } }),
    ]);
    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    expect(rowCells(csv, "所有 花子")[headerIndex(csv, "郵便番号")]).toBe("200-0002");
    expect(csv).not.toContain("100-0001");
  });

  it("09. formula injection を全セルに sanitizeCsvCellForExcel 適用(=,+,-,@ の4文字を別セルで無害化)", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        address: "=1+1", // 物件住所: = 始まり
        postalCode: "@evil", // 郵便番号(不妥当=素のまま): @ 始まり
        roomNo: "-99", // 部屋番号: - 始まり
        propertyOwners: [
          makePropertyOwner({ owner: { name: "+SUM(A1:A2)" } }), // 所有者名: + 始まり
        ],
      }),
    ]);
    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    // = / + / - / @ で始まる全セルが先頭に ' を付与され無害化される
    expect(csv).toContain("'=1+1"); // 物件住所
    expect(csv).toContain("'+SUM(A1:A2)"); // 所有者名(送付先一覧も同様に無害化)
    expect(csv).toContain("'-99"); // 部屋番号
    expect(csv).toContain("'@evil"); // 郵便番号
    // 生の(無害化前の)値が CSV にそのまま現れない
    expect(csv).not.toMatch(/(^|,|\r\n)=1\+1/);
    expect(csv).not.toMatch(/(^|,|\r\n)-99/);
  });

  it("10. UTF-8 BOM + CRLF + ヘッダ列順(10列)", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    const res = await GET(makeRequest());
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(buf.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf);
    expect(csv).toContain("\r\n");
    expect(csv).not.toMatch(/[^\r]\n/);
    expect(csv.split("\r\n")[0].replace(/^﻿/, "")).toBe(
      "管理ID,郵便番号,物件住所,部屋番号,所有者名,敬称,物件種別,DM判断,送付先所有者名一覧,共有者数",
    );
  });

  it("11. property:read 欠如で 403(副作用なし)", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_PROPERTY as any);
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    expect(pm.property.findMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("12. csv_export:read 欠如で 403(副作用なし)", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_CSV_EXPORT as any);
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    expect(pm.property.findMany).not.toHaveBeenCalled();
  });

  it("13. csv_export_personal:read 欠如で 403(副作用なし)", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_CSV_PERSONAL as any);
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    expect(pm.property.findMany).not.toHaveBeenCalled();
  });

  it("14. owner:read 欠如で 403(副作用なし)", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_OWNER as any);
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    expect(pm.property.findMany).not.toHaveBeenCalled();
  });

  it("15. 氏名表示レベルが masked/partial/hidden なら 403(副作用なし)", async () => {
    for (const badLevel of ["masked", "partial", "hidden"] as const) {
      vi.clearAllMocks();
      vi.mocked(getApiSession).mockResolvedValue({ id: "u", role: "admin" } as any);
      vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL as any);
      vi.mocked(getOwnerDisplayConfig).mockResolvedValue({ ...FULL_DISPLAY, name: badLevel } as any);
      pm.property.findMany.mockResolvedValue([makeProp()]);
      const res = await GET(makeRequest());
      expect(res.status, `name=${badLevel}`).toBe(403);
      expect(pm.property.findMany).not.toHaveBeenCalled();
      expect(writeAuditLog).not.toHaveBeenCalled();
    }
  });

  it("16. zip/address の表示レベルが masked/hidden でも氏名が生値なら 200(物件住所宛のため緩和)", async () => {
    // #169 との差: 所有者の zip/address は出力しないので、その表示レベルはゲートしない。
    vi.mocked(getOwnerDisplayConfig).mockResolvedValue({
      ...FULL_DISPLAY, zip: "hidden", address: "masked",
    } as any);
    pm.property.findMany.mockResolvedValue([makeProp()]);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
  });

  it("17. AuditLog は PII 非含有・action 名・件数(keyword/mgmtId 生値を残さない)", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({ propertyOwners: [makePropertyOwner({ owner: { name: "秘密 花子" } })] }),
    ]);
    await GET(
      makeRequest("?keyword=" + encodeURIComponent("東京都千代田区") + "&mgmtId=受付帳.xlsx:1行&propertyType=land"),
    );
    const audit = lastAudit();
    expect(audit.action).toBe("property_address_dm_csv_export");
    expect(audit.targetTable).toBe("properties");
    const detailStr = JSON.stringify(audit.detail);
    expect(detailStr).not.toContain("秘密 花子");
    expect(detailStr).not.toContain("東京都千代田区");
    expect(detailStr).not.toContain("受付帳.xlsx");
    for (const key of Object.keys(audit.detail)) {
      expect(key.toLowerCase()).not.toContain("owner");
    }
    expect(audit.detail.filters.propertyType).toBe("land");
    expect(audit.detail.filters.dmStatus).toBe("send");
    expect(audit.detail.filters.keyword).toBeUndefined();
    expect(audit.detail.filters.mgmtId).toBeUndefined();
  });

  it("18. 取得物件数 > MAX で 400(取込元逆引き / COUNT / AuditLog 未実行)", async () => {
    const many = Array.from({ length: 10001 }, (_, i) => makeProp({ id: `p${i}` }));
    pm.property.findMany.mockResolvedValue(many);
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("EXPORT_LIMIT_EXCEEDED");
    expect(pm.importJobRow.findMany).not.toHaveBeenCalled();
    expect(pm.property.count).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
    expect(res.headers.get("Content-Type")).not.toBe("text/csv; charset=utf-8");
  });

  it("19. ちょうど MAX(10000)→ 200・全行出力", async () => {
    const many = Array.from({ length: 10000 }, (_, i) => makeProp({ id: `p${i}` }));
    pm.property.findMany.mockResolvedValue(many);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const csv = await readCsv(res);
    expect(csv.split("\r\n").filter((l) => l.length > 0)).toHaveLength(10001);
    expect(lastAudit().detail.resultCount).toBe(10000);
  });

  it("20. 0件 → ヘッダのみ CSV / 200", async () => {
    pm.property.findMany.mockResolvedValue([]);
    const res = await GET(makeRequest("?propertyType=land"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    const csv = await readCsv(res);
    expect(csv.split("\r\n").filter((l) => l.length > 0)).toHaveLength(1);
    expect(csv).toContain("管理ID");
  });

  it("21. レスポンスヘッダ(Content-Type / Content-Disposition=property_dm_ / Cache-Control)", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    const res = await GET(makeRequest());
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    const cd = res.headers.get("Content-Disposition") ?? "";
    expect(cd).toContain("property_dm_");
    expect(cd).toContain(".csv");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("22. 管理ID(取込元)が CSV に出る", async () => {
    pm.property.findMany.mockResolvedValue([makeProp({ id: "p1" })]);
    pm.importJobRow.findMany.mockResolvedValue([
      { createdId: "p1", rowNumber: 5, rawData: { __sourceRef: "MGMT-001" }, job: { fileName: "受付帳.xlsx" } },
    ]);
    const res = await GET(makeRequest());
    expect(await readCsv(res)).toContain("MGMT-001");
  });

  it("23. PropertyDmLog には一切書き込まない(export は送付履歴ではない)", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(pm.propertyDmLog.create).not.toHaveBeenCalled();
    expect(pm.propertyDmLog.createMany).not.toHaveBeenCalled();
    expect(pm.propertyDmLog.update).not.toHaveBeenCalled();
  });

  it("24. null フィールドは literal null/undefined を出力しない", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        address: null, postalCode: null, roomNo: null, building: null,
        propertyOwners: [makePropertyOwner({ owner: { name: "所有 花子", corporateNumber: null } })],
      }),
    ]);
    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    expect(csv).not.toContain("null");
    expect(csv).not.toContain("undefined");
  });
});
