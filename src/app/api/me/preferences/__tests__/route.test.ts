/**
 * 見た目の設定(2026-10-31): 自分の 色テーマ・文字サイズ・レイアウト の読み書き。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    get nextUrl() { return new URL(this.url); }
  }
  class MockNextResponse extends Response {
    static json(data: unknown, init?: ResponseInit) { return Response.json(data, init); }
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number; code: string;
    constructor(status: number, message: string, code = "ERROR") { super(message); this.status = status; this.code = code; }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(),
    apiResponse: (data: unknown, status = 200) => Response.json(data, { status }),
    parseJsonBody: vi.fn(async (r: Request) => r.json()),
    handleApiError: vi.fn((e: { status?: number; message?: string; code?: string; issues?: unknown }) =>
      Response.json({ error: { message: e?.message, code: e?.code } }, { status: e?.status ?? (e?.issues ? 422 : 500) })),
  };
});
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => {
  const db = {
    user: { findUnique: vi.fn(), update: vi.fn() },
    systemSetting: { findMany: vi.fn(async () => []) },
  };
  return { default: db };
});

import prisma from "@/lib/prisma";
import { getApiSession, ApiError } from "@/lib/api-helpers";
import { GET, PATCH } from "../route";

const db = prisma as unknown as {
  user: { findUnique: Mock; update: Mock };
  systemSetting: { findMany: Mock };
};
const ME = "11111111-1111-1111-1111-111111111111";
const req = (body: unknown) =>
  new Request("http://x/api/me/preferences", { method: "PATCH", body: JSON.stringify(body) }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: ME, email: "a@x", name: "A", role: "field_staff" });
  db.user.findUnique.mockResolvedValue({ theme: null, density: null, layout: null });
  db.systemSetting.findMany.mockResolvedValue([]);
});

describe("GET /api/me/preferences", () => {
  it("個人(未設定)・会社の初期値・実際の値を返す", async () => {
    db.systemSetting.findMany.mockResolvedValue([{ key: "appearance.default.theme", value: "navy" }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const { data } = await res.json();
    expect(data.user).toEqual({ theme: null, density: null, layout: null });
    expect(data.effective).toEqual({ theme: "navy", density: "normal", layout: "side" });
  });
  it("ログインしていなければ 401", async () => {
    (getApiSession as Mock).mockRejectedValue(new (ApiError as unknown as new (s: number, m: string) => Error)(401, "認証が必要です"));
    expect((await GET()).status).toBe(401);
  });
});

describe("PATCH /api/me/preferences", () => {
  it("自分の行だけを、渡した項目だけ書き換える", async () => {
    db.user.findUnique.mockResolvedValue({ theme: "washi", density: "large", layout: null });
    const res = await PATCH(req({ theme: "washi", density: "large" }));
    expect(res.status).toBe(200);
    expect(db.user.update).toHaveBeenCalledWith({ where: { id: ME }, data: { theme: "washi", density: "large" } });
    expect((await res.json()).data.effective).toEqual({ theme: "washi", density: "large", layout: "side" });
  });
  it("null = 会社の標準に戻す", async () => {
    await PATCH(req({ theme: null }));
    expect(db.user.update).toHaveBeenCalledWith({ where: { id: ME }, data: { theme: null } });
  });
  it.each([
    [{ theme: "purple" }],
    [{ density: "huge" }],
    [{ layout: "bottom" }],
    [{ theme: "navy", role: "admin" }],
    [{ theme: "navy", id: "someone-else" }],
    [{}],
  ])("選択肢以外・余計な項目・空は保存しない(422): %j", async (body) => {
    const res = await PATCH(req(body));
    expect(res.status).toBe(422);
    expect(db.user.update).not.toHaveBeenCalled();
  });
});
