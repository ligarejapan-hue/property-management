/**
 * 取込エラー行 CSV に「個人情報を含む CSV 出力」の既定ゲートを掛ける
 * （認可・PII 横断監査 2026-07-30）。
 *
 * 【背景】この CSV は rawData をそのまま列に展開するため**所有者の氏名・住所・電話が
 * 生で入る**のに、`import:write` だけで通り監査も無かった＝他の CSV 出力3経路が
 * 必須にしている関門（csv_export + csv_export_personal + 監査）を**唯一すり抜けて
 * いた**。以前の理由「詳細画面を見られる人は内容に到達できている」は、**画面上の
 * 閲覧と手元に残る CSV ファイルを同一視していた**点で誤り。
 *
 * 【発注者判断 2026-07-30】ゲートを足すだけだと**事務担当が落とせなくなる**ため、
 * 事務担当用テンプレートに csv_export_personal を付与する（seed + 本番向け migration）。
 * **この2つはセットで反映する**。
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

/** 現地担当（取込なし） */
const fieldPerms = [{ resource: "property", action: "read", granted: true }];
/** 修正前の事務担当（取込あり・個人情報CSVなし）= このPRで403になる組み合わせ */
const officeBefore = [
  { resource: "import", action: "write", granted: true },
  { resource: "csv_export", action: "read", granted: true },
];
/** 修正後の事務担当（テンプレに csv_export_personal を付与した後） */
const officeAfter = [...officeBefore, { resource: "csv_export_personal", action: "read", granted: true }];

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

  it("取込はあっても『個人情報を含むCSV出力』が無ければ 403", async () => {
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
      { resource: "import", action: "write", granted: true },
      { resource: "csv_export_personal", action: "read", granted: true },
    ]);
    const res = await GET(req(), params);
    expect(res.status).toBe(403);
  });

  it("3つ揃えば従来どおり CSV を返し、出力を監査に残す", async () => {
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
});

describe("事務担当への付与（ゲートとセットで反映する）", () => {
  const read = (p: string) =>
    readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

  it("seed の事務担当テンプレに csv_export_personal がある（2箇所とも）", () => {
    const seed = read("prisma/seed.ts");
    // 宣言側（permissions オブジェクト）
    expect(seed).toMatch(/csv_export_personal: \{ read: true \}/);
    // templateEntries 側（実際に行を作る方）
    expect(seed).toMatch(
      /officeStaffTemplate\.id, resource: "csv_export_personal", action: "read", granted: true/,
    );
  });

  it("本番へ届く経路（データ migration）がある", () => {
    // ⚠seed は本番反映手順で走らないため、migration が唯一の反映経路。
    const sql = read(
      "prisma/migrations/20260730230000_grant_csv_export_personal_to_office_staff/migration.sql",
    );
    expect(sql).toContain("INSERT INTO \"template_permissions\"");
    expect(sql).toContain("'csv_export_personal', 'read', true");
    expect(sql).toContain("pt.\"name\" = '事務担当用'");
    // 冪等（再実行しても増えない）
    expect(sql).toContain("ON CONFLICT");
    // DDL を含まない（additive・データのみ）
    expect(sql).not.toMatch(/ALTER TABLE|CREATE TABLE|DROP/i);
  });

  it("監査画面に日本語ラベルがある（生の識別子を出さない）", () => {
    expect(read("src/app/(dashboard)/admin/audit-logs/page.tsx")).toContain(
      'import_error_csv_export: "取込エラー行CSVエクスポート"',
    );
  });
});
