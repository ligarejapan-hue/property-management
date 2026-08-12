/**
 * POST /api/registry-fetch/preflight(謄本取得前の警告材料)の統合テスト。
 * 発注者要望(2026-08-08): 取得済み/所有者入力済みの物件への取得(課金)前に警告を出す。
 *  - ゲート: registry:auto_fetch + property:read(単発/一括routeと同型・fail-closed)
 *  - 入力: propertyIds 1..50件・UUID必須(一括ジョブ作成と同じ検証)
 *  - 判定(サーバ一元化・非PII): registryObtained(登記状況=取得済) /
 *    hasRegistryAttachment(type=registry・未削除の添付あり) / hasOwners(所有者リンクあり)
 *  - field_staff のスコープ外物件は結果から除外(excluded 件数のみ)
 *  - 警告は情報提供のみ=取得をブロックしない(この API は読み取りのみ・副作用なし)
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

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
    parseJsonBody: vi.fn(async (req: Request) => req.json()),
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data as object, { status }),
    ),
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
  };
});

vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findMany: vi.fn() },
    attachment: { findMany: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { POST } from "../../app/api/registry-fetch/preflight/route";

const pm = prisma as unknown as {
  property: { findMany: Mock };
  attachment: { findMany: Mock };
};

const PERMS = [
  { resource: "registry", action: "auto_fetch", granted: true },
  { resource: "property", action: "read", granted: true },
];

const P1 = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const P2 = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/registry-fetch/preflight", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }) as unknown as import("next/server").NextRequest;
}

function makeProp(over: Record<string, unknown> = {}) {
  return {
    id: P1,
    createdBy: "user-admin",
    assignedTo: null,
    registryStatus: "unconfirmed",
    // ⚠住所は「入っている」を既定にする。分類は住所を番号より先に見るので、
    //   未設定にすると全部 no_address になって他の観点が確かめられない。
    address: "神奈川県横浜市南区井土ケ谷中町",
    _count: { propertyOwners: 0 },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue({
    id: "user-admin",
    role: "admin",
  } as never);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS as never);
  pm.property.findMany.mockResolvedValue([makeProp()]);
  pm.attachment.findMany.mockResolvedValue([]);
});

describe("POST /api/registry-fetch/preflight", () => {
  it("registry:auto_fetch 欠如は 403(fail-closed: DB未読)", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue([
      { resource: "property", action: "read", granted: true },
    ] as never);
    const res = await POST(makeRequest({ propertyIds: [P1] }));
    expect(res.status).toBe(403);
    expect(pm.property.findMany).not.toHaveBeenCalled();
  });

  it("0件/51件/非UUID は 400", async () => {
    expect((await POST(makeRequest({ propertyIds: [] }))).status).toBe(400);
    expect(
      (
        await POST(
          makeRequest({
            // 51件の相異なるID(同一IDは重複排除されるため)
            propertyIds: Array.from(
              { length: 51 },
              (_, i) => `aaaaaaaa-1111-4111-8111-${String(i).padStart(12, "0")}`,
            ),
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await POST(makeRequest({ propertyIds: ["not-a-uuid"] }))).status,
    ).toBe(400);
    expect(pm.property.findMany).not.toHaveBeenCalled();
  });

  it("3判定を返す: 取得済み/謄本添付あり/所有者あり(非PII・idとフラグのみ)", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        id: P1,
        registryStatus: "obtained",
        _count: { propertyOwners: 2 },
      }),
      makeProp({ id: P2 }),
    ]);
    pm.attachment.findMany.mockResolvedValue([{ targetId: P2 }]);
    const res = await POST(makeRequest({ propertyIds: [P1, P2] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<Record<string, unknown>>;
      excluded: number;
    };
    expect(body.data).toEqual([
      {
        propertyId: P1,
        registryObtained: true,
        hasRegistryAttachment: false,
        hasOwners: true,
        // ⚠「何を取りに行くか」は参考情報ではなく買う対象そのものなので必ず返す
        //   (画面はこれが読めるまで実行させない・設計 §3.1.1)。
        target: { kind: "none", mismatchWarning: null },
        // ⚠画面が「この内容で承認した」と言えるようにする digest
        //   (地番そのものではない)。一括の作成時に照合する。
        fingerprintHash: expect.stringMatching(/^[0-9a-f]{32}$/),
      },
      {
        propertyId: P2,
        registryObtained: false,
        hasRegistryAttachment: true,
        hasOwners: false,
        target: { kind: "none", mismatchWarning: null },
        fingerprintHash: expect.stringMatching(/^[0-9a-f]{32}$/),
      },
    ]);
    // 住所・所有者名などの PII を返さない
    expect(JSON.stringify(body)).not.toMatch(/address|name|zip/i);
    // 添付判定は registry type・未削除・物件宛のみ
    const attArg = pm.attachment.findMany.mock.calls[0][0];
    expect(attArg.where).toMatchObject({
      targetType: "property",
      type: "registry",
      isDeleted: false,
    });
  });

  it("field_staff のスコープ外物件は結果から除外し excluded に数える", async () => {
    vi.mocked(getApiSession).mockResolvedValue({
      id: "user-field",
      role: "field_staff",
    } as never);
    pm.property.findMany.mockResolvedValue([
      makeProp({ id: P1, createdBy: "user-field" }),
      makeProp({ id: P2, createdBy: "someone-else" }),
    ]);
    const res = await POST(makeRequest({ propertyIds: [P1, P2] }));
    const body = (await res.json()) as {
      data: Array<{ propertyId: string }>;
      excluded: number;
    };
    expect(body.data.map((d) => d.propertyId)).toEqual([P1]);
    expect(body.excluded).toBe(1);
  });

  it("書き込みを一切しない(読み取り専用API)", async () => {
    const res = await POST(makeRequest({ propertyIds: [P1] }));
    expect(res.status).toBe(200);
    // prisma mock に write メソッドを用意していない=呼べば TypeError で落ちる構造で担保
  });
});

describe("⚠何を取りに行くかを返す（設計 §3.1.1）", () => {
  it("番号を持つ物件は土地/建物の分類が返る", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        id: P1,
        propertyType: "land",
        lotNumber: "69-2",
        buildingNumber: null,
      }),
    ]);
    pm.attachment.findMany.mockResolvedValue([]);
    const res = await POST(makeRequest({ propertyIds: [P1] }));
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data[0].target).toEqual({ kind: "land", mismatchWarning: null });
  });

  it("種別と食い違えば警告文も返る（止めない）", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        id: P1,
        propertyType: "house",
        lotNumber: "69-2",
        buildingNumber: null,
      }),
    ]);
    pm.attachment.findMany.mockResolvedValue([]);
    const res = await POST(makeRequest({ propertyIds: [P1] }));
    const body = (await res.json()) as {
      data: Array<{ target: { kind: string; mismatchWarning: string | null } }>;
    };
    expect(body.data[0].target.kind).toBe("land");
    expect(body.data[0].target.mismatchWarning).toContain("家屋番号");
  });

  it("⚠地番の値そのものは返さない（秘匿）", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        id: P1,
        propertyType: "land",
        lotNumber: "69-2",
        buildingNumber: null,
      }),
    ]);
    pm.attachment.findMany.mockResolvedValue([]);
    const res = await POST(makeRequest({ propertyIds: [P1] }));
    const text = await res.text();
    expect(text).not.toContain("69-2");
  });
});

describe("⚠住所が無い物件は地番ではなく住所を求める（@codex #373 R4 P2）", () => {
  it("住所が空なら no_address", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({ id: P1, address: null, lotNumber: null, buildingNumber: null }),
    ]);
    pm.attachment.findMany.mockResolvedValue([]);
    const res = await POST(makeRequest({ propertyIds: [P1] }));
    const body = (await res.json()) as {
      data: Array<{ target: { kind: string } }>;
    };
    expect(body.data[0].target.kind).toBe("no_address");
  });

  it("⚠住所の値そのものは返さない（秘匿）", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({ id: P1, address: "秘密の住所1-2-3" }),
    ]);
    pm.attachment.findMany.mockResolvedValue([]);
    const res = await POST(makeRequest({ propertyIds: [P1] }));
    expect(await res.text()).not.toContain("秘密の住所");
  });
});
