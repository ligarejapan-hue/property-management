/**
 * GET /api/properties/search — 取引の新規作成で物件を選ぶための caseStatus 絞り込み(2026-10-25)。
 * 従来の呼び出し(取込の紐付け: q だけ)は動きを変えない。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    nextUrl: URL;
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(input, init);
      this.nextUrl = new URL(typeof input === "string" ? input : (input as Request).url);
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
    handleApiError: vi.fn((error: unknown) => {
      if (error instanceof MockApiError) {
        return Response.json({ error: { message: error.message, code: error.code } }, { status: error.status });
      }
      return Response.json({ error: { message: String(error) } }, { status: 500 });
    }),
    apiResponse: vi.fn((data: unknown, status = 200) => Response.json(data, { status })),
  };
});

const findMany = vi.fn();
vi.mock("@/lib/prisma", () => ({ default: { property: { findMany: (...a: unknown[]) => findMany(...a) } } }));

import { NextRequest } from "next/server";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { GET } from "../route";

const READ = [{ resource: "property", action: "read", granted: true }];

function req(qs: string) {
  return new NextRequest(`http://localhost/api/properties/search?${qs}`);
}

type Where = { AND: Record<string, unknown>[] };
const whereOf = () => (findMany.mock.calls[0][0] as { where: Where }).where;

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue(READ);
  findMany.mockResolvedValue([]);
});

describe("GET /api/properties/search", () => {
  it("property:read が無ければ 403", async () => {
    (getUserPermissions as Mock).mockResolvedValue([]);
    const res = await GET(req("caseStatus=contract_planned"));
    expect(res.status).toBe(403);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("従来どおり: caseStatus なしで q が 2 文字未満なら空(DB を引かない)", async () => {
    const res = await GET(req("q=a"));
    expect(await res.json()).toEqual({ data: [] });
    const res2 = await GET(req(""));
    expect(await res2.json()).toEqual({ data: [] });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("従来どおり: q だけなら案件状況で絞らず、建物名でも探す", async () => {
    await GET(req("q=" + encodeURIComponent("架空")));
    const w = whereOf();
    expect(JSON.stringify(w)).not.toContain("caseStatus");
    expect(JSON.stringify(w)).toContain("buildingName");
    expect((findMany.mock.calls[0][0] as { take: number }).take).toBe(10);
  });

  it("取扱区分も返す(取引の作成画面で物件を選んだときの事業区分の初期値・2026-11-04)", async () => {
    findMany.mockResolvedValue([{ id: "p1", address: "架空区1-1", businessType: "resale" }]);
    const res = await GET(req("caseStatus=contract_planned"));
    const select = (findMany.mock.calls[0][0] as { select: Record<string, unknown> }).select;
    expect(select.businessType).toBe(true);
    expect(((await res.json()) as { data: Array<{ businessType: string }> }).data[0].businessType).toBe("resale");
  });

  it("caseStatus だけ(q 空)なら、その案件状況のアーカイブされていない物件を出す", async () => {
    await GET(req("caseStatus=contract_planned"));
    const w = whereOf();
    expect(w.AND).toContainEqual({ caseStatus: "contract_planned", isArchived: false });
    // キーワード条件は付かない
    expect(JSON.stringify(w)).not.toContain("contains");
  });

  it("caseStatus + q は両方で絞る(AND)", async () => {
    await GET(req("caseStatus=contract_planned&q=" + encodeURIComponent("架空町")));
    const w = whereOf();
    expect(w.AND).toContainEqual({ caseStatus: "contract_planned", isArchived: false });
    expect(JSON.stringify(w)).toContain("架空町");
  });

  it("caseStatus があっても q が 1 文字(打ちかけ)なら空", async () => {
    const res = await GET(req("caseStatus=contract_planned&q=a"));
    expect(await res.json()).toEqual({ data: [] });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("知らない caseStatus は 400", async () => {
    const res = await GET(req("caseStatus=bogus"));
    expect(res.status).toBe(400);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("field_staff は caseStatus だけのときも自分の物件に絞る(AND の先頭)", async () => {
    (getApiSession as Mock).mockResolvedValue({ id: "fs1", role: "field_staff" });
    await GET(req("caseStatus=contract_planned"));
    const w = whereOf();
    expect(w.AND[0]).toEqual({ OR: [{ createdBy: "fs1" }, { assignedTo: "fs1" }] });
    expect(w.AND).toContainEqual({ caseStatus: "contract_planned", isArchived: false });
  });
});
