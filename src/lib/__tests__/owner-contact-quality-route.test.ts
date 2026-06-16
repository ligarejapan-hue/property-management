/**
 * GET /api/admin/owners/contact-quality-candidates のルートテスト（DQ-02）。
 *
 * 観点: 認可 / type フィルタ(all は warning のみ) / archived 除外 / PII マスキング /
 * summary / blockReasons / recommendedAction / AuditLog 非PII / ページング。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
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
    getApiSession: vi.fn().mockResolvedValue({ id: "user-1", role: "admin" }),
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
    changeLog: { findMany: vi.fn() },
    importJobRow: { findMany: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { GET } from "../../app/api/admin/owners/contact-quality-candidates/route";

const pm = prisma as unknown as {
  owner: { findMany: Mock };
  changeLog: { findMany: Mock };
  importJobRow: { findMany: Mock };
};

const PERMS_FULL = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
];

const DISPLAY_FULL = {
  name: "full" as const,
  nameKana: "full" as const,
  phone: "full" as const,
  zip: "full" as const,
  address: "full" as const,
  note: "full" as const,
  email: "full" as const,
  corporateNumber: "full" as const,
};

function owner(
  over: Partial<{
    id: string;
    zip: string | null;
    phone: string | null;
    note: string | null;
    externalLinkKey: string | null;
    version: number;
    propertyOwners: number;
  }> = {},
) {
  return {
    id: over.id ?? "o-1",
    zip: over.zip ?? null,
    phone: over.phone ?? null,
    note: over.note ?? null,
    externalLinkKey: over.externalLinkKey ?? null,
    version: over.version ?? 1,
    _count: { propertyOwners: over.propertyOwners ?? 0 },
  };
}

function url(query = "") {
  return new Request(
    `http://localhost/api/admin/owners/contact-quality-candidates${query}`,
  ) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL);
  vi.mocked(getOwnerDisplayConfig).mockResolvedValue(DISPLAY_FULL);
  pm.owner.findMany.mockResolvedValue([]);
  pm.changeLog.findMany.mockResolvedValue([]);
  pm.importJobRow.findMany.mockResolvedValue([]);
});

describe("認可", () => {
  it("user_management:read 無しで 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce([
      { resource: "owner", action: "read", granted: true },
    ]);
    expect((await GET(url())).status).toBe(403);
  });
  it("owner:read 無しで 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce([
      { resource: "user_management", action: "read", granted: true },
    ]);
    expect((await GET(url())).status).toBe(403);
  });
});

describe("分類とフィルタ", () => {
  beforeEach(() => {
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", zip: "123" }), // zip_suspicious (warning)
      owner({ id: "o-2", phone: "不明" }), // phone_non_phone (warning)
      owner({ id: "o-3", zip: "1234567" }), // zip_unformatted (info)
      owner({ id: "o-4", zip: "123-4567", phone: "090-1234-5678" }), // clean
    ]);
  });

  it("type=all は warning のみ（info の unformatted を除外）", async () => {
    const res = await GET(url());
    const json = await res.json();
    const ids = json.candidates.map((c: { ownerId: string }) => c.ownerId).sort();
    expect(ids).toEqual(["o-1", "o-2"]);
  });

  it("type=zip_unformatted で info を明示表示", async () => {
    const res = await GET(url("?type=zip_unformatted"));
    const json = await res.json();
    expect(json.candidates.map((c: { ownerId: string }) => c.ownerId)).toEqual(["o-3"]);
  });

  it("summary は全 owner ベース", async () => {
    const res = await GET(url());
    const json = await res.json();
    expect(json.summary.zipSuspicious).toBe(1);
    expect(json.summary.phoneNonPhone).toBe(1);
    expect(json.summary.zipUnformatted).toBe(1);
    expect(json.summary.totalCandidates).toBe(3);
  });

  it("clean owner は候補に出ない", async () => {
    const res = await GET(url());
    const json = await res.json();
    expect(
      json.candidates.find((c: { ownerId: string }) => c.ownerId === "o-4"),
    ).toBeUndefined();
  });
});

describe("archived 除外", () => {
  it("findMany の where は isArchived:false", async () => {
    await GET(url());
    expect(pm.owner.findMany.mock.calls[0][0].where).toEqual({ isArchived: false });
  });
});

describe("blockReasons / recommendedAction", () => {
  it("safeguard（紐づきあり）は hold", async () => {
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", zip: "123", propertyOwners: 2 }),
    ]);
    const res = await GET(url("?type=zip_suspicious"));
    const json = await res.json();
    expect(json.candidates[0].blockReasons).toContain("property_owner_exists");
    expect(json.candidates[0].recommendedAction).toBe("hold");
  });

  it("未整形のみ・safeguard なしは format_candidate", async () => {
    pm.owner.findMany.mockResolvedValue([owner({ id: "o-1", zip: "1234567" })]);
    pm.importJobRow.findMany.mockResolvedValue([{ createdId: "o-1", status: "success" }]);
    const res = await GET(url("?type=zip_unformatted"));
    const json = await res.json();
    expect(json.candidates[0].recommendedAction).toBe("format_candidate");
  });

  it("suspicious・safeguard なしは review", async () => {
    pm.owner.findMany.mockResolvedValue([owner({ id: "o-1", zip: "123" })]);
    pm.importJobRow.findMany.mockResolvedValue([{ createdId: "o-1", status: "success" }]);
    const res = await GET(url("?type=zip_suspicious"));
    const json = await res.json();
    expect(json.candidates[0].recommendedAction).toBe("review");
  });
});

describe("PII マスキング", () => {
  it("可視フィールドで候補化しつつ、別の masked フィールドは生値を返さない", async () => {
    // phone は full（可視）で phone_non_phone により候補化。zip は masked のため
    // zipMasked に生値（1234567）を返さない。
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      zip: "masked",
      phone: "full",
    });
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", zip: "1234567", phone: "不明" }),
    ]);
    const res = await GET(url("?type=phone_non_phone"));
    const json = await res.json();
    expect(json.candidates[0].ownerId).toBe("o-1");
    expect(json.candidates[0].zipMasked).not.toBe("1234567");
  });
});

describe("フィールド可視性ゲート（DQ-02 P1）", () => {
  it("zip が masked（生値不可視）なら zip 由来の分類・summary を出さない", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      zip: "masked",
    });
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", zip: "123" }), // zip_suspicious だが zip 不可視 → 出さない
      owner({ id: "o-2", phone: "不明" }), // phone_non_phone は出す
    ]);
    const res = await GET(url());
    const json = await res.json();
    const ids = json.candidates.map((c: { ownerId: string }) => c.ownerId).sort();
    expect(ids).toEqual(["o-2"]);
    // zip 由来 summary はゼロ（隠し値の品質を推測させない）
    expect(json.summary.zipSuspicious).toBe(0);
    expect(json.summary.phoneNonPhone).toBe(1);
  });

  it("phone が hidden なら phone 由来の分類・summary を出さない", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      phone: "hidden",
    });
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", zip: "123" }), // zip_suspicious は出す
      owner({ id: "o-2", phone: "不明" }), // phone 不可視 → 出さない
    ]);
    const res = await GET(url());
    const json = await res.json();
    const ids = json.candidates.map((c: { ownerId: string }) => c.ownerId).sort();
    expect(ids).toEqual(["o-1"]);
    expect(json.summary.phoneNonPhone).toBe(0);
    expect(json.summary.zipSuspicious).toBe(1);
  });

  it("partial（生値非可視）も分類しない", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      zip: "partial",
      phone: "partial",
    });
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", zip: "123", phone: "不明" }),
    ]);
    const res = await GET(url());
    const json = await res.json();
    expect(json.candidates).toHaveLength(0);
    expect(json.summary.totalCandidates).toBe(0);
  });

  it("read 権限（生値可視）は従来どおり分類する", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      zip: "read",
      phone: "read",
    });
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", zip: "123" }),
      owner({ id: "o-2", phone: "不明" }),
    ]);
    const res = await GET(url());
    const json = await res.json();
    const ids = json.candidates.map((c: { ownerId: string }) => c.ownerId).sort();
    expect(ids).toEqual(["o-1", "o-2"]);
  });
});

describe("AuditLog 非PII", () => {
  it("detail に zip/phone 生値が含まれず type/summary のみ", async () => {
    pm.owner.findMany.mockResolvedValue([owner({ id: "o-1", phone: "09098761234" })]);
    await GET(url());
    const call = vi.mocked(writeAuditLog).mock.calls[0][0];
    expect(call.action).toBe("owner_contact_quality_candidates_list");
    const detailJson = JSON.stringify(call.detail);
    expect(detailJson).not.toContain("09098761234");
    expect(call.detail).toHaveProperty("summary");
  });
});

describe("ページング（DB カーソル）", () => {
  beforeEach(() => {
    // cursor は DB の where:{id:{gt:cursor}} で適用されるため mock も尊重する。
    const fixtures = Array.from({ length: 5 }, (_, i) =>
      owner({ id: `o-${i}`, zip: "123" }),
    );
    pm.owner.findMany.mockImplementation(
      (args: { where?: { id?: { gt?: string } }; take?: number }) => {
        const gt = args?.where?.id?.gt ?? null;
        const rows = gt ? fixtures.filter((o) => o.id > gt) : fixtures;
        return Promise.resolve(rows.slice(0, args?.take ?? rows.length));
      },
    );
  });
  it("limit=2 で 2 件 + hasNextPage", async () => {
    const res = await GET(url("?type=zip_suspicious&limit=2"));
    const json = await res.json();
    expect(json.candidates).toHaveLength(2);
    expect(json.hasNextPage).toBe(true);
    expect(json.nextCursor).toBe(json.candidates[1].ownerId);
  });
  it("cursor は DB クエリの where に id.gt として渡る（先頭固定スキャンにしない）", async () => {
    await GET(url("?type=zip_suspicious&limit=2&cursor=o-1"));
    expect(pm.owner.findMany.mock.calls[0][0].where).toEqual({
      isArchived: false,
      id: { gt: "o-1" },
    });
  });
  it("cursor 無しのときは where に id 条件を付けない", async () => {
    await GET(url("?type=zip_suspicious&limit=2"));
    expect(pm.owner.findMany.mock.calls[0][0].where).toEqual({
      isArchived: false,
    });
  });
  it("cursor で続きを取得", async () => {
    const res1 = await GET(url("?type=zip_suspicious&limit=2"));
    const json1 = await res1.json();
    const res2 = await GET(
      url(`?type=zip_suspicious&limit=2&cursor=${json1.nextCursor}`),
    );
    const json2 = await res2.json();
    expect(json2.candidates[0].ownerId > json1.nextCursor).toBe(true);
  });
});

// MAX_SCAN(10k) 超でも取りこぼさないこと（Codex P2 対応）。旧 in-memory cursor は先頭
// MAX_SCAN 窓しか走査できず、truncated:true/hasNextPage:false で >10k の候補を黙殺していた。
// DB カーソル化により、truncated 窓で matched を使い切っても nextCursor を窓末尾へ前進させ
// 次窓を走査できる（name-quality-candidates と同契約）。
describe("scan cap 超のページング前進（取りこぼし防止・Codex P2）", () => {
  function generateOwners(
    cursorId: string | null,
    total: number,
    take: number,
  ) {
    const all = Array.from({ length: total }, (_, i) =>
      owner({
        id: `o-${String(i).padStart(6, "0")}`,
        // 末尾にだけ zip_suspicious ゴミ（窓内で matched が枯渇する状況を作る）。
        zip: i >= total - 1 ? "123" : "123-4567",
      }),
    );
    const startIdx = cursorId ? all.findIndex((o) => o.id > cursorId) : 0;
    const from = startIdx < 0 ? all.length : startIdx;
    return all.slice(from, from + take);
  }

  it("truncated 窓で matched 枯渇 → hasNextPage=true・nextCursor は窓末尾へ前進", async () => {
    const TOTAL = 10_005;
    pm.owner.findMany.mockImplementation(
      (args: { where?: { id?: { gt?: string } }; take?: number }) =>
        Promise.resolve(
          generateOwners(
            args?.where?.id?.gt ?? null,
            TOTAL,
            args?.take ?? 10_001,
          ),
        ),
    );
    const res = await GET(url("?type=zip_suspicious&limit=2"));
    const json = await res.json();
    expect(json.candidates).toHaveLength(0);
    expect(json.truncated).toBe(true);
    expect(json.hasNextPage).toBe(true);
    expect(json.nextCursor).toBe(`o-${String(9999).padStart(6, "0")}`);
  });

  it("前進した cursor で次窓の scan cap 超候補へ到達できる", async () => {
    const TOTAL = 10_005;
    pm.owner.findMany.mockImplementation(
      (args: { where?: { id?: { gt?: string } }; take?: number }) =>
        Promise.resolve(
          generateOwners(
            args?.where?.id?.gt ?? null,
            TOTAL,
            args?.take ?? 10_001,
          ),
        ),
    );
    const res1 = await GET(url("?type=zip_suspicious&limit=2"));
    const json1 = await res1.json();
    const res2 = await GET(
      url(`?type=zip_suspicious&limit=2&cursor=${json1.nextCursor}`),
    );
    const json2 = await res2.json();
    expect(json2.candidates.length).toBeGreaterThan(0);
    expect(json2.candidates[0].ownerId).toBe(
      `o-${String(10004).padStart(6, "0")}`,
    );
  });
});
