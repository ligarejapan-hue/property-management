/**
 * GET /api/admin/postal-code-audit のルートテスト。
 *
 * - 外部 API は @/lib/address-lookup のモック注入で検証（実 API には一切アクセスしない）。
 * - 認可 403 / API 未設定時の安全動作 / 一致・不一致・判定不能 / 上限 truncation /
 *   CSV / 監査ログに PII を残さないこと / PII egress が郵便番号のみであること を網羅。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(input, init);
    }
  }
  class MockNextResponse extends Response {
    static json(data: unknown, init?: { status?: number }) {
      return Response.json(data, init);
    }
  }
  return {
    NextRequest: MockNextRequest,
    NextResponse: MockNextResponse,
  };
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
    getApiSession: vi.fn().mockResolvedValue({
      id: "user-1",
      email: "admin@test.com",
      name: "Admin",
      role: "admin",
    }),
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
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data, { status }),
    ),
  };
});

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  default: {
    owner: { findMany: vi.fn() },
  },
}));

// address-lookup orchestrator をモック注入（実 API 非アクセス）。
const lookupMock = vi.fn();
const configuredMock = vi.fn();
vi.mock("@/lib/address-lookup", async () => {
  const actual = await vi.importActual<typeof import("../address-lookup")>(
    "../address-lookup",
  );
  return {
    ...actual,
    lookupAddressByPostalCode: (zip: string) => lookupMock(zip),
    isAddressLookupConfigured: () => configuredMock(),
  };
});

import prisma from "@/lib/prisma";
import {
  getUserPermissions,
  getOwnerDisplayConfig,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { GET } from "../../app/api/admin/postal-code-audit/route";

const pm = prisma as unknown as { owner: { findMany: Mock } };
const permsMock = getUserPermissions as unknown as Mock;
const displayMock = getOwnerDisplayConfig as unknown as Mock;
const auditMock = writeAuditLog as unknown as Mock;

const FULL_PERMS = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
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

function req(url = "http://localhost/api/admin/postal-code-audit") {
  return new Request(url) as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  permsMock.mockResolvedValue(FULL_PERMS);
  displayMock.mockResolvedValue(FULL_DISPLAY);
  configuredMock.mockReturnValue(true);
  lookupMock.mockResolvedValue([]);
  pm.owner.findMany.mockResolvedValue([]);
});

describe("認可", () => {
  it("user_management:read が無ければ 403（DB/API/監査を呼ばない）", async () => {
    permsMock.mockResolvedValue([{ resource: "owner", action: "read", granted: true }]);
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(pm.owner.findMany).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("owner:read が無ければ 403", async () => {
    permsMock.mockResolvedValue([
      { resource: "user_management", action: "read", granted: true },
    ]);
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(pm.owner.findMany).not.toHaveBeenCalled();
  });

  it("CSV 出力は csv_export_personal が無ければ 403", async () => {
    permsMock.mockResolvedValue([
      { resource: "user_management", action: "read", granted: true },
      { resource: "owner", action: "read", granted: true },
      { resource: "csv_export", action: "read", granted: true },
    ]);
    const res = await GET(req("http://localhost/api/admin/postal-code-audit?format=csv"));
    expect(res.status).toBe(403);
  });
});

describe("照合結果", () => {
  it("一致・不一致・判定不能を分類する", async () => {
    pm.owner.findMany.mockResolvedValue([
      { id: "o-match", name: "一致氏名", zip: "1000005", address: "東京都千代田区丸の内1-1" },
      { id: "o-mismatch", name: "不一致氏名", zip: "1000005", address: "大阪府大阪市北区梅田" },
      { id: "o-nocand", name: "候補なし", zip: "9999999", address: "どこか町1-1" },
      { id: "o-badzip", name: "番号不正", zip: "123", address: "東京都千代田区" },
    ]);
    lookupMock.mockImplementation(async (zip: string) => {
      if (zip === "1000005") return [{ addressLine: "東京都千代田区丸の内", source: "mock" }];
      return []; // 9999999 → 候補なし
    });

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    const byId = Object.fromEntries(body.rows.map((r: { ownerId: string }) => [r.ownerId, r]));
    expect(byId["o-match"].verdict).toBe("match");
    expect(byId["o-mismatch"].verdict).toBe("mismatch");
    expect(byId["o-nocand"].verdict).toBe("indeterminate");
    expect(byId["o-nocand"].reason).toBe("no_candidate");
    expect(byId["o-badzip"].verdict).toBe("indeterminate");
    expect(byId["o-badzip"].reason).toBe("invalid_postal_code");
    expect(body.summary).toEqual({ total: 4, match: 1, mismatch: 1, indeterminate: 2 });
    expect(body.apiConfigured).toBe(true);
  });

  it("不正郵便番号は API を叩かない（PII egress / 無駄打ち回避）", async () => {
    pm.owner.findMany.mockResolvedValue([
      { id: "o1", name: "n", zip: "123", address: "東京都千代田区" },
    ]);
    await GET(req());
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("PII egress は郵便番号のみ（lookup に住所は渡さない）", async () => {
    pm.owner.findMany.mockResolvedValue([
      { id: "o1", name: "山田", zip: "100-0005", address: "東京都千代田区丸の内1-1" },
    ]);
    lookupMock.mockResolvedValue([{ addressLine: "東京都千代田区丸の内", source: "mock" }]);
    await GET(req());
    expect(lookupMock).toHaveBeenCalledTimes(1);
    // 正規化後 7 桁の郵便番号のみが渡る。住所が引数に混ざらない。
    expect(lookupMock).toHaveBeenCalledWith("1000005");
    const arg = lookupMock.mock.calls[0][0];
    expect(arg).not.toContain("東京");
  });

  it("同一郵便番号はキャッシュして 1 回だけ lookup する", async () => {
    pm.owner.findMany.mockResolvedValue([
      { id: "o1", name: "a", zip: "1000005", address: "東京都千代田区丸の内" },
      { id: "o2", name: "b", zip: "100-0005", address: "東京都千代田区丸の内2-2" },
    ]);
    lookupMock.mockResolvedValue([{ addressLine: "東京都千代田区丸の内", source: "mock" }]);
    await GET(req());
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });
});

describe("API 未設定時の安全動作", () => {
  it("未設定なら照合せず全件 lookup_unavailable・apiConfigured=false", async () => {
    configuredMock.mockReturnValue(false);
    pm.owner.findMany.mockResolvedValue([
      { id: "o1", name: "n", zip: "1000005", address: "東京都千代田区丸の内" },
    ]);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apiConfigured).toBe(false);
    expect(lookupMock).not.toHaveBeenCalled();
    expect(body.rows[0].verdict).toBe("indeterminate");
    expect(body.rows[0].reason).toBe("lookup_unavailable");
  });
});

describe("上限 truncation", () => {
  it("対象が上限超過なら truncated=true で打ち切る（silent切り捨てしない）", async () => {
    // route は take=MAX+1。MAX+1 件返れば truncated。テストでは小さく差し替えできないため、
    // findMany が MAX+1 件返した状況を再現する。
    const { POSTAL_AUDIT_MAX_TARGETS } = await import("../postal-code-audit");
    const many = Array.from({ length: POSTAL_AUDIT_MAX_TARGETS + 1 }, (_, i) => ({
      id: `o${i}`,
      name: "n",
      zip: "1000005",
      address: "東京都千代田区丸の内",
    }));
    pm.owner.findMany.mockResolvedValue(many);
    lookupMock.mockResolvedValue([{ addressLine: "東京都千代田区丸の内", source: "mock" }]);
    const res = await GET(req());
    const body = await res.json();
    expect(body.truncated).toBe(true);
    expect(body.summary.total).toBe(POSTAL_AUDIT_MAX_TARGETS);
  });
});

describe("CSV", () => {
  it("?format=csv で CSV を返す（BOM + ヘッダ + no-store）", async () => {
    pm.owner.findMany.mockResolvedValue([
      { id: "o1", name: "山田太郎", zip: "1000005", address: "大阪府大阪市北区梅田" },
    ]);
    lookupMock.mockResolvedValue([{ addressLine: "東京都千代田区丸の内", source: "mock" }]);
    const res = await GET(req("http://localhost/api/admin/postal-code-audit?format=csv"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    // BOM はバイト列で確認する（Response.text() は先頭 BOM を decode 時に剥がすため）。
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder("utf-8").decode(bytes);
    expect(text).toContain("所有者ID");
    expect(text).toContain("不一致");
  });
});

describe("監査ログ", () => {
  it("PII を記録せず件数・サマリ・フラグのみ残す", async () => {
    pm.owner.findMany.mockResolvedValue([
      { id: "o1", name: "山田太郎", zip: "1000005", address: "東京都千代田区丸の内1-1" },
    ]);
    lookupMock.mockResolvedValue([{ addressLine: "東京都千代田区丸の内", source: "mock" }]);
    await GET(req());
    expect(auditMock).toHaveBeenCalledTimes(1);
    const call = auditMock.mock.calls[0][0];
    expect(call.action).toBe("postal_code_audit_list");
    const serialized = JSON.stringify(call.detail);
    expect(serialized).not.toContain("山田");
    expect(serialized).not.toContain("丸の内");
    expect(serialized).not.toContain("1000005");
    expect(call.detail.summary.total).toBe(1);
    expect(call.detail.apiConfigured).toBe(true);
  });

  it("CSV 出力時は action=postal_code_audit_csv_export", async () => {
    pm.owner.findMany.mockResolvedValue([]);
    await GET(req("http://localhost/api/admin/postal-code-audit?format=csv"));
    expect(auditMock.mock.calls[0][0].action).toBe("postal_code_audit_csv_export");
  });
});

describe("マスキング", () => {
  it("住所が生値レベルでない場合 API住所は出さない", async () => {
    displayMock.mockResolvedValue({ ...FULL_DISPLAY, address: "masked" });
    pm.owner.findMany.mockResolvedValue([
      { id: "o1", name: "山田", zip: "1000005", address: "東京都千代田区丸の内1-1" },
    ]);
    lookupMock.mockResolvedValue([{ addressLine: "大阪府大阪市北区梅田", source: "mock" }]);
    const res = await GET(req());
    const body = await res.json();
    expect(body.rows[0].apiAddressLine).toBeNull();
    // 判定自体は内部の生値で行われる（mismatch のまま）。
    expect(body.rows[0].verdict).toBe("mismatch");
  });
});
