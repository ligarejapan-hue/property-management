import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response {
    static json = (b: unknown, init?: ResponseInit) => Response.json(b, init);
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(s: number, m: string, c = "ERROR") {
      super(m);
      this.status = s;
      this.code = c;
    }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    apiResponse: (b: unknown, status = 200) => Response.json(b, { status }),
    handleApiError: vi.fn((e: unknown) => {
      const x = e as { status?: unknown; code?: unknown; message?: unknown } | null;
      if (x && typeof x.status === "number") {
        return Response.json({ error: { message: x.message, code: x.code } }, { status: x.status });
      }
      return Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 });
    }),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/property-record-guard", () => ({ assertPropertyRecordAccess: vi.fn(async () => undefined) }));
vi.mock("@/lib/dm-reaction/clear-undeliverable", () => ({ clearOwnerUndeliverable: vi.fn() }));
vi.mock("@/lib/prisma", () => {
  const tx = { marker: "tx" };
  return {
    default: {
      propertyOwner: { findUnique: vi.fn() },
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
      _tx: tx,
    },
  };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { assertPropertyRecordAccess } from "@/lib/property-record-guard";
import { clearOwnerUndeliverable } from "@/lib/dm-reaction/clear-undeliverable";
import { POST } from "../../app/api/properties/[id]/owners/[ownerId]/clear-dm-undeliverable/route";

/**
 * 宛先不明の解除の窓口(2026-11-13 発注者決定)。
 * 権限=住所を編集できる人なら誰でも(所有者の編集+住所・郵便番号の両方+物件の編集)。
 * ⚠応答・監査に氏名・住所を出さない(件数だけ)。
 */
type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as { propertyOwner: { findUnique: Fn }; $transaction: Fn; _tx: unknown };
const req = () => new Request("http://x", { method: "POST" }) as never;
const ctx = (id = "p1", ownerId = "o1") => ({ params: Promise.resolve({ id, ownerId }) });
const FULL = [
  { resource: "owner", action: "write" },
  { resource: "owner_address", action: "full" },
  { resource: "owner_zip", action: "full" },
  { resource: "property", action: "write" },
];
const setPerms = (perms: Array<{ resource: string; action: string }>) =>
  (getUserPermissions as Fn).mockResolvedValue(perms.map((p) => ({ granted: true, ...p })));
const without = (resource: string) => FULL.filter((p) => p.resource !== resource);
const RESULT = { cleared: 2, sharedSkipped: 1, otherSkipped: 0, flagsCleared: 1, dmStatusRestored: 1, propertyIds: ["p1"] };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "office_staff" });
  setPerms(FULL);
  pm.propertyOwner.findUnique.mockResolvedValue({ id: "po-1" });
  pm.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(pm._tx));
  (clearOwnerUndeliverable as Fn).mockResolvedValue(RESULT);
});

describe("POST /api/properties/[id]/owners/[ownerId]/clear-dm-undeliverable", () => {
  it("★解除して、件数だけを返す(物件の id の一覧・氏名・住所は返さない)", async () => {
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      cleared: 2,
      sharedSkipped: 1,
      otherSkipped: 0,
      flagsCleared: 1,
      dmStatusRestored: 1,
    });
    // 解除の処理は、トランザクションの中で・その所有者と操作した人を渡して呼ぶ
    expect(clearOwnerUndeliverable).toHaveBeenCalledWith(pm._tx, {
      ownerId: "o1",
      session: { id: "u1", role: "office_staff" },
      now: expect.any(Date),
    });
  });

  it("監査には物件の id と件数だけを残す", async () => {
    await POST(req(), ctx());
    expect(writeAuditLog).toHaveBeenCalledWith({
      userId: "u1",
      action: "dm_undeliverable_clear",
      targetTable: "owners",
      targetId: "o1",
      detail: { propertyId: "p1", cleared: 2, sharedSkipped: 1, otherSkipped: 0, flagsCleared: 1, dmStatusRestored: 1 },
    });
  });

  it.each([
    ["所有者の編集(owner:write)", "owner"],
    ["住所(owner_address)", "owner_address"],
    ["郵便番号(owner_zip)", "owner_zip"],
    ["物件の編集(property:write)", "property"],
  ])("⚠%s の権限が無ければ 403(何も解除しない)", async (_label, resource) => {
    setPerms(without(resource));
    const res = await POST(req(), ctx());
    expect(res.status).toBe(403);
    expect(clearOwnerUndeliverable).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("⚠住所が「閲覧だけ」の人は 403(編集できる人だけ)", async () => {
    setPerms([...without("owner_address"), { resource: "owner_address", action: "read" }]);
    expect((await POST(req(), ctx())).status).toBe(403);
    expect(clearOwnerUndeliverable).not.toHaveBeenCalled();
  });

  it("⚠担当できない物件(現場担当の担当外)は、物件の担当の確認で止まる", async () => {
    class Forbidden extends Error {
      status = 403;
      code = "FORBIDDEN";
    }
    (assertPropertyRecordAccess as Fn).mockRejectedValueOnce(new Forbidden("担当外"));
    const res = await POST(req(), ctx());
    expect(res.status).toBe(403);
    expect(assertPropertyRecordAccess).toHaveBeenCalledWith("p1", { id: "u1", role: "office_staff" }, "write");
    expect(clearOwnerUndeliverable).not.toHaveBeenCalled();
  });

  it("⚠その物件の所有者でなければ 404(別の物件の画面から、関係ない所有者の記録を解除させない)", async () => {
    pm.propertyOwner.findUnique.mockResolvedValue(null);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(404);
    expect(pm.propertyOwner.findUnique).toHaveBeenCalledWith({
      where: { propertyId_ownerId: { propertyId: "p1", ownerId: "o1" } },
      select: { id: true },
    });
    expect(clearOwnerUndeliverable).not.toHaveBeenCalled();
  });
});
