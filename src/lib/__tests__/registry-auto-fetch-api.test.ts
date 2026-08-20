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
    providerCode?: string;
    constructor(status: number, message: string, code = "ERROR", providerCode?: string) {
      super(message);
      this.status = status;
      this.code = code;
      this.providerCode = providerCode;
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

vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
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
    attachment: { create: vi.fn(), findFirst: vi.fn() },
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
  };
  // link の親行ロック(#364 R10)で $transaction/$queryRaw を実行するため、
  // callback に同じ db を渡す(tx.* === pm.* で既存アサーションが効く)。
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw = vi.fn(async () => [{ id: "p1" }]);
  return { default: db };
});

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
import { RegistryFetchError } from "@/lib/registry-fetch/errors";
import { fingerprintProperty } from "@/lib/registry-fetch/candidate-cache";
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
  auditLog: { findFirst: Mock; create: Mock };
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
  // 段階②の台帳(二重課金ガード)は既定「記録なし」= 通る。
  pm.auditLog.findFirst.mockResolvedValue(null);
  pm.auditLog.create.mockResolvedValue({ id: "ledger-1" });
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

  it("realEstateNumber override（所在検索の候補取得）を fetchRegistryPdf に使う（物件は番号未保持）", async () => {
    const provider = successProvider();
    setProperty({ realEstateNumber: null });
    await runRegistryAutoFetch(
      { session: SESSION, propertyId: PROP_ID, confirmed: true, realEstateNumber: "CAND-REN-123" },
      provider,
    );
    expect(provider.fetchRegistryPdf).toHaveBeenCalledWith(
      expect.objectContaining({ realEstateNumber: "CAND-REN-123" }),
    );
  });

  it("expectedFingerprint が現在の物件指紋と一致すれば override 取得（@codex P2 TOCTOU）", async () => {
    const provider = successProvider();
    setProperty({ realEstateNumber: null, address: "所在X", lotNumber: "1", buildingNumber: "2" });
    const fp = fingerprintProperty({ address: "所在X", lotNumber: "1", buildingNumber: "2", realEstateNumber: null });
    await runRegistryAutoFetch(
      { session: SESSION, propertyId: PROP_ID, confirmed: true, realEstateNumber: "CAND-REN", expectedFingerprint: fp },
      provider,
    );
    expect(provider.fetchRegistryPdf).toHaveBeenCalledWith(expect.objectContaining({ realEstateNumber: "CAND-REN" }));
  });

  it("expectedFingerprint 不一致（resolve 後に物件編集）は 409・取得しない（@codex P2 TOCTOU）", async () => {
    const provider = successProvider();
    setProperty({ realEstateNumber: null, address: "編集後の所在", lotNumber: null, buildingNumber: null });
    await expect(
      runRegistryAutoFetch(
        { session: SESSION, propertyId: PROP_ID, confirmed: true, realEstateNumber: "CAND-REN", expectedFingerprint: "stale-fingerprint" },
        provider,
      ),
    ).rejects.toMatchObject({ status: 409, code: "REGISTRY_OBTAIN_CANDIDATE_NOT_FOUND" });
    expect(provider.fetchRegistryPdf).not.toHaveBeenCalled();
  });

  it("expectedFingerprint 指定時は lock の where に指紋フィールドを含める（@codex P2 atomic）", async () => {
    const provider = successProvider();
    setProperty({ realEstateNumber: null, address: "所在X", lotNumber: "1", buildingNumber: "2" });
    const fp = fingerprintProperty({ address: "所在X", lotNumber: "1", buildingNumber: "2", realEstateNumber: null });
    await runRegistryAutoFetch(
      { session: SESSION, propertyId: PROP_ID, confirmed: true, realEstateNumber: "CAND-REN", expectedFingerprint: fp },
      provider,
    );
    const lockWhere = (pm.property.updateMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(lockWhere).toMatchObject({ address: "所在X", lotNumber: "1", buildingNumber: "2", realEstateNumber: null });
  });

  it("lock 失敗(count=0)で再読込の指紋が不一致なら 409 CANDIDATE_NOT_FOUND（@codex P2）", async () => {
    const provider = successProvider();
    pm.property.findUnique
      .mockResolvedValueOnce({ id: PROP_ID, createdBy: "user-1", assignedTo: null, registryStatus: "unconfirmed", version: 3, realEstateNumber: null, address: "所在X", lotNumber: "1", buildingNumber: "2" })
      .mockResolvedValueOnce({ address: "編集後", lotNumber: null, buildingNumber: null, realEstateNumber: null });
    pm.property.updateMany.mockResolvedValue({ count: 0 });
    const fp = fingerprintProperty({ address: "所在X", lotNumber: "1", buildingNumber: "2", realEstateNumber: null });
    await expect(
      runRegistryAutoFetch(
        { session: SESSION, propertyId: PROP_ID, confirmed: true, realEstateNumber: "CAND-REN", expectedFingerprint: fp },
        provider,
      ),
    ).rejects.toMatchObject({ status: 409, code: "REGISTRY_OBTAIN_CANDIDATE_NOT_FOUND" });
    expect(provider.fetchRegistryPdf).not.toHaveBeenCalled();
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
      // 段階②(2026-07-31): location フィールドが増えた(番号取得では null=有料の地番フローに入らない)。
      location: null,
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

  it("I-1. not_found は業務的 not found ゆえ 404（upstream 障害扱いの 502 にしない・リトライ誤認回避）", async () => {
    const provider = new MockRegistryFetchProvider({ failWith: "not_found" });
    await expect(runLib({ provider })).rejects.toMatchObject({
      status: 404,
      code: "REGISTRY_AUTO_FETCH_PROVIDER_ERROR",
    });
    // 失敗時はロック解除され process へ進まない（既存挙動不変）。
    const release = pm.property.updateMany.mock.calls.find(
      (c) => c[0]?.data?.registryStatus === "unconfirmed",
    );
    expect(release).toBeTruthy();
    expect(pm.importJob.create).not.toHaveBeenCalled();
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("I-1. 他の provider 失敗コードの HTTP ステータスは不変（timeout=504/rate_limited=429/auth_failed=502/provider_error=502）", async () => {
    const cases: Array<
      ["timeout" | "rate_limited" | "auth_failed" | "provider_error", number]
    > = [
      ["timeout", 504],
      ["rate_limited", 429],
      ["auth_failed", 502],
      ["provider_error", 502],
    ];
    for (const [code, status] of cases) {
      vi.clearAllMocks();
      setProperty();
      pm.property.updateMany.mockResolvedValue({ count: 1 });
      const provider = new MockRegistryFetchProvider({ failWith: code });
      await expect(runLib({ provider })).rejects.toMatchObject({
        status,
        code: "REGISTRY_AUTO_FETCH_PROVIDER_ERROR",
      });
    }
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
  const officialProviderFile = "src/lib/registry-fetch/official-provider.ts";
  const routeSrc = read(routeFile);
  const libSrc = read(libFile);
  const officialProviderSrc = read(officialProviderFile);

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

  it("C-1. official-provider.ts / auto-fetch.ts は Playwright を静的 import しない（PR-2 で混入する芽を断つ）", () => {
    // 契約: Playwright は将来 resolveDefaultRegistryBrowserFactory() 内の動的 import
    // （await import("playwright") 等）でのみ読む。official-provider.ts と auto-fetch.ts は
    // static import / require の形で playwright を読み込まない。これにより
    // auto-fetch.ts → me/permissions route の import 連鎖で Playwright が
    // サーバーバンドルへ混入する芽を断つ。
    for (const src of [officialProviderSrc, libSrc]) {
      // ES static import: `import ... from "playwright"` / `import "playwright"`。
      expect(src).not.toMatch(
        /from\s+["'](playwright|playwright-core|@playwright\/test|puppeteer|puppeteer-core)["']/,
      );
      expect(src).not.toMatch(
        /import\s+["'](playwright|playwright-core|@playwright\/test|puppeteer|puppeteer-core)["']/,
      );
      // CommonJS require: `require("playwright")`。
      expect(src).not.toMatch(
        /require\s*\(\s*["'](playwright|playwright-core|@playwright\/test|puppeteer|puppeteer-core)["']\s*\)/,
      );
    }
  });

  it("C-1. 動的 import 契約: 将来 Playwright を読むのは resolveDefaultRegistryBrowserFactory（または注入境界）のみ", () => {
    // PR-1 では playwright 依存を一切追加しないため動的 import も存在しないが、
    // 契約として「読むなら動的 import 境界でのみ」をコメントで明示していることを固定する。
    expect(libSrc).toMatch(/resolveDefaultRegistryBrowserFactory/);
    // OfficialRegistryProvider は value import 可（クラス自体が playwright を静的 import
    // しない構造を上のアサートで保証済み）。
    expect(libSrc).toMatch(/OfficialRegistryProvider/);
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

describe("段階②: 地番候補の有料取得（台帳=二重課金ガード）", () => {
  const LC = { lotNumber: "1-1", buildingNumber: null };

  function runLocation(
    over: {
      locationCandidate?: typeof LC | null;
      certificateType?: "owner" | "all";
    } = {},
  ) {
    const provider = successProvider();
    const promise = runRegistryAutoFetch(
      {
        session: SESSION,
        propertyId: PROP_ID,
        confirmed: true,
        locationCandidate: over.locationCandidate ?? LC,
        ...(over.certificateType
          ? { certificateType: over.certificateType }
          : {}),
        expectedFingerprint: fingerprintProperty({
          address: "テスト市テスト町一丁目",
          lotNumber: null,
          buildingNumber: null,
          realEstateNumber: null,
        }),
      },
      provider,
    );
    return { provider, promise };
  }

  // ⚠有料取得の専用オプトイン(@codex #345 P1)。テストでは明示的に有効化し、必ず戻す。
  const PURCHASE_ENV = "REGISTRY_FETCH_PURCHASE_ENABLED";
  let savedPurchaseEnv: string | undefined;
  beforeEach(() => {
    savedPurchaseEnv = process.env[PURCHASE_ENV];
    process.env[PURCHASE_ENV] = "true";
    setProperty({ address: "テスト市テスト町一丁目" });
  });
  afterEach(() => {
    if (savedPurchaseEnv === undefined) delete process.env[PURCHASE_ENV];
    else process.env[PURCHASE_ENV] = savedPurchaseEnv;
  });

  it("⚠読めない形の地番では課金前に 422 で止まる（実サイトに触れない）", async () => {
    // 編集画面・PATCH API・CSV取込から入った値は検索の検査を通っていない。
    // ここを塞がないと normalizeChibanForDialog で潰れた**別の筆**を買う。
    const { provider, promise } = runLocation({
      locationCandidate: { lotNumber: "abc1x2", buildingNumber: null },
    });
    await expect(promise).rejects.toMatchObject({
      status: 422,
      code: "REGISTRY_OBTAIN_IDENTIFIER_INVALID",
    });
    expect(provider.fetchRegistryPdf).not.toHaveBeenCalled();
  });

  it("既存の表記（1番地2）は今までどおり取得できる", async () => {
    // 受理する範囲を狭めると、既に保存されている物件が取れなくなる。
    const { provider, promise } = runLocation({
      locationCandidate: { lotNumber: "1番地2", buildingNumber: null },
    });
    await promise;
    expect(provider.fetchRegistryPdf).toHaveBeenCalled();
  });

  it("⚠専用オプトインが無ければ 501 で止まる（provider もロックも呼ばない）", async () => {
    delete process.env[PURCHASE_ENV];
    const { provider, promise } = runLocation();
    await expect(promise).rejects.toMatchObject({
      status: 501,
      code: "REGISTRY_PURCHASE_NOT_ENABLED",
    });
    expect(provider.fetchRegistryPdf).not.toHaveBeenCalled();
    expect(pm.property.updateMany).not.toHaveBeenCalled();
  });

  it("台帳に無ければ provider へ location を渡して実行し、成功を台帳に記録する", async () => {
    const { provider, promise } = runLocation();
    await promise;
    expect(provider.fetchRegistryPdf).toHaveBeenCalledTimes(1);
    const req = provider.fetchRegistryPdf.mock.calls[0][0];
    expect(req.location).toEqual({
      address: "テスト市テスト町一丁目",
      lotNumber: "1-1",
      buildingNumber: null,
      certificateType: "owner",
    });
    // 台帳(成功)が書かれる。detail はハッシュと outcome のみ(地番そのものは載せない)。
    const ledger = pm.auditLog.create.mock.calls
      .map((c) => (c[0] as { data: { action: string; detail: { outcome: string; purchaseKeyHash: string } } }).data)
      .filter((a) => a.action === "registry_location_purchase");
    expect(ledger).toHaveLength(1);
    expect(ledger[0].detail.outcome).toBe("charged");
    expect(typeof ledger[0].detail.purchaseKeyHash).toBe("string");
    expect(JSON.stringify(ledger[0].detail)).not.toContain("1-1");
  });

  it("⚠台帳に既にあれば 409 で止まり、provider もロックも呼ばない（二重課金しない）", async () => {
    pm.auditLog.findFirst.mockResolvedValue({ id: "prior" });
    const { provider, promise } = runLocation();
    await expect(promise).rejects.toMatchObject({
      status: 409,
      code: "REGISTRY_PURCHASE_ALREADY_DONE",
    });
    expect(provider.fetchRegistryPdf).not.toHaveBeenCalled();
    expect(pm.property.updateMany).not.toHaveBeenCalled();
  });

  it("⚠課金後の失敗(charged_but_failed)も台帳に記録する（再実行=二重課金を台帳で止める）", async () => {
    const provider = successProvider();
    provider.fetchRegistryPdf.mockRejectedValue(
      new RegistryFetchError("charged_but_failed"),
    );
    await expect(
      runRegistryAutoFetch(
        {
          session: SESSION,
          propertyId: PROP_ID,
          confirmed: true,
          locationCandidate: LC,
        },
        provider,
      ),
    ).rejects.toMatchObject({ status: 502 });
    const ledger = pm.auditLog.create.mock.calls
      .map((c) => (c[0] as { data: { action: string; detail: { outcome: string; purchaseKeyHash: string } } }).data)
      .filter((a) => a.action === "registry_location_purchase");
    expect(ledger).toHaveLength(1);
    expect(ledger[0].detail.outcome).toBe("charged_but_failed");

    // ⚠台帳はロック解除より**先**(@codex #345 R2 P1)。解除が先だと
    // 「ロック無し×台帳無し」の隙間で同じ候補に再課金できる。
    const ledgerCallOrder = pm.auditLog.create.mock.invocationCallOrder[
      pm.auditLog.create.mock.calls.findIndex(
        (c) =>
          (c[0] as { data: { action: string } }).data.action ===
          "registry_location_purchase",
      )
    ];
    const releaseCall = pm.property.updateMany.mock.calls.findIndex(
      (c) =>
        (c[0] as { data?: { registryStatus?: unknown } })?.data
          ?.registryStatus === "unconfirmed",
    );
    expect(releaseCall).toBeGreaterThanOrEqual(0);
    const releaseCallOrder =
      pm.property.updateMany.mock.invocationCallOrder[releaseCall];
    expect(ledgerCallOrder).toBeLessThan(releaseCallOrder);
  });

  it("⚠provider 成功後に PDF 処理が失敗しても台帳は残る（@codex #345 P1: 台帳は provider 返却直後）", async () => {
    // 課金は provider が返った時点で済んでいる。後段（PDF検証）で失敗しても台帳が
    // 無いと再実行で同じ謄本にもう一度課金できてしまう。
    // ⚠課金境界(provider 返却)を越えた後の失敗は charged_but_failed に統一される
    // (@codex #361 P1)。生の 422 ではなく 502(charged_but_failed)を返し、台帳には
    // charged と charged_but_failed の両方が残る(再課金は charged マーカーで防がれる)。
    (isPdfBuffer as Mock).mockReturnValue(false); // PDF検証で post-charge 失敗
    const { promise } = runLocation();
    await expect(promise).rejects.toMatchObject({
      status: 502,
      providerCode: "charged_but_failed",
    });
    const ledger = pm.auditLog.create.mock.calls
      .map((c) => (c[0] as { data: { action: string; detail: { outcome: string; purchaseKeyHash: string } } }).data)
      .filter((a) => a.action === "registry_location_purchase");
    // 再課金ガードの charged マーカーが残っている。
    expect(ledger.some((l) => l.detail.outcome === "charged")).toBe(true);
    // 課金後失敗も記録される(生の 422 で握りつぶさない)。
    expect(ledger.some((l) => l.detail.outcome === "charged_but_failed")).toBe(true);
  });

  it("⚠課金後失敗の台帳が書けなければロックを解除しない（@codex #345 R3 P1: fail-closed）", async () => {
    // 「台帳無し×ロック無し」は再課金可能な状態そのもの。台帳が永続できないなら
    // scheduled のまま残し、取得APIを 409 で止め続ける(解消は運用)。
    pm.auditLog.create.mockRejectedValue(new Error("db down"));
    const provider = successProvider();
    provider.fetchRegistryPdf.mockRejectedValue(
      new RegistryFetchError("charged_but_failed"),
    );
    await expect(
      runRegistryAutoFetch(
        {
          session: SESSION,
          propertyId: PROP_ID,
          confirmed: true,
          locationCandidate: LC,
        },
        provider,
      ),
    ).rejects.toMatchObject({ status: 502 });
    // ロック解除(registryStatus を元に戻す updateMany)が**呼ばれない**。
    const releaseCalls = pm.property.updateMany.mock.calls.filter(
      (c) =>
        (c[0] as { data?: { registryStatus?: unknown } })?.data
          ?.registryStatus === "unconfirmed",
    );
    expect(releaseCalls).toHaveLength(0);
  });

  it("⚠provider成功後、台帳(charged)が書けなければ添付に進まず charged_but_failed（fail-closed）", async () => {
    // writeAuditLog(失敗を握りつぶす)ではなく throw する直書きであることの検証。
    // 台帳が無いまま添付まで成功すると、30日マーカー無しで再実行=再課金できてしまう。
    pm.auditLog.create.mockRejectedValue(new Error("db down"));
    const { promise } = runLocation();
    await expect(promise).rejects.toMatchObject({ status: 502 });
    // 添付処理(ImportJob作成)へ進んでいない。
    expect(pm.importJob.create).not.toHaveBeenCalled();
    // catch 側でも台帳を再試行している(計2回)。両方失敗したのでロックは保持。
    expect(pm.auditLog.create).toHaveBeenCalledTimes(2);
    const releaseCalls = pm.property.updateMany.mock.calls.filter(
      (c) =>
        (c[0] as { data?: { registryStatus?: unknown } })?.data
          ?.registryStatus === "unconfirmed",
    );
    expect(releaseCalls).toHaveLength(0);
  });

  it("⚠有料取得でPDFを添付できなければ成功にせず charged_but_failed（@codex #360 P1）", async () => {
    // 有料取得はPDFの添付が成果物。保存に失敗(warning握りつぶし=attachmentId無し)なら、
    // obtained にして成功表示せず、課金後失敗として台帳に残す(再取得は運用者確認)。
    pm.attachment.create.mockRejectedValue(new Error("storage down"));
    const { promise } = runLocation();
    await expect(promise).rejects.toMatchObject({ status: 502 });
    // 課金後失敗として台帳に残る（charged→charged_but_failed の2件）。
    const ledger = pm.auditLog.create.mock.calls
      .map(
        (c) =>
          (c[0] as { data: { action: string; detail: { outcome: string } } })
            .data,
      )
      .filter((a) => a.action === "registry_location_purchase");
    expect(ledger.map((l) => l.detail.outcome)).toContain("charged_but_failed");
    // obtained に確定させない（PDFが無いのに取得済みにしない）。
    const obtained = pm.property.update.mock.calls.filter(
      (c) =>
        (c[0] as { data?: { registryStatus?: unknown } })?.data
          ?.registryStatus === "obtained",
    );
    expect(obtained).toHaveLength(0);
  });

  it("⚠全部事項(all)も添付できなければ charged_but_failed（所有者反映が無いので特に重要）", async () => {
    pm.attachment.create.mockRejectedValue(new Error("storage down"));
    const { promise } = runLocation({ certificateType: "all" });
    await expect(promise).rejects.toMatchObject({ status: 502 });
    const ledger = pm.auditLog.create.mock.calls
      .map(
        (c) =>
          (c[0] as {
            data: {
              action: string;
              detail: { outcome: string; certificateType?: string };
            };
          }).data,
      )
      .filter((a) => a.action === "registry_location_purchase");
    expect(ledger.map((l) => l.detail.outcome)).toContain("charged_but_failed");
    // 台帳の種別も all で残る。
    expect(
      ledger.find((l) => l.detail.outcome === "charged_but_failed")?.detail
        .certificateType,
    ).toBe("all");
  });

  it("課金前の失敗(provider_error等)は台帳に書かない（まだ買っていない=再実行してよい）", async () => {
    const provider = successProvider();
    provider.fetchRegistryPdf.mockRejectedValue(
      new RegistryFetchError("provider_error"),
    );
    await expect(
      runRegistryAutoFetch(
        {
          session: SESSION,
          propertyId: PROP_ID,
          confirmed: true,
          locationCandidate: LC,
        },
        provider,
      ),
    ).rejects.toMatchObject({ status: 502 });
    const ledger = pm.auditLog.create.mock.calls
      .map((c) => (c[0] as { data: { action: string; detail: { outcome: string; purchaseKeyHash: string } } }).data)
      .filter((a) => a.action === "registry_location_purchase");
    expect(ledger).toHaveLength(0);
  });

  it("不動産番号を持つ物件では番号を優先し location を渡さない", async () => {
    setProperty({
      address: "テスト市テスト町一丁目",
      realEstateNumber: "0123456789012",
    });
    const provider = successProvider();
    await runRegistryAutoFetch(
      {
        session: SESSION,
        propertyId: PROP_ID,
        confirmed: true,
        locationCandidate: LC,
      },
      provider,
    );
    const req = provider.fetchRegistryPdf.mock.calls[0][0];
    expect(req.realEstateNumber).toBe("0123456789012");
    expect(req.location).toBeNull();
  });

  it("地番も家屋番号も無い候補は 409（買う対象が無い・provider を呼ばない）", async () => {
    const provider = successProvider();
    await expect(
      runRegistryAutoFetch(
        {
          session: SESSION,
          propertyId: PROP_ID,
          confirmed: true,
          locationCandidate: { lotNumber: null, buildingNumber: null },
        },
        provider,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(provider.fetchRegistryPdf).not.toHaveBeenCalled();
  });
});

describe("【回収】購入済みの謄本を再課金なしで取り込む(mode:recover)", () => {
  // 2026-08-19: 実課金テスト第8回で請求は成立(課金済み)したのに、行の同定に失敗して
  // PDFを取り逃した。二重課金ガードが効いて取り直せない=**払ったのに手元に残らない**。
  // 期限内なら課金せず回収できるので、その経路をここで固定する。
  const LC = { lotNumber: "1-1", buildingNumber: null };
  const RECOVERED_PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 9, 9, 9, 9, 9, 9]);

  type RecoverProvider = RegistryFetchProvider & {
    fetchRegistryPdf: Mock;
    recoverRegistryPdf: Mock;
  };

  function recoverProvider(): RecoverProvider {
    return {
      name: "mock",
      fetchRegistryPdf: vi.fn(),
      recoverRegistryPdf: vi.fn().mockResolvedValue({
        pdfBuffer: RECOVERED_PDF,
        fileName: "registry-recovered-req-1.pdf",
        source: "mock",
        fetchedAt: new Date(0),
        providerRequestId: "req-1",
      }),
    } as unknown as RecoverProvider;
  }

  function runRecover(
    over: {
      locationCandidate?: {
        lotNumber: string | null;
        buildingNumber: string | null;
      } | null;
      provider?: RegistryFetchProvider;
      recoverKind?: "land" | "building";
      recoverExpectedVersion?: number;
      recoverExpectedIdentifier?: string | null;
      recoverExpectedAddress?: string | null;
    } = {},
  ) {
    const provider = (over.provider ?? recoverProvider()) as RecoverProvider;
    const promise = runRegistryAutoFetch(
      {
        session: SESSION,
        propertyId: PROP_ID,
        confirmed: true,
        mode: "recover",
        ...(over.recoverKind ? { recoverKind: over.recoverKind } : {}),
        ...(over.recoverExpectedVersion !== undefined
          ? { recoverExpectedVersion: over.recoverExpectedVersion }
          : {}),
        ...(over.recoverExpectedIdentifier !== undefined
          ? { recoverExpectedIdentifier: over.recoverExpectedIdentifier }
          : {}),
        ...(over.recoverExpectedAddress !== undefined
          ? { recoverExpectedAddress: over.recoverExpectedAddress }
          : {}),
        locationCandidate:
          over.locationCandidate === undefined ? LC : over.locationCandidate,
      },
      provider,
    );
    return { provider, promise };
  }

  const PURCHASE_ENV = "REGISTRY_FETCH_PURCHASE_ENABLED";
  let savedPurchaseEnv: string | undefined;
  beforeEach(() => {
    savedPurchaseEnv = process.env[PURCHASE_ENV];
    // ⚠回収は**有料取得のスイッチが切れている本番でも使える**ことが要件。
    delete process.env[PURCHASE_ENV];
    setProperty({ address: "テスト市テスト町一丁目" });
  });
  afterEach(() => {
    if (savedPurchaseEnv === undefined) delete process.env[PURCHASE_ENV];
    else process.env[PURCHASE_ENV] = savedPurchaseEnv;
  });

  it("⚠有料取得のスイッチが切れていても実行できる(課金操作をしないため)", async () => {
    const { provider, promise } = runRecover();
    await promise;
    expect(provider.recoverRegistryPdf).toHaveBeenCalledTimes(1);
  });

  it("⚠課金の入口(fetchRegistryPdf)は呼ばない", async () => {
    const { provider, promise } = runRecover();
    await promise;
    expect(provider.fetchRegistryPdf).not.toHaveBeenCalled();
  });

  it("⚠課金台帳を書かない(お金は動いていない)", async () => {
    const { promise } = runRecover();
    await promise;
    const ledger = pm.auditLog.create.mock.calls
      .map((c) => (c[0] as { data: { action: string } }).data)
      .filter((a) => a.action === "registry_location_purchase");
    expect(ledger).toHaveLength(0);
  });

  it("⚠二重課金ガード(過去の課金記録)があっても止めない=これが回収の目的", async () => {
    // 有料取得なら 409 で止まる状況。回収は「その課金済みの書類を取りに行く」ので通す。
    pm.auditLog.findFirst.mockResolvedValue({
      id: "ledger-old",
      createdAt: new Date(),
    });
    const { provider, promise } = runRecover();
    await promise;
    expect(provider.recoverRegistryPdf).toHaveBeenCalledTimes(1);
  });

  it("回収したPDFは物件に添付され、取得済み(obtained)になる", async () => {
    const { promise } = runRecover();
    await promise;
    expect(uploadMock()).toHaveBeenCalled();
    expect(pm.attachment.create).toHaveBeenCalled();
    const obtained = pm.property.update.mock.calls.filter(
      (c) =>
        (c[0] as { data?: { registryStatus?: unknown } })?.data
          ?.registryStatus === "obtained",
    );
    expect(obtained.length).toBeGreaterThan(0);
  });

  it("⚠取り込みに失敗しても「課金の可能性」にはしない(502/charged_but_failed にしない)", async () => {
    // 第7回テストの反省: 課金していないのに「お金が動いたかも」と出すと、
    // 利用者は取り直しを恐れて動けなくなる。回収は課金境界を持たない。
    (isPdfBuffer as Mock).mockReturnValue(false);
    const { promise } = runRecover();
    await expect(promise).rejects.toMatchObject({ status: 422 });
    await promise.catch((e: unknown) => {
      expect((e as { providerCode?: string }).providerCode).not.toBe(
        "charged_but_failed",
      );
    });
    const ledger = pm.auditLog.create.mock.calls
      .map((c) => (c[0] as { data: { action: string } }).data)
      .filter((a) => a.action === "registry_location_purchase");
    expect(ledger).toHaveLength(0);
  });

  it("⚠保存できなければ成功にしない(422・課金扱いにはしない)", async () => {
    pm.attachment.create.mockRejectedValue(new Error("storage down"));
    const { promise } = runRecover();
    await expect(promise).rejects.toMatchObject({
      status: 422,
      code: "REGISTRY_RECOVER_ATTACH_FAILED",
    });
  });

  it("⚠地番も家屋番号も無ければ取り込まない(別の筆を掴まない)", async () => {
    const { provider, promise } = runRecover({
      locationCandidate: { lotNumber: null, buildingNumber: null },
    });
    await expect(promise).rejects.toMatchObject({ status: 409 });
    expect(provider.recoverRegistryPdf).not.toHaveBeenCalled();
  });

  it("⚠地番の書き方が読めなければ取り込まない(取得と同じ規則)", async () => {
    const { provider, promise } = runRecover({
      locationCandidate: { lotNumber: "abc1x2", buildingNumber: null },
    });
    await expect(promise).rejects.toMatchObject({
      status: 422,
      code: "REGISTRY_OBTAIN_IDENTIFIER_INVALID",
    });
    expect(provider.recoverRegistryPdf).not.toHaveBeenCalled();
  });

  it("⚠地番が正しくても家屋番号が壊れていれば止める(探す値と検査値をそろえる)", async () => {
    // provider は家屋番号が入っていれば建物として探す。地番だけ検査して通すと、
    // 壊れた家屋番号を正規化した別の値で探し別の登記を掴む(@codex #394 R8 P2)。
    const { provider, promise } = runRecover({
      locationCandidate: { lotNumber: "1-1", buildingNumber: "abc1x2" },
    });
    await expect(promise).rejects.toMatchObject({
      status: 422,
      code: "REGISTRY_OBTAIN_IDENTIFIER_INVALID",
    });
    expect(provider.recoverRegistryPdf).not.toHaveBeenCalled();
  });

  it("回収では**物件行の識別子**も一緒に渡す(建物候補で区域が合わなくならない)", async () => {
    // 所在検索の建物候補は地番を持たないため、所在末尾の地番を外せずに
    // 『見つかりません』になっていた(@codex #394 R12 P2)。
    setProperty({
      address: "テスト市テスト町一丁目69-2",
      lotNumber: "69-2",
      buildingNumber: "5-2",
    });
    const { provider, promise } = runRecover({
      locationCandidate: { lotNumber: null, buildingNumber: "5-2" },
    });
    await promise;
    const req = provider.recoverRegistryPdf.mock.calls[0][0];
    expect(req.location.addressIdentifiers).toEqual(["69-2", "5-2"]);
  });

  it("回収に未対応の provider では 501(黙って課金経路へ落ちない)", async () => {
    const provider = successProvider() as unknown as RegistryFetchProvider;
    const { promise } = runRecover({ provider });
    await expect(promise).rejects.toMatchObject({
      status: 501,
      code: "REGISTRY_RECOVER_NOT_SUPPORTED",
    });
    expect(
      (provider as unknown as { fetchRegistryPdf: Mock }).fetchRegistryPdf,
    ).not.toHaveBeenCalled();
  });

  it("候補が無ければ**物件自身の地番**で探す(検索できない物件でも救える)", async () => {
    // 取込が途中まで進むと物件に不動産番号が入り、所在検索が対象外になる。
    // 候補が取れなくなっても、買った書類に手が届くようにする(@codex #394 R6 P1)。
    setProperty({
      address: "テスト市テスト町一丁目",
      lotNumber: "5-6",
      realEstateNumber: "0123456789012",
    });
    const { provider, promise } = runRecover({ locationCandidate: null });
    await promise;
    const req = provider.recoverRegistryPdf.mock.calls[0][0];
    expect(req.location).toMatchObject({ lotNumber: "5-6" });
    expect(req.realEstateNumber).toBeFalsy();
  });

  it("⚠確認の後に物件が編集されていたら取り込まない(版番号が違う)", async () => {
    // 画面が見せていた地番と、いまDBにある地番が違う=利用者が見たものと別の筆。
    // 所有者事項なら所有者の紐付けまで書き換わる(@codex #394 R20 P1)。
    setProperty({
      address: "テスト市テスト町一丁目",
      lotNumber: "69-2",
      version: 5,
    });
    const { provider, promise } = runRecover({
      locationCandidate: null,
      recoverExpectedVersion: 4, // 画面は古い版を見ていた
    });
    await expect(promise).rejects.toMatchObject({
      status: 409,
      code: "REGISTRY_RECOVER_PROPERTY_CHANGED",
    });
    expect(provider.recoverRegistryPdf).not.toHaveBeenCalled();
  });

  it("⚠回収のロックは取得キー項目も条件に含める(検査の後に変わっても掴まない)", async () => {
    // 確認時点の検査を通っても、その後に version を上げない経路で所在や地番が
    // 変わると、別の対象になった物件にPDFを貼ってしまう(@codex #394 R24 P1)。
    setProperty({
      address: "テスト市テスト町一丁目",
      lotNumber: "69-2",
      version: 5,
    });
    const { promise } = runRecover({
      locationCandidate: null,
      recoverExpectedVersion: 5,
      recoverExpectedIdentifier: "69-2",
      recoverExpectedAddress: "テスト市テスト町一丁目",
    });
    await promise;
    const lockCall = pm.property.updateMany.mock.calls.find(
      (c) =>
        (c[0] as { data?: { registryStatus?: unknown } })?.data
          ?.registryStatus === "scheduled",
    );
    expect(lockCall).toBeDefined();
    expect((lockCall![0] as { where: Record<string, unknown> }).where).
      toMatchObject({
        address: "テスト市テスト町一丁目",
        lotNumber: "69-2",
      });
  });

  it("⚠所在だけが書き換わっていても取り込まない(版番号が上がらない経路がある)", async () => {
    // CSV取込の重複更新は version を上げずに所在を書き換える。所在が変わると
    // 探す区域が変わり、**別の物件の書類**を取り込みかねない(@codex #394 R23 P1)。
    setProperty({
      address: "テスト市テスト町二丁目", // 取込で書き換わった後
      lotNumber: "69-2",
      version: 5,
    });
    const { provider, promise } = runRecover({
      locationCandidate: null,
      recoverExpectedVersion: 5, // 版番号は同じ
      recoverExpectedIdentifier: "69-2", // 地番も同じ
      recoverExpectedAddress: "テスト市テスト町一丁目", // 画面が見せていた所在
    });
    await expect(promise).rejects.toMatchObject({
      status: 409,
      code: "REGISTRY_RECOVER_PROPERTY_CHANGED",
    });
    expect(provider.recoverRegistryPdf).not.toHaveBeenCalled();
  });

  it("所在の表記ゆれ(空白・全角)は同じものとして通す", async () => {
    setProperty({
      address: "テスト市テスト町一丁目",
      lotNumber: "69-2",
      version: 5,
    });
    const { provider, promise } = runRecover({
      locationCandidate: null,
      recoverExpectedVersion: 5,
      recoverExpectedIdentifier: "69-2",
      recoverExpectedAddress: " テスト市 テスト町一丁目 ",
    });
    await promise;
    expect(provider.recoverRegistryPdf).toHaveBeenCalledTimes(1);
  });

  it("⚠画面が見せていた地番と現在値が違えば取り込まない", async () => {
    setProperty({
      address: "テスト市テスト町一丁目",
      lotNumber: "70-1", // 誰かが直した後
      version: 5,
    });
    const { provider, promise } = runRecover({
      locationCandidate: null,
      recoverExpectedVersion: 5,
      recoverExpectedIdentifier: "69-2", // 画面はこれを見せていた
    });
    await expect(promise).rejects.toMatchObject({
      status: 409,
      code: "REGISTRY_RECOVER_PROPERTY_CHANGED",
    });
    expect(provider.recoverRegistryPdf).not.toHaveBeenCalled();
  });

  it("表記ゆれ(全角・番)は同じものとして通す", async () => {
    setProperty({
      address: "テスト市テスト町一丁目",
      lotNumber: "69-2",
      version: 5,
    });
    const { provider, promise } = runRecover({
      locationCandidate: null,
      recoverExpectedVersion: 5,
      recoverExpectedIdentifier: "６９番２",
    });
    await promise;
    expect(provider.recoverRegistryPdf).toHaveBeenCalledTimes(1);
  });

  it("⚠候補経由の回収は従来どおり指紋で守る(この検査は掛けない)", async () => {
    setProperty({ address: "テスト市テスト町一丁目", version: 5 });
    const { provider, promise } = runRecover({
      recoverExpectedVersion: 4, // 候補ありなら無視される
    });
    await promise;
    expect(provider.recoverRegistryPdf).toHaveBeenCalledTimes(1);
  });

  it("⚠両方登録された物件で種別の指定が無ければ実行しない(黙って建物にしない)", async () => {
    // 既定の選び方(家屋番号優先)に倒すと、土地のつもりで建物のPDFと所有者情報を
    // 取り込みかねない(@codex #394 R21 P1)。
    setProperty({
      address: "テスト市テスト町一丁目",
      lotNumber: "69-2",
      buildingNumber: "5-2",
    });
    const { provider, promise } = runRecover({ locationCandidate: null });
    await expect(promise).rejects.toMatchObject({
      status: 409,
      code: "REGISTRY_RECOVER_KIND_REQUIRED",
    });
    expect(provider.recoverRegistryPdf).not.toHaveBeenCalled();
  });

  it("片方しか無い物件は種別の指定が無くても実行できる", async () => {
    setProperty({ address: "テスト市テスト町一丁目", lotNumber: "69-2" });
    const { provider, promise } = runRecover({ locationCandidate: null });
    await promise;
    expect(provider.recoverRegistryPdf).toHaveBeenCalledTimes(1);
  });

  it("⚠両方登録された物件で『土地』を選べば地番で探す(建物に化けない)", async () => {
    // 既定の選び方は家屋番号優先。土地の購入を取り込めない/建物のPDFを
    // 土地の物件へ入れてしまう、を防ぐ(@codex #394 R13 P1)。
    setProperty({
      address: "テスト市テスト町一丁目",
      lotNumber: "69-2",
      buildingNumber: "5-2",
    });
    const { provider, promise } = runRecover({
      locationCandidate: null,
      recoverKind: "land",
    });
    await promise;
    const req = provider.recoverRegistryPdf.mock.calls[0][0];
    expect(req.location).toMatchObject({
      lotNumber: "69-2",
      buildingNumber: null,
    });
  });

  it("『建物』を選べば家屋番号で探す", async () => {
    setProperty({
      address: "テスト市テスト町一丁目",
      lotNumber: "69-2",
      buildingNumber: "5-2",
    });
    const { provider, promise } = runRecover({
      locationCandidate: null,
      recoverKind: "building",
    });
    await promise;
    const req = provider.recoverRegistryPdf.mock.calls[0][0];
    expect(req.location).toMatchObject({
      lotNumber: null,
      buildingNumber: "5-2",
    });
  });

  it("⚠物件にも地番が無ければ取り込まない(別の筆を掴まない)", async () => {
    setProperty({ address: "テスト市テスト町一丁目", lotNumber: null });
    const { provider, promise } = runRecover({ locationCandidate: null });
    await expect(promise).rejects.toMatchObject({ status: 409 });
    expect(provider.recoverRegistryPdf).not.toHaveBeenCalled();
  });

  it("⚠物件に不動産番号があっても所在(地番)で探す=番号経路に落ちない", async () => {
    setProperty({
      address: "テスト市テスト町一丁目",
      realEstateNumber: "0123456789012",
    });
    const { provider, promise } = runRecover();
    await promise;
    const req = provider.recoverRegistryPdf.mock.calls[0][0];
    expect(req.location).toMatchObject({ lotNumber: "1-1" });
    // ⚠番号は**渡さない**。渡すと provider 側の「番号があれば番号を優先」に
    //   乗って課金フロー(確定→請求)へ落ちる余地が残る。
    expect(req.realEstateNumber).toBeFalsy();
  });
});
