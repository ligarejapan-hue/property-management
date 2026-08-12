/**
 * PR-2b-2: 謄本 所在検索 API（POST /api/properties/[id]/registry/search）。
 *
 * 検索ルート（add-only）。番号無し物件を所在/地番/家屋番号で謄本候補検索する。
 * テスト方式は registry-auto-fetch-api.test.ts に倣う:
 *   - lib コア runRegistrySearch は provider 注入で直接検証
 *   - 権限ゲートは route 実行で検証（hasPermission / canAccessPropertyRecord は実物・getUserPermissions のみ mock）
 *   - 秘匿情報（所在/地番/家屋番号/不動産番号）が error / AuditLog / 応答(realEstateNumber) に出ないことを固定
 *   - source-assertion でスコープ（外部接続なし / route は POST のみ）を固定
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
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

// hasPermission / canAccessPropertyRecord は実物。getUserPermissions のみ mock。
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  default: {
    property: {
      findUnique: vi.fn(),
    },
  },
}));

import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import {
  MockRegistryFetchProvider,
  type RegistryFetchProvider,
} from "@/lib/registry-fetch";
import { runRegistrySearch } from "@/lib/registry-fetch/search";
import { sanitizeAuditDetail } from "@/lib/audit-log-detail-safety";
import * as routeModule from "@/app/api/properties/[id]/registry/search/route";

const { POST } = routeModule;

const PROP_ID = "22222222-2222-4222-8222-222222222222";
const SESSION = { id: "user-1", role: "admin" };
const SECRET_ADDR = "東京都秘匿区テスト1-2-3";

const PERMS_FULL = [
  { resource: "registry", action: "auto_fetch", granted: true },
  { resource: "property", action: "read", granted: true },
];
const PERMS_NO_REGISTRY = [{ resource: "property", action: "read", granted: true }];
const PERMS_NO_PROPERTY = [
  { resource: "registry", action: "auto_fetch", granted: true },
];

const pm = prisma as unknown as {
  property: { findUnique: Mock };
};

function setProperty(over: Record<string, unknown> = {}) {
  pm.property.findUnique.mockResolvedValue({
    id: PROP_ID,
    createdBy: "user-1",
    assignedTo: null,
    address: SECRET_ADDR,
    lotNumber: "5番6",
    buildingNumber: "7",
    realEstateNumber: null,
    ...over,
  });
}

function runSearch(opts: {
  confirmed?: boolean;
  session?: { id: string; role: string };
  provider?: RegistryFetchProvider;
  extraArgs?: Record<string, unknown>;
} = {}) {
  const { confirmed = true, session = SESSION } = opts;
  const provider = opts.provider ?? new MockRegistryFetchProvider();
  return runRegistrySearch(
    { session, propertyId: PROP_ID, confirmed, ...(opts.extraArgs ?? {}) },
    provider,
  );
}

function callRoute(body: unknown) {
  const req = new Request(
    `http://test/api/properties/${PROP_ID}/registry/search`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    },
  ) as never;
  return POST(req, { params: Promise.resolve({ id: PROP_ID }) });
}

function searchAuditCall() {
  return (writeAuditLog as Mock).mock.calls.find(
    (c) => c[0]?.action === "registry_search",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setProperty();
  (getApiSession as Mock).mockResolvedValue({
    id: "user-1",
    role: "admin",
    email: "u@test",
    name: "U",
  });
  (getUserPermissions as Mock).mockResolvedValue(PERMS_FULL);
});

describe("PR-2b-2: runRegistrySearch（provider 注入）", () => {
  it("段階①: candidateRef を持つ候補は不動産番号が無くても表示する(実サイトの所在検索は地番候補=番号なし)", async () => {
    // 実サイトの所在検索は不動産番号を返さず候補は地番(candidateRef)。旧実装は番号無し候補を
    // 捨てていたが、それでは実候補が全て消える。candidateRef があれば表示用に通す。取得(段階②)は
    // 別経路で、地番候補は取得 API で 409(課金なし)になる=表示を広げても誤課金は起きない。
    const provider = new MockRegistryFetchProvider({
      candidates: [
        { candidateRef: "with-ren", address: "所在A", realEstateNumber: "REN-A" },
        { candidateRef: "chiban-only", address: "所在B", lotNumber: "１－２", realEstateNumber: null },
      ],
    });
    const body = await runSearch({ provider });
    expect(body.searchable).toBe(true);
    const candidates = body.candidates as Array<{ candidateRef: string }>;
    expect(candidates.map((c) => c.candidateRef)).toEqual(["with-ren", "chiban-only"]);
    // 不動産番号は応答に出さない（cond③）。
    expect(candidates[0]).not.toHaveProperty("realEstateNumber");
  });

  it("candidateRef 空の候補は表示しない(参照キーが無く扱えない)", async () => {
    const provider = new MockRegistryFetchProvider({
      candidates: [
        { candidateRef: "ok", address: "所在A", realEstateNumber: null },
        { candidateRef: "", address: "所在B", realEstateNumber: null },
      ],
    });
    const body = await runSearch({ provider });
    const candidates = body.candidates as Array<{ candidateRef: string }>;
    expect(candidates.map((c) => c.candidateRef)).toEqual(["ok"]);
  });

  it("正常系: searchable な物件で候補を返し、realEstateNumber は応答に含めない", async () => {
    const body = await runSearch();
    expect(body.searchable).toBe(true);
    const candidates = body.candidates as Array<Record<string, unknown>>;
    expect(candidates).toHaveLength(1);
    expect(candidates[0].candidateRef).toBe(`mock-candidate-${PROP_ID}`);
    // 表示用フィールド（認可ユーザー向け本文）は返す
    expect(candidates[0].address).toBe(SECRET_ADDR);
    // ⚠渡す番号は1つだけ（設計 §3.1.2）。この物件は家屋番号を持つので
    //   家屋番号だけを送り、地番は送らない（provider の土地/建物の判定と
    //   呼び出し側の意図を一致させる）。mock は送った値をそのまま返す。
    expect(candidates[0].lotNumber).toBeNull();
    expect(candidates[0].buildingNumber).toBe("7");
    // realEstateNumber は応答に出さない（cond③ 改ざん対策・取得時 server 再解決の前提）
    expect(candidates[0]).not.toHaveProperty("realEstateNumber");
  });

  it("不動産番号があれば検索しない（searchable:false / has_real_estate_number・provider 未到達）", async () => {
    setProperty({ realEstateNumber: "1234567890123" });
    const provider = new MockRegistryFetchProvider();
    const spy = vi.spyOn(provider, "searchCandidates");
    const body = await runSearch({ provider });
    expect(body.searchable).toBe(false);
    expect(body.reason).toBe("has_real_estate_number");
    expect(spy).not.toHaveBeenCalled();
  });

  it("所在が無ければ検索不能（searchable:false / insufficient_location・provider 未到達）", async () => {
    setProperty({ address: null });
    const provider = new MockRegistryFetchProvider();
    const spy = vi.spyOn(provider, "searchCandidates");
    const body = await runSearch({ provider });
    expect(body.searchable).toBe(false);
    expect(body.reason).toBe("insufficient_location");
    expect(spy).not.toHaveBeenCalled();
  });

  it("provider 失敗を安全な HTTP 分類へ写像（429/404/504/502）", async () => {
    const cases: Array<
      ["timeout" | "rate_limited" | "auth_failed" | "not_found" | "provider_error", number]
    > = [
      ["timeout", 504],
      ["rate_limited", 429],
      ["auth_failed", 502],
      ["not_found", 404],
      ["provider_error", 502],
    ];
    for (const [code, status] of cases) {
      vi.clearAllMocks();
      setProperty();
      const provider = new MockRegistryFetchProvider({ searchFailWith: code });
      await expect(runSearch({ provider })).rejects.toMatchObject({
        status,
        code: "REGISTRY_SEARCH_PROVIDER_ERROR",
      });
    }
  });

  it("field_staff 担当外は 403・provider 未到達", async () => {
    setProperty({ createdBy: "someone-else", assignedTo: "another" });
    const provider = new MockRegistryFetchProvider();
    const spy = vi.spyOn(provider, "searchCandidates");
    await expect(
      runSearch({ session: { id: "user-1", role: "field_staff" }, provider }),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("物件が無ければ 404", async () => {
    pm.property.findUnique.mockResolvedValue(null);
    await expect(runSearch()).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("confirmed:true でなければ 400・DB/provider 未到達", async () => {
    const provider = new MockRegistryFetchProvider();
    const spy = vi.spyOn(provider, "searchCandidates");
    await expect(runSearch({ confirmed: false, provider })).rejects.toMatchObject({
      status: 400,
      code: "REGISTRY_SEARCH_CONFIRMATION_REQUIRED",
    });
    expect(pm.property.findUnique).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  it("provider が searchCandidates 未実装なら 501（型安全ガード）", async () => {
    const provider = { name: "no-search" } as unknown as RegistryFetchProvider;
    await expect(runSearch({ provider })).rejects.toMatchObject({
      status: 501,
      code: "REGISTRY_SEARCH_PROVIDER_NOT_CONFIGURED",
    });
  });

  it("searchCandidates はあるが所在検索未対応(supportsLocationSearch!==true)なら 501・呼ばない", async () => {
    // official は searchCandidates を持つが searchByLocation 未実装 → supportsLocationSearch=false。
    // メソッド有無だけで通すと throttle/ブラウザを消費し provider_error(502) になるため、
    // 呼ぶ前に 501 で fail-closed する（cond⑦・@codex P2）。
    const sc = vi.fn(async () => []);
    const provider = {
      name: "official-like",
      supportsLocationSearch: false,
      searchCandidates: sc,
    } as unknown as RegistryFetchProvider;
    await expect(runSearch({ provider })).rejects.toMatchObject({
      status: 501,
      code: "REGISTRY_SEARCH_PROVIDER_NOT_CONFIGURED",
    });
    expect(sc).not.toHaveBeenCalled();
  });

  it("成功 AuditLog は非PII（status/candidateCount のみ・所在/不動産番号を含まない）", async () => {
    await runSearch();
    const call = searchAuditCall();
    expect(call).toBeTruthy();
    const detail = call![0].detail as Record<string, unknown>;
    expect(detail.status).toBe("success");
    expect(detail.candidateCount).toBe(1);
    expect(detail.propertyId).toBe(PROP_ID);
    const json = JSON.stringify(detail);
    expect(json).not.toContain(SECRET_ADDR);
    expect(json).not.toContain("5番6");
    expect(json).not.toContain("MOCK-"); // realEstateNumber 由来
  });

  it("失敗 AuditLog も非PII（分類コードのみ）", async () => {
    const provider = new MockRegistryFetchProvider({ searchFailWith: "auth_failed" });
    await expect(runSearch({ provider })).rejects.toMatchObject({
      code: "REGISTRY_SEARCH_PROVIDER_ERROR",
    });
    const call = searchAuditCall();
    expect(call).toBeTruthy();
    const detail = call![0].detail as Record<string, unknown>;
    expect(detail.status).toBe("failed");
    expect(detail.providerErrorCode).toBe("auth_failed");
    const json = JSON.stringify(detail);
    expect(json).not.toContain(SECRET_ADDR);
    expect(json).not.toMatch(/credential|token|password|secret/i);
  });

  it("error / 応答に秘匿情報（所在/地番）が混入しない", async () => {
    const provider = new MockRegistryFetchProvider({ searchFailWith: "provider_error" });
    let thrown: unknown;
    try {
      await runSearch({ provider });
    } catch (e) {
      thrown = e;
    }
    const msg = (thrown as { message?: string })?.message ?? "";
    expect(msg).not.toContain(SECRET_ADDR);
    expect(msg).not.toContain("5番6");
  });
});

describe("PR-2b-2: route POST（権限ゲート / provider 未設定で 501）", () => {
  it("registry:auto_fetch が無ければ 403", async () => {
    (getUserPermissions as Mock).mockResolvedValue(PERMS_NO_REGISTRY);
    const res = await callRoute({ confirmed: true });
    expect(res.status).toBe(403);
  });

  it("property:read が無ければ 403", async () => {
    (getUserPermissions as Mock).mockResolvedValue(PERMS_NO_PROPERTY);
    const res = await callRoute({ confirmed: true });
    expect(res.status).toBe(403);
  });

  it("confirmed が無ければ 400", async () => {
    const res = await callRoute({});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("REGISTRY_SEARCH_CONFIRMATION_REQUIRED");
  });

  it("confirmed:true + full perms でも provider 未設定なら 501（本番 fail-closed）", async () => {
    const res = await callRoute({ confirmed: true });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error.code).toBe("REGISTRY_SEARCH_PROVIDER_NOT_CONFIGURED");
    // エラー応答に PII を含まない
    const json = JSON.stringify(body);
    expect(json).not.toMatch(/owner|所有者|住所|郵便/);
  });

  it("body が JSON null でも 500 でなく 400（confirmed 必須）", async () => {
    // parseJsonBody は body 'null' で null を返す。null.confirmed は TypeError→500 になるため、
    // 非null object ガードで 400 REGISTRY_SEARCH_CONFIRMATION_REQUIRED を返す（@codex P3）。
    const req = new Request(
      `http://test/api/properties/${PROP_ID}/registry/search`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
      },
    ) as never;
    const res = await POST(req, { params: Promise.resolve({ id: PROP_ID }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("REGISTRY_SEARCH_CONFIRMATION_REQUIRED");
  });
});

describe("PR-2b-2: source-assertion（スコープ固定）", () => {
  const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), "utf8");
  const routeFile = "src/app/api/properties/[id]/registry/search/route.ts";
  const libFile = "src/lib/registry-fetch/search.ts";
  const routeSrc = read(routeFile);
  const libSrc = read(libFile);

  it("route は POST handler のみを export する", () => {
    expect(Object.keys(routeModule).sort()).toEqual(["POST"]);
  });

  it("外部 HTTP / Playwright / fetch を使わない", () => {
    for (const src of [routeSrc, libSrc]) {
      expect(src).not.toMatch(
        /from\s+["'](node:)?(http|https|net|child_process|dns|tls)["']/,
      );
      expect(src).not.toMatch(
        /from\s+["'](axios|node-fetch|undici|got|playwright|puppeteer|@playwright\/test)["']/,
      );
      expect(src).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it("schema / migration / package を変更しない", () => {
    for (const src of [routeSrc, libSrc]) {
      expect(src).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP TABLE/i);
      expect(src).not.toMatch(/package\.json|package-lock/);
    }
  });
});

describe("PR-2b-2: audit allowlist（registry_search）", () => {
  it("status/candidateCount/reason/providerErrorCode は残り、address/owner は REDACTED", () => {
    const out = sanitizeAuditDetail("registry_search", {
      propertyId: PROP_ID,
      status: "success",
      candidateCount: 2,
      reason: "insufficient_location",
      providerErrorCode: "rate_limited",
      confirmed: true,
      address: SECRET_ADDR,
      ownerName: "山田太郎",
    }) as Record<string, unknown>;
    expect(out.status).toBe("success");
    expect(out.candidateCount).toBe(2);
    expect(out.reason).toBe("insufficient_location");
    expect(out.providerErrorCode).toBe("rate_limited");
    expect(out.propertyId).toBe(PROP_ID);
    expect(out.address).toBe("[REDACTED]");
    expect(out.ownerName).toBe("[REDACTED]");
  });
});

describe("⚠申し込んだときの内容から変わっていたら検索しない（@codex #372 Blocker）", () => {
  it("指紋が違えば provider に触れず identifier_changed を返す", async () => {
    // 一括は「照合 → provider の準備 → DB更新 → 検索」と進むので、呼び出し側の
    // 照合だけでは隙が残る。検索が読む物件と同じ読み取りで照合する。
    const provider = new MockRegistryFetchProvider({});
    const spy = vi.spyOn(provider, "searchCandidates");
    const body = await runSearch({
      provider,
      extraArgs: { expectedFingerprintHash: "hash-at-creation" },
    });
    expect(body).toEqual({ searchable: false, reason: "identifier_changed" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("指紋が同じなら今までどおり検索する", async () => {
    const { hashPropertyFingerprint } = await import(
      "@/lib/registry-fetch/candidate-cache"
    );
    const body = await runSearch({
      extraArgs: {
        expectedFingerprintHash: hashPropertyFingerprint({
          address: SECRET_ADDR,
          lotNumber: "5番6",
          buildingNumber: "7",
          realEstateNumber: null,
        }),
      },
    });
    expect(body.searchable).toBe(true);
  });

  it("指紋を渡さなければ今までどおり（単発の検索は無関係）", async () => {
    const body = await runSearch();
    expect(body.searchable).toBe(true);
  });
});
