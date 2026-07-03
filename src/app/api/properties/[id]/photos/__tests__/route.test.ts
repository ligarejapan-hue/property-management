import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// GET /photos の fileUrl 正規化（写真管理・計画④ @codex対応）を検証する。
// server backend の /{bucket}/{key} や絶対URLも /uploads/{key} へ揃える（エディタ受理条件）。

vi.mock("@/lib/api-helpers", () => ({
  ApiError: class extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  getApiSession: vi.fn(),
  getUserPermissions: vi.fn(),
  apiResponse: vi.fn((body: unknown, status = 200) => Response.json(body as object, { status })),
  handleApiError: vi.fn((e: { status?: number; message?: string; code?: string }) =>
    Response.json({ error: { message: e?.message, code: e?.code } }, { status: e?.status ?? 500 }),
  ),
}));
vi.mock("@/lib/permissions", () => ({ hasPermission: () => true }));
vi.mock("@/lib/property-access", () => ({ canAccessPropertyRecord: () => true }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/storage", () => ({
  // 疑似 keyFromUrl: /uploads/{key} と /{bucket}/{key}(=/property-management/) から key を抽出、
  // 外部URL(http…)は null。
  getStorage: () => ({
    keyFromUrl: (u: string | null) => {
      if (!u) return null;
      const m = u.match(/(?:\/uploads\/|\/property-management\/)(.+)$/);
      return m ? m[1] : null;
    },
  }),
  validateFile: vi.fn(),
  ALLOWED_PHOTO_MIMES: [],
}));
vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findUnique: vi.fn() },
    propertyPhoto: { findMany: vi.fn() },
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { GET } from "../route";

type PrismaMock = {
  property: { findUnique: Mock };
  propertyPhoto: { findMany: Mock };
};
const pm = prisma as unknown as PrismaMock;

const photo = (over: Record<string, unknown>) => ({
  id: "ph1",
  thumbnailUrl: null,
  fileName: "a.jpg",
  caption: null,
  sortOrder: 0,
  isPrimary: true,
  createdAt: new Date("2026-07-02T00:00:00Z"),
  photographer: null,
  ...over,
});

async function getData() {
  const res = await GET(
    { } as unknown as Parameters<typeof GET>[0],
    { params: Promise.resolve({ id: "p1" }) },
  );
  return ((await res.json()) as { data: { fileUrl: string; thumbnailUrl: string | null }[] }).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  pm.property.findUnique.mockResolvedValue({ id: "p1", createdBy: "u1", assignedTo: null });
});

describe("GET /api/properties/[id]/photos — fileUrl 正規化", () => {
  it("server backend の /{bucket}/{key} を /uploads/{key} に揃える", async () => {
    pm.propertyPhoto.findMany.mockResolvedValue([
      photo({ fileUrl: "/property-management/properties/p1/1.jpg" }),
    ]);
    const data = await getData();
    expect(data[0].fileUrl).toBe("/uploads/properties/p1/1.jpg");
  });

  it("local backend の /uploads/{key} は不変", async () => {
    pm.propertyPhoto.findMany.mockResolvedValue([
      photo({ fileUrl: "/uploads/properties/p1/1.jpg" }),
    ]);
    const data = await getData();
    expect(data[0].fileUrl).toBe("/uploads/properties/p1/1.jpg");
  });

  it("thumbnailUrl は /uploads/ へ proxy しない（PropertyPhoto authz が thumbnail key を逆引きせず 404 になるため・表示用正規化のまま）", async () => {
    pm.propertyPhoto.findMany.mockResolvedValue([
      photo({
        fileUrl: "/property-management/properties/p1/1.jpg",
        thumbnailUrl: "/property-management/properties/p1/thumb/1.jpg",
      }),
    ]);
    const data = await getData();
    expect(data[0].fileUrl).toBe("/uploads/properties/p1/1.jpg");
    expect(data[0].thumbnailUrl).not.toContain("/uploads/");
  });

  it("key 解決不能な外部URLは表示用正規化のままフォールバック（/uploads/化しない）", async () => {
    pm.propertyPhoto.findMany.mockResolvedValue([
      photo({ fileUrl: "https://cdn.example.com/x.jpg" }),
    ]);
    const data = await getData();
    expect(data[0].fileUrl).toBe("https://cdn.example.com/x.jpg");
  });
});
