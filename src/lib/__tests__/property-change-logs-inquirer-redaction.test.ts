/**
 * GET /api/properties/[id]/change-logs — 問い合わせ者(個人情報)の値を伏せる(2026-10-24)。
 * 物件の変更履歴は property:read だけで読めるので、問い合わせ者の値は所有者の氏名と同じ扱いにする。
 * ⚠権限は本物(@/lib/permissions)で判定させる。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

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
  getOwnerDisplayConfig: vi.fn(),
  apiResponse: vi.fn((body: unknown, status = 200) => Response.json(body as object, { status })),
  handleApiError: vi.fn((e: { status?: number; message?: string; code?: string }) =>
    Response.json({ error: { message: e?.message, code: e?.code } }, { status: e?.status ?? 500 }),
  ),
}));
vi.mock("@/lib/prisma", () => ({
  default: {
    propertyOwner: { findMany: vi.fn() },
    property: { findUnique: vi.fn() },
    changeLog: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
  },
}));

import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { GET } from "@/app/api/properties/[id]/change-logs/route";

const PROPERTY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const req = new Request(`http://x/api/properties/${PROPERTY_ID}/change-logs`) as never;
const ctx = { params: Promise.resolve({ id: PROPERTY_ID }) };
const P = (resource: string, action: string) => ({ resource, action, granted: true });

const LOGS = [
  { id: "l1", targetTable: "properties", targetId: PROPERTY_ID, fieldName: "inquirerName", oldValue: "山田花子様", newValue: "佐藤一郎様" },
  { id: "l2", targetTable: "properties", targetId: PROPERTY_ID, fieldName: "note", oldValue: null, newValue: "メモ" },
  { id: "l3", targetTable: "properties", targetId: PROPERTY_ID, fieldName: "inquirerName", oldValue: null, newValue: "鈴木様" },
];

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getOwnerDisplayConfig as Mock).mockResolvedValue({ name: "full" });
  (prisma.changeLog.findMany as unknown as Mock).mockResolvedValue(LOGS);
  (prisma.changeLog.count as unknown as Mock).mockResolvedValue(LOGS.length);
  (prisma.changeLog.groupBy as unknown as Mock).mockResolvedValue([]);
  (prisma.propertyOwner.findMany as unknown as Mock).mockResolvedValue([]);
  (prisma.property.findUnique as unknown as Mock).mockResolvedValue({ id: PROPERTY_ID, buildingId: null, createdBy: "u1", assignedTo: null });
});

async function run() {
  const res = await GET(req, ctx);
  expect(res.status).toBe(200);
  return (await res.json()).data as Array<{ fieldName: string; oldValue: string | null; newValue: string | null }>;
}

describe("変更履歴の問い合わせ者", () => {
  it("owner:read なし → 値は「（非表示）」(空はそのまま)・他の欄はそのまま", async () => {
    (getUserPermissions as Mock).mockResolvedValue([P("property", "read")]);
    const data = await run();
    expect(data[0]).toMatchObject({ oldValue: "（非表示）", newValue: "（非表示）" });
    expect(data[1]).toMatchObject({ newValue: "メモ" });
    expect(data[2]).toMatchObject({ oldValue: null, newValue: "（非表示）" });
    expect(JSON.stringify(data)).not.toMatch(/山田|佐藤|鈴木/);
    expect(getOwnerDisplayConfig).not.toHaveBeenCalled();
  });

  it("owner:read あり・full → そのまま", async () => {
    (getUserPermissions as Mock).mockResolvedValue([P("property", "read"), P("owner", "read")]);
    const data = await run();
    expect(data[0]).toMatchObject({ oldValue: "山田花子様", newValue: "佐藤一郎様" });
  });

  it("owner:read あり・partial → 所有者の氏名と同じく伏せる", async () => {
    (getUserPermissions as Mock).mockResolvedValue([P("property", "read"), P("owner", "read")]);
    (getOwnerDisplayConfig as Mock).mockResolvedValue({ name: "partial" });
    const data = await run();
    expect(data[0]).toMatchObject({ oldValue: "山田花***", newValue: "佐藤一***" });
  });
});
