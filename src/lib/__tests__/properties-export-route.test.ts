/**
 * GET /api/properties/export（物件一覧 CSV 出力）の統合テスト + 共有 where ロジックの単体テスト。
 *
 * 確認項目（指示の最低限テスト）:
 *  1. 条件一致の全件が出る
 *  2. page/limit の1ページ分だけにならない（page/limit は無視・全件）
 *  3. property:read なしは 403
 *  4. field_staff スコープが where に効く
 *  5. owner:read なしでは所有者名が空欄
 *  6. CSV が UTF-8 BOM 付き
 *  7. CRLF 改行
 *  8. 10,000件超過時に切り捨てずエラー
 *  9. AuditLog に CSV本文・所有者名・mgmtId 生値などの PII が残らない
 * 10. 一覧 API の where 構築（共有ロジック）が従来挙動と一致（archived/field_staff/keyword）
 *
 * permissions / maskValue / csv-encode / property-list-query / property-types は実物を使用し、
 * 権限ゲート・マスキング・BOM/CRLF・スコープを実挙動で検証する。
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
import { GET } from "../../app/api/properties/export/route";
import {
  buildPropertyListWhere,
  buildPropertyListOrderBy,
} from "@/lib/property-list-query";
import { sanitizeCsvCellForExcel } from "@/lib/csv-encode";

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
const PERMS_NO_OWNER = [
  { resource: "property", action: "read", granted: true },
  { resource: "csv_export", action: "read", granted: true },
  { resource: "csv_export_personal", action: "read", granted: true },
];
const PERMS_NO_PROPERTY = [
  { resource: "owner", action: "read", granted: true },
  { resource: "csv_export", action: "read", granted: true },
  { resource: "csv_export_personal", action: "read", granted: true },
];
// property:read はあるが CSV export 専用権限を欠く（field_staff 相当）
const PERMS_NO_CSV_EXPORT = [
  { resource: "property", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
];
// csv_export はあるが個人情報 CSV 権限を欠く（office_staff 相当）
const PERMS_NO_CSV_PERSONAL = [
  { resource: "property", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "csv_export", action: "read", granted: true },
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

function makeProp(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    propertyType: "land",
    address: "東京都千代田区1-1",
    lotNumber: "12-3",
    buildingNumber: null,
    realEstateNumber: "RE-1",
    registryStatus: "obtained",
    dmStatus: "send",
    caseStatus: "new_case",
    introductionRoute: "reception_csv",
    updatedAt: new Date("2026-05-01T12:00:00Z"),
    createdAt: new Date("2026-04-01T09:00:00Z"),
    assignee: { name: "担当 太郎" },
    propertyOwners: [{ owner: { name: "所有 花子" } }],
    ...over,
  };
}

function makeRequest(qs = "") {
  return new Request(
    `http://localhost/api/properties/export${qs}`,
    { method: "GET" },
  ) as unknown as import("next/server").NextRequest;
}

function lastAudit(): any {
  return vi.mocked(writeAuditLog).mock.calls.at(-1)?.[0];
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

describe("GET /api/properties/export", () => {
  it("条件一致の全件を CSV 出力し、page/limit の1ページ分に制限されない", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({ id: "p1", address: "住所A" }),
      makeProp({ id: "p2", address: "住所B" }),
      makeProp({ id: "p3", address: "住所C" }),
    ]);

    // page/limit を 1件分に絞っても全件返る
    const res = await GET(makeRequest("?page=2&limit=1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");

    const csv = await res.text();
    const lines = csv.split("\r\n");
    // ヘッダ + 3 行
    expect(lines).toHaveLength(4);
    expect(csv).toContain("住所A");
    expect(csv).toContain("住所B");
    expect(csv).toContain("住所C");

    // findMany は skip 無し / take = 上限+1 で全件取得している
    const call = pm.property.findMany.mock.calls[0][0];
    expect(call.skip).toBeUndefined();
    expect(call.take).toBe(10001);
  });

  it("CSV は UTF-8 BOM 付き・CRLF 改行・日本語ラベルで出力", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);

    const res = await GET(makeRequest("?propertyType=land"));
    // 生バイト列で検証する。Response.text() は仕様上、先頭 BOM を除去してしまうため。
    const buf = new Uint8Array(await res.arrayBuffer());

    // UTF-8 BOM（EF BB BF）が先頭バイトにある
    expect(Array.from(buf.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);

    // ignoreBOM で BOM を保持したままデコードして文字列検証
    const csv = new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf);
    expect(csv.codePointAt(0)).toBe(0xfeff);
    // CRLF
    expect(csv).toContain("\r\n");
    expect(csv).not.toMatch(/[^\r]\n/); // LF 単独が無い
    // ヘッダ（BOM 直後）
    expect(csv).toContain("管理ID");
    expect(csv).toContain("作成日時");
    // 値はラベル化されている
    expect(csv).toContain("土地"); // land
    expect(csv).toContain("取得済"); // registryStatus obtained
    expect(csv).toContain("送付可"); // dmStatus send
    expect(csv).toContain("受付帳取込"); // introductionRoute reception_csv
    // 日時は ISO 形式
    expect(csv).toContain("2026-05-01T12:00:00.000Z");
    expect(csv).toContain("2026-04-01T09:00:00.000Z");
  });

  it("property:read なしは 403（DB を叩かない）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_PROPERTY as any);

    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    expect(pm.property.findMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("property:read はあっても csv_export:read が無ければ 403（DB/AuditLog なし）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_CSV_EXPORT as any);

    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    // CSV 生成・DB 取得・AuditLog 書き込みのいずれも行わない
    expect(pm.property.findMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
    expect(res.headers.get("Content-Type")).not.toBe("text/csv; charset=utf-8");
  });

  it("csv_export:read はあっても csv_export_personal:read が無ければ 403（DB/AuditLog なし）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(
      PERMS_NO_CSV_PERSONAL as any,
    );

    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    expect(pm.property.findMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
    expect(res.headers.get("Content-Type")).not.toBe("text/csv; charset=utf-8");
  });

  it("property:read + csv_export:read + csv_export_personal:read の3権限が揃って初めて CSV 出力できる", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL as any);
    pm.property.findMany.mockResolvedValue([makeProp()]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
  });

  it("field_staff スコープが where.AND に積まれる", async () => {
    vi.mocked(getApiSession).mockResolvedValue({
      id: "fs-1",
      email: "fs@x",
      name: "FS",
      role: "field_staff",
    } as any);
    pm.property.findMany.mockResolvedValue([]);

    await GET(makeRequest());

    const where = pm.property.findMany.mock.calls[0][0].where;
    const and = where.AND ?? [];
    const scope = and.find((c: any) =>
      c?.OR?.some((x: any) => x.createdBy === "fs-1"),
    );
    expect(scope).toBeDefined();
    expect(scope.OR).toContainEqual({ createdBy: "fs-1" });
    expect(scope.OR).toContainEqual({ assignedTo: "fs-1" });
    // archived は常に除外
    expect(where.isArchived).toBe(false);
  });

  it("owner:read ありで所有者名が出力される", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    const res = await GET(makeRequest());
    const csv = await res.text();
    expect(csv).toContain("所有 花子");
  });

  it("owner:read なしでは所有者名が空欄（getOwnerDisplayConfig も呼ばない）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_OWNER as any);
    pm.property.findMany.mockResolvedValue([makeProp()]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const csv = await res.text();
    // 所有者名は出ない
    expect(csv).not.toContain("所有 花子");
    expect(getOwnerDisplayConfig).not.toHaveBeenCalled();
  });

  it("owner_name の display-level が masked なら maskValue 準拠でマスクされる", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValue({
      ...FULL_DISPLAY,
      name: "masked",
    } as any);
    pm.property.findMany.mockResolvedValue([
      makeProp({ propertyOwners: [{ owner: { name: "山田一郎太" } }] }),
    ]);

    const res = await GET(makeRequest());
    const csv = await res.text();
    // 生の氏名は出ず、マスク（***+末尾4文字）になる
    expect(csv).not.toContain("山田一郎太");
    expect(csv).toContain("***");
  });

  it("10,000件超過時は切り捨てずエラー（CSV を返さない・AuditLog も書かない）", async () => {
    const many = Array.from({ length: 10001 }, (_, i) =>
      makeProp({ id: `p${i}` }),
    );
    pm.property.findMany.mockResolvedValue(many);

    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).not.toBe("text/csv; charset=utf-8");
    const body = await res.json();
    expect(body.error.code).toBe("EXPORT_LIMIT_EXCEEDED");
    // エラー時は監査ログを書かない
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("AuditLog は操作事実のみ。所有者名・CSV本文などの PII を含まない", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);

    await GET(makeRequest("?propertyType=land&dmStatus=send"));

    const audit = lastAudit();
    expect(audit.action).toBe("property_csv_export");
    expect(audit.targetTable).toBe("properties");
    expect(audit.targetId).toBeUndefined(); // targetId は持たせない（null 相当）
    expect(audit.detail.resultCount).toBe(1);
    expect(typeof audit.detail.exportedAt).toBe("string");
    expect(audit.detail.filters.propertyType).toBe("land");
    // 所有者名・住所など PII が detail に紛れ込まない
    const detailStr = JSON.stringify(audit.detail);
    expect(detailStr).not.toContain("所有 花子");
    expect(detailStr).not.toContain("東京都千代田区1-1");
  });

  it("AuditLog: mgmtId 生値を残さず mgmtIdLen / mgmtHitCount のみ記録", async () => {
    // importJobRow / property いずれも空 → mgmtId hit 0 → 短絡空結果
    pm.importJobRow.findMany.mockResolvedValue([]);
    pm.property.findMany.mockResolvedValue([]);

    const rawMgmtId = "受付帳XYZ.xlsx:777行";
    await GET(makeRequest("?mgmtId=" + encodeURIComponent(rawMgmtId)));

    const audit = lastAudit();
    expect(audit.detail.filters.mgmtId).toBeUndefined();
    expect(audit.detail.mgmtIdLen).toBe(rawMgmtId.length);
    expect(audit.detail.mgmtHitCount).toBe(0);
    expect(JSON.stringify(audit.detail)).not.toContain(rawMgmtId);
  });

  it("AuditLog: keyword 生値（住所など PII を含み得る）を filters に残さない", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);

    // keyword は address / lotNumber 等を検索するため住所を渡せてしまう。
    // この生値が監査ログに残らないこと（PII 漏洩防止）。
    const rawKeyword = "東京都千代田区1-1";
    await GET(
      makeRequest(
        "?keyword=" + encodeURIComponent(rawKeyword) + "&propertyType=land",
      ),
    );

    const audit = lastAudit();
    expect(audit.detail.filters.keyword).toBeUndefined();
    // filters 以外も含め監査ログ全体に生 keyword が混入しない
    expect(JSON.stringify(audit.detail)).not.toContain(rawKeyword);
    // 通常の絞り込み条件は残る
    expect(audit.detail.filters.propertyType).toBe("land");
  });

  it("AuditLog: page / limit（全件出力では無意味）を filters に残さない", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);

    await GET(makeRequest("?page=3&limit=10&propertyType=land"));

    const audit = lastAudit();
    expect(audit.detail.filters.page).toBeUndefined();
    expect(audit.detail.filters.limit).toBeUndefined();
    expect(audit.detail.filters.propertyType).toBe("land");
  });

  it("AuditLog: filters は allowlist。unknown / token / apiKey / password / secret / env を残さない", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);

    await GET(
      makeRequest(
        "?propertyType=land&dmStatus=send" +
          "&token=tok-abc&apiKey=key-xyz&password=pw-123&secret=sec-456&env=production&foo=bar",
      ),
    );

    const audit = lastAudit();
    const filters = audit.detail.filters;
    // 任意 / 機微 query は一切残らない
    expect(filters.token).toBeUndefined();
    expect(filters.apiKey).toBeUndefined();
    expect(filters.password).toBeUndefined();
    expect(filters.secret).toBeUndefined();
    expect(filters.env).toBeUndefined();
    expect(filters.foo).toBeUndefined();
    // allowlist の正規 filter は残る
    expect(filters.propertyType).toBe("land");
    expect(filters.dmStatus).toBe("send");
    // 監査ログ全体にも生値が混入しない
    const detailStr = JSON.stringify(audit.detail);
    for (const leak of ["tok-abc", "key-xyz", "pw-123", "sec-456"]) {
      expect(detailStr).not.toContain(leak);
    }
  });

  it("CSV formula injection: 先頭が = + - @ のセル値は ' を付けて無害化して出力する", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        address: "=1+1",
        lotNumber: "+SUM(A1:A2)",
        realEstateNumber: "-10",
        propertyOwners: [{ owner: { name: "@cmd" } }],
      }),
    ]);

    const res = await GET(makeRequest());
    const csv = await res.text();
    expect(csv).toContain("'=1+1");
    expect(csv).toContain("'+SUM(A1:A2)");
    expect(csv).toContain("'-10");
    expect(csv).toContain("'@cmd");
  });

  it("CSV formula injection: 通常文字列・日本語ラベルは無害化で変化しない", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({ address: "東京都千代田区1-1" }),
    ]);

    const res = await GET(makeRequest());
    const csv = await res.text();
    // 先頭が無害なので ' は付かない
    expect(csv).toContain("東京都千代田区1-1");
    expect(csv).not.toContain("'東京都千代田区1-1");
  });

  it("所有者名にカンマ・ダブルクオートを含む場合 RFC4180 で CSV エスケープされる", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({ propertyOwners: [{ owner: { name: '所有者,"太郎"' } }] }),
    ]);

    const res = await GET(makeRequest());
    const csv = await res.text();
    // カンマ/クオートを含むので "" で囲い、内部 " は "" にエスケープ
    expect(csv).toContain('"所有者,""太郎"""');
    // 行が列区切りで壊れない（ヘッダ + 1行）
    expect(csv.split("\r\n")).toHaveLength(2);
  });

  it("複数所有者は「、」区切りで結合して出力する", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        propertyOwners: [
          { owner: { name: "所有 花子" } },
          { owner: { name: "所有 次郎" } },
        ],
      }),
    ]);

    const res = await GET(makeRequest());
    const csv = await res.text();
    expect(csv).toContain("所有 花子、所有 次郎");
  });

  it("updatedAt / createdAt が null の物件は日時セルが空欄", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({ updatedAt: null, createdAt: null }),
    ]);

    const res = await GET(makeRequest());
    const csv = await res.text();
    // makeProp 既定値にカンマを含むセルは無いので「,」分割で検証できる
    const cells = csv.split("\r\n")[1].split(",");
    expect(cells.at(-2)).toBe(""); // 更新日時
    expect(cells.at(-1)).toBe(""); // 作成日時
  });

  it("owner_name の display-level が hidden なら所有者名は空欄（生名を出さない）", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValue({
      ...FULL_DISPLAY,
      name: "hidden",
    } as any);
    pm.property.findMany.mockResolvedValue([
      makeProp({ propertyOwners: [{ owner: { name: "山田一郎太" } }] }),
    ]);

    const res = await GET(makeRequest());
    const csv = await res.text();
    expect(csv).not.toContain("山田一郎太");
  });

  it("所有者0件の物件でもエラーにならず所有者名は空欄", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({ propertyOwners: [] }),
    ]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv.split("\r\n")).toHaveLength(2); // ヘッダ + 1行
  });

  it("条件一致0件でもヘッダ行のみの CSV を 200 で返す（空 export がエラーにならない）", async () => {
    pm.property.findMany.mockResolvedValue([]);

    const res = await GET(makeRequest("?propertyType=land"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    const csv = await res.text();
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1); // ヘッダのみ
    expect(csv).toContain("管理ID");
  });
});

describe("buildPropertyListWhere（一覧 API と共有・従来挙動の固定）", () => {
  const adminSession = { id: "admin", role: "admin" };
  const baseQuery = {
    page: 1,
    limit: 50,
    includeArchived: false,
    sortBy: "updatedAt",
    sortOrder: "desc",
  } as any;

  it("既定で isArchived=false を付与する", async () => {
    const { where } = await buildPropertyListWhere(baseQuery, adminSession);
    expect(where.isArchived).toBe(false);
  });

  it("includeArchived=true なら isArchived 条件を付けない", async () => {
    const { where } = await buildPropertyListWhere(
      { ...baseQuery, includeArchived: true },
      adminSession,
    );
    expect(where.isArchived).toBeUndefined();
  });

  it("keyword は address/lotNumber/realEstateNumber/buildingNumber の OR", async () => {
    const { where } = await buildPropertyListWhere(
      { ...baseQuery, keyword: "東京" },
      adminSession,
    );
    expect(where.OR).toEqual([
      { address: { contains: "東京", mode: "insensitive" } },
      { lotNumber: { contains: "東京", mode: "insensitive" } },
      { realEstateNumber: { contains: "東京", mode: "insensitive" } },
      { buildingNumber: { contains: "東京", mode: "insensitive" } },
    ]);
  });

  it("field_staff は createdBy/assignedTo スコープを AND に積む", async () => {
    const { where } = await buildPropertyListWhere(baseQuery, {
      id: "fs-1",
      role: "field_staff",
    });
    const and = where.AND ?? [];
    expect(
      and.some((c: any) => c?.OR?.some((x: any) => x.createdBy === "fs-1")),
    ).toBe(true);
  });

  it("buildPropertyListOrderBy は { [sortBy]: sortOrder } を返す", () => {
    expect(buildPropertyListOrderBy(baseQuery)).toEqual({ updatedAt: "desc" });
    expect(
      buildPropertyListOrderBy({
        ...baseQuery,
        sortBy: "createdAt",
        sortOrder: "asc",
      }),
    ).toEqual({ createdAt: "asc" });
  });
});

describe("sanitizeCsvCellForExcel（CSV formula injection 対策）", () => {
  it("数式起動文字（= + - @ tab CR）で始まるセルは先頭に ' を付ける", () => {
    expect(sanitizeCsvCellForExcel("=1+1")).toBe("'=1+1");
    expect(sanitizeCsvCellForExcel("+SUM(A1:A2)")).toBe("'+SUM(A1:A2)");
    expect(sanitizeCsvCellForExcel("-10")).toBe("'-10");
    expect(sanitizeCsvCellForExcel("@cmd")).toBe("'@cmd");
    expect(sanitizeCsvCellForExcel("\tfoo")).toBe("'\tfoo"); // タブ開始
    expect(sanitizeCsvCellForExcel("\rfoo")).toBe("'\rfoo"); // CR 開始
  });

  it("通常文字列はそのまま（数式起動文字が先頭でなければ変えない）", () => {
    expect(sanitizeCsvCellForExcel("東京都千代田区1-1")).toBe("東京都千代田区1-1");
    expect(sanitizeCsvCellForExcel("RE-1")).toBe("RE-1");
    expect(sanitizeCsvCellForExcel("12-3")).toBe("12-3");
    expect(sanitizeCsvCellForExcel("abc=1")).toBe("abc=1"); // 途中の = は対象外
  });

  it("null / undefined / 空文字は空文字を返す（既存挙動を壊さない）", () => {
    expect(sanitizeCsvCellForExcel(null)).toBe("");
    expect(sanitizeCsvCellForExcel(undefined)).toBe("");
    expect(sanitizeCsvCellForExcel("")).toBe("");
  });
});
