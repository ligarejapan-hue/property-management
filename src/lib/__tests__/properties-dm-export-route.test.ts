/**
 * GET /api/properties/dm-export（DM 差込 CSV 出力）の統合テスト。
 *
 * 確認項目（番号は指示の 1〜21 に対応）:
 *  1. dmStatus=send の行のみ出力される
 *  2. クライアントが dmStatus=hold/no_send を渡しても where.dmStatus==="send" になる
 *  3. no_send / hold が漏れない（where.dmStatus==="send" / where.isArchived===false）
 *  4. 所有者2名の物件 → 2行
 *  5. 非アーカイブ所有者0件の物件 → 出力されず skippedCount に反映
 *  6. アーカイブ物件は除外（where.isArchived===false）
 *  7. アーカイブ所有者は除外（select の propertyOwners.where.owner.isArchived===false）
 *  8. formula injection 無害化（所有者名 / 所有者住所 / 郵便番号 / 物件住所、全角含む）
 *  9. UTF-8 BOM + CRLF
 * 10. property:read 欠如で 403（findMany / writeAuditLog 未実行）
 * 11. csv_export:read 欠如で 403（副作用なし）
 * 12. csv_export_personal:read 欠如で 403（副作用なし）
 * 13. owner:read 欠如で 403（副作用なし）
 * 14. owner 表示レベル（name/zip/address）が masked/partial/hidden なら 403（副作用なし）
 * 15. 403 時は findMany / writeAuditLog 未実行
 * 16. AuditLog detail に PII が無い（owner を含むキー名も無い）
 * 17. count / resultCount / skippedCount が混在 fixture で正しい
 * 18. rows.length > MAX_DM_EXPORT_ROWS で 400（writeAuditLog 未実行）
 * 19. 0件 → ヘッダのみ CSV / 200
 * 20. 敬称: corporateNumber あり → 御中 / なし → 様
 * 21. レスポンスヘッダ（Content-Type / Content-Disposition / Cache-Control）
 *
 * permissions / maskValue / csv-encode / property-list-query / property-types / dm-export は
 * 実物を使用し、権限ゲート・マスキング・BOM/CRLF・行展開を実挙動で検証する。
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
    property: { findMany: vi.fn() },
    importJobRow: { findMany: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { GET } from "../../app/api/properties/dm-export/route";

const pm = prisma as unknown as {
  property: { findMany: Mock };
  importJobRow: { findMany: Mock };
};

const PERMS_FULL = [
  { resource: "property", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "csv_export", action: "read", granted: true },
  { resource: "csv_export_personal", action: "read", granted: true },
];
const PERMS_NO_PROPERTY = [
  { resource: "owner", action: "read", granted: true },
  { resource: "csv_export", action: "read", granted: true },
  { resource: "csv_export_personal", action: "read", granted: true },
];
const PERMS_NO_CSV_EXPORT = [
  { resource: "property", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "csv_export_personal", action: "read", granted: true },
];
const PERMS_NO_CSV_PERSONAL = [
  { resource: "property", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "csv_export", action: "read", granted: true },
];
const PERMS_NO_OWNER = [
  { resource: "property", action: "read", granted: true },
  { resource: "csv_export", action: "read", granted: true },
  { resource: "csv_export_personal", action: "read", granted: true },
];

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
  return {
    name: "所有 花子",
    nameKana: "ショユウ ハナコ",
    zip: "100-0001",
    address: "東京都千代田区2-2",
    corporateNumber: null,
    ...over,
  };
}

function makePropertyOwner(over: Record<string, unknown> = {}) {
  const { owner, ...rest } = over;
  return {
    isPrimary: true,
    relationship: "本人",
    ...rest,
    owner: makeOwner((owner as Record<string, unknown>) ?? {}),
  };
}

function makeProp(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    address: "東京都千代田区1-1",
    propertyType: "land",
    roomNo: null,
    propertyOwners: [makePropertyOwner()],
    ...over,
  };
}

function makeRequest(qs = "") {
  return new Request(`http://localhost/api/properties/dm-export${qs}`, {
    method: "GET",
  }) as unknown as import("next/server").NextRequest;
}

function lastAudit(): any {
  return vi.mocked(writeAuditLog).mock.calls.at(-1)?.[0];
}

// BOM を保持したまま CSV 文字列を取り出す（Response.text() は先頭 BOM を除去するため）。
async function readCsv(res: Response): Promise<string> {
  const buf = new Uint8Array(await res.arrayBuffer());
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue({
    id: "user-admin",
    email: "a@a",
    name: "A",
    role: "admin",
  } as any);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL as any);
  vi.mocked(getOwnerDisplayConfig).mockResolvedValue(FULL_DISPLAY as any);
  pm.property.findMany.mockResolvedValue([]);
  pm.importJobRow.findMany.mockResolvedValue([]);
});

describe("GET /api/properties/dm-export", () => {
  it("01. dmStatus=send の行のみ出力する（送付可のみ）", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({ id: "p1", address: "住所A" }),
    ]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const csv = await readCsv(res);
    expect(csv).toContain("住所A");
    // 全行の DM判断 が「送付可」
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    for (const line of lines.slice(1)) {
      expect(line).toContain("送付可");
    }
    // サーバ側で送付可を強制
    const where = pm.property.findMany.mock.calls[0][0].where;
    expect(where.dmStatus).toBe("send");
  });

  it("02. クライアントが dmStatus=hold/no_send を渡しても where.dmStatus は send", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    await GET(makeRequest("?dmStatus=hold"));
    expect(pm.property.findMany.mock.calls[0][0].where.dmStatus).toBe("send");

    vi.clearAllMocks();
    vi.mocked(getApiSession).mockResolvedValue({ id: "u", role: "admin" } as any);
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL as any);
    vi.mocked(getOwnerDisplayConfig).mockResolvedValue(FULL_DISPLAY as any);
    pm.property.findMany.mockResolvedValue([makeProp()]);
    pm.importJobRow.findMany.mockResolvedValue([]);
    await GET(makeRequest("?dmStatus=no_send"));
    expect(pm.property.findMany.mock.calls[0][0].where.dmStatus).toBe("send");
  });

  it("03. no_send / hold は漏れない（where.dmStatus===send かつ isArchived===false）", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    await GET(makeRequest("?dmStatus=no_send"));
    const where = pm.property.findMany.mock.calls[0][0].where;
    expect(where.dmStatus).toBe("send");
    expect(where.isArchived).toBe(false);
  });

  it("04. 所有者2名の物件 → 2行", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        propertyOwners: [
          makePropertyOwner({ owner: { name: "所有 花子" }, isPrimary: true }),
          makePropertyOwner({
            owner: { name: "所有 次郎" },
            isPrimary: false,
            relationship: "子",
          }),
        ],
      }),
    ]);

    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    // ヘッダ + 2 行
    expect(lines).toHaveLength(3);
    expect(csv).toContain("所有 花子");
    expect(csv).toContain("所有 次郎");
    // 代表者列
    expect(csv).toContain("代表");
  });

  it("05. 非アーカイブ所有者0件の物件は出力されず skippedCount に反映", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({ id: "p1", propertyOwners: [] }),
    ]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const csv = await readCsv(res);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1); // ヘッダのみ
    const audit = lastAudit();
    expect(audit.detail.skippedCount).toBe(1);
    expect(audit.detail.count).toBe(0);
    expect(audit.detail.resultCount).toBe(0);
  });

  it("06. アーカイブ物件は除外（where.isArchived===false）", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    // クライアントが includeArchived=true を渡しても DM 出力では強制 false
    await GET(makeRequest("?includeArchived=true"));
    expect(pm.property.findMany.mock.calls[0][0].where.isArchived).toBe(false);
  });

  it("07. アーカイブ所有者は除外（select の propertyOwners.where.owner.isArchived===false）", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    await GET(makeRequest());
    const call = pm.property.findMany.mock.calls[0][0];
    expect(call.select.propertyOwners.where.owner.isArchived).toBe(false);
  });

  it("08. formula injection を 所有者名/所有者住所/郵便番号/物件住所 で無害化（全角含む）", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        address: "=1+1",
        propertyOwners: [
          makePropertyOwner({
            owner: {
              name: "+SUM(A1:A2)",
              zip: "-10",
              address: "@cmd",
              nameKana: "＝EVIL",
            },
          }),
        ],
      }),
    ]);

    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    expect(csv).toContain("'=1+1"); // 物件住所
    expect(csv).toContain("'+SUM(A1:A2)"); // 所有者名
    expect(csv).toContain("'-10"); // 郵便番号
    expect(csv).toContain("'@cmd"); // 所有者住所
    expect(csv).toContain("'＝EVIL"); // 全角（所有者名カナ）
  });

  it("09. UTF-8 BOM 付き・CRLF 改行", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    const res = await GET(makeRequest());
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(buf.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf);
    expect(csv.codePointAt(0)).toBe(0xfeff);
    expect(csv).toContain("\r\n");
    expect(csv).not.toMatch(/[^\r]\n/);
    // ヘッダ列順
    expect(csv).toContain(
      "管理ID,物件住所,所有者名,敬称,郵便番号,所有者住所,物件種別,所有者名カナ,代表者,続柄,部屋番号,DM判断",
    );
  });

  it("10. property:read 欠如で 403（findMany / writeAuditLog 未実行）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_PROPERTY as any);
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    expect(pm.property.findMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("11. csv_export:read 欠如で 403（副作用なし）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_CSV_EXPORT as any);
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    expect(pm.property.findMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("12. csv_export_personal:read 欠如で 403（副作用なし）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_CSV_PERSONAL as any);
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    expect(pm.property.findMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("13. owner:read 欠如で 403（副作用なし）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_OWNER as any);
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    expect(pm.property.findMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("14. owner 表示レベル（name/zip/address）が masked/partial/hidden なら 403（副作用なし）", async () => {
    for (const badLevel of ["masked", "partial", "hidden"] as const) {
      for (const field of ["name", "zip", "address"] as const) {
        vi.clearAllMocks();
        vi.mocked(getApiSession).mockResolvedValue({
          id: "u",
          role: "admin",
        } as any);
        vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL as any);
        vi.mocked(getOwnerDisplayConfig).mockResolvedValue({
          ...FULL_DISPLAY,
          [field]: badLevel,
        } as any);
        pm.property.findMany.mockResolvedValue([makeProp()]);
        pm.importJobRow.findMany.mockResolvedValue([]);

        const res = await GET(makeRequest());
        expect(res.status, `${field}=${badLevel}`).toBe(403);
        expect(pm.property.findMany).not.toHaveBeenCalled();
        expect(writeAuditLog).not.toHaveBeenCalled();
      }
    }
  });

  it("15. 403 時は findMany / writeAuditLog を呼ばない（代表で property:read 欠如）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_PROPERTY as any);
    await GET(makeRequest());
    expect(pm.property.findMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("16. AuditLog detail に PII が無い（owner を含むキー名も無い）", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        propertyOwners: [
          makePropertyOwner({
            owner: {
              name: "所有 花子",
              zip: "100-0001",
              address: "東京都千代田区2-2",
              nameKana: "ショユウ ハナコ",
            },
          }),
        ],
      }),
    ]);
    pm.importJobRow.findMany.mockResolvedValue([]);

    await GET(
      makeRequest("?keyword=" + encodeURIComponent("東京都千代田区") + "&mgmtId=受付帳.xlsx:1行&propertyType=land"),
    );

    const audit = lastAudit();
    expect(audit.action).toBe("property_dm_csv_export");
    expect(audit.targetTable).toBe("properties");
    const detailStr = JSON.stringify(audit.detail);
    // PII（氏名・住所・郵便番号・カナ）が混入しない
    expect(detailStr).not.toContain("所有 花子");
    expect(detailStr).not.toContain("東京都千代田区2-2");
    expect(detailStr).not.toContain("100-0001");
    expect(detailStr).not.toContain("ショユウ");
    // keyword / mgmtId 生値が混入しない
    expect(detailStr).not.toContain("東京都千代田区");
    expect(detailStr).not.toContain("受付帳.xlsx");
    // "owner" を含むキー名が無い（監査 allowlist で REDACT されるリスク回避）
    for (const key of Object.keys(audit.detail)) {
      expect(key.toLowerCase()).not.toContain("owner");
    }
    for (const key of Object.keys(audit.detail.filters)) {
      expect(key.toLowerCase()).not.toContain("owner");
    }
    // allowlist の正規 filter は残り、dmStatus は常に send
    expect(audit.detail.filters.propertyType).toBe("land");
    expect(audit.detail.filters.dmStatus).toBe("send");
    expect(audit.detail.filters.keyword).toBeUndefined();
    expect(audit.detail.filters.mgmtId).toBeUndefined();
  });

  it("17. count / resultCount / skippedCount が混在 fixture で正しい", async () => {
    // 2 物件: 一方は所有者2名、もう一方は0名 → count=1, resultCount=2, skippedCount=1
    pm.property.findMany.mockResolvedValue([
      makeProp({
        id: "p1",
        propertyOwners: [
          makePropertyOwner({ owner: { name: "A" } }),
          makePropertyOwner({ owner: { name: "B" } }),
        ],
      }),
      makeProp({ id: "p2", propertyOwners: [] }),
    ]);

    await GET(makeRequest());
    const audit = lastAudit();
    expect(audit.detail.count).toBe(1);
    expect(audit.detail.resultCount).toBe(2);
    expect(audit.detail.skippedCount).toBe(1);
  });

  it("18. rows.length > MAX_DM_EXPORT_ROWS で 400（writeAuditLog 未実行）", async () => {
    // 各物件1所有者 × 10001 物件 → 10001 行 > 10000
    const many = Array.from({ length: 10001 }, (_, i) =>
      makeProp({ id: `p${i}` }),
    );
    pm.property.findMany.mockResolvedValue(many);

    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("EXPORT_LIMIT_EXCEEDED");
    expect(writeAuditLog).not.toHaveBeenCalled();
    expect(res.headers.get("Content-Type")).not.toBe("text/csv; charset=utf-8");
  });

  it("19. 0件 → ヘッダのみ CSV / 200", async () => {
    pm.property.findMany.mockResolvedValue([]);
    const res = await GET(makeRequest("?propertyType=land"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    const csv = await readCsv(res);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(csv).toContain("管理ID");
  });

  it("20. 敬称: corporateNumber あり → 御中 / なし → 様", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        id: "p1",
        propertyOwners: [
          makePropertyOwner({
            owner: { name: "法人A", corporateNumber: "1234567890123" },
          }),
          makePropertyOwner({
            owner: { name: "個人B", corporateNumber: null },
            isPrimary: false,
          }),
        ],
      }),
    ]);

    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    const corpLine = lines.find((l) => l.includes("法人A"))!;
    const indivLine = lines.find((l) => l.includes("個人B"))!;
    expect(corpLine).toContain("御中");
    expect(indivLine).toContain("様");
    expect(indivLine).not.toContain("御中");
  });

  it("21. レスポンスヘッダ（Content-Type / Content-Disposition / Cache-Control）", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    const res = await GET(makeRequest());
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    const cd = res.headers.get("Content-Disposition") ?? "";
    expect(cd).toContain("dm_merge_");
    expect(cd).toContain(".csv");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("null / undefined フィールドは空文字（literal null を出力しない）", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        address: null,
        roomNo: null,
        propertyOwners: [
          makePropertyOwner({
            owner: {
              name: "所有 花子",
              nameKana: null,
              zip: null,
              address: null,
              corporateNumber: null,
            },
            relationship: null,
          }),
        ],
      }),
    ]);

    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    expect(csv).not.toContain("null");
    expect(csv).not.toContain("undefined");
  });

  it("management-id（取込元）が CSV の管理ID 列に出る", async () => {
    pm.property.findMany.mockResolvedValue([makeProp({ id: "p1" })]);
    pm.importJobRow.findMany.mockResolvedValue([
      {
        createdId: "p1",
        rowNumber: 5,
        rawData: { __sourceRef: "MGMT-001" },
        job: { fileName: "受付帳.xlsx" },
      },
    ]);

    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    expect(csv).toContain("MGMT-001");
  });
});
