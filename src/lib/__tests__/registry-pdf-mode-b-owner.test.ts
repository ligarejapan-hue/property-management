/**
 * A-2c: 謄本PDF確定取込の Mode B（propertyId 未指定で物件を照合/新規作成）でも
 *       抽出済み所有者を Owner / PropertyOwner へ反映することを検証する。
 *
 *  - Mode A の owner 反映を共通関数 reflectParsedOwners に抽出（挙動不変）し、
 *    Mode B でも targetPropertyId 確定後・field_staff スコープ確認後に呼ぶ。
 *  - 既存 active Owner の再利用 / 新規 Owner 作成 / archive race fallback /
 *    PropertyOwner 重複防止 / name空skip / address無は新規 を Mode B で検証。
 *  - field_staff がアクセス不可の Mode B matched 物件では owner 反映を skip + warning。
 *  - 反映件数 ownersMatched/ownersCreated/ownersLinked を response/rawData/audit に
 *    非PII で載せ、audit-log-detail-safety で安全に保持されることを検証。
 *
 * 既存 registry-pdf テスト（attachment / field-scope / archive-filter）と同じ mock 方式。
 * normalize / owner-corporate-import は実物を使用（owner 反映ロジックの実挙動を検証）。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
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
  parseRegistryText: vi.fn(),
}));
vi.mock("@/lib/pdf-extract", () => ({
  extractTextFromPdf: vi.fn().mockResolvedValue("dummy registry text"),
  isPdfBuffer: vi.fn().mockReturnValue(true),
}));
vi.mock("@/lib/storage", () => {
  const upload = vi.fn();
  const del = vi.fn();
  return {
    getStorage: vi.fn(() => ({ upload, delete: del })),
    validateFile: vi.fn(() => null),
    ALLOWED_ATTACHMENT_MIMES: new Set(["application/pdf"]),
  };
});

vi.mock("@/lib/prisma", () => ({
  default: {
    property: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    owner: {
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    propertyOwner: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    importJob: { create: vi.fn(), update: vi.fn() },
    importJobRow: { create: vi.fn() },
    attachment: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { sanitizeAuditDetail, REDACTED } from "@/lib/audit-log-detail-safety";
import { POST as REGISTRY_PDF_POST } from "../../app/api/import/registry-pdf/route";

const SESSION_ID = "user-1";
const PROP_A = "11111111-1111-4111-8111-111111111111"; // Mode A propertyId
const MATCHED_ID = "22222222-2222-4222-8222-222222222222"; // Mode B matched
const NEW_PROP_ID = "33333333-3333-4333-8333-333333333333"; // Mode B created

type ParsedOwner = { name: string; address: string | null; share: string | null };

const pm = prisma as unknown as {
  property: {
    findUnique: Mock;
    findFirst: Mock;
    create: Mock;
    update: Mock;
    updateMany: Mock;
  };
  owner: { findMany: Mock; create: Mock; updateMany: Mock };
  propertyOwner: { findFirst: Mock; create: Mock };
  importJob: { create: Mock; update: Mock };
  importJobRow: { create: Mock };
  attachment: { create: Mock };
  $transaction: Mock;
};

function setSession(role = "admin") {
  (getApiSession as Mock).mockResolvedValue({
    id: SESSION_ID,
    role,
    email: "u@test",
    name: "U",
  });
}

function setParsed(
  owners: ParsedOwner[],
  overrides: Record<string, unknown> = {},
) {
  (parseRegistryText as Mock).mockReturnValue({
    realEstateNumber: null,
    address: "東京都千代田区一番町1",
    lotNumber: null,
    buildingNumber: null,
    landCategory: null,
    area: null,
    owners,
    warnings: [],
    confidence: 0.9,
    ...overrides,
  });
}

function jsonReq(body: unknown) {
  return new Request("http://test/api/import/registry-pdf", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

function successRowData(): Record<string, unknown> | undefined {
  const call = pm.importJobRow.create.mock.calls.find(
    (c) => c[0]?.data?.status === "success",
  );
  return call?.[0]?.data?.rawData;
}

function auditDetail(): Record<string, unknown> | undefined {
  const call = (writeAuditLog as Mock).mock.calls.find(
    (c) => c[0]?.targetTable === "properties",
  );
  return call?.[0]?.detail;
}

beforeEach(() => {
  vi.clearAllMocks();
  setSession("admin");
  (hasPermission as Mock).mockReturnValue(true);
  (getUserPermissions as Mock).mockResolvedValue([
    { resource: "import", action: "write", granted: true },
  ]);
  pm.importJob.create.mockResolvedValue({ id: "job-1" });
  pm.importJob.update.mockResolvedValue({});
  pm.importJobRow.create.mockResolvedValue({});
  // Mode B: 既定は「マッチ無し → 新規作成」
  pm.property.findFirst.mockResolvedValue(null);
  pm.property.create.mockResolvedValue({ id: NEW_PROP_ID });
  // owner 反映用スコープ確認の既定（admin はどの値でも許可）
  pm.property.findUnique.mockResolvedValue({
    createdBy: SESSION_ID,
    assignedTo: null,
  });
  // owner 反映の既定: 候補なし → 新規 Owner 作成 + link
  pm.owner.findMany.mockResolvedValue([]);
  pm.owner.create.mockResolvedValue({ id: "owner-new" });
  pm.owner.updateMany.mockResolvedValue({ count: 1 });
  pm.propertyOwner.findFirst.mockResolvedValue(null);
  pm.propertyOwner.create.mockResolvedValue({});
  // $transaction: callback に prisma mock を tx として渡す（tx.owner / tx.propertyOwner 同一 mock）
  pm.$transaction.mockImplementation((cb: (tx: typeof prisma) => unknown) =>
    cb(prisma),
  );
  setParsed([]);
});

// ── Mode B: 既存物件 match → owner 反映 ──────────────────────────────────────
describe("A-2c: Mode B matched で owner を反映", () => {
  beforeEach(() => {
    setParsed([{ name: "山田太郎", address: "東京都港区1丁目1", share: null }]);
    pm.property.findFirst.mockResolvedValue({ id: MATCHED_ID });
  });

  it("1+2. 既存 active owner を再利用し PropertyOwner link を作成する", async () => {
    pm.owner.findMany.mockResolvedValue([
      {
        id: "owner-1",
        name: "山田太郎",
        address: "東京都港区1丁目1",
        corporateNumber: null,
      },
    ]);
    pm.owner.updateMany.mockResolvedValue({ count: 1 }); // tx lock 成功
    pm.propertyOwner.findFirst.mockResolvedValue(null); // 未link

    const res = await REGISTRY_PDF_POST(jsonReq({ text: "x" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.propertyId).toBe(MATCHED_ID);
    // 既存 owner を再利用（新規作成しない）
    expect(pm.owner.create).not.toHaveBeenCalled();
    // PropertyOwner link が作成される
    expect(pm.propertyOwner.create).toHaveBeenCalledTimes(1);
    expect(pm.propertyOwner.create.mock.calls[0][0].data).toMatchObject({
      propertyId: MATCHED_ID,
      ownerId: "owner-1",
      relationship: "所有者",
    });
    // 件数
    expect(body.ownersMatched).toBe(1);
    expect(body.ownersCreated).toBe(0);
    expect(body.ownersLinked).toBe(1);
  });

  it("8. 同一 owner が既に link 済みなら PropertyOwner を重複作成しない", async () => {
    pm.owner.findMany.mockResolvedValue([
      {
        id: "owner-1",
        name: "山田太郎",
        address: "東京都港区1丁目1",
        corporateNumber: null,
      },
    ]);
    pm.owner.updateMany.mockResolvedValue({ count: 1 });
    pm.propertyOwner.findFirst.mockResolvedValue({ propertyId: MATCHED_ID }); // 既存link

    const res = await REGISTRY_PDF_POST(jsonReq({ text: "x" }));
    const body = await res.json();
    expect(pm.propertyOwner.create).not.toHaveBeenCalled();
    expect(body.ownersMatched).toBe(1);
    expect(body.ownersLinked).toBe(0);
  });

  it("5. archive race（tx lock count=0）で新規 owner にフォールバックする", async () => {
    pm.owner.findMany.mockResolvedValue([
      {
        id: "owner-1",
        name: "山田太郎",
        address: "東京都港区1丁目1",
        corporateNumber: null,
      },
    ]);
    pm.owner.updateMany.mockResolvedValue({ count: 0 }); // race: archived between lookup/tx
    pm.owner.create.mockResolvedValue({ id: "owner-fallback" });

    const res = await REGISTRY_PDF_POST(jsonReq({ text: "x" }));
    const body = await res.json();
    // 新規 owner にフォールバック
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
    expect(pm.propertyOwner.create).toHaveBeenCalledTimes(1);
    expect(pm.propertyOwner.create.mock.calls[0][0].data.ownerId).toBe(
      "owner-fallback",
    );
    expect(body.ownersMatched).toBe(0);
    expect(body.ownersCreated).toBe(1);
    expect(body.ownersLinked).toBe(1);
  });
});

// ── Mode B: 新規物件作成 → owner 反映 ────────────────────────────────────────
describe("A-2c: Mode B created で owner を反映", () => {
  it("3. 新規 Property 作成後に新規 Owner + PropertyOwner を作成する", async () => {
    setParsed([{ name: "佐藤花子", address: "大阪市北区2", share: null }]);
    pm.property.findFirst.mockResolvedValue(null); // マッチなし → create
    pm.owner.findMany.mockResolvedValue([]); // 候補なし → 新規

    const res = await REGISTRY_PDF_POST(jsonReq({ text: "x" }));
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.action).toBe("created");
    expect(body.propertyId).toBe(NEW_PROP_ID);
    expect(pm.property.create).toHaveBeenCalledTimes(1);
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
    expect(pm.propertyOwner.create).toHaveBeenCalledTimes(1);
    expect(pm.propertyOwner.create.mock.calls[0][0].data.propertyId).toBe(
      NEW_PROP_ID,
    );
    expect(body.ownersCreated).toBe(1);
    expect(body.ownersLinked).toBe(1);
    expect(body.ownersMatched).toBe(0);
  });

  it("4. archived owner は再利用せず（候補に出ない）新規 owner を作成する", async () => {
    setParsed([{ name: "鈴木次郎", address: "京都市左京区3", share: null }]);
    // findMany は isArchived:false で絞るため archived owner は返らない＝候補空
    pm.owner.findMany.mockResolvedValue([]);

    const res = await REGISTRY_PDF_POST(jsonReq({ text: "x" }));
    const body = await res.json();
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
    expect(body.ownersCreated).toBe(1);
    expect(body.ownersMatched).toBe(0);
  });

  it("6. name 空の owner は skip される", async () => {
    setParsed([{ name: "", address: "x", share: null }]);

    const res = await REGISTRY_PDF_POST(jsonReq({ text: "x" }));
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(pm.owner.findMany).not.toHaveBeenCalled();
    expect(pm.owner.create).not.toHaveBeenCalled();
    expect(pm.propertyOwner.create).not.toHaveBeenCalled();
    expect(body.ownersCreated).toBe(0);
    expect(body.ownersLinked).toBe(0);
  });

  it("7. address 無しの owner は誤統合せず新規 owner を作成する", async () => {
    setParsed([{ name: "無番地太郎", address: null, share: null }]);

    const res = await REGISTRY_PDF_POST(jsonReq({ text: "x" }));
    const body = await res.json();
    // address 無 → 既存突合(findMany)を行わない
    expect(pm.owner.findMany).not.toHaveBeenCalled();
    // 新規 owner（address フィールド無し）
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
    expect(pm.owner.create.mock.calls[0][0].data).not.toHaveProperty("address");
    expect(body.ownersCreated).toBe(1);
  });
});

// ── Codex P2: PropertyOwner link 作成の同時実行冪等性 ────────────────────────
describe("A-2c/P2: PropertyOwner link 作成を unique 競合に対して冪等化", () => {
  const P2002 = Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
  });

  it("1+2+3. reuse パスで link 作成が P2002 → job は失敗せず既存リンク扱い・linkedCount 増えない", async () => {
    setParsed([{ name: "山田太郎", address: "東京都港区1丁目1", share: null }]);
    pm.property.findFirst.mockResolvedValue({ id: MATCHED_ID });
    pm.owner.findMany.mockResolvedValue([
      {
        id: "owner-1",
        name: "山田太郎",
        address: "東京都港区1丁目1",
        corporateNumber: null,
      },
    ]);
    pm.owner.updateMany.mockResolvedValue({ count: 1 }); // tx lock 成功
    pm.propertyOwner.findFirst.mockResolvedValue(null); // findFirst では未link
    // しかし create 時点で別 tx が先に link 済み → unique 制約違反
    pm.propertyOwner.create.mockRejectedValueOnce(P2002);

    const res = await REGISTRY_PDF_POST(jsonReq({ text: "x" }));
    expect(res.status).toBe(201); // job 全体は失敗しない
    const body = await res.json();
    expect(body.propertyId).toBe(MATCHED_ID);
    // 既存リンク扱い: 再利用としてカウント、新規 owner は作らない
    expect(body.ownersMatched).toBe(1);
    expect(pm.owner.create).not.toHaveBeenCalled();
    // linkedCount は二重に増えない
    expect(body.ownersLinked).toBe(0);
  });

  it("新規 owner パスで link 作成が P2002 → job は失敗せず linkedCount 増えない", async () => {
    setParsed([{ name: "佐藤花子", address: "大阪市北区2", share: null }]);
    pm.property.findFirst.mockResolvedValue(null); // 新規 Property
    pm.owner.findMany.mockResolvedValue([]); // 候補なし → 新規 owner
    pm.owner.create.mockResolvedValue({ id: "owner-new" });
    pm.propertyOwner.findFirst.mockResolvedValue(null);
    pm.propertyOwner.create.mockRejectedValueOnce(P2002);

    const res = await REGISTRY_PDF_POST(jsonReq({ text: "x" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ownersCreated).toBe(1);
    expect(body.ownersLinked).toBe(0); // 重複で増やさない
  });

  it("4. P2002 以外の DB エラーは従来どおり job failed になる", async () => {
    setParsed([{ name: "佐藤花子", address: "大阪市北区2", share: null }]);
    pm.property.findFirst.mockResolvedValue(null);
    pm.owner.findMany.mockResolvedValue([]);
    pm.owner.create.mockResolvedValue({ id: "owner-new" });
    pm.propertyOwner.findFirst.mockResolvedValue(null);
    // 一般的な DB エラー（P2002 ではない）→ 握りつぶさず伝播
    pm.propertyOwner.create.mockRejectedValueOnce(new Error("connection lost"));

    const res = await REGISTRY_PDF_POST(jsonReq({ text: "x" }));
    // 取込本体が失敗（handleApiError 経由で非201）
    expect(res.status).not.toBe(201);
    // import job は failed で finalize される
    expect(pm.importJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "failed" }),
      }),
    );
  });
});

// ── field_staff scope（Mode B matched）───────────────────────────────────────
describe("A-2c: field_staff スコープ（Mode B matched）", () => {
  beforeEach(() => {
    setSession("field_staff");
    setParsed([{ name: "山田太郎", address: "東京都港区1", share: null }]);
    pm.property.findFirst.mockResolvedValue({ id: MATCHED_ID });
  });

  it("9. アクセス不可物件では owner 反映を skip し warning を返す", async () => {
    pm.property.findUnique.mockResolvedValue({
      createdBy: "someone-else",
      assignedTo: "another",
    });

    const res = await REGISTRY_PDF_POST(jsonReq({ text: "x" }));
    const body = await res.json();
    // owner 反映は一切実行されない
    expect(pm.owner.findMany).not.toHaveBeenCalled();
    expect(pm.owner.create).not.toHaveBeenCalled();
    expect(pm.propertyOwner.create).not.toHaveBeenCalled();
    expect(body.ownersMatched).toBe(0);
    expect(body.ownersCreated).toBe(0);
    expect(body.ownersLinked).toBe(0);
    expect(typeof body.warning).toBe("string");
    expect(body.warning).toContain("所有者");
  });

  it("10. アクセス不可でも取込本体 matched は成功を維持する", async () => {
    pm.property.findUnique.mockResolvedValue({
      createdBy: "someone-else",
      assignedTo: "another",
    });
    const res = await REGISTRY_PDF_POST(jsonReq({ text: "x" }));
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.action).toBe("matched");
    expect(body.propertyId).toBe(MATCHED_ID);
  });

  it("field_staff が担当(assignedTo)物件なら owner 反映される", async () => {
    pm.property.findUnique.mockResolvedValue({
      createdBy: "someone-else",
      assignedTo: SESSION_ID, // 担当 → アクセス可
    });
    const res = await REGISTRY_PDF_POST(jsonReq({ text: "x" }));
    const body = await res.json();
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
    expect(body.ownersCreated).toBe(1);
    expect(body.warning).toBeUndefined();
  });
});

// ── Mode A 不変（共通関数抽出後）─────────────────────────────────────────────
describe("A-2c: Mode A の owner 反映が共通関数抽出後も不変", () => {
  it("11. Mode A(propertyId 指定) で owner 反映が従来どおり動作する", async () => {
    setParsed([{ name: "田中一郎", address: "名古屋市中区3", share: null }]);
    pm.property.findUnique.mockResolvedValue({
      id: PROP_A,
      createdBy: "someone-else", // admin なのでアクセス可
      assignedTo: "another",
      registryStatus: "obtained",
      version: 0,
      realEstateNumber: "REN",
      lotNumber: "1",
      buildingNumber: "1",
    });
    pm.owner.findMany.mockResolvedValue([]); // 新規 owner

    const res = await REGISTRY_PDF_POST(
      jsonReq({ text: "x", propertyId: PROP_A }),
    );
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.propertyId).toBe(PROP_A);
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
    expect(pm.propertyOwner.create).toHaveBeenCalledTimes(1);
    expect(pm.propertyOwner.create.mock.calls[0][0].data.propertyId).toBe(
      PROP_A,
    );
    expect(body.ownersCreated).toBe(1);
    expect(body.ownersLinked).toBe(1);
  });

  it("relationship は share 有りで「共有者」", async () => {
    setParsed([
      { name: "共有太郎", address: "札幌市中央区4", share: "1/2" },
    ]);
    const res = await REGISTRY_PDF_POST(jsonReq({ text: "x" }));
    await res.json();
    expect(pm.propertyOwner.create.mock.calls[0][0].data.relationship).toBe(
      "共有者",
    );
  });
});

// ── 件数の response / rawData / audit 反映 ───────────────────────────────────
describe("A-2c: ownersMatched/Created/Linked を response/rawData/audit に載せる", () => {
  beforeEach(() => {
    setParsed([{ name: "佐藤花子", address: "大阪市北区2", share: null }]);
  });

  it("12. response に 3 件数が返る", async () => {
    const res = await REGISTRY_PDF_POST(jsonReq({ text: "x" }));
    const body = await res.json();
    expect(typeof body.ownersMatched).toBe("number");
    expect(typeof body.ownersCreated).toBe("number");
    expect(typeof body.ownersLinked).toBe("number");
  });

  it("13. ImportJobRow.rawData に 3 件数が入る", async () => {
    await REGISTRY_PDF_POST(jsonReq({ text: "x" }));
    const raw = successRowData();
    expect(raw).toMatchObject({
      ownersMatched: 0,
      ownersCreated: 1,
      ownersLinked: 1,
    });
  });

  it("14. AuditLog detail に 3 件数が入る", async () => {
    await REGISTRY_PDF_POST(jsonReq({ text: "x" }));
    const detail = auditDetail();
    expect(detail).toMatchObject({
      ownersMatched: 0,
      ownersCreated: 1,
      ownersLinked: 1,
    });
  });

  it("15. AuditLog detail に owner名/住所/郵便番号/rawText/PDF本文が入らない", async () => {
    setParsed([{ name: "個人情報太郎", address: "秘密住所5", share: null }]);
    await REGISTRY_PDF_POST(jsonReq({ text: "x" }));
    const detail = auditDetail()!;
    const keys = Object.keys(detail);
    for (const k of ["owners", "ownerNames", "address", "zip", "rawText", "text", "pdfText"]) {
      expect(keys).not.toContain(k);
    }
    const json = JSON.stringify(detail);
    expect(json).not.toContain("個人情報太郎");
    expect(json).not.toContain("秘密住所5");
  });
});

// ── audit-log-detail-safety: 3 件数キーが安全に保持される ────────────────────
describe("A-2c: audit-log-detail-safety の force-safe（pdf_import）", () => {
  it("16. pdf_import で ownersMatched/Created/Linked は保持、owner名/住所/zip は [REDACTED]", () => {
    const sanitized = sanitizeAuditDetail("pdf_import", {
      jobId: "j1",
      ownersMatched: 1,
      ownersCreated: 2,
      ownersLinked: 3,
      owner: "山田太郎",
      ownerName: "山田太郎",
      address: "東京都港区",
      zip: "1000001",
      note: "secret",
    }) as Record<string, unknown>;
    expect(sanitized.ownersMatched).toBe(1);
    expect(sanitized.ownersCreated).toBe(2);
    expect(sanitized.ownersLinked).toBe(3);
    // PII は引き続きマスク
    expect(sanitized.owner).toBe(REDACTED);
    expect(sanitized.ownerName).toBe(REDACTED);
    expect(sanitized.address).toBe(REDACTED);
    expect(sanitized.zip).toBe(REDACTED);
    expect(sanitized.note).toBe(REDACTED);
  });

  it("unknown action では owner件数キーは保持されない（force-safe は pdf_import 限定）", () => {
    const sanitized = sanitizeAuditDetail("some_other_action", {
      ownersMatched: 1,
    }) as Record<string, unknown>;
    expect(sanitized.ownersMatched).toBe(REDACTED);
  });
});

// ── source-assertion: 実装固定 ───────────────────────────────────────────────
const read = (p: string) =>
  fs.readFileSync(path.resolve(process.cwd(), p), "utf8");
const routeSrc = read("src/app/api/import/registry-pdf/route.ts");
const safetySrc = read("src/lib/audit-log-detail-safety.ts");

describe("A-2c: registry-pdf route source-assertion", () => {
  it("17. route.ts は POST handler のみ export している", () => {
    const exports =
      routeSrc.match(/^export (async function|function|const) \w+/gm) || [];
    expect(exports.join("\n")).toMatch(/export async function POST/);
    expect(exports.length).toBe(1);
  });

  it("18. route.ts に rawText を混入していない", () => {
    expect(routeSrc).not.toMatch(/rawText/);
  });

  it("reflectParsedOwners を Mode A / Mode B 双方で呼ぶ", () => {
    expect(routeSrc).toMatch(/async function reflectParsedOwners\(/);
    // Mode A
    expect(routeSrc).toMatch(/reflectParsedOwners\(\{\s*propertyId,/);
    // Mode B
    expect(routeSrc).toMatch(/reflectParsedOwners\(\{\s*propertyId: targetPropertyId,/);
  });

  it("owner 突合は isArchived:false で archived を除外する", () => {
    expect(routeSrc).toMatch(/where: \{ address: \{ not: null \}, isArchived: false \}/);
  });

  it("Mode B owner 反映前に canAccessPropertyRecord でスコープ確認する", () => {
    expect(routeSrc).toMatch(
      /if \(!targetProp \|\| !canAccessPropertyRecord\(session, targetProp\)\)/,
    );
  });

  it("audit-log-detail-safety が pdf_import の owner件数を force-safe にしている", () => {
    expect(safetySrc).toMatch(
      /pdf_import: new Set\(\["ownersMatched", "ownersCreated", "ownersLinked"\]\)/,
    );
  });
});
