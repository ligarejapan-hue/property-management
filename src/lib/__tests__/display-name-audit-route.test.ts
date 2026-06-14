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

// 完全権限の admin: 監査閲覧(user_management) + owner 生値 + building(property) +
// PII CSV 出力(csv_export / csv_export_personal)。既存の正常系はこれを既定に置く。
const PERMS_ADMIN_OWNER: PermissionEntry[] = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "property", action: "read", granted: true },
  { resource: "csv_export", action: "read", granted: true },
  { resource: "csv_export_personal", action: "read", granted: true },
];
// admin だが owner:read 無し（building は property:read で見える）。
const PERMS_ADMIN_NO_OWNER: PermissionEntry[] = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "property", action: "read", granted: true },
  { resource: "csv_export", action: "read", granted: true },
  { resource: "csv_export_personal", action: "read", granted: true },
];
const PERMS_NON_ADMIN: PermissionEntry[] = [
  { resource: "owner", action: "read", granted: true },
];
// admin + owner だが property:read 無し（building 群は空になる）。
const PERMS_ADMIN_OWNER_NO_PROPERTY: PermissionEntry[] = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "csv_export", action: "read", granted: true },
  { resource: "csv_export_personal", action: "read", granted: true },
];
// admin + owner + property だが PII CSV 出力権限を欠く（CSV では owner を出さない）。
const PERMS_ADMIN_OWNER_NO_CSV: PermissionEntry[] = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "property", action: "read", granted: true },
];
const PERMS_ADMIN_OWNER_NO_CSV_PERSONAL: PermissionEntry[] = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "property", action: "read", granted: true },
  { resource: "csv_export", action: "read", granted: true },
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

  it("admin だが property:read 無し → building 群は空・owner 群は返る（fail-closed）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(
      PERMS_ADMIN_OWNER_NO_PROPERTY,
    );
    pm.owner.findMany.mockResolvedValue(OWNER_VARIANTS);
    pm.building.findMany.mockResolvedValue(BUILDING_VARIANTS);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.owner.groups).toHaveLength(1);
    expect(body.building.groups).toEqual([]);
    // property:read 無しでは building の DB も叩かない
    expect(pm.building.findMany).not.toHaveBeenCalled();
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

describe("GET /api/admin/display-name-audit — スキャン上限（DQ-01 と同型）", () => {
  // scan 上限の値。route の MAX_SCAN（10000）と一致させる。
  const MAX_SCAN = 10_000;

  // 「単一の正規化キーに大量の生バリアント」を作る（Codex P2 の主シナリオ）。
  // 群数は常に 1（MAX_GROUPS 上限には掛からない）が、行数=変動するので
  // 群数上限ではなく scan/row 上限の効果だけを切り分けて検証できる。
  // 半角/全角スペースの位置を 1 文字ずつずらして全件 distinct な生 name にする。
  function makeOneKeyManyVariants(count: number) {
    const rows: Array<{ id: string; name: string }> = [];
    for (let i = 0; i < count; i++) {
      // "山田" + 半角スペース i 個 + "太郎"。normalizeName は空白を畳むため
      // 正規化キーは全件同一（"山田太郎"）だが、生 name は全件別バリアント。
      rows.push({ id: `o${i}`, name: `山田${" ".repeat(i + 1)}太郎` });
    }
    return rows;
  }

  it("owner findMany は take: MAX_SCAN+1 で取得上限を設ける", async () => {
    pm.owner.findMany.mockResolvedValue(OWNER_VARIANTS);
    pm.building.findMany.mockResolvedValue([]);

    await GET(makeRequest("?entity=owner"));

    const ownerCall = pm.owner.findMany.mock.calls[0][0];
    expect(ownerCall.take).toBe(MAX_SCAN + 1);
  });

  it("building findMany も take: MAX_SCAN+1 で取得上限を設ける", async () => {
    pm.building.findMany.mockResolvedValue(BUILDING_VARIANTS);

    await GET(makeRequest("?entity=building"));

    const buildingCall = pm.building.findMany.mock.calls[0][0];
    expect(buildingCall.take).toBe(MAX_SCAN + 1);
  });

  it("owner scan が MAX_SCAN を超える（MAX_SCAN+1 件返る）と truncated:true・先頭 MAX_SCAN 件のみ集計", async () => {
    // DB が take 上限ぶん（MAX_SCAN+1）返した状況を模す。単一キー・全件 distinct。
    pm.owner.findMany.mockResolvedValue(makeOneKeyManyVariants(MAX_SCAN + 1));
    pm.building.findMany.mockResolvedValue([]);

    const res = await GET(makeRequest("?entity=owner"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.owner.truncated).toBe(true);
    // 群は単一キーゆえ常に1群。だが先頭 MAX_SCAN 件のみ集計＝バリアント数は MAX_SCAN。
    expect(body.owner.groups).toHaveLength(1);
    expect(body.owner.groups[0].variants).toHaveLength(MAX_SCAN);
    // 監査ログにも scan 切り捨てが反映される
    expect(lastAudit().detail).toMatchObject({ ownerTruncated: true });
  });

  it("building scan が MAX_SCAN を超えると truncated:true（silent 切り捨てしない）", async () => {
    pm.owner.findMany.mockResolvedValue([]);
    pm.building.findMany.mockResolvedValue(makeOneKeyManyVariants(MAX_SCAN + 1));

    const res = await GET(makeRequest("?entity=building"));
    const body = await res.json();
    expect(body.building.truncated).toBe(true);
    expect(lastAudit().detail).toMatchObject({ buildingTruncated: true });
  });

  it("scan が MAX_SCAN 以下なら truncated:false・従来どおり全件集計", async () => {
    // ちょうど MAX_SCAN 件（take 上限ぶん未満＝超過判定されない）。
    pm.owner.findMany.mockResolvedValue(makeOneKeyManyVariants(MAX_SCAN));
    pm.building.findMany.mockResolvedValue([]);

    const res = await GET(makeRequest("?entity=owner"));
    const body = await res.json();
    expect(body.owner.truncated).toBe(false);
    expect(body.owner.groups[0].variants).toHaveLength(MAX_SCAN);
  });

  it("CSV: owner scan 超過時も truncated を握りつぶさず・先頭 MAX_SCAN 件のみ展開する", async () => {
    pm.owner.findMany.mockResolvedValue(makeOneKeyManyVariants(MAX_SCAN + 1));
    pm.building.findMany.mockResolvedValue([]);

    const res = await GET(makeRequest("?format=csv&entity=owner"));
    expect(res.status).toBe(200);
    const csv = await res.text();
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    // ヘッダ1 + 先頭 MAX_SCAN 件のバリアント行（単一群・全件 distinct）= 1 + MAX_SCAN。
    // 超過分1件は scan 上限で捨てられるため 1 + (MAX_SCAN+1) にはならない。
    expect(lines).toHaveLength(1 + MAX_SCAN);
    expect(lastAudit().detail).toMatchObject({ ownerTruncated: true });
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

  it("CSV: csv_export:read 欠如なら 403（不正な CSV 出力を拒否・空 CSV を返さない）", async () => {
    // csv_export:read は CSV 出力という行為の一般ゲート。欠如時は entity を問わず
    // 403 で拒否する（既存 PII CSV 出力ルートと同じ fail-closed）。Codex 追加 P2 の是正。
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_ADMIN_OWNER_NO_CSV);
    pm.owner.findMany.mockResolvedValue(OWNER_VARIANTS);
    pm.building.findMany.mockResolvedValue(BUILDING_VARIANTS);

    const res = await GET(makeRequest("?format=csv"));
    expect(res.status).toBe(403);
    // DB 取得・CSV 生成・AuditLog 書き込みは一切行わない
    expect(pm.owner.findMany).not.toHaveBeenCalled();
    expect(pm.building.findMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("CSV: owner を含むのに csv_export_personal:read 欠如なら 403（空 owner CSV を返さない）", async () => {
    // owner（PII）を CSV に含む要求（entity=owner / 既定 all）で個人情報 CSV 権限が
    // 無い場合は 403 で拒否する（既存 PII CSV 出力ルートと同基準）。Codex 追加 P2 の是正。
    vi.mocked(getUserPermissions).mockResolvedValue(
      PERMS_ADMIN_OWNER_NO_CSV_PERSONAL,
    );
    pm.owner.findMany.mockResolvedValue(OWNER_VARIANTS);
    pm.building.findMany.mockResolvedValue(BUILDING_VARIANTS);

    const res = await GET(makeRequest("?format=csv"));
    expect(res.status).toBe(403);
    expect(pm.owner.findMany).not.toHaveBeenCalled();
    expect(pm.building.findMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("JSON では owner（PII）は CSV 権限に依らず owner:read + 表示レベルで返る", async () => {
    // CSV 出力権限が無くても JSON の owner 群は owner:read + 生値レベルで従来どおり返る。
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_ADMIN_OWNER_NO_CSV);
    pm.owner.findMany.mockResolvedValue(OWNER_VARIANTS);
    pm.building.findMany.mockResolvedValue([]);

    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.owner.groups).toHaveLength(1);
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

  // ---- Codex 追加 P2: CSV 出力は entity を問わず csv_export:read を一般ゲートとして要求する ----

  it("CSV building: csv_export:read 欠如なら 403（property:read のみでは不可）", async () => {
    // property:read はあるが csv_export:read が無い。建物は非PII でも
    // 「CSV 出力という行為」の一般ゲート（csv_export:read）を満たさないため 403 で拒否する。
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_ADMIN_OWNER_NO_CSV);
    pm.building.findMany.mockResolvedValue(BUILDING_VARIANTS);

    const res = await GET(makeRequest("?format=csv&entity=building"));
    expect(res.status).toBe(403);
    // 403 ゆえ building の DB も叩かない・AuditLog も書かない（fail-closed）
    expect(pm.building.findMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("CSV owner: csv_export_personal:read 欠如なら entity=owner も 403", async () => {
    // entity=owner（PII のみ）で個人情報 CSV 権限が無い場合も 403 で拒否する。
    vi.mocked(getUserPermissions).mockResolvedValue(
      PERMS_ADMIN_OWNER_NO_CSV_PERSONAL,
    );
    pm.owner.findMany.mockResolvedValue(OWNER_VARIANTS);

    const res = await GET(makeRequest("?format=csv&entity=owner"));
    expect(res.status).toBe(403);
    expect(pm.owner.findMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("CSV building: csv_export:read + property:read があれば building CSV を出力する", async () => {
    // csv_export:read はあるが personal は不要（building は非PII）。
    vi.mocked(getUserPermissions).mockResolvedValue(
      PERMS_ADMIN_OWNER_NO_CSV_PERSONAL,
    );
    pm.building.findMany.mockResolvedValue(BUILDING_VARIANTS);

    const res = await GET(makeRequest("?format=csv&entity=building"));
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).toContain("ABC");
    expect(csv).toContain("建物");
    expect(pm.building.findMany).toHaveBeenCalledTimes(1);
  });

  it("CSV building: csv_export:read はあるが property:read 無し → building は出さない", async () => {
    // CSV 出力権限はあるが、building データ読み取り権限（property:read）が無い。
    vi.mocked(getUserPermissions).mockResolvedValue([
      { resource: "user_management", action: "read", granted: true },
      { resource: "csv_export", action: "read", granted: true },
    ]);
    pm.building.findMany.mockResolvedValue(BUILDING_VARIANTS);

    const res = await GET(makeRequest("?format=csv&entity=building"));
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).not.toContain("ABC");
    expect(pm.building.findMany).not.toHaveBeenCalled();
  });

  it("CSV 両 entity: csv_export:read 欠如なら 403（owner も building も出さない）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_ADMIN_OWNER_NO_CSV);
    pm.owner.findMany.mockResolvedValue(OWNER_VARIANTS);
    pm.building.findMany.mockResolvedValue(BUILDING_VARIANTS);

    const res = await GET(makeRequest("?format=csv"));
    expect(res.status).toBe(403);
    expect(pm.owner.findMany).not.toHaveBeenCalled();
    expect(pm.building.findMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("JSON building: csv_export:read 非依存で property:read だけで building 群が返る（回帰維持）", async () => {
    // JSON 経路の building は従来どおり property:read のみで返る（CSV 権限に依らない）。
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_ADMIN_OWNER_NO_CSV);
    pm.building.findMany.mockResolvedValue(BUILDING_VARIANTS);

    const res = await GET(makeRequest("?entity=building"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.building.groups).toHaveLength(1);
    expect(pm.building.findMany).toHaveBeenCalledTimes(1);
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

  // ---- Codex 追加 P2（4巡目）: entity は正規化値のみ記録（生入力を残さない） ----

  it("未知の entity（PII/トークン風の生入力）は AuditLog.detail に残さず canonical(all) に畳む", async () => {
    pm.owner.findMany.mockResolvedValue(OWNER_VARIANTS);
    pm.building.findMany.mockResolvedValue(BUILDING_VARIANTS);

    // 任意の長い PII/秘密風文字列を entity として渡す（既存挙動では両方を返す＝all）。
    const secret = "山田花子-secret-token-0123456789abcdef-PII-leak-attempt";
    const res = await GET(
      makeRequest(`?entity=${encodeURIComponent(secret)}`),
    );
    expect(res.status).toBe(200);

    const detailStr = JSON.stringify(lastAudit().detail ?? {});
    // 生入力は一切 detail に入らない
    expect(detailStr).not.toContain("山田花子");
    expect(detailStr).not.toContain("secret-token");
    expect(detailStr).not.toContain("PII-leak");
    // canonical 値のみが記録される（未知値は両方＝all に畳む）
    expect(lastAudit().detail).toMatchObject({ entity: "all" });
  });

  it("entity=owner は canonical 'owner' を記録する", async () => {
    pm.owner.findMany.mockResolvedValue(OWNER_VARIANTS);
    await GET(makeRequest("?entity=owner"));
    expect(lastAudit().detail).toMatchObject({ entity: "owner" });
  });

  it("entity=building は canonical 'building' を記録する", async () => {
    pm.building.findMany.mockResolvedValue(BUILDING_VARIANTS);
    await GET(makeRequest("?entity=building"));
    expect(lastAudit().detail).toMatchObject({ entity: "building" });
  });

  it("entity 未指定（null）は canonical 'all' を記録する", async () => {
    pm.owner.findMany.mockResolvedValue(OWNER_VARIANTS);
    pm.building.findMany.mockResolvedValue(BUILDING_VARIANTS);
    await GET(makeRequest());
    expect(lastAudit().detail).toMatchObject({ entity: "all" });
  });
});
