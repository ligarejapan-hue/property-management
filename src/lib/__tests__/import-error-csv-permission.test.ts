/**
 * 取込エラー行 CSV に「個人情報を含む CSV 出力」のゲートを掛ける
 * （認可・PII 横断監査 2026-07-30）。
 *
 * 【背景】この CSV は rawData をそのまま列に展開するため**所有者の氏名・住所・電話が
 * 生で入る**のに、`import:write` だけで通り監査も無かった＝他の CSV 出力3経路が
 * 必須にしている関門を**唯一すり抜けていた**。以前の理由「詳細画面を見られる人は
 * 内容に到達できている」は、**画面上の閲覧と手元に残る CSV ファイルを同一視していた**
 * 点で誤り。
 *
 * 【発注者判断 2026-07-30】ゲートを足すだけだと**事務担当が落とせなくなる**ため、
 * 事務担当用テンプレートに付与する（seed + 本番向け migration）。**この2つはセットで
 * 反映する**。
 *
 * 【⚠専用権限であること】付与するのは共有の `csv_export_personal` ではなく
 * **この CSV 専用の `import_error_csv`**。共有権限を配ると全物件CSV(所有者名入り)・
 * DM差込CSV・物件宛DM CSV まで一度に解禁される（事務担当は property:read /
 * owner:read / csv_export:read を既に持つ）。下の「専用権限であることの回帰ガード」が
 * この線引きを守る。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

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
    handleApiError: vi.fn((error: unknown) => {
      const e = error as { status?: number; message?: string; code?: string };
      if (e?.status) {
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
  };
});

vi.mock("@/lib/permissions", () => ({
  hasPermission: vi.fn(
    (
      perms: Array<{ resource: string; action: string; granted: boolean }>,
      resource: string,
      action: string,
    ) =>
      perms.find((p) => p.resource === resource && p.action === action)
        ?.granted ?? false,
  ),
}));

const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));

vi.mock("@/lib/prisma", () => ({
  default: {
    importJob: { findUnique: vi.fn() },
    importJobRow: { findMany: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { GET } from "@/app/api/import/jobs/[jobId]/export-errors/route";

const pm = prisma as unknown as {
  importJob: { findUnique: Mock };
  importJobRow: { findMany: Mock };
};
const JOB = "99999999-9999-4999-8999-999999999999";
const params = { params: Promise.resolve({ jobId: JOB }) };
const req = () =>
  new Request(`http://x/api/import/jobs/${JOB}/export-errors`) as never;

const p = (resource: string, action: string) => ({
  resource,
  action,
  granted: true,
});

/** 現地担当（取込なし） */
const fieldPerms = [p("property", "read")];
/** 修正前の事務担当（取込あり・個人情報の権限なし）= このPRで403になる組み合わせ */
const officeBefore = [p("import", "write"), p("csv_export", "read")];
/** 修正後の事務担当（テンプレに専用権限を付与した後） */
const officeAfter = [...officeBefore, p("import_error_csv", "read")];
/** 管理者（従来から共有権限を持つ）= OR 判定で従来どおり通ること */
const adminPerms = [...officeBefore, p("csv_export_personal", "read")];

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "office_staff" });
  pm.importJob.findUnique.mockResolvedValue({ id: JOB });
  pm.importJobRow.findMany.mockResolvedValue([
    {
      rowNumber: 1,
      status: "error",
      errorType: "x",
      errorMessage: "エラー",
      rawData: { 所有者名: "山田太郎", 住所: "東京都…", 電話: "03-0000-0000" },
    },
  ]);
});

describe("取込エラー行CSVの権限ゲート", () => {
  it("取込権限が無ければ 403（従来どおり）", async () => {
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const res = await GET(req(), params);
    expect(res.status).toBe(403);
    expect(pm.importJobRow.findMany).not.toHaveBeenCalled();
  });

  it("取込はあっても個人情報の権限が無ければ 403", async () => {
    // ⚠これが本PRの本体。氏名・住所・電話を含むファイルが手元に残るため、
    // 画面で見られることと同一視しない。
    (getUserPermissions as Mock).mockResolvedValue(officeBefore);
    const res = await GET(req(), params);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("個人情報");
    // 行を読む前に弾く（PII をメモリに載せない）
    expect(pm.importJobRow.findMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("CSV出力の権限そのものが無ければ 403", async () => {
    (getUserPermissions as Mock).mockResolvedValue([
      p("import", "write"),
      p("import_error_csv", "read"),
    ]);
    const res = await GET(req(), params);
    expect(res.status).toBe(403);
    expect(pm.importJobRow.findMany).not.toHaveBeenCalled();
  });

  it("専用権限が揃えば CSV を返し、出力を監査に残す", async () => {
    (getUserPermissions as Mock).mockResolvedValue(officeAfter);
    const res = await GET(req(), params);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const call = (writeAuditLog as Mock).mock.calls[0][0];
    expect(call.action).toBe("import_error_csv_export");
    expect(call.targetId).toBe(JOB);
    // ⚠監査 detail に PII を載せない（列名は所有者名の見出しになり得るので入れない）
    const serialized = JSON.stringify(call);
    expect(serialized).not.toMatch(/山田太郎|東京都|03-0000/);
    expect(serialized).not.toMatch(/所有者名|住所|電話/);
    expect(call.detail.rowCount).toBe(1);
  });

  it("既に共有権限を持つ管理者は従来どおり通る（この反映で失う権限は無い）", async () => {
    (getUserPermissions as Mock).mockResolvedValue(adminPerms);
    const res = await GET(req(), params);
    expect(res.status).toBe(200);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
  });
});

const read = (rel: string) =>
  readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

const MIGRATION =
  "prisma/migrations/20260730230000_grant_import_error_csv_to_office_staff/migration.sql";

describe("事務担当への付与（ゲートとセットで反映する）", () => {
  it("seed の事務担当テンプレに専用権限がある（宣言側と行生成側の2箇所とも）", () => {
    const seed = read("prisma/seed.ts");
    // 宣言側（permissions オブジェクト）: 事務担当ブロックだけを切り出して確認
    const officeBlock = seed.slice(
      seed.indexOf('name: "事務担当用"'),
      seed.indexOf('name: "管理者用"'),
    );
    expect(officeBlock).toMatch(/import_error_csv: \{ read: true \}/);
    // templateEntries 側（実際に行を作る方）
    expect(seed).toMatch(
      /officeStaffTemplate\.id, resource: "import_error_csv", action: "read", granted: true/,
    );
  });

  it("本番へ届く経路（データ migration）がある", () => {
    // ⚠seed は本番反映手順で走らないため、migration が唯一の反映経路。
    const sql = read(MIGRATION);
    expect(sql).toContain('INSERT INTO "template_permissions"');
    expect(sql).toContain("'import_error_csv', 'read', true");
    expect(sql).toContain("pt.\"name\" = '事務担当用'");
    // 冪等（再実行しても増えない）
    expect(sql).toContain("ON CONFLICT");
    // DDL を含まない（additive・データのみ）
    expect(sql).not.toMatch(/ALTER TABLE|CREATE TABLE|DROP/i);
  });

  it("権限画面2つに出る（片方だけだと付与できず必ず403になる）", () => {
    for (const page of [
      "src/app/(dashboard)/admin/templates/[id]/page.tsx",
      "src/app/(dashboard)/admin/users/[id]/permissions/page.tsx",
    ]) {
      expect(read(page)).toContain(
        '{ key: "import_error_csv", label: "取込エラー行CSV", actions: ["read"] }',
      );
    }
  });

  it("監査画面に日本語ラベルがある（生の識別子を出さない）", () => {
    expect(read("src/app/(dashboard)/admin/audit-logs/page.tsx")).toContain(
      'import_error_csv_export: "取込エラー行CSVエクスポート"',
    );
  });
});

describe("画面のダウンロードリンクを route のゲートに揃える", () => {
  // 揃っていないと、権限を外した利用者にリンクが出たまま＝押すたび 403 の
  // JSON 画面へ飛ぶ（権限画面から無効化できる今回の設計と UI が矛盾する）。
  const PAGE = "src/app/(dashboard)/import/jobs/[jobId]/page.tsx";

  it("リンクの表示条件に権限判定が入っている", () => {
    expect(read(PAGE)).toContain(
      "{canDownloadErrorCsv && (counts.error > 0 || counts.needs_review > 0) && (",
    );
  });

  it("表示条件は route と同じ権限の組み合わせで、取得中・失敗は非表示に倒す", () => {
    const src = read(PAGE);
    const block = src.slice(
      src.indexOf("const canDownloadErrorCsv"),
      src.indexOf("const [job, setJob]"),
    );
    expect(block).toContain('has("import", "write")');
    expect(block).toContain('has("csv_export", "read")');
    expect(block).toContain('has("import_error_csv", "read")');
    expect(block).toContain('has("csv_export_personal", "read")');
    // fail-safe（緩めない側に倒す）
    expect(block).toContain("if (permissionsLoading) return false;");
    expect(block).toContain("mePermissions ?? []");
  });
});

describe("専用権限であることの回帰ガード（全件CSVを解禁しない）", () => {
  // 事務担当は property:read / owner:read / csv_export:read を既に持つため、
  // 共有の csv_export_personal を配ると下記まで一度に解禁されてしまう。
  const BROAD_ROUTES = [
    "src/app/api/properties/export/route.ts",
    "src/app/api/properties/dm-export/route.ts",
    "src/app/api/properties/property-dm-export/route.ts",
  ];

  it("全件CSV3経路は共有権限 csv_export_personal のままである（緩めていない）", () => {
    for (const route of BROAD_ROUTES) {
      expect(read(route)).toMatch(
        /hasPermission\(\s*permissions,\s*"csv_export_personal",\s*"read"\s*\)/,
      );
      // 取込エラー行の専用権限で全件CSVが通ってはならない
      expect(read(route)).not.toContain("import_error_csv");
    }
  });

  it("事務担当テンプレに共有権限 csv_export_personal を付けていない", () => {
    const seed = read("prisma/seed.ts");
    const officeEntries = seed
      .split("\n")
      .filter((l) => l.includes("officeStaffTemplate.id"));
    expect(officeEntries.length).toBeGreaterThan(0);
    expect(
      officeEntries.filter((l) => l.includes("csv_export_personal")),
    ).toEqual([]);

    const officeBlock = seed.slice(
      seed.indexOf('name: "事務担当用"'),
      seed.indexOf('name: "管理者用"'),
    );
    expect(officeBlock).not.toMatch(/csv_export_personal: \{/);
  });

  it("migration も共有権限を配っていない", () => {
    expect(read(MIGRATION)).not.toContain("'csv_export_personal'");
  });
});
