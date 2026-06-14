/**
 * PR4: 謄本自動取得 API（POST /api/properties/[id]/registry/auto-fetch・mock provider のみ）。
 *
 * 確認項目（指示の追加テスト 1〜12 に対応）:
 *  1. confirmed:true が無ければ実行されない（400・DB/provider 未到達）
 *  2. registry:auto_fetch 権限が無ければ 403（route）
 *  3. property access scope（field_staff）が守られる（403・provider 未到達）
 *  4. mock provider が呼ばれる（非PIIの検索キーで）
 *  5. provider の pdfBuffer が extract → processRegistryPdf（upload/Attachment）へ接続される
 *  6. 成功時に registryStatus が scheduled → obtained に更新される
 *  7. 進行中（scheduled）ロック中は二重実行されない（409・provider 未到達）
 *  8. provider 失敗時に registryStatus がロック解除される（previous へ戻る・process 未到達）
 *  9. AuditLog に PII / rawText / fileUrl 全文 / owner / address / zip / token 等が入らない
 * 10. 外部 HTTP / Playwright / env / APIキー を使っていない（source-assertion）
 * 11. schema / migration / package を変更していない（source-assertion + 検証ゲートで担保）
 * 12. route.ts は POST handler 以外を export しない
 *
 * テスト方式は既存 registry-pdf 系（route 実行 + prisma/storage 等 mock）と
 * quality-check route（hasPermission は実物・getUserPermissions のみ mock）に倣う。
 * lib コア runRegistryAutoFetch は provider 注入で直接検証し、権限ゲートは route 実行で検証する。
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
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
    getUserPermissions: vi.fn(),
    parseJsonBody: vi.fn(async (req: Request) => {
      const t = await req.text();
      return t.trim() === "" ? {} : JSON.parse(t);
    }),
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data as Record<string, unknown>, { status }),
    ),
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
  };
});

// hasPermission は実物を使用（quality-check route テスト方針）。getUserPermissions のみ mock。
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/change-log", () => ({
  recordChanges: vi.fn(),
  PROPERTY_TRACKED_FIELDS: [],
}));
vi.mock("@/lib/pdf-registry-parser", () => ({ parseRegistryText: vi.fn() }));
vi.mock("@/lib/pdf-extract", () => ({
  extractTextFromPdf: vi.fn(),
  isPdfBuffer: vi.fn(),
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
    owner: { findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    propertyOwner: { findFirst: vi.fn(), create: vi.fn() },
    importJob: { create: vi.fn(), update: vi.fn() },
    importJobRow: { create: vi.fn() },
    attachment: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  parseJsonBody,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { extractTextFromPdf, isPdfBuffer } from "@/lib/pdf-extract";
import { getStorage } from "@/lib/storage";
import {
  MockRegistryFetchProvider,
  type RegistryFetchProvider,
} from "@/lib/registry-fetch";
import { runRegistryAutoFetch } from "@/lib/registry-fetch/auto-fetch";
import * as routeModule from "@/app/api/properties/[id]/registry/auto-fetch/route";

const { POST } = routeModule;

const PROP_ID = "11111111-1111-4111-8111-111111111111";
const SESSION = { id: "user-1", role: "admin" };
const PROVIDER_PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4, 5, 6]); // "%PDF"+, length 10

const PERMS_FULL = [
  { resource: "registry", action: "auto_fetch", granted: true },
  { resource: "property", action: "read", granted: true },
];
const PERMS_NO_REGISTRY = [{ resource: "property", action: "read", granted: true }];

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

function uploadMock(): Mock {
  return (getStorage() as unknown as { upload: Mock }).upload;
}

const EMPTY_PARSED = () => ({
  realEstateNumber: null,
  address: null,
  lotNumber: null,
  buildingNumber: null,
  landCategory: null,
  area: null,
  owners: [] as Array<{ name: string; address: string | null; share: string | null }>,
  warnings: [],
  confidence: 0.9,
});

function setProperty(over: Record<string, unknown> = {}) {
  pm.property.findUnique.mockResolvedValue({
    id: PROP_ID,
    createdBy: "user-1",
    assignedTo: null,
    registryStatus: "unconfirmed",
    version: 3,
    realEstateNumber: null,
    lotNumber: null,
    buildingNumber: null,
    ...over,
  });
}

type SpyProvider = RegistryFetchProvider & { fetchRegistryPdf: Mock };

function successProvider(over: Record<string, unknown> = {}): SpyProvider {
  return {
    name: "mock",
    fetchRegistryPdf: vi.fn().mockResolvedValue({
      pdfBuffer: PROVIDER_PDF,
      fileName: "registry-mock.pdf",
      source: "mock",
      fetchedAt: new Date(0),
      providerRequestId: "req-1",
      ...over,
    }),
  } as SpyProvider;
}

function runLib(opts: {
  confirmed?: boolean;
  session?: { id: string; role: string };
  provider?: RegistryFetchProvider;
} = {}) {
  const { confirmed = true, session = SESSION } = opts;
  // CodexP1: provider は必須引数。テストで未指定なら明示の mock を注入する。
  const provider = opts.provider ?? new MockRegistryFetchProvider();
  return runRegistryAutoFetch({ session, propertyId: PROP_ID, confirmed }, provider);
}

function callRoute(body: unknown) {
  const req = new Request(
    `http://test/api/properties/${PROP_ID}/registry/auto-fetch`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    },
  ) as never;
  return POST(req, { params: Promise.resolve({ id: PROP_ID }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  setProperty();
  pm.property.updateMany.mockResolvedValue({ count: 1 });
  pm.property.update.mockResolvedValue({});
  pm.property.findFirst.mockResolvedValue(null);
  pm.property.create.mockResolvedValue({ id: PROP_ID });
  pm.importJob.create.mockResolvedValue({ id: "job-1" });
  pm.importJob.update.mockResolvedValue({});
  pm.importJobRow.create.mockResolvedValue({});
  pm.attachment.create.mockResolvedValue({ id: "att-1" });
  pm.owner.findMany.mockResolvedValue([]);
  pm.owner.create.mockResolvedValue({ id: "owner-x" });
  pm.owner.updateMany.mockResolvedValue({ count: 1 });
  pm.propertyOwner.findFirst.mockResolvedValue(null);
  pm.propertyOwner.create.mockResolvedValue({});
  pm.$transaction.mockImplementation((cb: (tx: typeof prisma) => unknown) =>
    cb(prisma),
  );
  uploadMock().mockResolvedValue({ url: "/uploads/x.pdf", key: "x.pdf" });
  (parseRegistryText as Mock).mockReturnValue(EMPTY_PARSED());
  (extractTextFromPdf as Mock).mockResolvedValue("dummy registry text");
  (isPdfBuffer as Mock).mockReturnValue(true);
  (getApiSession as Mock).mockResolvedValue({
    id: "user-1",
    role: "admin",
    email: "u@test",
    name: "U",
  });
  (getUserPermissions as Mock).mockResolvedValue(PERMS_FULL);
});

function autoFetchAuditCall() {
  return (writeAuditLog as Mock).mock.calls.find(
    (c) => c[0]?.action === "registry_auto_fetch",
  );
}

describe("PR4: runRegistryAutoFetch (mock provider 接続)", () => {
  it("1. confirmed:true が無ければ実行されない（400・DB/provider 未到達）", async () => {
    const provider = successProvider();
    await expect(runLib({ confirmed: false, provider })).rejects.toMatchObject({
      status: 400,
      code: "REGISTRY_AUTO_FETCH_CONFIRMATION_REQUIRED",
    });
    expect(provider.fetchRegistryPdf).not.toHaveBeenCalled();
    expect(pm.property.findUnique).not.toHaveBeenCalled();
    expect(pm.property.updateMany).not.toHaveBeenCalled();
    expect(pm.importJob.create).not.toHaveBeenCalled();
  });

  it("3. property access scope（field_staff・担当外）で 403・provider 未到達", async () => {
    const provider = successProvider();
    setProperty({ createdBy: "someone-else", assignedTo: "another" });
    await expect(
      runLib({ session: { id: "user-1", role: "field_staff" }, provider }),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(provider.fetchRegistryPdf).not.toHaveBeenCalled();
    expect(pm.property.updateMany).not.toHaveBeenCalled();
    expect(pm.importJob.create).not.toHaveBeenCalled();
  });

  it("4. mock provider が非PIIの検索キー（realEstateNumber/ref）で呼ばれる", async () => {
    const provider = successProvider();
    setProperty({ realEstateNumber: "1234567890123" });
    await runLib({ provider });
    expect(provider.fetchRegistryPdf).toHaveBeenCalledTimes(1);
    expect(provider.fetchRegistryPdf).toHaveBeenCalledWith({
      realEstateNumber: "1234567890123",
      ref: PROP_ID,
    });
  });

  it("5. provider の pdfBuffer が extract → processRegistryPdf（upload/Attachment）へ接続される", async () => {
    const provider = successProvider({ pdfBuffer: PROVIDER_PDF });
    await runLib({ provider });
    // provider の pdfBuffer が extractTextFromPdf に渡る
    expect(extractTextFromPdf).toHaveBeenCalledWith(PROVIDER_PDF);
    // processRegistryPdf に接続され、同じ buffer が storage.upload に渡る
    expect(uploadMock()).toHaveBeenCalledTimes(1);
    expect(uploadMock().mock.calls[0][0]).toBe(PROVIDER_PDF);
    // 既存取込コアの証跡（ImportJob 作成 + Attachment(registry) 作成）
    expect(pm.importJob.create).toHaveBeenCalledTimes(1);
    expect(pm.attachment.create).toHaveBeenCalledTimes(1);
    expect(pm.attachment.create.mock.calls[0][0].data.type).toBe("registry");
  });

  it("6. 成功時に registryStatus が scheduled→obtained に更新される（version 楽観ロック）", async () => {
    const provider = successProvider();
    const body = await runLib({ provider });
    const lockCall = pm.property.updateMany.mock.calls.find(
      (c) => c[0]?.data?.registryStatus === "scheduled",
    );
    expect(lockCall).toBeTruthy();
    expect(lockCall![0].where.version).toBe(3);
    expect(lockCall![0].where.registryStatus).toEqual({ not: "scheduled" });
    expect(pm.property.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PROP_ID },
        data: expect.objectContaining({ registryStatus: "obtained" }),
      }),
    );
    expect(body.registryStatus).toBe("obtained");
    expect(body.source).toBe("mock");
    expect(body.providerRequestId).toBe("req-1");
  });

  it("6b. new MockRegistryFetchProvider() を明示注入した成功フロー（obtained・Attachment作成・PII非露出）", async () => {
    const provider = new MockRegistryFetchProvider({
      providerRequestId: "req-mock",
      now: new Date(0),
    });
    const body = await runLib({ provider });
    expect(body.registryStatus).toBe("obtained");
    expect(body.status).toBe("success");
    expect(body.source).toBe("mock");
    expect(body.providerRequestId).toBe("req-mock");
    expect(pm.importJob.create).toHaveBeenCalledTimes(1);
    expect(pm.attachment.create).toHaveBeenCalledTimes(1);
    // owner PII レスポンス除去は維持（parsed を返さない）
    expect(body.parsed).toBeUndefined();
  });

  it("7a. 進行中（scheduled）は早期 409・provider/ロック未到達", async () => {
    const provider = successProvider();
    setProperty({ registryStatus: "scheduled" });
    await expect(runLib({ provider })).rejects.toMatchObject({
      status: 409,
      code: "REGISTRY_AUTO_FETCH_ALREADY_RUNNING",
    });
    expect(provider.fetchRegistryPdf).not.toHaveBeenCalled();
    expect(pm.property.updateMany).not.toHaveBeenCalled();
    expect(pm.importJob.create).not.toHaveBeenCalled();
  });

  it("7b. 楽観ロック競合（updateMany count=0）でも 409・provider 未到達", async () => {
    const provider = successProvider();
    pm.property.updateMany.mockResolvedValue({ count: 0 });
    await expect(runLib({ provider })).rejects.toMatchObject({
      status: 409,
      code: "REGISTRY_AUTO_FETCH_ALREADY_RUNNING",
    });
    expect(provider.fetchRegistryPdf).not.toHaveBeenCalled();
    expect(pm.importJob.create).not.toHaveBeenCalled();
  });

  it("8. provider 失敗時に registryStatus がロック解除（previous へ）され process 未到達", async () => {
    const provider = new MockRegistryFetchProvider({ failWith: "rate_limited" });
    const spy = vi.spyOn(provider, "fetchRegistryPdf");
    await expect(runLib({ provider })).rejects.toMatchObject({
      status: 429,
      code: "REGISTRY_AUTO_FETCH_PROVIDER_ERROR",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const calls = pm.property.updateMany.mock.calls;
    const lock = calls.find((c) => c[0]?.data?.registryStatus === "scheduled");
    const release = calls.find(
      (c) => c[0]?.data?.registryStatus === "unconfirmed",
    );
    expect(lock).toBeTruthy();
    expect(release).toBeTruthy();
    expect(release![0].where.registryStatus).toBe("scheduled");
    // processRegistryPdf には進まない / obtained にもしない
    expect(pm.importJob.create).not.toHaveBeenCalled();
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("9. AuditLog に PII / rawText / fileUrl / owner / address / zip / token 等が入らない", async () => {
    const provider = successProvider();
    (parseRegistryText as Mock).mockReturnValue({
      ...EMPTY_PARSED(),
      address: "東京都港区2-3-4",
      owners: [{ name: "山田太郎", address: "東京都港区2-3-4", share: null }],
    });
    await runLib({ provider });
    const call = autoFetchAuditCall();
    expect(call).toBeTruthy();
    const detail = call![0].detail as Record<string, unknown>;
    // 非PIIフィールドは載る
    expect(detail.status).toBe("success");
    expect(detail.source).toBe("mock");
    expect(detail.providerRequestId).toBe("req-1");
    expect(detail.confirmed).toBe(true);
    expect(detail.propertyId).toBe(PROP_ID);
    // PII / 機微キーは載らない
    const keys = Object.keys(detail);
    for (const k of [
      "owners",
      "ownerNames",
      "ownerName",
      "address",
      "zip",
      "fileUrl",
      "rawText",
      "text",
      "parsed",
      "token",
      "apiKey",
      "credential",
    ]) {
      expect(keys).not.toContain(k);
    }
    const json = JSON.stringify(detail);
    expect(json).not.toContain("山田太郎");
    expect(json).not.toContain("東京都港区2-3-4");
    expect(json).not.toContain("/uploads/");
  });

  it("provider 失敗 AuditLog も非PII（分類コードのみ）", async () => {
    const provider = new MockRegistryFetchProvider({ failWith: "auth_failed" });
    await expect(runLib({ provider })).rejects.toMatchObject({
      code: "REGISTRY_AUTO_FETCH_PROVIDER_ERROR",
    });
    const call = autoFetchAuditCall();
    expect(call).toBeTruthy();
    const detail = call![0].detail as Record<string, unknown>;
    expect(detail.status).toBe("failed");
    expect(detail.providerErrorCode).toBe("auth_failed");
    const json = JSON.stringify(detail);
    expect(json).not.toMatch(/credential|token|apikey|api[_-]?key|secret|bearer/i);
  });
});

describe("PR4/CodexP1: live route は provider 未設定で安全停止（mock で本番DBを更新しない）", () => {
  it("2. registry:auto_fetch 権限が無ければ 403・取込未実行", async () => {
    (getUserPermissions as Mock).mockResolvedValue(PERMS_NO_REGISTRY);
    const res = await callRoute({ confirmed: true });
    expect(res.status).toBe(403);
    expect(pm.property.updateMany).not.toHaveBeenCalled();
    expect(pm.importJob.create).not.toHaveBeenCalled();
  });

  it("3+4+5. confirmed:true でも provider 未設定なら 501・registryStatus/ImportJob/Attachment/Audit 無し", async () => {
    const res = await callRoute({ confirmed: true });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error.code).toBe("REGISTRY_AUTO_FETCH_PROVIDER_NOT_CONFIGURED");
    // DB 副作用ゼロ（registryStatus 変更なし・ImportJob/Attachment/AuditLog 作成なし）
    expect(pm.property.updateMany).not.toHaveBeenCalled();
    expect(pm.property.update).not.toHaveBeenCalled();
    expect(pm.importJob.create).not.toHaveBeenCalled();
    expect(pm.attachment.create).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
    // エラーレスポンスに PII を含まない
    const json = JSON.stringify(body);
    expect(json).not.toMatch(/owner|所有者|住所|郵便/);
  });

  it("confirmed 無しは route で 400（入力検証スケルトン維持）・DB副作用なし", async () => {
    const res = await callRoute({});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("REGISTRY_AUTO_FETCH_CONFIRMATION_REQUIRED");
    expect(pm.importJob.create).not.toHaveBeenCalled();
    expect(pm.property.updateMany).not.toHaveBeenCalled();
  });

  it("owner:read なしでも provider 未設定で 501（route に owner PII 露出経路なし）", async () => {
    (getUserPermissions as Mock).mockResolvedValue([
      { resource: "registry", action: "auto_fetch", granted: true },
      { resource: "property", action: "read", granted: true },
    ]);
    const res = await callRoute({ confirmed: true });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error.code).toBe("REGISTRY_AUTO_FETCH_PROVIDER_NOT_CONFIGURED");
    expect(pm.importJob.create).not.toHaveBeenCalled();
  });
});

describe("PR4/CodexP2: env 設定済みでも browserFactory 未配線なら 501・scheduled にしない", () => {
  const ENV_KEYS = [
    "REGISTRY_FETCH_LOGIN_ID",
    "REGISTRY_FETCH_PASSWORD",
  ] as const;
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
    }
    // 資格情報 env を「設定済み」にする（= 旧実装ならここで provider 解決し POST が
    // 物件を scheduled にして provider_error で必ず失敗する経路に入ってしまう）。
    process.env.REGISTRY_FETCH_LOGIN_ID = "configured-id";
    process.env.REGISTRY_FETCH_PASSWORD = "configured-pw";
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("env 設定済み + browserFactory 未配線 → POST 501・registryStatus/ImportJob/Attachment/AuditLog 副作用ゼロ（scheduled にしない）", async () => {
    const res = await callRoute({ confirmed: true });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error.code).toBe("REGISTRY_AUTO_FETCH_PROVIDER_NOT_CONFIGURED");
    // 物件を一瞬たりとも scheduled にしない（楽観ロックの updateMany を呼ばない）
    expect(pm.property.updateMany).not.toHaveBeenCalled();
    expect(pm.property.update).not.toHaveBeenCalled();
    // ImportJob / Attachment / AuditLog いずれも作成されない
    expect(pm.importJob.create).not.toHaveBeenCalled();
    expect(pm.attachment.create).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("capability も false（isRegistryAutoFetchProviderConfigured() が env 設定済みでも false）", async () => {
    const { isRegistryAutoFetchProviderConfigured } = await import(
      "@/lib/registry-fetch/auto-fetch"
    );
    // env 設定済みでも browserFactory 未配線（PR-1）ゆえ capability=false。
    expect(isRegistryAutoFetchProviderConfigured()).toBe(false);
  });
});

describe("PR4/CodexP2: レスポンスから owner PII を除去", () => {
  const PARSED_WITH_PII = () => ({
    ...EMPTY_PARSED(),
    realEstateNumber: "9999999999999",
    address: "東京都港区PII住所1-2-3",
    owners: [
      { name: "謄本太郎", address: "東京都港区PII住所1-2-3", share: "1/2" },
    ],
  });

  it("1. processRegistryPdf が parsed.owners を返しても response に parsed/owners が含まれない", async () => {
    const provider = successProvider();
    (parseRegistryText as Mock).mockReturnValue(PARSED_WITH_PII());
    const body = await runLib({ provider });
    // parsed 自体を返さない（最優先）。owners も含まれない。
    expect(body.parsed).toBeUndefined();
    expect(Object.keys(body)).not.toContain("parsed");
    expect(Object.keys(body)).not.toContain("owners");
    // 非PII の allowlist は残る
    expect(body.jobId).toBe("job-1");
    expect(body.propertyId).toBe(PROP_ID);
    expect(body.registryStatus).toBe("obtained");
    expect(body.status).toBe("success");
    expect(body.source).toBe("mock");
    expect(body.providerRequestId).toBe("req-1");
    expect(typeof body.ownersCreated).toBe("number");
  });

  it("2. response に所有者名・所有者住所・郵便番号・realEstateNumber・fileUrl が含まれない", async () => {
    const provider = successProvider();
    (parseRegistryText as Mock).mockReturnValue(PARSED_WITH_PII());
    const body = await runLib({ provider });
    const json = JSON.stringify(body);
    expect(json).not.toContain("謄本太郎");
    expect(json).not.toContain("東京都港区PII住所1-2-3");
    expect(json).not.toContain("9999999999999");
    expect(json).not.toMatch(/zip|郵便番号/);
    expect(json).not.toContain("/uploads/");
  });

  it("3. lib は owner:read を見ずに owner PII を除去する（owner 閲覧権限に依存しない）", async () => {
    const provider = successProvider();
    (parseRegistryText as Mock).mockReturnValue({
      ...EMPTY_PARSED(),
      owners: [{ name: "漏洩花子", address: "大阪府PII市1-1", share: null }],
    });
    const body = await runLib({ provider });
    expect(body.parsed).toBeUndefined();
    const json = JSON.stringify(body);
    expect(json).not.toContain("漏洩花子");
    expect(json).not.toContain("大阪府PII市1-1");
  });
});

describe("PR4: source-assertion（スコープ固定）", () => {
  const read = (p: string) =>
    fs.readFileSync(path.resolve(process.cwd(), p), "utf8");
  const routeFile =
    "src/app/api/properties/[id]/registry/auto-fetch/route.ts";
  const libFile = "src/lib/registry-fetch/auto-fetch.ts";
  const routeSrc = read(routeFile);
  const libSrc = read(libFile);

  it("10. 外部 HTTP / Playwright / 旧ベンダAPIキー を使っていない（PR-1: env は REGISTRY_FETCH_* のみ許可）", () => {
    for (const src of [routeSrc, libSrc]) {
      expect(src).not.toMatch(
        /from\s+["'](node:)?(http|https|net|child_process|dns|tls|dgram)["']/,
      );
      expect(src).not.toMatch(
        /from\s+["'](axios|node-fetch|undici|got|playwright|puppeteer|@playwright\/test)["']/,
      );
      expect(src).not.toMatch(/\bfetch\s*\(/);
      // 旧ベンダAPIキー方式（路線変更前）の env 名は使わない。
      expect(src).not.toMatch(/REGISTRY_API_KEY|REGISTRY_API_URL/);
      // playwright/puppeteer は import 形（上の正規表現）で禁止。実コードでの使用には
      // import が必須のため、コメント言及の誤検知を避けつつ実害を防げる（PR3 と同方針）。
    }
    // route は env を一切読まない（provider 解決は lib に委譲）。
    expect(routeSrc).not.toMatch(/process\.env/);
    // PR-1: lib は getRegistryFetchProvider() 内で REGISTRY_FETCH_*（server-side 資格情報）
    // のみを読む。NEXT_PUBLIC_* は読まない（client 露出禁止）。
    const libEnvRefs = libSrc.match(/process\.env\.\w+/g) ?? [];
    for (const ref of libEnvRefs) {
      expect(ref).toMatch(/^process\.env\.REGISTRY_FETCH_/);
    }
    expect(libSrc).not.toMatch(/process\.env\.NEXT_PUBLIC_/);
  });

  it("11. schema/migration/package を変更しない（DDL/env なし・既存 enum 値のみ使用）", () => {
    for (const src of [routeSrc, libSrc]) {
      expect(src).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP TABLE/i);
      expect(src).not.toMatch(/package\.json|package-lock/);
    }
    // 既存 RegistryStatus enum 値のみを使う（新 enum 値を追加していない）
    expect(libSrc).toMatch(/registryStatus: "scheduled"/);
    expect(libSrc).toMatch(/registryStatus: "obtained"/);
  });

  it("12. route.ts は POST handler のみを export する", () => {
    expect(Object.keys(routeModule).sort()).toEqual(["POST"]);
    const exports =
      routeSrc.match(
        /^export (async function|function|const|class|type|interface) \w+/gm,
      ) || [];
    expect(exports.length).toBe(1);
    expect(exports[0]).toMatch(/export async function POST/);
  });

  it("実 provider / cron / queue / 一括取得 を含まない（lib も route も）", () => {
    for (const src of [routeSrc, libSrc]) {
      expect(src).not.toMatch(/cron|queue|bull|agenda/i);
      expect(src).not.toMatch(/bulk|batch/i);
    }
  });

  it("CodexP1-1. runRegistryAutoFetch は provider 必須・lib は mock を参照しない（暗黙利用なし）", () => {
    // 既定値 new MockRegistryFetchProvider() を削除し provider を必須引数にした
    expect(libSrc).toMatch(/provider: RegistryFetchProvider/);
    expect(libSrc).not.toMatch(/provider\s*=\s*new MockRegistryFetchProvider/);
    expect(libSrc).not.toMatch(/MockRegistryFetchProvider/);
    // 本番 provider 解決は資格情報 env（REGISTRY_FETCH_*）で行い、env フラグ切替はしない。
    expect(libSrc).toMatch(/getRegistryFetchProvider/);
    expect(libSrc).not.toMatch(/ENABLE_MOCK_REGISTRY_FETCH/);
    // mock を本番解決に使わない（official-provider のみ解決する）。
    expect(libSrc).not.toMatch(/MockRegistryFetchProvider/);
  });

  it("CodexP1-2. route は mock provider を直接 new せず provider 未設定で 501 を返す", () => {
    expect(routeSrc).not.toMatch(/MockRegistryFetchProvider/);
    expect(routeSrc).not.toMatch(/new\s+\w*Provider/);
    expect(routeSrc).toMatch(/REGISTRY_AUTO_FETCH_PROVIDER_NOT_CONFIGURED/);
    expect(routeSrc).toMatch(/501/);
  });
});
