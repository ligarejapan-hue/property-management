/**
 * GET /api/admin/display-name-audit（表示名監査レポート）の統合テスト。
 *
 * 確認項目（設計書 route test）:
 *  1. admin 認可必須（admin ガード=user_management:read なし → 403、DB を叩かない）
 *  2. 表示レベルゲート（owner:read 無し / name 表示レベルが生値未満 → owner 群は空・building は返る）
 *  3. ?format=csv の Content-Type と行展開（種別/正規化キー/表示名/件数/対象ID）
 *  4. 空結果 200（表記ゆれ 0 件でもエラーにしない）
 *  5. 監査ログに PII 本文（生 name）が出ない・action は display_name_audit_view のみ
 *  6. ?entity=owner|building の絞り込み・DB 書込なし（findMany のみ・select は id/name 最小）
 *
 * normalize / csv-encode / display-name-audit は実物を使用し、群化・CSV・ソートを実挙動で検証する。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response {}
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
    getOwnerDisplayConfig: vi.fn(),
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
    owner: { findMany: vi.fn() },
    building: { findMany: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
  type ApiSession,
  type PermissionEntry,
  type OwnerDisplayConfig,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { GET } from "../../app/api/admin/display-name-audit/route";

const pm = prisma as unknown as {
  owner: { findMany: Mock };
  building: { findMany: Mock };
};

const PERMS_ADMIN_OWNER: PermissionEntry[] = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
];
const PERMS_ADMIN_NO_OWNER: PermissionEntry[] = [
  { resource: "user_management", action: "read", granted: true },
];
const PERMS_NON_ADMIN: PermissionEntry[] = [
  { resource: "owner", action: "read", granted: true },
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

const ADMIN_SESSION: ApiSession = {
  id: "user-admin",
  email: "a@a",
  name: "A",
  role: "admin",
};

function makeRequest(qs = "") {
  return new Request(
    `http://localhost/api/admin/display-name-audit${qs}`,
    { method: "GET" },
  ) as unknown as import("next/server").NextRequest;
}

function lastAudit() {
  const call = vi.mocked(writeAuditLog).mock.calls.at(-1);
  if (!call) throw new Error("writeAuditLog was not called");
  return call[0];
}

// 同一キー2バリアントの owner / building データ。
const OWNER_VARIANTS = [
  { id: "o1", name: "田中 太郎" },
  { id: "o2", name: "田中太郎" },
];
const BUILDING_VARIANTS = [
  { id: "b1", name: "ABC マンション" },
  { id: "b2", name: "ABCマンション" },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue(ADMIN_SESSION);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_ADMIN_OWNER);
  vi.mocked(getOwnerDisplayConfig).mockResolvedValue(FULL_DISPLAY);
  pm.owner.findMany.mockResolvedValue([]);
  pm.building.findMany.mockResolvedValue([]);
});

describe("GET /api/admin/display-name-audit — 認可", () => {
  it("admin ガード（user_management:read）なしは 403・DB を叩かない", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NON_ADMIN);

    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    expect(pm.owner.findMany).not.toHaveBeenCalled();
    expect(pm.building.findMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("admin だが owner:read 無し → owner 群は空・building 群は返る", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_ADMIN_NO_OWNER);
    pm.owner.findMany.mockResolvedValue(OWNER_VARIANTS);
    pm.building.findMany.mockResolvedValue(BUILDING_VARIANTS);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.owner.groups).toEqual([]);
    expect(body.building.groups).toHaveLength(1);
    // owner:read 無しでは getOwnerDisplayConfig も呼ばない
    expect(getOwnerDisplayConfig).not.toHaveBeenCalled();
  });

  it("owner:read はあるが name 表示レベルが生値未満（masked）→ owner 群は空・building は返る", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValue({
      ...FULL_DISPLAY,
      name: "masked",
    });
    pm.owner.findMany.mockResolvedValue(OWNER_VARIANTS);
    pm.building.findMany.mockResolvedValue(BUILDING_VARIANTS);

    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.owner.groups).toEqual([]);
    expect(body.building.groups).toHaveLength(1);
  });

  it("name 表示レベルが read / edit でも owner 群は返る（生値レベル）", async () => {
    const rawLevels: OwnerDisplayConfig["name"][] = ["read", "edit", "full"];
    for (const level of rawLevels) {
      vi.clearAllMocks();
      vi.mocked(getApiSession).mockResolvedValue(ADMIN_SESSION);
      vi.mocked(getUserPermissions).mockResolvedValue(PERMS_ADMIN_OWNER);
      vi.mocked(getOwnerDisplayConfig).mockResolvedValue({
        ...FULL_DISPLAY,
        name: level,
      });
      pm.owner.findMany.mockResolvedValue(OWNER_VARIANTS);
      pm.building.findMany.mockResolvedValue([]);

      const res = await GET(makeRequest());
      const body = await res.json();
      expect(body.owner.groups, `level=${level}`).toHaveLength(1);
    }
  });
});

describe("GET /api/admin/display-name-audit — JSON 出力", () => {
  it("owner / building の両方の群を JSON で返す", async () => {
    pm.owner.findMany.mockResolvedValue(OWNER_VARIANTS);
    pm.building.findMany.mockResolvedValue(BUILDING_VARIANTS);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.owner.groups).toHaveLength(1);
    expect(body.owner.groups[0].key).toBe("田中太郎");
    expect(body.owner.truncated).toBe(false);
    expect(body.building.groups).toHaveLength(1);
    expect(body.building.groups[0].key).toBe("abcマンション");
  });

  it("?entity=owner なら owner のみ取得・building は取得しない", async () => {
    pm.owner.findMany.mockResolvedValue(OWNER_VARIANTS);

    const res = await GET(makeRequest("?entity=owner"));
    const body = await res.json();
    expect(body.owner.groups).toHaveLength(1);
    expect(body.building).toBeUndefined();
    expect(pm.building.findMany).not.toHaveBeenCalled();
  });

  it("?entity=building なら building のみ取得・owner は取得しない", async () => {
    pm.building.findMany.mockResolvedValue(BUILDING_VARIANTS);

    const res = await GET(makeRequest("?entity=building"));
    const body = await res.json();
    expect(body.building.groups).toHaveLength(1);
    expect(body.owner).toBeUndefined();
    expect(pm.owner.findMany).not.toHaveBeenCalled();
    // building のみなら owner 表示設定は不要
    expect(getOwnerDisplayConfig).not.toHaveBeenCalled();
  });

  it("表記ゆれ 0 件でも 200 で空群を返す（エラーにしない）", async () => {
    pm.owner.findMany.mockResolvedValue([{ id: "o1", name: "唯一の名前" }]);
    pm.building.findMany.mockResolvedValue([]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.owner.groups).toEqual([]);
    expect(body.building.groups).toEqual([]);
  });

  it("DB は findMany のみ・select は id/name 最小・isArchived:false", async () => {
    pm.owner.findMany.mockResolvedValue(OWNER_VARIANTS);
    pm.building.findMany.mockResolvedValue(BUILDING_VARIANTS);

    await GET(makeRequest());

    const ownerCall = pm.owner.findMany.mock.calls[0][0];
    expect(ownerCall.select).toEqual({ id: true, name: true });
    // Owner には isArchived があり、dedup と一貫して archived を除外する。
    expect(ownerCall.where.isArchived).toBe(false);
    const buildingCall = pm.building.findMany.mock.calls[0][0];
    expect(buildingCall.select).toEqual({ id: true, name: true });
    // Building には isArchived カラムが無いため、archived 条件は付けない。
    expect(buildingCall.where?.isArchived).toBeUndefined();
  });
});

describe("GET /api/admin/display-name-audit — CSV 出力", () => {
  it("?format=csv は text/csv・BOM・CRLF・ヘッダ行を返す", async () => {
    pm.owner.findMany.mockResolvedValue(OWNER_VARIANTS);
    pm.building.findMany.mockResolvedValue(BUILDING_VARIANTS);

    const res = await GET(makeRequest("?format=csv"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");

    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(buf.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf);
    expect(csv).toContain("\r\n");
    // ヘッダ列
    expect(csv).toContain("種別");
    expect(csv).toContain("正規化キー");
    expect(csv).toContain("表示名");
    expect(csv).toContain("件数");
    expect(csv).toContain("対象ID");
  });

  it("CSV はバリアント1行ずつに展開する（種別/キー/表示名/件数/対象ID）", async () => {
    pm.owner.findMany.mockResolvedValue([
      { id: "o1", name: "田中 太郎" },
      { id: "o2", name: "田中 太郎" },
      { id: "o3", name: "田中太郎" },
    ]);
    pm.building.findMany.mockResolvedValue([]);

    const res = await GET(makeRequest("?format=csv"));
    const csv = await res.text();
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    // ヘッダ + 2 バリアント行
    expect(lines).toHaveLength(3);
    expect(csv).toContain("所有者");
    expect(csv).toContain("田中 太郎");
    expect(csv).toContain("田中太郎");
    // 対象ID は ; 区切りなどで列挙される（生 name 行ごと）
    expect(csv).toContain("o1");
    expect(csv).toContain("o3");
  });

  it("CSV: 種別ラベルは所有者 / 建物で分かれる", async () => {
    pm.owner.findMany.mockResolvedValue(OWNER_VARIANTS);
    pm.building.findMany.mockResolvedValue(BUILDING_VARIANTS);

    const res = await GET(makeRequest("?format=csv"));
    const csv = await res.text();
    expect(csv).toContain("所有者");
    expect(csv).toContain("建物");
  });

  it("CSV: 表示名の formula injection 対策が効く（先頭 = に ' 付与）", async () => {
    pm.owner.findMany.mockResolvedValue([
      { id: "o1", name: "=cmd" },
      { id: "o2", name: "＝cmd" }, // 別バリアント（同一キーになるよう NFKC 後一致）
    ]);
    pm.building.findMany.mockResolvedValue([]);

    const res = await GET(makeRequest("?format=csv"));
    const csv = await res.text();
    expect(csv).toContain("'=cmd");
  });

  it("CSV: owner 群が表示レベル不足なら building のみ出力される", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValue({
      ...FULL_DISPLAY,
      name: "masked",
    });
    pm.owner.findMany.mockResolvedValue(OWNER_VARIANTS);
    pm.building.findMany.mockResolvedValue(BUILDING_VARIANTS);

    const res = await GET(makeRequest("?format=csv"));
    const csv = await res.text();
    // owner の生 name は出ない、building は出る
    expect(csv).not.toContain("田中");
    expect(csv).toContain("ABC");
  });
});

describe("GET /api/admin/display-name-audit — 監査ログ", () => {
  it("action は display_name_audit_view のみ・生 name（PII 本文）を残さない", async () => {
    pm.owner.findMany.mockResolvedValue(OWNER_VARIANTS);
    pm.building.findMany.mockResolvedValue(BUILDING_VARIANTS);

    await GET(makeRequest());

    const audit = lastAudit();
    expect(audit.action).toBe("display_name_audit_view");
    const detailStr = JSON.stringify(audit.detail ?? {});
    expect(detailStr).not.toContain("田中");
    expect(detailStr).not.toContain("太郎");
    // building 名（非PII）も本文は残さない方針
    expect(detailStr).not.toContain("マンション");
  });

  it("403（認可不足）時は監査ログを書かない", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NON_ADMIN);
    await GET(makeRequest());
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("CSV 出力時も監査ログを1回だけ書く", async () => {
    pm.owner.findMany.mockResolvedValue(OWNER_VARIANTS);
    pm.building.findMany.mockResolvedValue([]);
    await GET(makeRequest("?format=csv"));
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    expect(lastAudit().action).toBe("display_name_audit_view");
  });
});
