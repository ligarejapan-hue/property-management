/**
 * E-T3(17-C): GET /api/me/permissions の route handler 単体テスト（test-only）。
 *
 * 背景: client 側 5 箇所（screen-protection-provider / properties 一覧・詳細 /
 * admin owner 詳細 / field-survey-map）がこの route のレスポンス契約
 * `{ permissions, capabilities: { corporateLookup, registryAutoFetch } }` に
 * 暗黙依存しているが、handler 自体の単体テストが存在しなかった。
 * F12（provider への permissions 配布）に進む前の安全網として、現仕様を
 * そのままロックする。route 実装は一切変更しない。
 *
 * 検証方針（owners-search-route.test.ts / registry-auto-fetch-api.test.ts に倣う）:
 *  - api-helpers（getApiSession / getUserPermissions / apiResponse / handleApiError）を
 *    忠実な replica で mock し、route の orchestration とレスポンス契約を検証する。
 *  - capabilities ヘルパー（isCorporateLookupConfigured /
 *    isRegistryAutoFetchProviderConfigured）は boolean を返す mock とし、
 *    値が素通しで capabilities に載ることを検証する。
 *  - mock モード（NEXT_PUBLIC_USE_MOCK）の分岐は getApiSession /
 *    getUserPermissions の内部にあり route には存在しない（source assertion で固定）。
 *
 * 既存テストとの分担:
 *  - registry-auto-fetch-ui.test.ts は route ソースの
 *    `registryAutoFetch: isRegistryAutoFetchProviderConfigured()` 形のみを assert
 *    （本テストは runtime 挙動を担当・重複なし）。
 *  - UI 側の fetch("/api/me/permissions") literal は各 UI テストがロック済み。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import fs from "fs";
import path from "path";

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

vi.mock("@/lib/corporate-lookup", () => ({
  isCorporateLookupConfigured: vi.fn(),
}));

vi.mock("@/lib/registry-fetch/auto-fetch", () => ({
  isRegistryAutoFetchProviderConfigured: vi.fn(),
  isRegistryLocationSearchConfigured: vi.fn(),
}));

vi.mock("@/lib/registry-ocr/client", () => ({
  isRegistryOcrConfigured: vi.fn(),
}));

vi.mock("@/lib/sale-dm-letter", () => ({
  isSaleDmConfigured: vi.fn(),
}));
vi.mock("@/lib/sale-dm-letter/tracking", () => ({
  resolveTrackingBaseUrl: vi.fn(() => "https://app.example.com"),
  resolveLpUrl: vi.fn(() => "https://lp.example.com"),
}));
vi.mock("@/lib/sale-dm-letter/sender", () => ({
  isSenderConfigured: vi.fn(() => true),
}));

import {
  ApiError,
  getApiSession,
  getUserPermissions,
  handleApiError,
} from "@/lib/api-helpers";
import { isCorporateLookupConfigured } from "@/lib/corporate-lookup";
import {
  isRegistryAutoFetchProviderConfigured,
  isRegistryLocationSearchConfigured,
} from "@/lib/registry-fetch/auto-fetch";
import { isRegistryOcrConfigured } from "@/lib/registry-ocr/client";
import { isSaleDmConfigured } from "@/lib/sale-dm-letter";
import { resolveTrackingBaseUrl, resolveLpUrl } from "@/lib/sale-dm-letter/tracking";
import { isSenderConfigured } from "@/lib/sale-dm-letter/sender";
import { GET } from "@/app/api/me/permissions/route";

const SESSION = {
  id: "user-1",
  email: "staff@example.com",
  name: "テスト担当者",
  role: "office_staff",
};

const PERMS = [
  { resource: "property", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "csv_export", action: "read", granted: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue(SESSION);
  (getUserPermissions as Mock).mockResolvedValue(PERMS);
  (isCorporateLookupConfigured as Mock).mockReturnValue(true);
  (isRegistryAutoFetchProviderConfigured as Mock).mockReturnValue(false);
  (isRegistryLocationSearchConfigured as Mock).mockReturnValue(false);
  (isRegistryOcrConfigured as Mock).mockReturnValue(false);
  (isSaleDmConfigured as Mock).mockReturnValue(false);
});

describe("GET /api/me/permissions — レスポンス契約（E-T3）", () => {
  it("認証済みなら 200 で permissions 配列をそのまま返す（無加工・無フィルタ）", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.permissions).toEqual(PERMS);
  });

  it("saleDmLetter は AI provider + 印刷必須URL(tracking/LP) + 差出人(sender) が揃って初めて true", async () => {
    (isSaleDmConfigured as Mock).mockReturnValue(true);
    // provider + 両URL + 差出人 → true
    let body = await (await GET()).json();
    expect(body.capabilities.saleDmLetter).toBe(true);
    // tracking URL 欠落 → false(campaign 作成が 503 になるため一覧の作成導線を出さない)
    (resolveTrackingBaseUrl as Mock).mockReturnValueOnce(undefined);
    body = await (await GET()).json();
    expect(body.capabilities.saleDmLetter).toBe(false);
    // LP URL 欠落でも false
    (resolveLpUrl as Mock).mockReturnValueOnce(undefined);
    body = await (await GET()).json();
    expect(body.capabilities.saleDmLetter).toBe(false);
    // 差出人 env 欠落でも false(生成/印刷の fail-closed と UI を揃える・Codex)
    (isSenderConfigured as Mock).mockReturnValueOnce(false);
    body = await (await GET()).json();
    expect(body.capabilities.saleDmLetter).toBe(false);
  });

  it("capabilities は { corporateLookup, registryAutoFetch } の boolean を素通しで返す", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.capabilities).toEqual({
      corporateLookup: true,
      registryAutoFetch: false,
      registryLocationSearch: false,
      // office_staff（非 admin）かつ OCR 未設定 → false
      registryOcrDraft: false,
      saleDmLetter: false,
    });
    expect(isCorporateLookupConfigured).toHaveBeenCalledTimes(1);
    expect(isRegistryAutoFetchProviderConfigured).toHaveBeenCalledTimes(1);
  });

  it("capabilities ヘルパーの戻り値が変われば応答も追従する（true/true）", async () => {
    (isRegistryAutoFetchProviderConfigured as Mock).mockReturnValue(true);
    const res = await GET();
    const body = await res.json();
    expect(body.capabilities).toEqual({
      corporateLookup: true,
      registryAutoFetch: true,
      registryLocationSearch: false,
      registryOcrDraft: false,
      saleDmLetter: false,
    });
  });

  it("registryLocationSearch は所在検索対応 provider のときだけ true（自動取得より厳しい）", async () => {
    (isRegistryLocationSearchConfigured as Mock).mockReturnValue(true);
    const body = await (await GET()).json();
    expect(body.capabilities.registryLocationSearch).toBe(true);
    expect(isRegistryLocationSearchConfigured).toHaveBeenCalledTimes(1);
  });

  it("registryOcrDraft は OCR 設定済み かつ admin のときだけ true", async () => {
    (isRegistryOcrConfigured as Mock).mockReturnValue(true);
    // 設定済みでも office_staff なら false
    let body = await (await GET()).json();
    expect(body.capabilities.registryOcrDraft).toBe(false);

    // admin かつ設定済みで true
    (getApiSession as Mock).mockResolvedValue({ ...SESSION, role: "admin" });
    body = await (await GET()).json();
    expect(body.capabilities.registryOcrDraft).toBe(true);

    // admin でも未設定なら false
    (isRegistryOcrConfigured as Mock).mockReturnValue(false);
    body = await (await GET()).json();
    expect(body.capabilities.registryOcrDraft).toBe(false);
  });

  it("レスポンス body のトップレベルは permissions / capabilities の 2 キーのみ（client/provider が依存するキー名の固定）", async () => {
    const res = await GET();
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["capabilities", "permissions"]);
    expect(Object.keys(body.capabilities).sort()).toEqual([
      "corporateLookup",
      "registryAutoFetch",
      "registryLocationSearch",
      "registryOcrDraft",
      "saleDmLetter",
    ]);
  });

  it("session 由来の PII（email / name / id / role）をレスポンスに含めない", async () => {
    const res = await GET();
    const text = await res.text();
    expect(text).not.toContain(SESSION.email);
    expect(text).not.toContain(SESSION.name);
    expect(text).not.toContain(SESSION.id);
    const body = JSON.parse(text);
    expect(body).not.toHaveProperty("session");
    expect(body).not.toHaveProperty("user");
    expect(body).not.toHaveProperty("role");
  });

  it("getUserPermissions は session.id で 1 回だけ呼ばれる", async () => {
    await GET();
    expect(getApiSession).toHaveBeenCalledTimes(1);
    expect(getUserPermissions).toHaveBeenCalledTimes(1);
    expect(getUserPermissions).toHaveBeenCalledWith(SESSION.id);
  });
});

describe("GET /api/me/permissions — エラー経路（現仕様の保存）", () => {
  it("未認証（getApiSession が 401 ApiError）なら 401 を返し、getUserPermissions を呼ばない", async () => {
    (getApiSession as Mock).mockRejectedValue(
      new ApiError(401, "認証が必要です", "UNAUTHORIZED"),
    );
    const res = await GET();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(getUserPermissions).not.toHaveBeenCalled();
  });

  it("getUserPermissions の 401 ApiError（user 不在）は 401 として返す", async () => {
    (getUserPermissions as Mock).mockRejectedValue(
      new ApiError(401, "ユーザーが見つかりません", "UNAUTHORIZED"),
    );
    const res = await GET();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("DB エラー等の非 ApiError は handleApiError 経由で 500（現仕様）", async () => {
    const dbError = new Error("connection refused");
    (getUserPermissions as Mock).mockRejectedValue(dbError);
    const res = await GET();
    expect(res.status).toBe(500);
    expect(handleApiError).toHaveBeenCalledWith(dbError);
    const text = await res.text();
    // エラー詳細（接続情報等）を漏らさない
    expect(text).not.toContain("connection refused");
  });
});

// ---------- source assertion（route 実装形状の固定）----------

const routeSrc = fs.readFileSync(
  path.join(process.cwd(), "src/app/api/me/permissions/route.ts"),
  "utf8",
);

describe("GET /api/me/permissions — 実装形状（source assertion）", () => {
  it("getApiSession → getUserPermissions(session.id) の orchestration を維持する", () => {
    expect(routeSrc).toMatch(/const session = await getApiSession\(\)/);
    expect(routeSrc).toMatch(
      /const permissions = await getUserPermissions\(session\.id\)/,
    );
  });

  it("mock モード分岐を route 内に持たない（mock 処理は api-helpers 内部に集約）", () => {
    expect(routeSrc).not.toMatch(/NEXT_PUBLIC_USE_MOCK/);
  });

  it("capabilities は boolean helper のみで構成し、env 値・secret を直接返さない", () => {
    expect(routeSrc).toMatch(
      /corporateLookup:\s*isCorporateLookupConfigured\(\)/,
    );
    expect(routeSrc).toMatch(
      /registryAutoFetch:\s*isRegistryAutoFetchProviderConfigured\(\)/,
    );
    expect(routeSrc).toMatch(
      /registryLocationSearch:\s*isRegistryLocationSearchConfigured\(\)/,
    );
    expect(routeSrc).not.toMatch(/process\.env\./);
  });

  it("prisma / audit を route から直接触らない（DB アクセスは helpers 経由のみ）", () => {
    expect(routeSrc).not.toMatch(/from "@\/lib\/prisma"/);
    expect(routeSrc).not.toMatch(/writeAuditLog/);
  });
});
