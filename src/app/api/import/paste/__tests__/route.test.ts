/**
 * 貼り付け取込 API の契約テスト。
 * vitest は env=node のため、route を直接 import して NextRequest を渡す。
 * 認証・Prisma は vi.mock で差し替える。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSession = { id: "user-1" };
// ⚠ granted: true が無いと hasPermission (src/lib/permissions.ts) は
//   常に false を返す(= 常に403)。リポジトリ内の他テストの慣例に合わせる。
let mockPerms: unknown = [{ resource: "property", action: "write", granted: true }];
const mockFindMany = vi.fn();

// ⚠api-helpers を vi.importActual すると実物の "@/lib/auth" まで読み込まれ、
//   next-auth 内部の拡張子なし "next/server" import が node の ESM 解決に失敗する
//   (corporate-number-mock-permissions.test.ts と同じ回避: @/lib/auth 自体も
//   mock してこの経路に入らせない)。
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

// リポジトリ内の route テスト全てが NextRequest をこの形で mock している
// (例: owner-archive-route.test.ts)ので同じ形にする。
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
  prisma: { property: { findMany: (...a: unknown[]) => mockFindMany(...a) } },
}));

import { POST } from "../route";
import { NextRequest } from "next/server";

const jsonReq = (body: unknown) =>
  new NextRequest("http://localhost/api/import/paste", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  mockPerms = [{ resource: "property", action: "write", granted: true }];
  mockFindMany.mockReset();
  mockFindMany.mockResolvedValue([]);
});

describe("POST /api/import/paste", () => {
  it("貼り付けたテキストから下書きを返す", async () => {
    const res = await POST(jsonReq({ text: "■物件所在地： 東京都A区B1-2-3（地番552-2）" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.draft.property.address.value).toBe("東京都A区B1-2-3");
    expect(body.draft.property.lotNumber.value).toBe("552-2");
  });

  it("★権限が無ければ403", async () => {
    mockPerms = [];
    const res = await POST(jsonReq({ text: "■物件所在地： 東京都A区B1-2-3" }));
    expect(res.status).toBe(403);
  });

  it("★文字数の上限を超えたら400（無言で切り詰めない）", async () => {
    const res = await POST(jsonReq({ text: "あ".repeat(200_001) }));
    expect(res.status).toBe(400);
    const body = await res.json();
    // ⚠実際の handleApiError(@/lib/api-helpers) は { error: { message, code } } を返す
    //   (registry-preflight-route.test.ts 等、既存の全 route テストと同じ形)。
    expect(body.error.message).toContain("長すぎ");
  });

  it("text が空なら400", async () => {
    const res = await POST(jsonReq({ text: "   " }));
    expect(res.status).toBe(400);
  });

  it("★同じ外部キーの物件があれば blocked で返す", async () => {
    mockFindMany.mockResolvedValue([
      { id: "p1", address: "別", lotNumber: null, externalLinkKey: "SA-1" },
    ]);
    const res = await POST(
      jsonReq({ text: "■査定ナンバー： SA-1\n■物件所在地： 東京都A区B1-2-3" }),
    );
    const body = await res.json();
    expect(body.duplicates.blocked).toBe(true);
    expect(body.duplicates.blockedByPropertyId).toBe("p1");
  });

  it("★下書きに貼った原文をそのまま含めない（PII を返しっぱなしにしない）", async () => {
    const res = await POST(
      jsonReq({ text: "■物件所在地： 東京都A区B1-2-3\n■電話番号： 09012345678\n■お名前： 山田太郎" }),
    );
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("rawText");
    // 所有者の欄には入るが、原文そのものは返さない
    expect(body.draft.owner.phone.value).toBe("09012345678");
  });
});
