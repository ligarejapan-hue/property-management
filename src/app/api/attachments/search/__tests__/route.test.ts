/**
 * GET /api/attachments/search — 添付横断検索（admin オーバーサイト・ISO-SAFE・schema 無改変）。
 *
 *  - 認可は **実効権限**で判定する：getUserPermissions(session.id)（DB 由来・テンプレート＋
 *    ユーザー個別オーバーライドを反映）+ hasPermission + getOwnerDisplayConfig。
 *    本検索は全添付のメタ（fileName・targetId 等、PII を含み得る）を横断露出するため:
 *      - 管理者能力 user_management:read
 *      - 添付が紐づくデータ read 権限 property:read・owner:read
 *      - ファイル名は自由テキストで任意の owner PII を含み得るため、**owner PII 全
 *        フィールド（name/kana/phone/zip/address/note/email/corporate_number）の実効
 *        可視性（edit/full/read）**
 *    をすべて要求する。いずれかを欠く/剥奪/マスクされた場合は 403（JWT role 非依存）。
 *  - 未認証は 401。
 *  - query: type / fileName(部分一致) / from・to(期間) / targetType・targetId。
 *  - 既定 isDeleted=false。
 *  - 返却はメタ（id/fileName/type/createdAt/targetType/targetId）のみ。
 *    **ファイル本体 URL(fileUrl)は select せず=結果に載せない**。
 *  - 非PII audit（検索語の生値は記録せず hasFileName 真偽のみ）。
 *
 * api-helpers / audit / prisma はモック。hasPermission は純関数のため実物を使う。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

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
    handleApiError: vi.fn((error: unknown) => {
      const e = error as { status?: number; message?: string; code?: string };
      if (typeof e?.status === "number") {
        return Response.json(
          { error: { message: e.message, code: e.code } },
          { status: e.status },
        );
      }
      return Response.json(
        { error: { message: "Server error", code: "INTERNAL_ERROR" } },
        { status: 500 },
      );
    }),
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data, { status }),
    ),
  };
});

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  default: { attachment: { findMany: vi.fn() } },
}));

import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
  ApiError,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { GET } from "../route";

const pm = prisma as unknown as { attachment: { findMany: Mock } };
const mockedGetSession = getApiSession as unknown as Mock;
const mockedGetPerms = getUserPermissions as unknown as Mock;
const mockedGetDisplay = getOwnerDisplayConfig as unknown as Mock;
const mockedAudit = writeAuditLog as unknown as Mock;

const UUID = "11111111-1111-4111-8111-111111111111";

// admin 能力 + データ read。owner PII の field-level 可視性は getOwnerDisplayConfig 側で表現。
const BASE_PERMS = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "property", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
];

// owner PII 全フィールドが可視（full）の表示設定。
const ALL_VISIBLE = {
  name: "full",
  nameKana: "full",
  phone: "full",
  zip: "full",
  address: "full",
  note: "full",
  email: "full",
  corporateNumber: "full",
} as const;

function req(qs = ""): Request {
  return new Request(`http://localhost/api/attachments/search${qs}`);
}

function lastWhere(): Record<string, unknown> {
  return (pm.attachment.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> })
    .where;
}

describe("GET /api/attachments/search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetSession.mockResolvedValue({
      id: "admin-1",
      email: "a@a",
      name: "Admin",
      role: "admin",
    });
    mockedGetPerms.mockResolvedValue(BASE_PERMS);
    mockedGetDisplay.mockResolvedValue({ ...ALL_VISIBLE });
    pm.attachment.findMany.mockResolvedValue([]);
  });

  it("未認証は 401", async () => {
    mockedGetSession.mockRejectedValueOnce(
      new ApiError(401, "認証が必要です", "UNAUTHORIZED"),
    );

    const res = await GET(req());

    expect(res.status).toBe(401);
    expect(pm.attachment.findMany).not.toHaveBeenCalled();
  });

  it("user_management:read が無ければ 403（DB&audit を呼ばない）", async () => {
    mockedGetPerms.mockResolvedValueOnce(
      BASE_PERMS.filter((p) => p.resource !== "user_management"),
    );

    const res = await GET(req());

    expect(res.status).toBe(403);
    expect(pm.attachment.findMany).not.toHaveBeenCalled();
    expect(mockedAudit).not.toHaveBeenCalled();
  });

  it("property:read が無ければ 403", async () => {
    mockedGetPerms.mockResolvedValueOnce(
      BASE_PERMS.filter((p) => p.resource !== "property"),
    );

    const res = await GET(req());

    expect(res.status).toBe(403);
    expect(pm.attachment.findMany).not.toHaveBeenCalled();
  });

  it("owner:read がオーバーライドで granted:false に剥奪されていれば 403", async () => {
    mockedGetPerms.mockResolvedValueOnce([
      { resource: "user_management", action: "read", granted: true },
      { resource: "property", action: "read", granted: true },
      { resource: "owner", action: "read", granted: false },
    ]);

    const res = await GET(req());

    expect(res.status).toBe(403);
    expect(pm.attachment.findMany).not.toHaveBeenCalled();
  });

  it("owner PII のうち phone が masked なら 403（ファイル名 PII 保護）", async () => {
    mockedGetDisplay.mockResolvedValueOnce({ ...ALL_VISIBLE, phone: "masked" });

    const res = await GET(req());

    expect(res.status).toBe(403);
    expect(pm.attachment.findMany).not.toHaveBeenCalled();
  });

  it("owner PII のうち email が hidden なら 403（name/address 以外も要求）", async () => {
    mockedGetDisplay.mockResolvedValueOnce({ ...ALL_VISIBLE, email: "hidden" });

    const res = await GET(req());

    expect(res.status).toBe(403);
    expect(pm.attachment.findMany).not.toHaveBeenCalled();
  });

  it("partial（部分マスク）は不可視扱いで 403", async () => {
    mockedGetDisplay.mockResolvedValueOnce({ ...ALL_VISIBLE, address: "partial" });

    const res = await GET(req());

    expect(res.status).toBe(403);
    expect(pm.attachment.findMany).not.toHaveBeenCalled();
  });

  it("認可は getUserPermissions(session.id) の実効権限で判定する", async () => {
    await GET(req());

    expect(mockedGetPerms).toHaveBeenCalledTimes(1);
    expect(mockedGetPerms.mock.calls[0][0]).toBe("admin-1");
  });

  it("必要権限が揃えば 200・メタのみ返す（fileUrl を select せず結果に載せない）", async () => {
    pm.attachment.findMany.mockResolvedValueOnce([
      {
        id: "att-1",
        fileName: "謄本.pdf",
        type: "registry",
        createdAt: new Date("2026-02-01T00:00:00Z"),
        targetType: "property",
        targetId: UUID,
      },
    ]);

    const res = await GET(req());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).not.toHaveProperty("fileUrl");

    const call = pm.attachment.findMany.mock.calls[0][0];
    expect(call.select).toEqual({
      id: true,
      fileName: true,
      type: true,
      // 謄本の表示名を組み立てる材料（owner|all の2値・非PII）。
      registryCertificateType: true,
      createdAt: true,
      targetType: true,
      targetId: true,
    });
    expect(call.select).not.toHaveProperty("fileUrl");
    expect(call).not.toHaveProperty("include");
    expect(call.orderBy).toEqual({ createdAt: "desc" });
    expect(typeof call.take).toBe("number");
    expect(call.take).toBeGreaterThan(0);
  });

  it("既定で isDeleted=false を where に含む", async () => {
    await GET(req());
    expect(lastWhere().isDeleted).toBe(false);
  });

  it("type / fileName / targetType / targetId / 期間 を where に反映", async () => {
    await GET(
      req(
        `?type=registry&fileName=foo&targetType=property&targetId=${UUID}&from=2026-01-01&to=2026-01-31`,
      ),
    );

    const where = lastWhere();
    expect(where.type).toBe("registry");
    // ファイル名は OR の1本目に入る（表示名での検索を上乗せするため）。
    const or = where.OR as Record<string, unknown>[];
    expect(or[0]).toEqual({ fileName: { contains: "foo", mode: "insensitive" } });
    expect(where.targetType).toBe("property");
    expect(where.targetId).toBe(UUID);
    const createdAt = where.createdAt as { gte: Date; lte: Date };
    expect(createdAt.gte).toBeInstanceOf(Date);
    expect(createdAt.lte).toBeInstanceOf(Date);
    expect(createdAt.lte.getTime()).toBeGreaterThan(createdAt.gte.getTime());
  });

  it("表示名と関係ない語のときは、生のファイル名の検索だけ（条件を増やさない）", async () => {
    await GET(req(`?fileName=世田谷区`));
    const or = lastWhere().OR as Record<string, unknown>[];
    expect(or).toHaveLength(1);
    expect(or[0]).toEqual({
      fileName: { contains: "世田谷区", mode: "insensitive" },
    });
  });

  it("「謄本」で探すと、昔の registry-auto- の行も拾えるよう条件を上乗せする", async () => {
    await GET(req(`?fileName=${encodeURIComponent("謄本")}`));
    const or = lastWhere().OR as Record<string, unknown>[];
    expect(or).toHaveLength(2);
    expect(or[1]).toEqual({
      type: "registry",
      registryCertificateType: { in: ["owner", "all"] },
    });
  });

  it("画面の名前をそのまま貼り付けると、種別と登録日で絞る", async () => {
    await GET(
      req(`?fileName=${encodeURIComponent("謄本(所有者事項)_2026-08-25.pdf")}`),
    );
    const or = lastWhere().OR as Record<string, unknown>[];
    expect(or).toHaveLength(2);
    const derived = or[1] as {
      type: string;
      registryCertificateType: { in: string[] };
      createdAt: { gte: Date; lt: Date };
    };
    expect(derived.type).toBe("registry");
    expect(derived.registryCertificateType).toEqual({ in: ["owner"] });
    // 日本時間の1日 = UTC の前日15時〜当日15時。
    expect(derived.createdAt.gte).toEqual(new Date("2026-08-24T15:00:00.000Z"));
    expect(derived.createdAt.lt).toEqual(new Date("2026-08-25T15:00:00.000Z"));
  });

  it("上乗せしても、他の絞り込み（対象・期間）は AND のまま", async () => {
    await GET(
      req(
        `?fileName=${encodeURIComponent("謄本")}&targetType=property&from=2026-01-01`,
      ),
    );
    const where = lastWhere();
    expect(where.targetType).toBe("property");
    expect(where.createdAt).toBeDefined();
    expect((where.OR as unknown[]).length).toBe(2);
  });

  it("非PII audit：action=attachment_search・検索語の生値は記録しない", async () => {
    await GET(req(`?fileName=zzsecretterm`));

    expect(mockedAudit).toHaveBeenCalledTimes(1);
    const arg = mockedAudit.mock.calls[0][0];
    expect(arg.action).toBe("attachment_search");
    expect(arg.userId).toBe("admin-1");
    expect(JSON.stringify(arg.detail)).not.toContain("zzsecretterm");
    expect(arg.detail.filters.hasFileName).toBe(true);
  });

  it("不正な query は 400（DB 検索を呼ばない）", async () => {
    const res = await GET(req(`?type=bogus`));

    expect(res.status).toBe(400);
    expect(pm.attachment.findMany).not.toHaveBeenCalled();
  });
});

describe("referral(反響資料) が一覧から見えなくならない（@codex PR#414 16巡目 ①）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetSession.mockResolvedValue({
      id: "admin-1",
      email: "a@a",
      name: "Admin",
      role: "admin",
    });
    mockedGetPerms.mockResolvedValue(BASE_PERMS);
    mockedGetDisplay.mockResolvedValue({ ...ALL_VISIBLE });
    pm.attachment.findMany.mockResolvedValue([]);
  });

  it("★種類フィルタ未指定なら where.type を立てない＝referral も一覧に出る", async () => {
    pm.attachment.findMany.mockResolvedValue([
      {
        id: "att-ref",
        fileName: "反響資料_2026-08-26.pdf",
        type: "referral",
        createdAt: new Date("2026-08-26T02:00:00Z"),
        targetType: "property",
        targetId: UUID,
      },
    ]);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(lastWhere()).not.toHaveProperty("type");
    const body = await res.json();
    expect(body.data.map((h: { type: string }) => h.type)).toEqual(["referral"]);
  });

  it("★種類フィルタで referral を選べる", async () => {
    const res = await GET(req("?type=referral"));
    expect(res.status).toBe(200);
    expect(lastWhere().type).toBe("referral");
  });

  it("既存の general / registry フィルタは変わらない", async () => {
    await GET(req("?type=general"));
    expect(lastWhere().type).toBe("general");
    vi.clearAllMocks();
    pm.attachment.findMany.mockResolvedValue([]);
    await GET(req("?type=registry"));
    expect(lastWhere().type).toBe("registry");
  });

  it("知らない種類は従来どおり 400", async () => {
    const res = await GET(req("?type=unknown-kind"));
    expect(res.status).toBe(400);
  });
});
