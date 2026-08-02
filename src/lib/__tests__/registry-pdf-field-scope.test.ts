/**
 * A-2d: 謄本PDF確定取込の Mode A（propertyId 直指定）で field_staff スコープを
 * サーバ側強制することを検証する。
 *  - field_staff は createdBy/assignedTo 不一致の物件を propertyId 指定で更新できない（403）
 *  - admin / office_staff / 担当 field_staff は access チェックで弾かれない
 *  - import:write が無ければ従来どおり 403
 * 既存 registry-pdf テストと同じ mock 方式。property-access は実物を使う（挙動検証）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(input, init);
    }
  }
  return { NextRequest: MockNextRequest };
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
    getUserPermissions: vi.fn().mockResolvedValue([]),
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

vi.mock("@/lib/permissions", () => ({ hasPermission: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/change-log", () => ({
  recordChanges: vi.fn(),
  PROPERTY_TRACKED_FIELDS: [],
}));
vi.mock("@/lib/pdf-registry-parser", () => ({
  parseRegistryText: vi.fn(() => ({
    realEstateNumber: null,
    address: null,
    lotNumber: null,
    buildingNumber: null,
    landCategory: null,
    area: null,
    owners: [],
    warnings: [],
    confidence: 0.5,
  })),
}));
vi.mock("@/lib/pdf-extract", () => ({
  extractTextFromPdf: vi.fn(),
  isPdfBuffer: vi.fn().mockReturnValue(true),
}));
vi.mock("@/lib/prisma", () => ({
  default: {
    property: {
      findUnique: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    importJob: { create: vi.fn(), update: vi.fn() },
    importJobRow: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { POST as REGISTRY_PDF_POST } from "../../app/api/import/registry-pdf/route";

const PROP_ID = "11111111-1111-4111-8111-111111111111";

const pm = prisma as unknown as {
  property: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  importJob: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  importJobRow: { create: ReturnType<typeof vi.fn> };
};

function jsonReq(body: unknown) {
  return new Request("http://test/api/import/registry-pdf", {
    method: "POST",
    headers: { "content-type": "application/json" , "content-length": String(Buffer.byteLength(JSON.stringify(body))) },
    body: JSON.stringify(body),
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  (hasPermission as ReturnType<typeof vi.fn>).mockReturnValue(true);
  (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([
    { resource: "import", action: "write", granted: true },
  ]);
  pm.importJob.create.mockResolvedValue({ id: "job-1" });
  pm.importJob.update.mockResolvedValue({});
  pm.importJobRow.create.mockResolvedValue({});
  pm.property.update.mockResolvedValue({ id: PROP_ID });
});

function setSession(id: string, role: string) {
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({
    id,
    role,
    email: "u@test",
    name: "U",
  });
}

describe("A-2d: registry-pdf Mode A field_staff スコープ (挙動)", () => {
  it("4. field_staff がアクセス不可物件を propertyId 直指定すると 403", async () => {
    setSession("u-field", "field_staff");
    pm.property.findUnique.mockResolvedValue({
      id: PROP_ID,
      createdBy: "someone-else",
      assignedTo: "another",
      registryStatus: "unconfirmed",
    });
    const res = await REGISTRY_PDF_POST(jsonReq({ text: "x", propertyId: PROP_ID }));
    expect(res.status).toBe(403);
  });

  it("3. field_staff が担当(assignedTo)物件は access で弾かれない", async () => {
    setSession("u-field", "field_staff");
    pm.property.findUnique.mockResolvedValue({
      id: PROP_ID,
      createdBy: "someone-else",
      assignedTo: "u-field",
      registryStatus: "unconfirmed",
    });
    const res = await REGISTRY_PDF_POST(jsonReq({ text: "x", propertyId: PROP_ID }));
    expect(res.status).not.toBe(403);
  });

  it("1. admin は propertyId 指定で access 拒否されない", async () => {
    setSession("u-admin", "admin");
    pm.property.findUnique.mockResolvedValue({
      id: PROP_ID,
      createdBy: "someone-else",
      assignedTo: "another",
      registryStatus: "unconfirmed",
    });
    const res = await REGISTRY_PDF_POST(jsonReq({ text: "x", propertyId: PROP_ID }));
    expect(res.status).not.toBe(403);
  });

  it("2. office_staff は propertyId 指定で access 拒否されない", async () => {
    setSession("u-office", "office_staff");
    pm.property.findUnique.mockResolvedValue({
      id: PROP_ID,
      createdBy: "someone-else",
      assignedTo: "another",
      registryStatus: "unconfirmed",
    });
    const res = await REGISTRY_PDF_POST(jsonReq({ text: "x", propertyId: PROP_ID }));
    expect(res.status).not.toBe(403);
  });

  it("5. propertyId 不存在は 404（access チェックより前の既存仕様を壊さない）", async () => {
    setSession("u-admin", "admin");
    pm.property.findUnique.mockResolvedValue(null);
    const res = await REGISTRY_PDF_POST(jsonReq({ text: "x", propertyId: PROP_ID }));
    expect(res.status).toBe(404);
  });

  it("6. import:write が無ければ従来どおり 403（access チェック到達前）", async () => {
    setSession("u-field", "field_staff");
    (hasPermission as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const res = await REGISTRY_PDF_POST(jsonReq({ text: "x", propertyId: PROP_ID }));
    expect(res.status).toBe(403);
    expect(pm.property.findUnique).not.toHaveBeenCalled();
  });
});

// ── source-assertion: 実装の固定化 ──────────────────────────────────────────
const read = (p: string) =>
  fs.readFileSync(path.resolve(process.cwd(), p), "utf8");
// PR1: 取込コアは @/lib/registry-pdf/process へ移動。実装の所在に依存しないよう
// route.ts + process.ts の連結に対して source-assertion を行う。
// （route.ts が handler のみ export であることは export 検証で別途 route 単独で確認）
const routeSrc =
  read("src/app/api/import/registry-pdf/route.ts") +
  "\n" +
  read("src/lib/registry-pdf/process.ts");

describe("A-2d: registry-pdf route source-assertion", () => {
  it("canAccessPropertyRecord を import し Mode A で session+existing に適用", () => {
    expect(routeSrc).toMatch(
      /import \{ canAccessPropertyRecord \} from "@\/lib\/property-access"/,
    );
    expect(routeSrc).toMatch(/canAccessPropertyRecord\(session, existing\)/);
  });

  it("アクセス不可時は 403 FORBIDDEN を throw する", () => {
    expect(routeSrc).toMatch(
      /if \(!canAccessPropertyRecord\(session, existing\)\) \{[\s\S]*?ApiError\(\s*403/,
    );
    expect(routeSrc).toMatch(/"FORBIDDEN"/);
  });

  it("import:write 権限チェックを維持している", () => {
    expect(routeSrc).toMatch(/hasPermission\(perms, "import", "write"\)/);
  });

  it("7. AuditLog に rawText / 本文を増やしていない", () => {
    expect(routeSrc).not.toMatch(/rawText/);
  });

  it("8. route.ts は POST handler のみ export している", () => {
    // export 検証だけは route.ts 単独で行う（handler 以外を export しないことの確認）。
    const routeOnlySrc = read("src/app/api/import/registry-pdf/route.ts");
    const exports =
      routeOnlySrc.match(/^export (async function|function|const) \w+/gm) || [];
    expect(exports.join("\n")).toMatch(/export async function POST/);
    expect(exports.length).toBe(1);
  });
});
