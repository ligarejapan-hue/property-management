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

// token-bucket: createTokenBucketLimiter を spy して「モジュール共有（リクエスト間で
// 1 インスタンス）」であることを検証する。実装（tryConsume）はそのまま使う。
// route がモジュール読込時に limiter を生成する（= 共有）ため、spy は vi.hoisted で
// mock factory より前に初期化しておく（TDZ 回避）。
// tryConsumeImpl で limiter の挙動を差し替えられるようにしておき、
// 「バケット枯渇（常に false）」下で上流 lookup を叩かないことを検証する（P2-②）。
const { createLimiterSpy, tryConsumeSpy, tryConsumeImpl } = vi.hoisted(() => {
  const impl: { fn: ((key: string, nowMs: number) => boolean) | null } = { fn: null };
  return {
    createLimiterSpy: vi.fn(),
    tryConsumeSpy: vi.fn(),
    tryConsumeImpl: impl,
  };
});
vi.mock("@/lib/token-bucket", async () => {
  const actual = await vi.importActual<typeof import("../token-bucket")>(
    "../token-bucket",
  );
  return {
    ...actual,
    createTokenBucketLimiter: (opts: Parameters<typeof actual.createTokenBucketLimiter>[0]) => {
      createLimiterSpy(opts);
      const real = actual.createTokenBucketLimiter(opts);
      return {
        tryConsume(key: string, nowMs: number): boolean {
          tryConsumeSpy(key, nowMs);
          if (tryConsumeImpl.fn) return tryConsumeImpl.fn(key, nowMs);
          return real.tryConsume(key, nowMs);
        },
      };
    },
  };
});

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
  tryConsumeImpl.fn = null;
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

describe("空住所スキップ（Codex P2-①）", () => {
  it("妥当ZIP + 空文字 address なら lookup(API) を叩かず address_empty", async () => {
    pm.owner.findMany.mockResolvedValue([
      { id: "o-empty", name: "空住所", zip: "1000005", address: "" },
    ]);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(lookupMock).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.rows[0].verdict).toBe("indeterminate");
    expect(body.rows[0].reason).toBe("address_empty");
  });

  it("妥当ZIP + 空白のみ address なら lookup(API) を叩かず address_empty", async () => {
    pm.owner.findMany.mockResolvedValue([
      { id: "o-ws", name: "空白住所", zip: "1000005", address: "  　\t " },
    ]);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(lookupMock).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.rows[0].verdict).toBe("indeterminate");
    expect(body.rows[0].reason).toBe("address_empty");
  });

  it("住所ありは従来どおり lookup する", async () => {
    pm.owner.findMany.mockResolvedValue([
      { id: "o1", name: "n", zip: "1000005", address: "東京都千代田区丸の内1-1" },
    ]);
    lookupMock.mockResolvedValue([{ addressLine: "東京都千代田区丸の内", source: "mock" }]);
    await GET(req());
    expect(lookupMock).toHaveBeenCalledTimes(1);
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

describe("空文字 zip/address の DB 除外（指摘1）", () => {
  it("findMany の where で zip/address の空文字を除外する（not:null だけに頼らない）", async () => {
    await GET(req());
    expect(pm.owner.findMany).toHaveBeenCalledTimes(1);
    const where = pm.owner.findMany.mock.calls[0][0].where as Record<string, unknown>;
    // Prisma では空文字 "" は not:null を通過するため、空文字も明示的に除外する。
    // 実装は zip/address それぞれに { not: null } と { not: "" } を AND で併記する。
    const serialized = JSON.stringify(where);
    // null 除外（既存挙動の維持）。
    expect(serialized).toContain("\"not\":null");
    // 空文字除外（指摘1の本修正）。zip・address とも { not: "" } を含むこと。
    expect(where).toMatchObject({
      AND: expect.arrayContaining([
        { zip: { not: "" } },
        { address: { not: "" } },
        { zip: { not: null } },
        { address: { not: null } },
      ]),
    });
  });

  it("空文字 zip の行がキャッシュを汚染せず、正常な同一正規化キーの行を no_candidate にしない", async () => {
    // DB が（仮に）空文字 zip を返しても、空文字 zip の lookup は [] を返すだけで
    // キャッシュに書かれてはならない。書かれると後続の正常レコード（normalizePostalCode が
    // 同じ "" を生む値）まで候補なし扱い（no_candidate）に誤判定される。
    // ここでは「空文字 zip → 続いて妥当 zip」で、妥当 zip の lookup が確実に呼ばれ
    // match できることを確認する（キャッシュ汚染が無いことの固定）。
    pm.owner.findMany.mockResolvedValue([
      { id: "o-empty-zip", name: "空zip", zip: "", address: "東京都千代田区丸の内1-1" },
      { id: "o-valid", name: "正常", zip: "1000005", address: "東京都千代田区丸の内1-1" },
    ]);
    lookupMock.mockResolvedValue([{ addressLine: "東京都千代田区丸の内", source: "mock" }]);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    const byId = Object.fromEntries(
      body.rows.map((r: { ownerId: string }) => [r.ownerId, r]),
    );
    // 空文字 zip は invalid_postal_code（API 非呼出）。
    expect(byId["o-empty-zip"].verdict).toBe("indeterminate");
    expect(byId["o-empty-zip"].reason).toBe("invalid_postal_code");
    // 正常レコードは lookup が呼ばれ match する（空 zip の [] にキャッシュ汚染されない）。
    expect(byId["o-valid"].verdict).toBe("match");
    expect(lookupMock).toHaveBeenCalledWith("1000005");
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

  // Codex P1: API住所(matchedAddressLine)は保存ZIPから API で導出した値であり、
  // ZIP の地域情報を含む。住所が生値レベルでも ZIP がマスク/非表示なら、
  // 見えてはいけない ZIP 由来の地域情報を露出させてしまうため API住所も伏せる。
  it("住所は生値だが ZIP がマスクなら API住所は出さない（ZIP 地域情報の露出防止）", async () => {
    displayMock.mockResolvedValue({ ...FULL_DISPLAY, address: "full", zip: "masked" });
    pm.owner.findMany.mockResolvedValue([
      { id: "o1", name: "山田", zip: "1000005", address: "大阪府大阪市北区梅田" },
    ]);
    lookupMock.mockResolvedValue([{ addressLine: "東京都千代田区丸の内", source: "mock" }]);
    const res = await GET(req());
    const body = await res.json();
    expect(body.rows[0].apiAddressLine).toBeNull();
    // 判定（不一致フラグ）自体は内部の生値で行われ、出してよい。
    expect(body.rows[0].verdict).toBe("mismatch");
  });

  it("住所は生値だが ZIP が非表示(hidden)なら API住所は出さない", async () => {
    displayMock.mockResolvedValue({ ...FULL_DISPLAY, address: "full", zip: "hidden" });
    pm.owner.findMany.mockResolvedValue([
      { id: "o1", name: "山田", zip: "1000005", address: "東京都千代田区丸の内1-1" },
    ]);
    lookupMock.mockResolvedValue([{ addressLine: "東京都千代田区丸の内", source: "mock" }]);
    const res = await GET(req());
    const body = await res.json();
    expect(body.rows[0].apiAddressLine).toBeNull();
    expect(body.rows[0].verdict).toBe("match");
  });

  it("住所・ZIP ともに生値なら従来どおり API住所を返す", async () => {
    displayMock.mockResolvedValue({ ...FULL_DISPLAY, address: "full", zip: "full" });
    pm.owner.findMany.mockResolvedValue([
      { id: "o1", name: "山田", zip: "1000005", address: "東京都千代田区丸の内1-1" },
    ]);
    lookupMock.mockResolvedValue([{ addressLine: "東京都千代田区丸の内", source: "mock" }]);
    const res = await GET(req());
    const body = await res.json();
    expect(body.rows[0].apiAddressLine).toBe("東京都千代田区丸の内");
    expect(body.rows[0].verdict).toBe("match");
  });
});

describe("throttle 共有（Codex P2）", () => {
  it("token-bucket はモジュールレベルの単一インスタンス（リクエスト毎に生成しない）", async () => {
    // モジュール読込時に 1 度だけ生成される。各 GET では生成しない（共有）。
    // beforeEach の clearAllMocks 後、複数回 GET しても createTokenBucketLimiter は呼ばれない。
    pm.owner.findMany.mockResolvedValue([
      { id: "o1", name: "n", zip: "1000005", address: "東京都千代田区丸の内" },
    ]);
    lookupMock.mockResolvedValue([{ addressLine: "東京都千代田区丸の内", source: "mock" }]);
    createLimiterSpy.mockClear();
    await GET(req());
    await GET(req());
    await GET(req());
    expect(createLimiterSpy).not.toHaveBeenCalled();
  });

  it("バケット枯渇（待機タイムアウト）時はトークン未消費で上流を呼ばない", async () => {
    // limiter が常に枯渇（tryConsume が必ず false）= バックプレッシャ最大の状況。
    // 待機ループのタイムアウトで諦めても、トークンを消費せずに上流 lookup を
    // 呼んではならない（共有 limiter のレート制御がバイパスされる）。
    tryConsumeImpl.fn = () => false;
    pm.owner.findMany.mockResolvedValue([
      { id: "o1", name: "n", zip: "1000005", address: "東京都千代田区丸の内1-1" },
    ]);
    lookupMock.mockResolvedValue([{ addressLine: "東京都千代田区丸の内", source: "mock" }]);

    vi.useFakeTimers();
    try {
      const p = GET(req());
      // 待機ループ(sleep)を全て進める。
      await vi.runAllTimersAsync();
      const res = await p;
      expect(res.status).toBe(200);
      const body = await res.json();
      // トークンを 1 つも消費できていない（= 上流は呼べない）。
      expect(lookupMock).not.toHaveBeenCalled();
      // 判定不能（lookup できなかった = lookup_unavailable）に倒れる。
      expect(body.rows[0].verdict).toBe("indeterminate");
      expect(body.rows[0].reason).toBe("lookup_unavailable");
    } finally {
      vi.useRealTimers();
    }
  });
});
