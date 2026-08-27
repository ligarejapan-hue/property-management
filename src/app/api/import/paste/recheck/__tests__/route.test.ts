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

/**
 * 候補から「id / 氏名 / 一致の種類」だけを取り出す。
 * ⚠住所・所有物件数（同姓同名を見分けるための項目）は**別のテストで**固定する。
 *   ここは一致の種類の判定を見るテスト群なので、そこだけを比べる。
 */
function pickKind(
  candidates: { id: string; name: string; matchKind: string }[],
): { id: string; name: string; matchKind: string }[] {
  return candidates.map(({ id, name, matchKind }) => ({ id, name, matchKind }));
}

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
    expect(pickKind(body.ownerCandidates)).toEqual([
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
    expect(pickKind(body.ownerCandidates)).toEqual([]);
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

describe("同姓同名の候補を見分けられる（8巡目 ②・共有モジュールが両ルートに効く）", () => {
  it("★再判定でも住所と所有物件数が付いて返る", async () => {
    mockOwnerFindMany.mockResolvedValue([
      {
        id: "same-1", name: "山田太郎",
        currentAddress: null, address: "東京都A区1-1-1",
        _count: { propertyOwners: 3 },
      },
      {
        id: "same-2", name: "山田太郎",
        currentAddress: null, address: "大阪府B市2-2-2",
        _count: { propertyOwners: 7 },
      },
    ]);
    const res = await POST(req({ address: "東京都A区B1-2-3", ownerName: "山田太郎" }));
    const body = await res.json();
    expect(body.ownerCandidates).toEqual([
      { id: "same-1", name: "山田太郎", matchKind: "name_only", address: "東京都A区1-1-1", addressKind: "registry", propertyCount: 3 },
      { id: "same-2", name: "山田太郎", matchKind: "name_only", address: "大阪府B市2-2-2", addressKind: "registry", propertyCount: 7 },
    ]);
  });

  it("★電話・メールは返さない（住所は表示レベル経由でのみ）", async () => {
    mockOwnerFindMany.mockResolvedValue([
      {
        id: "o-1", name: "山田太郎",
        currentAddress: "東京都渋谷区X1-1-1", address: null,
        phone: "09099999999", email: "yamada@example.com",
        _count: { propertyOwners: 1 },
      },
    ]);
    const res = await POST(req({ address: "東京都A区B1-2-3", ownerName: "山田太郎" }));
    const dumped = JSON.stringify((await res.json()).ownerCandidates);
    expect(dumped).not.toContain("09099999999");
    expect(dumped).not.toContain("yamada@example.com");
  });
});

describe("同じ所有者が、住所の編集だけで一致の種類を落とす（12巡目 ①の前提）", () => {
  /**
   * ⚠画面側の「弱くなったら止める」が守っている状況を、**サーバーが本当に
   *   作れる**ことを確かめる。id は同じまま matchKind だけが落ちる、という
   *   組み合わせが実在しなければ、画面側のテストは空振りになる。
   */
  const owner = {
    id: "same-owner",
    name: "山田太郎",
    currentAddress: null,
    address: "東京都渋谷区X1-1-1",
    _count: { propertyOwners: 1 },
  };

  it("★住所が一致していれば registry_address、住所を直して一致が消えると同じ id が name_only になる", async () => {
    mockOwnerFindMany.mockResolvedValue([owner]);

    const matched = await (
      await POST(
        req({
          address: "東京都A区B1-2-3",
          ownerName: "山田太郎",
          ownerCurrentAddress: "東京都渋谷区X1-1-1",
        }),
      )
    ).json();
    expect(matched.ownerCandidates).toHaveLength(1);
    expect(matched.ownerCandidates[0].id).toBe("same-owner");
    expect(matched.ownerCandidates[0].matchKind).toBe("registry_address");

    const weakened = await (
      await POST(
        req({
          address: "東京都A区B1-2-3",
          ownerName: "山田太郎",
          // 住所だけを直した(一致が消える)。
          ownerCurrentAddress: "大阪府B市9-9-9",
        }),
      )
    ).json();
    expect(weakened.ownerCandidates).toHaveLength(1);
    // ⚠**id は同じ**。だから id の集合比較では「変化なし」に見えていた。
    expect(weakened.ownerCandidates[0].id).toBe("same-owner");
    expect(weakened.ownerCandidates[0].matchKind).toBe("name_only");
  });
});

describe("外部キーは下書き・確定と同じ正規化を通る（16巡目 ②）", () => {
  /** 保存されている外部キーの表記を1つだけ持つDB。where を実際に適用する。 */
  function dbWithKey(stored: string) {
    const row = {
      id: "p-key",
      address: "東京都A区B1-2-3",
      lotNumber: null,
      externalLinkKey: stored,
      createdBy: "user-1",
      assignedTo: null,
    };
    mockFindMany.mockImplementation(
      async (args: { where?: { externalLinkKey?: { in?: string[] } } }) => {
        if (args?.where?.externalLinkKey) {
          return (args.where.externalLinkKey.in ?? []).includes(stored) ? [row] : [];
        }
        return [];
      },
    );
  }

  it("★全角の査定ナンバーで再判定しても、半角で保存された既存行がヒットして blocked になる", async () => {
    // ⚠ここが生値のままだと「再判定は重複なし・登録は409」の食い違いになる。
    dbWithKey("SA2608-1234567");
    const res = await POST(req({ externalLinkKey: "ＳＡ２６０８－１２３４５６７" }));
    const body = await res.json();
    expect(body.duplicates.blocked).toBe(true);
    expect(body.duplicates.blockedByPropertyId).toBe("p-key");
  });

  it("★問い合わせに使う値が正規化後（半角）であること", async () => {
    dbWithKey("SA2608-1234567");
    await POST(req({ externalLinkKey: "　ＳＡ２６０８－１２３４５６７　" }));
    const keyCall = mockFindMany.mock.calls
      .map((c) => c[0] as { where?: { externalLinkKey?: { in?: string[] } } })
      .find((a) => a?.where?.externalLinkKey !== undefined);
    expect(keyCall?.where?.externalLinkKey?.in?.[0]).toBe("SA2608-1234567");
  });

  it("半角で送っても従来どおり blocked（挙動が変わっていない）", async () => {
    dbWithKey("SA2608-1234567");
    const res = await POST(req({ externalLinkKey: "SA2608-1234567" }));
    expect((await res.json()).duplicates.blocked).toBe(true);
  });
});
