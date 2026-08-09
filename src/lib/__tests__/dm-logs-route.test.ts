/**
 * GET /api/properties/[id]/dm-logs（DM 送付履歴 表示・read-only）の統合テスト。
 *
 * B-3 PR-1: 既存 PropertyDmLog を read-only で返す。送付確定 write / 反響 / 再送 / migration は対象外。
 *  - 認可: property:read + owner:read（いずれか欠ければ 403・DB/監査の副作用なし）
 *  - PII: note は所有者備考と同じ表示レベル（owner_note → cfg.note）で server-side マスク
 *  - 送信者名(staff) / method / 日付は素表示（change-logs の changer.name と同方針）
 *  - 非PII の AuditLog（件数・閲覧時刻のみ。note 本文・送信者名・owner 由来キーは残さない）
 *
 * permissions（hasPermission / maskValue）は実物を使用し、403 ゲートと note マスクを実挙動で検証する。
 * prisma / api-helpers / audit は mock。型付き定数で no-explicit-any を増やさない。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type {
  ApiSession,
  PermissionEntry,
  OwnerDisplayConfig,
} from "@/lib/api-helpers";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
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
    getOwnerDisplayConfig: vi.fn(),
    apiResponse: vi.fn((data: unknown, status = 200) => Response.json(data, { status })),
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

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findUnique: vi.fn() },
    propertyDmLog: { findMany: vi.fn(), count: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { GET } from "../../app/api/properties/[id]/dm-logs/route";

const PROPERTY_ID = "11111111-1111-4111-8111-111111111111";

const pm = prisma as unknown as {
  property: { findUnique: Mock };
  propertyDmLog: { findMany: Mock; count: Mock };
};

const SESSION: ApiSession = {
  id: "user-admin",
  email: "a@a",
  name: "A",
  role: "admin",
};

const PERMS_FULL: PermissionEntry[] = [
  { resource: "property", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
];
const PERMS_NO_PROPERTY: PermissionEntry[] = [
  { resource: "owner", action: "read", granted: true },
];
const PERMS_NO_OWNER: PermissionEntry[] = [
  { resource: "property", action: "read", granted: true },
];

const FULL_DISPLAY: OwnerDisplayConfig = {
  name: "full",
  nameKana: "full",
  phone: "full",
  zip: "full",
  address: "full",
  note: "full",
  email: "full",
  corporateNumber: "full",
};

function makeLog(over: Record<string, unknown> = {}) {
  return {
    id: "log-1",
    sentAt: new Date("2026-06-01T00:00:00Z"),
    method: "郵送",
    note: null,
    createdAt: new Date("2026-06-01T01:00:00Z"),
    sender: { id: "user-staff", name: "担当 太郎" },
    ...over,
  };
}

function makeRequest(qs = "") {
  return new Request(
    `http://localhost/api/properties/${PROPERTY_ID}/dm-logs${qs}`,
    { method: "GET" },
  ) as unknown as import("next/server").NextRequest;
}

const makeParams = () => ({ params: Promise.resolve({ id: PROPERTY_ID }) });

function lastAudit() {
  return vi.mocked(writeAuditLog).mock.calls.at(-1)?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue(SESSION);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL);
  vi.mocked(getOwnerDisplayConfig).mockResolvedValue(FULL_DISPLAY);
  pm.property.findUnique.mockResolvedValue({
    id: PROPERTY_ID,
    createdBy: "user-admin",
    assignedTo: null,
  });
  pm.propertyDmLog.findMany.mockResolvedValue([]);
  pm.propertyDmLog.count.mockResolvedValue(0);
});

describe("GET /api/properties/[id]/dm-logs — 認可", () => {
  it("property:read 欠如で 403（findMany / audit 未実行）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_PROPERTY);
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(403);
    expect(pm.propertyDmLog.findMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("owner:read 欠如で 403（findMany / audit 未実行）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_OWNER);
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(403);
    expect(pm.propertyDmLog.findMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});

describe("GET /api/properties/[id]/dm-logs — record-scope（field_staff・物件詳細 API と同方針）", () => {
  it("物件が存在しない → 404（findMany / audit 未実行）", async () => {
    pm.property.findUnique.mockResolvedValue(null);
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(404);
    expect(pm.propertyDmLog.findMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("field_staff が担当外（createdBy / assignedTo 不一致）→ 403（findMany / audit 未実行）", async () => {
    vi.mocked(getApiSession).mockResolvedValue({
      ...SESSION,
      id: "fs1",
      role: "field_staff",
    });
    pm.property.findUnique.mockResolvedValue({
      id: PROPERTY_ID,
      createdBy: "other-user",
      assignedTo: "another-user",
    });
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(403);
    expect(pm.propertyDmLog.findMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("field_staff が担当（createdBy 一致）→ 200（取得・監査実行）", async () => {
    vi.mocked(getApiSession).mockResolvedValue({
      ...SESSION,
      id: "fs1",
      role: "field_staff",
    });
    pm.property.findUnique.mockResolvedValue({
      id: PROPERTY_ID,
      createdBy: "fs1",
      assignedTo: null,
    });
    pm.propertyDmLog.findMany.mockResolvedValue([makeLog()]);
    pm.propertyDmLog.count.mockResolvedValue(1);
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(200);
    expect(writeAuditLog).toHaveBeenCalled();
  });

  it("admin は record-scope に関係なく 200（別ユーザー作成物件でも可）", async () => {
    pm.property.findUnique.mockResolvedValue({
      id: PROPERTY_ID,
      createdBy: "someone-else",
      assignedTo: null,
    });
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(200);
  });
});

describe("GET /api/properties/[id]/dm-logs — 一覧 / 整形", () => {
  it("当該物件の送付履歴を新しい順で返す（where=propertyId, orderBy sentAt desc → createdAt desc）", async () => {
    pm.propertyDmLog.findMany.mockResolvedValue([
      makeLog({ id: "l1", method: "郵送", sender: { id: "u1", name: "担当 太郎" } }),
    ]);
    pm.propertyDmLog.count.mockResolvedValue(1);

    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].id).toBe("l1");
    expect(json.data[0].method).toBe("郵送");
    expect(json.data[0].sentBy).toEqual({ id: "u1", name: "担当 太郎" });
    expect(json.data[0].sentAt).toBe("2026-06-01"); // @db.Date は日付のみ文字列（TZ シフトなし）
    expect(json.pagination.total).toBe(1);

    const arg = pm.propertyDmLog.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ propertyId: PROPERTY_ID });
    expect(arg.orderBy).toEqual([{ sentAt: "desc" }, { createdAt: "desc" }]);
  });

  it("0 件でも 200・data 空・total 0（空でも返る）", async () => {
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual([]);
    expect(json.pagination.total).toBe(0);
  });

  it("page / limit が skip / take に反映され limit は 100 上限", async () => {
    await GET(makeRequest("?page=3&limit=10"), makeParams());
    const arg = pm.propertyDmLog.findMany.mock.calls[0][0];
    expect(arg.skip).toBe(20);
    expect(arg.take).toBe(10);

    vi.clearAllMocks();
    vi.mocked(getApiSession).mockResolvedValue(SESSION);
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL);
    vi.mocked(getOwnerDisplayConfig).mockResolvedValue(FULL_DISPLAY);
    pm.propertyDmLog.findMany.mockResolvedValue([]);
    pm.propertyDmLog.count.mockResolvedValue(0);
    await GET(makeRequest("?limit=9999"), makeParams());
    expect(pm.propertyDmLog.findMany.mock.calls[0][0].take).toBe(100);
  });
});

describe("GET /api/properties/[id]/dm-logs — 反響4項目(PR-B)", () => {
  it("reactionStatus/reactedAt/reactionSource を返す(reactedAt は YYYY-MM-DD)", async () => {
    pm.propertyDmLog.findMany.mockResolvedValue([
      makeLog({
        reactionStatus: "replied",
        reactedAt: new Date("2026-08-01T00:00:00Z"),
        reactionSource: "manual",
        reactionNote: null,
      }),
    ]);
    pm.propertyDmLog.count.mockResolvedValue(1);
    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();
    expect(json.data[0].reactionStatus).toBe("replied");
    expect(json.data[0].reactedAt).toBe("2026-08-01");
    expect(json.data[0].reactionSource).toBe("manual");
  });

  it("reactionNote は note と同じ表示レベルで server-side マスク(生値を返さない)", async () => {
    const RAW = "所有者から電話あり";
    vi.mocked(getOwnerDisplayConfig).mockResolvedValue({
      ...FULL_DISPLAY,
      note: "masked",
    });
    pm.propertyDmLog.findMany.mockResolvedValue([
      makeLog({
        reactionStatus: "replied",
        reactedAt: null,
        reactionSource: "manual",
        reactionNote: RAW,
      }),
    ]);
    pm.propertyDmLog.count.mockResolvedValue(1);
    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();
    expect(json.data[0].reactionNote).toBe("***" + RAW.slice(-4));
    expect(JSON.stringify(json)).not.toContain(RAW);
  });
});

describe("GET /api/properties/[id]/dm-logs — note の server-side マスク", () => {
  const RAW_NOTE = "田中花子様 同居の長男宛";

  it("note 表示レベル full → 生の note", async () => {
    pm.propertyDmLog.findMany.mockResolvedValue([makeLog({ note: RAW_NOTE })]);
    pm.propertyDmLog.count.mockResolvedValue(1);
    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();
    expect(json.data[0].note).toBe(RAW_NOTE);
  });

  it("note 表示レベル masked → 末尾4文字以外マスク（生 note を返さない）", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValue({
      ...FULL_DISPLAY,
      note: "masked",
    });
    pm.propertyDmLog.findMany.mockResolvedValue([makeLog({ note: RAW_NOTE })]);
    pm.propertyDmLog.count.mockResolvedValue(1);
    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();
    expect(json.data[0].note).toBe("***" + RAW_NOTE.slice(-4));
    expect(json.data[0].note).not.toBe(RAW_NOTE);
    expect(JSON.stringify(json)).not.toContain(RAW_NOTE);
  });

  it("note 表示レベル hidden → null（生 note を返さない）", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValue({
      ...FULL_DISPLAY,
      note: "hidden",
    });
    pm.propertyDmLog.findMany.mockResolvedValue([makeLog({ note: RAW_NOTE })]);
    pm.propertyDmLog.count.mockResolvedValue(1);
    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();
    expect(json.data[0].note).toBeNull();
    expect(JSON.stringify(json)).not.toContain(RAW_NOTE);
  });

  it("note が null なら null（マスク経由でも安全）", async () => {
    pm.propertyDmLog.findMany.mockResolvedValue([makeLog({ note: null })]);
    pm.propertyDmLog.count.mockResolvedValue(1);
    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();
    expect(json.data[0].note).toBeNull();
  });
});

describe("GET /api/properties/[id]/dm-logs — 非PII AuditLog", () => {
  it("action / targetTable / targetId と非PII detail を記録（note 本文・送信者名・owner キーを残さない）", async () => {
    const RAW_NOTE = "秘密メモ 鈴木一郎様";
    pm.propertyDmLog.findMany.mockResolvedValue([
      makeLog({ note: RAW_NOTE, sender: { id: "u9", name: "送信 花子" } }),
    ]);
    pm.propertyDmLog.count.mockResolvedValue(1);

    await GET(makeRequest(), makeParams());
    const audit = lastAudit();
    expect(audit?.action).toBe("property_dm_log_view");
    expect(audit?.targetTable).toBe("property_dm_logs");
    expect(audit?.targetId).toBe(PROPERTY_ID);
    const detail = audit?.detail as { count: number };
    const detailStr = JSON.stringify(detail);
    expect(detailStr).not.toContain(RAW_NOTE);
    expect(detailStr).not.toContain("送信 花子");
    for (const key of Object.keys(detail)) {
      expect(key.toLowerCase()).not.toContain("owner");
    }
    expect(typeof detail.count).toBe("number");
  });
});
