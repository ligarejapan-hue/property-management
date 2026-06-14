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
    property: { findMany: vi.fn(), count: vi.fn() },
    propertyOwner: { count: vi.fn() },
    importJobRow: { findMany: vi.fn() },
    // export は CSV 生成であり送付履歴ではない。PropertyDmLog には一切書き込まないことを
    // 固定するため mock を用意し、各テストで未呼び出しを検証する。
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
import { GET } from "../../app/api/properties/dm-export/route";

const pm = prisma as unknown as {
  property: { findMany: Mock; count: Mock };
  propertyOwner: { count: Mock };
  importJobRow: { findMany: Mock };
  propertyDmLog: { create: Mock; createMany: Mock; update: Mock };
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
  // ownerなし送付可物件 COUNT（skippedCount 用）/ address 欠落所有者 COUNT
  // （skippedAddressMissingCount 用）の既定値。
  // mockResolvedValue は vi.clearAllMocks では消えない（呼び出し履歴のみクリア）ため、
  // 各テスト内の vi.clearAllMocks() 後も既定値 0 が維持される。
  pm.property.count.mockResolvedValue(0);
  pm.propertyOwner.count.mockResolvedValue(0);
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

  it("04. 送付先住所が異なる所有者2名の物件 → 2行", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        propertyOwners: [
          makePropertyOwner({
            owner: { name: "所有 花子", address: "東京都千代田区1-1" },
            isPrimary: true,
          }),
          makePropertyOwner({
            owner: { name: "所有 次郎", address: "東京都港区9-9" },
            isPrimary: false,
            relationship: "子",
          }),
        ],
      }),
    ]);

    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    // ヘッダ + 2 行（住所が異なるので別送付先 = 別行）
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
      "管理ID,物件住所,所有者名,敬称,郵便番号,所有者住所,物件種別,所有者名カナ,代表者,続柄,DM判断",
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
    // 2 物件: 一方は別住所の所有者2名（2送付先=2行）、もう一方は0名
    //  → count=1, resultCount=2, skippedCount=1
    pm.property.findMany.mockResolvedValue([
      makeProp({
        id: "p1",
        propertyOwners: [
          makePropertyOwner({ owner: { name: "A", address: "住所A" } }),
          makePropertyOwner({ owner: { name: "B", address: "住所B" } }),
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
    // 単独送付先（別住所）にして、各 1 名グループの敬称を検証する。
    pm.property.findMany.mockResolvedValue([
      makeProp({
        id: "p1",
        propertyOwners: [
          makePropertyOwner({
            owner: {
              name: "法人A",
              corporateNumber: "1234567890123",
              address: "東京都中央区1-1",
            },
          }),
          makePropertyOwner({
            owner: {
              name: "個人B",
              corporateNumber: null,
              address: "東京都新宿区2-2",
            },
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

// ============================================================
// DM出力運用確認 Phase 1（追加カバレッジ・17-A）
// 既存ケース未カバーの運用確認点を test-only で固定する:
//  - 1 所有者が複数物件に紐づく場合の行展開・件数整合
//  - 代表者は isPrimary のみ「代表」/ 続柄は relationship / 非代表は代表者空欄
//  - 所有者名・住所内のカンマ / ダブルクオート / 改行の RFC4180 escape（文字化け・列ズレ防止）
// 既存仕様（dmStatus=send 強制・archived 除外・BOM+CRLF・formula injection 無害化）は
// 既存 01〜21 と csv-encode.test.ts が担保しており、ここでは重複させない。
// ============================================================
describe("GET /api/properties/dm-export — Phase 1 追加ガード", () => {
  it("1 所有者が複数物件に紐づく場合は物件ごとに 1 行（複数行）になり件数も整合", async () => {
    const sharedOwner = { name: "共有 一郎", address: "東京都港区3-3" };
    pm.property.findMany.mockResolvedValue([
      makeProp({
        id: "p1",
        address: "物件A",
        propertyOwners: [makePropertyOwner({ owner: sharedOwner })],
      }),
      makeProp({
        id: "p2",
        address: "物件B",
        propertyOwners: [makePropertyOwner({ owner: sharedOwner })],
      }),
    ]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const csv = await readCsv(res);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    // ヘッダ + 物件A / 物件B の 2 行（同一所有者でも物件ごとに 1 行）。
    expect(lines).toHaveLength(3);
    expect(csv).toContain("物件A");
    expect(csv).toContain("物件B");
    // 件数整合: 出力対象 2 物件 = 2 行・skipped 0。
    const audit = lastAudit();
    expect(audit.detail.count).toBe(2);
    expect(audit.detail.resultCount).toBe(2);
    expect(audit.detail.skippedCount).toBe(0);
  });

  it("代表者は isPrimary のみ「代表」・続柄は relationship・非代表は代表者空欄", async () => {
    // 別住所にして 2 送付先 = 2 行とし、各行（各 1 名グループ）の代表者/続柄列を検証する。
    pm.property.findMany.mockResolvedValue([
      makeProp({
        propertyOwners: [
          makePropertyOwner({
            owner: { name: "代表 太郎", address: "東京都千代田区1-1" },
            isPrimary: true,
            relationship: "本人",
          }),
          makePropertyOwner({
            owner: { name: "非代表 次郎", address: "東京都港区9-9" },
            isPrimary: false,
            relationship: "子",
          }),
        ],
      }),
    ]);

    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    // どのフィールドにもカンマを含まない fixture なので列を "," 分割で取り出せる。
    const header = lines[0].split(",");
    const idxRep = header.indexOf("代表者");
    const idxRel = header.indexOf("続柄");
    const primaryRow = lines.find((l) => l.includes("代表 太郎"))!.split(",");
    const subRow = lines.find((l) => l.includes("非代表 次郎"))!.split(",");
    expect(primaryRow[idxRep]).toBe("代表");
    expect(primaryRow[idxRel]).toBe("本人");
    // 「非代表」は名前に "代表" を含むが、代表者列は空であること（substring 誤検出を列で回避）。
    expect(subRow[idxRep]).toBe("");
    expect(subRow[idxRel]).toBe("子");
  });

  it("所有者名/住所内のカンマ・ダブルクオート・改行は RFC4180 で escape し列/行が壊れない", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        propertyOwners: [
          makePropertyOwner({
            owner: { name: '田中, "太郎"', address: "東京都\n中央区4-4" },
          }),
        ],
      }),
    ]);

    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    // カンマ + 内部クオートは "..." で囲い、内部 " は "" にエスケープ。
    expect(csv).toContain('"田中, ""太郎"""');
    // 改行を含む住所はクオートで囲い、改行はフィールド内に保持する（行が割れない）。
    expect(csv).toContain('"東京都\n中央区4-4"');
    // 行区切りは CRLF。埋め込み改行(LF)では CRLF 分割が割れず、データ行は 1 行のみ。
    const dataLines = csv
      .split("\r\n")
      .slice(1)
      .filter((l) => l.length > 0);
    expect(dataLines).toHaveLength(1);
  });
});

// ============================================================
// 上限判定の保証（送付先住所グループ数ベース・PR-3a で owner 行数ベースから再設計）
// route は次の 2 段で「最終グループ行数が上限超なら必ず 400 / 部分 CSV の 200 を返さない」を保証する:
//  (1) findMany を「非アーカイブ所有者を 1 名以上持つ物件」に限定 + take=MAX+1。
//      取得物件数が MAX 超（窓を埋め切った）→ 全件性を保証できないため 400
//      （owner リンク数ではなく「取得物件数」で判定。同住所共有者は 1 行に畳まれるので
//        owner 数での reject は false 400 になる）。
//  (2) 取得後にグルーピングし、送付先グループ数（= 最終 CSV 行数）が MAX 超なら 400
//      （取込元逆引き / AuditLog より前）。
// あわせて ownerなし送付可物件の skippedCount は property.count（none 条件）で
// 全 matching 範囲を正確に計上する。
// ============================================================
describe("GET /api/properties/dm-export — 上限判定の保証（送付先住所グループ数ベース）", () => {
  it("(1) findMany は mailable 所有者（非アーカイブ + address 非空）を持つ物件に限定され take は MAX+1", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    await GET(makeRequest());

    const call = pm.property.findMany.mock.calls[0][0];
    // address 空欄しか持たない物件を窓から除外するため、some に address 非空条件を含める
    expect(call.where.AND).toContainEqual({
      propertyOwners: { some: { owner: { isArchived: false, address: { not: "" } } } },
    });
    // 既存の強制条件・取得上限はそのまま
    expect(call.where.dmStatus).toBe("send");
    expect(call.where.isArchived).toBe(false);
    expect(call.take).toBe(10001);
    // nested select は非アーカイブ所有者を全件取る（address 空欄も grouping 側で skip/計上するため）
    expect(call.select.propertyOwners.where).toEqual({
      owner: { isArchived: false },
    });
  });

  it("(1) 既存の where.AND がある場合（hasWarning）も clobber せず some 条件を追記する", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    await GET(makeRequest("?hasWarning=true"));

    const andClauses: Array<Record<string, unknown>> =
      pm.property.findMany.mock.calls[0][0].where.AND;
    // hasWarning 由来の既存 AND 条件（OR 句）が保持されている
    expect(andClauses.some((c) => "OR" in c)).toBe(true);
    // mailable 限定の some 条件が「追記」されている（上書きでない）
    expect(andClauses).toContainEqual({
      propertyOwners: { some: { owner: { isArchived: false, address: { not: "" } } } },
    });
    expect(andClauses.length).toBeGreaterThanOrEqual(2);
  });

  it("(1) 取得物件数が MAX 超 → グルーピング前に 400・取込元逆引き/AuditLog 未実行", async () => {
    // eligible 物件が take 窓を埋めた（MAX+1=10,001 件取得）= 全件性を保証できない → 400。
    const many = Array.from({ length: 10001 }, (_, i) => makeProp({ id: `p${i}` }));
    pm.property.findMany.mockResolvedValue(many);

    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("EXPORT_LIMIT_EXCEEDED");
    // PII 行マッピング前に 400（取込元逆引き / 監査ログを実行しない）
    expect(pm.importJobRow.findMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
    expect(res.headers.get("Content-Type")).not.toBe("text/csv; charset=utf-8");
  });

  it("owner リンク数が MAX 超でも、全員が同一 zip+address なら 1 行で export 成功（false 400 にしない）", async () => {
    // Codex P2 シナリオ: 1 物件・同一送付先住所の共有者 10,001 名 → グルーピング後 1 行。
    // owner リンク数（10,001）で hard reject すると 400 になってしまうが、最終行数は 1 なので 200。
    const manyOwners = Array.from({ length: 10001 }, (_, i) =>
      makePropertyOwner({
        owner: { name: `共有 ${i}`, zip: "100-0001", address: "東京都港区3-3" },
        isPrimary: i === 0,
      }),
    );
    pm.property.findMany.mockResolvedValue([
      makeProp({ id: "p1", propertyOwners: manyOwners }),
    ]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    const csv = await readCsv(res);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2); // ヘッダ + 1 行（同住所 10,001 名 → 1 通）
    const audit = lastAudit();
    expect(audit.detail.resultCount).toBe(1);
    expect(audit.detail.count).toBe(1);
  });

  it("送付先住所グループ数が MAX 超なら 400（少数物件でも異住所共有者が多数）", async () => {
    // 1 物件に「異なる住所」の共有者 10,001 名 → 10,001 グループ → 最終行数 > MAX → 400。
    const distinctOwners = Array.from({ length: 10001 }, (_, i) =>
      makePropertyOwner({
        owner: { name: `共有 ${i}`, zip: "100-0001", address: `住所-${i}` },
        isPrimary: i === 0,
      }),
    );
    pm.property.findMany.mockResolvedValue([
      makeProp({ id: "p1", propertyOwners: distinctOwners }),
    ]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("EXPORT_LIMIT_EXCEEDED");
    // グループ数判定は取込元逆引き / AuditLog より前
    expect(pm.importJobRow.findMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("(3) 取得後のグループ行数が MAX+1（property 件数は窓内）→ 400・取込元逆引き/AuditLog 未実行", async () => {
    // 10,000 物件（take 窓内）だが、先頭 1 物件が「別住所」の所有者 2 名 → グループ行 10,001 > MAX。
    // （住所が異なるためグルーピングされず 2 行になる点が核。同住所だと 1 行にまとまり 400 にならない）
    // 本テストの核は「(3) の再判定は取込元逆引きより前に行われ、400 経路では importJobRow
    // アクセスも AuditLog も発生しない」のロック（下の importJobRow.findMany 未呼び出し assertion）。
    const many = Array.from({ length: 10000 }, (_, i) =>
      i === 0
        ? makeProp({
            id: "p0",
            propertyOwners: [
              makePropertyOwner({ owner: { name: "A", address: "住所A" } }),
              makePropertyOwner({
                owner: { name: "B", address: "住所B" },
                isPrimary: false,
              }),
            ],
          })
        : makeProp({ id: `p${i}` }),
    );
    pm.property.findMany.mockResolvedValue(many);

    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("EXPORT_LIMIT_EXCEEDED");
    expect(pm.importJobRow.findMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
    expect(res.headers.get("Content-Type")).not.toBe("text/csv; charset=utf-8");
  });

  it("グループ行数がちょうど MAX（10,000）→ 200・全行出力・resultCount=10000", async () => {
    // 10,000 物件 × 各 1 送付先 = 10,000 行（境界値・取得物件数も 10,000 = MAX で通る）。
    const many = Array.from({ length: 10000 }, (_, i) =>
      makeProp({ id: `p${i}` }),
    );
    pm.property.findMany.mockResolvedValue(many);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    const csv = await readCsv(res);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(10001); // ヘッダ + 10,000 行（切り捨てなし）
    const audit = lastAudit();
    expect(audit.detail.count).toBe(10000);
    expect(audit.detail.resultCount).toBe(10000);
  });

  it("ownerなし送付可物件が大量にあっても部分 CSV にならず、skippedCount に正確に反映される", async () => {
    // ownerなし物件は findMany の対象外（take 窓を消費しない）ため、
    // 50,000 件あっても eligible owner 行は全件出力され、件数は COUNT で監査に残る。
    pm.property.count.mockResolvedValue(50000);
    pm.property.findMany.mockResolvedValue([
      makeProp({ id: "p1", address: "物件A" }),
      makeProp({ id: "p2", address: "物件B" }),
    ]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const csv = await readCsv(res);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(3); // ヘッダ + 2 行（eligible owner 行は欠落しない）
    expect(csv).toContain("物件A");
    expect(csv).toContain("物件B");

    const audit = lastAudit();
    expect(audit.detail.count).toBe(2);
    expect(audit.detail.resultCount).toBe(2);
    expect(audit.detail.skippedCount).toBe(50000);

    // skippedCount の COUNT は「非アーカイブ所有者が 0 名の送付可物件」を数える
    const skipWhere = pm.property.count.mock.calls[0][0].where;
    expect(skipWhere.dmStatus).toBe("send");
    expect(skipWhere.isArchived).toBe(false);
    expect(skipWhere.AND).toContainEqual({
      propertyOwners: { none: { owner: { isArchived: false } } },
    });
  });

  it("400（取得物件数 超過）時は ownerなし COUNT も実行されない（負荷を増やさない）", async () => {
    // 取得物件数 > MAX で 400 する経路では、skippedCount 用の property.count も実行しない。
    const many = Array.from({ length: 10001 }, (_, i) => makeProp({ id: `p${i}` }));
    pm.property.findMany.mockResolvedValue(many);
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
    expect(pm.property.count).not.toHaveBeenCalled();
  });
});

// ============================================================
// PR-3a: 同一送付先住所グルーピング（1 送付先住所 = 1 行）
// 送付方針: 同一物件内で「Owner.zip + Owner.address」が同じ共有者は 1 通にまとめる。
//  - 名義が違っても同住所なら重複送付しない（未成年・家族名義への個別 DM を回避）。
//  - 宛先は Owner.zip / Owner.address のみ（Property / Building.postalCode は使わない）。
// 列ヘッダは既存 12 列を維持し、末尾に「送付先所有者名一覧 / 共有者数」を追加。
// ============================================================
describe("GET /api/properties/dm-export — 同一送付先住所グルーピング（PR-3a）", () => {
  // カンマを含まない fixture 前提で 1 行を列配列に分解するヘルパー。
  function rowCells(csv: string, needle: string): string[] {
    const line = csv
      .split("\r\n")
      .filter((l) => l.length > 0)
      .find((l) => l.includes(needle));
    if (!line) throw new Error(`row containing ${needle} not found`);
    return line.split(",");
  }
  function headerIndex(csv: string, col: string): number {
    return csv.split("\r\n")[0].split(",").indexOf(col);
  }

  it("01. 同一 zip+address の共有者は 1 行にまとまる（共有者数 2・送付先一覧に両名）", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        id: "p1",
        propertyOwners: [
          makePropertyOwner({
            owner: { name: "親 太郎", zip: "100-0001", address: "東京都港区3-3" },
            isPrimary: true,
          }),
          makePropertyOwner({
            owner: { name: "子 次郎", zip: "100-0001", address: "東京都港区3-3" },
            isPrimary: false,
            relationship: "子",
          }),
        ],
      }),
    ]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const csv = await readCsv(res);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    // ヘッダ + 1 行（2 名が同住所 → 1 通）
    expect(lines).toHaveLength(2);
    const idxCount = headerIndex(csv, "共有者数");
    const cells = rowCells(csv, "親 太郎");
    expect(cells[idxCount]).toBe("2");
    expect(csv).toContain("親 太郎、子 次郎"); // 送付先所有者名一覧
    const audit = lastAudit();
    expect(audit.detail.count).toBe(1);
    expect(audit.detail.resultCount).toBe(1);
  });

  it("02. 異なる zip+address の共有者は別行（住所違いは個別送付）", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        propertyOwners: [
          makePropertyOwner({ owner: { name: "甲", address: "住所X" } }),
          makePropertyOwner({
            owner: { name: "乙", address: "住所Y" },
            isPrimary: false,
          }),
        ],
      }),
    ]);

    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(3); // ヘッダ + 2 行
  });

  it("03. 同一住所だが氏名が違っても重複出力されない（氏名はキーに含めない）", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        propertyOwners: [
          makePropertyOwner({
            owner: { name: "名義A", zip: "100-0001", address: "同じ住所1-1" },
          }),
          makePropertyOwner({
            owner: { name: "名義B", zip: "100-0001", address: "同じ住所1-1" },
            isPrimary: false,
          }),
        ],
      }),
    ]);

    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2); // 1 通のみ
  });

  it("04. 1 名なら宛名は『所有者名』+『様』", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        propertyOwners: [
          makePropertyOwner({
            owner: { name: "単独 一郎", address: "東京都港区3-3", corporateNumber: null },
          }),
        ],
      }),
    ]);

    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    const idxName = headerIndex(csv, "所有者名");
    const idxHon = headerIndex(csv, "敬称");
    const cells = rowCells(csv, "単独 一郎");
    expect(cells[idxName]).toBe("単独 一郎");
    expect(cells[idxHon]).toBe("様");
  });

  it("05. 複数名なら宛名は『代表所有者名』+『様 他共有者様』", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        propertyOwners: [
          makePropertyOwner({
            owner: { name: "代表 太郎", zip: "100-0001", address: "東京都港区3-3" },
            isPrimary: true,
          }),
          makePropertyOwner({
            owner: { name: "共有 次郎", zip: "100-0001", address: "東京都港区3-3" },
            isPrimary: false,
          }),
        ],
      }),
    ]);

    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    const idxName = headerIndex(csv, "所有者名");
    const idxHon = headerIndex(csv, "敬称");
    const cells = rowCells(csv, "代表 太郎");
    expect(cells[idxName]).toBe("代表 太郎");
    expect(cells[idxHon]).toBe("様 他共有者様");
  });

  it("06. primary owner が代表者として優先される（入力順が primary 後でも）", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        propertyOwners: [
          // 入力順では非 primary が先頭
          makePropertyOwner({
            owner: { name: "非代表 先頭", zip: "100-0001", address: "東京都港区3-3" },
            isPrimary: false,
          }),
          makePropertyOwner({
            owner: { name: "代表 後ろ", zip: "100-0001", address: "東京都港区3-3" },
            isPrimary: true,
          }),
        ],
      }),
    ]);

    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    const idxName = headerIndex(csv, "所有者名");
    const idxRep = headerIndex(csv, "代表者");
    const cells = rowCells(csv, "代表 後ろ");
    // 宛名（所有者名列）は primary を採用
    expect(cells[idxName]).toBe("代表 後ろ");
    expect(cells[idxRep]).toBe("代表");
  });

  it("07. 郵便番号列は Owner.zip を使い、Property.postalCode / Building.postalCode に影響されない", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        // route の select には postalCode / building が含まれないが、混入回帰を防ぐため fixture に入れる
        postalCode: "999-9999",
        building: { postalCode: "888-8888", address: "棟住所" },
        propertyOwners: [
          makePropertyOwner({
            owner: { zip: "100-0001", address: "東京都千代田区2-2", name: "所有 花子" },
          }),
        ],
      }),
    ]);

    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    const idxZip = headerIndex(csv, "郵便番号");
    const cells = rowCells(csv, "所有 花子");
    expect(cells[idxZip]).toBe("100-0001"); // Owner.zip
    // 物件/棟の postalCode は出力に現れない
    expect(csv).not.toContain("999-9999");
    expect(csv).not.toContain("888-8888");
  });

  it("08. address 空欄の所有者は CSV に出ず、skippedAddressMissingCount は DB COUNT を反映", async () => {
    // 取得物件内では address 空欄の共有者は grouping で skip され CSV に出ない。
    // skippedAddressMissingCount は fetch ではなく DB COUNT（全 matching 範囲）由来。
    pm.property.findMany.mockResolvedValue([
      makeProp({
        id: "p1",
        propertyOwners: [
          makePropertyOwner({ owner: { name: "送付可 太郎", address: "東京都港区3-3" } }),
          makePropertyOwner({
            owner: { name: "住所空 次郎", address: "" },
            isPrimary: false,
          }),
        ],
      }),
    ]);
    pm.propertyOwner.count.mockResolvedValue(1); // address null/"" の非アーカイブ所有者数

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const csv = await readCsv(res);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2); // ヘッダ + 1 行（住所空の所有者は出ない）
    expect(csv).toContain("送付可 太郎");
    expect(csv).not.toContain("住所空 次郎");
    const audit = lastAudit();
    expect(audit.detail.skippedAddressMissingCount).toBe(1);
    // skippedCount（非アーカイブ所有者0件の物件）には混ぜない
    expect(audit.detail.skippedCount).toBe(0);
    expect(audit.detail.resultCount).toBe(1);

    // COUNT は「matching 送付可物件 × 非アーカイブ所有者 × address が null/空」を数える
    const cwhere = pm.propertyOwner.count.mock.calls[0][0].where;
    expect(cwhere.owner.isArchived).toBe(false);
    expect(cwhere.owner.OR).toEqual([{ address: null }, { address: "" }]);
    expect(cwhere.property.dmStatus).toBe("send");
    expect(cwhere.property.isArchived).toBe(false);
  });

  it("08b. address 空欄しか無い物件は fetch されなくても skippedAddressMissingCount に計上（Codex P2: 取りこぼさない）", async () => {
    // address 空欄しか持たない物件は mailable 述語で fetch 対象外（findMany は空）。
    // それでも DB COUNT は全 matching 範囲を数えるため、当該所有者は監査に残る。
    pm.property.findMany.mockResolvedValue([]); // mailable 物件なし
    pm.propertyOwner.count.mockResolvedValue(3); // address 空欄の非アーカイブ所有者 3 名

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const csv = await readCsv(res);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1); // ヘッダのみ
    const audit = lastAudit();
    expect(audit.detail.resultCount).toBe(0);
    expect(audit.detail.count).toBe(0);
    // fetch されていない物件の所有者も DB COUNT で計上される（取りこぼさない）
    expect(audit.detail.skippedAddressMissingCount).toBe(3);
  });

  it("09. 既存 12 列の列順を維持し、末尾に送付先所有者名一覧・共有者数を追加", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    // 先頭 BOM（U+FEFF）を除いてヘッダ行を厳密一致で検証する。
    const header = csv.split("\r\n")[0].replace(/^﻿/, "");
    expect(header).toBe(
      "管理ID,物件住所,所有者名,敬称,郵便番号,所有者住所,物件種別,所有者名カナ,代表者,続柄,DM判断,送付先所有者名一覧,共有者数",
    );
  });

  it("11. AuditLog に PII が無く、skippedAddressMissingCount などのキー名にも owner を含まない", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        propertyOwners: [
          makePropertyOwner({
            owner: { name: "秘密 花子", zip: "100-0001", address: "東京都千代田区2-2" },
          }),
        ],
      }),
    ]);

    await GET(makeRequest());
    const audit = lastAudit();
    const detailStr = JSON.stringify(audit.detail);
    expect(detailStr).not.toContain("秘密 花子");
    expect(detailStr).not.toContain("東京都千代田区2-2");
    expect(detailStr).not.toContain("100-0001");
    for (const key of Object.keys(audit.detail)) {
      expect(key.toLowerCase()).not.toContain("owner");
    }
    // 新カウントは数値のみ
    expect(typeof audit.detail.skippedAddressMissingCount).toBe("number");
  });

  it("12. PropertyDmLog には一切書き込まない（export は送付履歴ではない）", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        propertyOwners: [
          makePropertyOwner({
            owner: { name: "親 太郎", zip: "100-0001", address: "東京都港区3-3" },
          }),
          makePropertyOwner({
            owner: { name: "子 次郎", zip: "100-0001", address: "東京都港区3-3" },
            isPrimary: false,
          }),
        ],
      }),
    ]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(pm.propertyDmLog.create).not.toHaveBeenCalled();
    expect(pm.propertyDmLog.createMany).not.toHaveBeenCalled();
    expect(pm.propertyDmLog.update).not.toHaveBeenCalled();
  });
});
