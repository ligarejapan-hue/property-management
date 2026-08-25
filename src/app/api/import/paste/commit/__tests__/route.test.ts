import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSession = { id: "user-1" };
// ⚠granted: true が無いと hasPermission は全件 false を返す(このリポジトリの
//   テスト作法のハマりどころ)。brief の見本にこのキーが抜けていたので補った。
let mockPerms: unknown = [
  { resource: "property", action: "write", granted: true },
  { resource: "owner", action: "write", granted: true },
];
const created: Record<string, unknown[]> = {};
const auditCalls: unknown[] = [];
/** lockPropertyRow(→$queryRaw) と attachment.create の呼び出し順を記録する。 */
const callOrder: string[] = [];

// ⚠api-helpers を vi.importActual すると実物の "@/lib/auth" まで読み込まれ、
//   next-auth 内部の拡張子なし "next/server" import が node の ESM 解決に失敗する
//   (src/app/api/import/paste/__tests__/route.test.ts と同じ回避)。
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

// リポジトリ内の route テスト全てが NextRequest をこの形で mock している。
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
vi.mock("@/lib/audit", () => ({
  writeAuditLog: vi.fn(async (input: unknown) => { auditCalls.push(input); }),
}));
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    getStorage: vi.fn(() => ({
      upload: vi.fn(async () => ({
        url: "https://storage.local/properties/x/paste-import/x.pdf",
        key: "properties/x/paste-import/x.pdf",
      })),
      delete: vi.fn(async () => {}),
      getUrl: vi.fn(async () => ""),
      read: vi.fn(async () => null),
      keyFromUrl: vi.fn(() => null),
    })),
  };
});
vi.mock("@/lib/prisma", () => {
  const tx = {
    property: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        (created.property ??= []).push(data);
        return { id: "new-prop", ...(data as object) };
      }),
      findUnique: vi.fn(async () => ({ id: "new-prop" })),
    },
    owner: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        (created.owner ??= []).push(data);
        return { id: "new-owner", ...(data as object) };
      }),
      findFirst: vi.fn(async () => null),
    },
    propertyOwner: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        (created.propertyOwner ??= []).push(data);
        return { id: "po-1" };
      }),
    },
    attachment: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        callOrder.push("attachment.create");
        (created.attachment ??= []).push(data);
        return { id: "att-1", ...(data as object) };
      }),
    },
    $queryRaw: vi.fn(async (..._args: unknown[]) => {
      callOrder.push("lockPropertyRow");
      return [{ id: "new-prop" }];
    }),
  };
  return { prisma: { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)), ...tx } };
});

import { POST } from "../route";
import { NextRequest } from "next/server";

const req = (body: unknown) =>
  new NextRequest("http://localhost/api/import/paste/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** %PDF- マジックバイトを持つ最小限の PDF バイナリ。 */
function pdfFile(name = "shokai.pdf"): File {
  return new File([Buffer.from("%PDF-1.4\n%%EOF")], name, { type: "application/pdf" });
}

/** multipart/form-data で data(JSON文字列) + file(PDF) を送るリクエストを作る。 */
async function multipartReq(body: unknown, file: File | null): Promise<NextRequest> {
  const fd = new FormData();
  fd.append("data", JSON.stringify(body));
  if (file) fd.append("file", file);
  const blob = await new Response(fd).blob();
  return new NextRequest("http://localhost/api/import/paste/commit", {
    method: "POST",
    body: blob,
    headers: { "content-length": String(blob.size) },
  });
}

const baseBody = {
  property: {
    address: "東京都A区B1-2-3",
    lotNumber: "552-2",
    propertyType: "house",
    buildingName: null, roomNo: null, exclusiveArea: null,
    layoutType: null, occupancyStatus: null, note: "建物構造: 木造",
  },
  owner: null,
  externalLinkKey: null,
};

beforeEach(() => {
  // ⚠vi.fn() の呼び出し回数はテスト間で自動リセットされない(vitest.config.ts に
  //   clearMocks 設定なし)。「1つのトランザクションで作る」テストが他テストの
  //   累積呼び出しを拾って失敗するのを防ぐ(実装の実装をREADME通りにモックの実装
  //   自体はここでは消えない=clearAllMocksは呼び出し履歴だけを消す)。
  vi.clearAllMocks();
  mockPerms = [
    { resource: "property", action: "write", granted: true },
    { resource: "owner", action: "write", granted: true },
  ];
  for (const k of Object.keys(created)) delete created[k];
  auditCalls.length = 0;
  callOrder.length = 0;
});

describe("POST /api/import/paste/commit", () => {
  it("物件を作って id を返す", async () => {
    const res = await POST(req(baseBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.propertyId).toBe("new-prop");
    expect(created.property?.[0]).toMatchObject({
      address: "東京都A区B1-2-3",
      lotNumber: "552-2",
      propertyType: "house",
      introductionRoute: "web_inquiry",
      caseStatus: "new_case",
      createdBy: "user-1",
    });
  });

  it("★所有者の住所は currentAddress に入れる(登記上住所には入れない)", async () => {
    await POST(req({
      ...baseBody,
      owner: {
        name: "山田太郎", nameKana: "ヤマダタロウ",
        phone: "09000000000", email: "a@example.jp",
        currentAddress: "東京都A区B1-2-3",
      },
    }));
    expect(created.owner?.[0]).toMatchObject({
      name: "山田太郎",
      currentAddress: "東京都A区B1-2-3",
    });
    expect(created.owner?.[0]).not.toHaveProperty("address");
  });

  it("★物件の権限が無ければ403", async () => {
    mockPerms = [];
    const res = await POST(req(baseBody));
    expect(res.status).toBe(403);
  });

  it("★所有者を作るのに owner:write が無ければ403", async () => {
    mockPerms = [{ resource: "property", action: "write", granted: true }];
    const res = await POST(req({ ...baseBody, owner: { name: "山田太郎" } }));
    expect(res.status).toBe(403);
  });

  it("住所が無ければ400", async () => {
    const res = await POST(req({ ...baseBody, property: { ...baseBody.property, address: "" } }));
    expect(res.status).toBe(400);
  });

  it("★監査ログに氏名・電話・メール・住所を入れない", async () => {
    await POST(req({
      ...baseBody,
      owner: { name: "山田太郎", phone: "09000000000", email: "a@example.jp",
               currentAddress: "東京都A区B1-2-3", nameKana: null },
    }));
    const dumped = JSON.stringify(auditCalls);
    expect(dumped).not.toContain("山田太郎");
    expect(dumped).not.toContain("09000000000");
    expect(dumped).not.toContain("a@example.jp");
    expect(dumped).not.toContain("東京都A区B1-2-3");
    expect(dumped).toContain("new-prop");
  });

  it("★1つのトランザクションで作る", async () => {
    const { prisma } = await import("@/lib/prisma");
    await POST(req(baseBody));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  // ---- Step 4: PDF を投入した場合の添付作成 ----
  describe("PDFを投入した場合", () => {
    it("添付を作り、親の物件行ロックの後に作成する", async () => {
      const res = await POST(await multipartReq(baseBody, pdfFile("shokai.pdf")));
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(created.attachment?.[0]).toMatchObject({
        targetType: "property",
        targetId: body.propertyId,
        propertyId: body.propertyId,
        fileName: "shokai.pdf",
        mimeType: "application/pdf",
        uploadedBy: "user-1",
      });
      // 親行ロック(lockPropertyRow → $queryRaw)が attachment.create より先。
      const lockIdx = callOrder.indexOf("lockPropertyRow");
      const createIdx = callOrder.indexOf("attachment.create");
      expect(lockIdx).toBeGreaterThanOrEqual(0);
      expect(createIdx).toBeGreaterThan(lockIdx);
    });

    it("PDFが無ければ添付を作らない", async () => {
      await POST(req(baseBody));
      expect(created.attachment).toBeUndefined();
    });

    it("PDFではないファイルは400", async () => {
      const notPdf = new File([Buffer.from("not a pdf")], "x.txt", { type: "text/plain" });
      const res = await POST(await multipartReq(baseBody, notPdf));
      expect(res.status).toBe(400);
    });

    it("監査ログに添付があっても原文・PII は入らない", async () => {
      await POST(await multipartReq({
        ...baseBody,
        owner: { name: "山田太郎", phone: "09000000000", email: "a@example.jp",
                 currentAddress: "東京都A区B1-2-3", nameKana: null },
      }, pdfFile("shokai.pdf")));
      const dumped = JSON.stringify(auditCalls);
      expect(dumped).not.toContain("山田太郎");
      expect(dumped).not.toContain("shokai.pdf");
    });
  });
});
