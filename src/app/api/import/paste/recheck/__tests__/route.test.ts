/**
 * 確認画面で人が直したあとの「重複の見直し」API。
 *
 * ⚠この口は**下書きAPIと同じ守り**でなければならない。ここが緩むと、
 *   塞いだはずの検索オラクル(全体レビュー Critical 2)が別の口から開く。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let mockSession: { id: string; role?: string } = { id: "user-1" };
const FULL_PERMS = [
  { resource: "import", action: "write", granted: true },
  { resource: "property", action: "write", granted: true },
  // ⚠物件を引くには property:read も要る(通常の物件API と同じゲート)。
  { resource: "property", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "owner_name", action: "full", granted: true },
  { resource: "owner_address", action: "full", granted: true },
];
let mockPerms: unknown = FULL_PERMS;
const mockFindMany = vi.fn();
const mockOwnerFindMany = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(input, init);
    }
  }
  class MockNextResponse extends Response {
    static json = (b: unknown, init?: ResponseInit) => Response.json(b, init);
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-helpers")>("@/lib/api-helpers");
  return {
    ...actual,
    getApiSession: vi.fn(async () => mockSession),
    getUserPermissions: vi.fn(async () => mockPerms),
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    property: { findMany: (...a: unknown[]) => mockFindMany(...a) },
    owner: { findMany: (...a: unknown[]) => mockOwnerFindMany(...a) },
  },
}));

import { POST } from "../route";
import { NextRequest } from "next/server";

const req = (body: unknown) => {
  const s = JSON.stringify(body);
  return new NextRequest("http://localhost/api/import/paste/recheck", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(s)),
    },
    body: s,
  });
};

beforeEach(() => {
  mockSession = { id: "user-1" };
  mockPerms = FULL_PERMS;
  mockFindMany.mockReset();
  mockFindMany.mockResolvedValue([]);
  mockOwnerFindMany.mockReset();
  mockOwnerFindMany.mockResolvedValue([]);
});

/** ⚠where を実際に適用する(素通しのモックは実装を戻しても緑のまま通る)。 */
function dbProperty(row: {
  id: string;
  address: string;
  lotNumber: string | null;
  externalLinkKey: string | null;
  createdBy?: string;
  assignedTo?: string | null;
}) {
  const full = { createdBy: "user-1", assignedTo: null, ...row };
  mockFindMany.mockImplementation(
    async (args: {
      where?: { externalLinkKey?: { in?: string[] }; address?: { contains?: string } };
    }) => {
      if (args?.where?.externalLinkKey) {
        return full.externalLinkKey !== null &&
          (args.where.externalLinkKey.in ?? []).includes(full.externalLinkKey)
          ? [full]
          : [];
      }
      const cond = args?.where?.address;
      if (cond && typeof cond.contains === "string") {
        return full.address.includes(cond.contains) ? [full] : [];
      }
      return [];
    },
  );
}

describe("POST /api/import/paste/recheck", () => {
  it("★直した住所が既存物件と一致すれば similar が出る(直す前は出なかった)", async () => {
    dbProperty({
      id: "p-1",
      address: "東京都Ａ区Ｂ１－２－３",
      lotNumber: null,
      externalLinkKey: null,
    });
    const res = await POST(req({ address: "東京都A区B1-2-3" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.similar.map((x: { id: string }) => x.id)).toEqual(["p-1"]);
    expect(body.duplicates.similarPropertyIds).toEqual(["p-1"]);
  });

  it("★直した住所が既存と違えば出ない(出しっぱなしになっていない)", async () => {
    dbProperty({
      id: "p-1",
      address: "東京都Ａ区Ｂ９－９－９",
      lotNumber: null,
      externalLinkKey: null,
    });
    const res = await POST(req({ address: "東京都A区B1-2-3" }));
    const body = await res.json();
    expect(body.similar).toEqual([]);
  });

  it("★直した査定ナンバーが既存と一致すれば blocked になる", async () => {
    dbProperty({
      id: "p-key",
      address: "別の住所",
      lotNumber: null,
      externalLinkKey: "SA2608-1234567",
    });
    const res = await POST(req({ externalLinkKey: "SA2608-1234567" }));
    const body = await res.json();
    expect(body.duplicates.blocked).toBe(true);
    expect(body.duplicates.blockedByPropertyId).toBe("p-key");
  });

  it("★直した氏名が既存所有者と一致すれば候補が出る", async () => {
    mockOwnerFindMany.mockResolvedValue([
      { id: "o-1", name: "山田太郎", currentAddress: "東京都渋谷区X1-1-1", address: null },
    ]);
    const res = await POST(
      req({
        address: "東京都A区B1-2-3",
        ownerName: "山田太郎",
        ownerCurrentAddress: "東京都渋谷区X1-1-1",
      }),
    );
    const body = await res.json();
    expect(body.ownerCandidates).toEqual([
      { id: "o-1", name: "山田太郎", matchKind: "current_address" },
    ]);
  });

  it("★氏名が空なら所有者を引きに行かない", async () => {
    const res = await POST(req({ address: "東京都A区B1-2-3", ownerName: "" }));
    expect(res.status).toBe(200);
    expect((await res.json()).ownerCandidates).toEqual([]);
    expect(mockOwnerFindMany).not.toHaveBeenCalled();
  });

  it("★import:write が無ければ403", async () => {
    mockPerms = FULL_PERMS.filter((p) => p.resource !== "import");
    expect((await POST(req({ address: "東京都A区B1-2-3" }))).status).toBe(403);
  });

  it("★property:write が無ければ403", async () => {
    mockPerms = FULL_PERMS.filter((p) => p.resource !== "property");
    expect((await POST(req({ address: "東京都A区B1-2-3" }))).status).toBe(403);
  });

  it("★owner:read が無ければ所有者情報を返さず、DBも引かない", async () => {
    mockPerms = FULL_PERMS.filter((p) => p.resource !== "owner");
    mockOwnerFindMany.mockResolvedValue([
      { id: "o-secret", name: "山田太郎", currentAddress: "東京都渋谷区X1-1-1", address: null },
    ]);
    const res = await POST(
      req({
        address: "東京都A区B1-2-3",
        ownerName: "山田太郎",
        ownerCurrentAddress: "東京都渋谷区X1-1-1",
      }),
    );
    const body = await res.json();
    expect(body.ownerCandidates).toEqual([]);
    expect(mockOwnerFindMany).not.toHaveBeenCalled();
  });

  it("★住所の表示レベルが partial(既定の field_staff)なら所有者を引かない=検索オラクルを開かない", async () => {
    mockPerms = [
      { resource: "import", action: "write", granted: true },
      { resource: "property", action: "write", granted: true },
      { resource: "property", action: "read", granted: true },
      { resource: "owner", action: "read", granted: true },
      { resource: "owner_name", action: "full", granted: true },
      { resource: "owner_address", action: "partial", granted: true },
    ];
    mockOwnerFindMany.mockResolvedValue([
      { id: "o-secret", name: "山田太郎", currentAddress: null, address: "東京都渋谷区X1-1-1" },
    ]);
    const res = await POST(
      req({
        address: "東京都A区B1-2-3",
        ownerName: "山田太郎",
        ownerCurrentAddress: "東京都渋谷区X1-1-1",
      }),
    );
    expect((await res.json()).ownerCandidates).toEqual([]);
    expect(mockOwnerFindMany).not.toHaveBeenCalled();
  });

  it("★field_staff には担当外の物件を返さない(blocked は残すが id は渡さない)", async () => {
    mockSession = { id: "user-1", role: "field_staff" };
    dbProperty({
      id: "p-theirs",
      address: "東京都A区B1-2-3",
      lotNumber: null,
      externalLinkKey: "SA2608-1234567",
      createdBy: "someone-else",
      assignedTo: "someone-else",
    });
    const res = await POST(
      req({ address: "東京都A区B1-2-3", externalLinkKey: "SA2608-1234567" }),
    );
    const body = await res.json();
    expect(body.duplicates.blocked).toBe(true);
    expect(body.duplicates.blockedByPropertyId).toBeNull();
    expect(body.similar).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("someone-else");
  });

  it("★この口は何も保存しない(Prisma の書き込みを一切呼ばない)", async () => {
    // prisma のモックには findMany しか生えていない。create/update を呼べば
    // TypeError で 500 になるので、200 であること自体が「書いていない」証拠。
    const res = await POST(req({ address: "東京都A区B1-2-3" }));
    expect(res.status).toBe(200);
  });

  it("★共有の既定(64MB)ではなく、この口専用の小さい上限で弾く", async () => {
    const big = new NextRequest("http://localhost/api/import/paste/recheck", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(512 * 1024),
      },
      body: JSON.stringify({ address: "東京都A区B1-2-3" }),
    });
    expect((await POST(big)).status).toBe(413);
  });
});

describe("物件を読む権限(property:read)が無ければ、物件情報を返さない（7巡目 ①）", () => {
  /** property:write は持つが property:read だけ落とされた利用者。 */
  const WRITE_ONLY = () =>
    FULL_PERMS.filter((p) => !(p.resource === "property" && p.action === "read"));

  it("★similar も blockedByPropertyId も返さない（住所・地番・id が漏れない）", async () => {
    mockPerms = WRITE_ONLY();
    dbProperty({
      id: "p-secret",
      address: "東京都Ａ区Ｂ１－２－３",
      lotNumber: "552-2",
      externalLinkKey: "SA2608-1234567",
    });
    const res = await POST(
      req({ address: "東京都A区B1-2-3", lotNumber: "552-2", externalLinkKey: "SA2608-1234567" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.similar).toEqual([]);
    expect(body.duplicates.similarPropertyIds).toEqual([]);
    expect(body.duplicates.blockedByPropertyId).toBeNull();
    const dumped = JSON.stringify(body);
    expect(dumped).not.toContain("p-secret");
    expect(dumped).not.toContain("東京都Ａ区Ｂ１－２－３");
    expect(dumped).not.toContain("552-2");
  });

  it("★それでも blocked の真偽は残す（伝えないと二重登録が起きる）", async () => {
    mockPerms = WRITE_ONLY();
    dbProperty({
      id: "p-secret",
      address: "東京都Ａ区Ｂ１－２－３",
      lotNumber: null,
      externalLinkKey: "SA2608-1234567",
    });
    const res = await POST(req({ externalLinkKey: "SA2608-1234567" }));
    const body = await res.json();
    expect(body.duplicates.blocked).toBe(true);
    expect(body.duplicates.blockedByPropertyId).toBeNull();
  });

  it("★住所での検索そのものを行わない（住所で既存物件を探れない）", async () => {
    mockPerms = WRITE_ONLY();
    mockFindMany.mockResolvedValue([]);
    await POST(req({ address: "東京都A区B1-2-3" }));
    // 外部キーが無いので、DB は一度も引かれない。
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("property:read があれば従来どおり返る（閉じすぎていない）", async () => {
    dbProperty({
      id: "p-ok",
      address: "東京都Ａ区Ｂ１－２－３",
      lotNumber: null,
      externalLinkKey: null,
    });
    const res = await POST(req({ address: "東京都A区B1-2-3" }));
    const body = await res.json();
    expect(body.similar.map((x: { id: string }) => x.id)).toEqual(["p-ok"]);
  });
});
