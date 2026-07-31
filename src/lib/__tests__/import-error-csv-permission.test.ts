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
import { canDownloadImportErrorCsv } from "@/lib/import-error-csv-access";
import {
  sanitizeAuditDetail,
  REDACTED,
} from "@/lib/audit-log-detail-safety";
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

describe("画面のダウンロードリンクの表示判定（純関数として検証）", () => {
  // 揃っていないと、権限を外した利用者にリンクが出たまま＝押すたび 403 の
  // JSON 画面へ飛ぶ（権限画面から無効化できる今回の設計と UI が矛盾する）。
  const FRESH = { loading: false, refreshPending: false };
  const full = [
    p("import", "write"),
    p("csv_export", "read"),
    p("import_error_csv", "read"),
  ];

  it("専用権限が揃えば出す", () => {
    expect(canDownloadImportErrorCsv(full, FRESH)).toBe(true);
  });

  it("共有の個人情報CSV権限でも出す（route と同じ OR 判定）", () => {
    expect(
      canDownloadImportErrorCsv(
        [p("import", "write"), p("csv_export", "read"), p("csv_export_personal", "read")],
        FRESH,
      ),
    ).toBe(true);
  });

  it.each([
    ["import:write", "import"],
    ["csv_export:read", "csv_export"],
    ["個人情報側", "import_error_csv"],
  ])("%s を欠くと出さない", (_label, resource) => {
    const perms = full.filter((x) => x.resource !== resource);
    expect(canDownloadImportErrorCsv(perms, FRESH)).toBe(false);
  });

  it("granted:false は持っていない扱い", () => {
    const revoked = full.map((x) =>
      x.resource === "import_error_csv" ? { ...x, granted: false } : x,
    );
    expect(canDownloadImportErrorCsv(revoked, FRESH)).toBe(false);
  });

  // ⚠ここが本命。dashboard の layout は client navigation をまたいで保持されるため、
  // 別画面で権限を剥奪された後もこの画面へ遷移すると stale な granted が残り得る。
  // 進入時の再取得が終わるまでは「出さない」に倒すことで、一瞬でも押せる状態を作らない。
  it("権限が揃っていても、進入時の再取得が終わるまでは出さない（stale 対策）", () => {
    expect(
      canDownloadImportErrorCsv(full, { loading: false, refreshPending: true }),
    ).toBe(false);
  });

  it("provider が取得中は出さない", () => {
    expect(
      canDownloadImportErrorCsv(full, { loading: true, refreshPending: false }),
    ).toBe(false);
  });

  it("取得失敗（null）は権限なし扱いで出さない", () => {
    expect(canDownloadImportErrorCsv(null, FRESH)).toBe(false);
  });
});

describe("画面が判定関数と鮮度確認を正しく配線している", () => {
  const PAGE = "src/app/(dashboard)/import/jobs/[jobId]/page.tsx";

  it("リンクは判定結果で出し分ける", () => {
    expect(read(PAGE)).toContain(
      "{canDownloadErrorCsv && (counts.error > 0 || counts.needs_review > 0) && (",
    );
  });

  it("判定は共有の純関数を使い、独自実装を持たない", () => {
    const src = read(PAGE);
    expect(src).toContain(
      'import { canDownloadImportErrorCsv } from "@/lib/import-error-csv-access"',
    );
    expect(src).toContain("canDownloadImportErrorCsv(mePermissions, {");
    // 画面側に権限名を直書きした判定を残さない（route との二重管理を防ぐ）
    expect(src).not.toContain('has("csv_export_personal"');
  });

  it("進入時に権限を再取得し、その完了までは pending として扱う", () => {
    const src = read(PAGE);
    expect(src).toContain("refetchPermissions().finally(() => {");
    expect(src).toContain("setPermissionsRefreshPending(false);");
    expect(src).toContain("refreshPending: permissionsRefreshPending,");
    // provider 経由のみ（ページ独自の権限 fetch を増やさない）。
    // ⚠コメント本文にも同じパスが出てくるので、**実際の呼び出し形**で照合する。
    expect(src).not.toMatch(/fetch\(\s*["'`]\/api\/me\/permissions/);
  });
});

describe("監査 detail が管理画面で読めること", () => {
  // sanitizeAuditDetail は**許可リストに無いキーを既定で伏せる**ため、監査に
  // 残した件数も登録しないと管理画面では [REDACTED] になり、追加した意味が無くなる。
  const sanitize = (detail: Record<string, unknown>) =>
    sanitizeAuditDetail("import_error_csv_export", detail) as Record<
      string,
      unknown
    >;

  it("行数・列数・出力時刻は残る", () => {
    const out = sanitize({
      rowCount: 12,
      columnCount: 9,
      exportedAt: "2026-07-30T00:00:00.000Z",
    });
    expect(out.rowCount).toBe(12);
    expect(out.columnCount).toBe(9);
    expect(out.exportedAt).toBe("2026-07-30T00:00:00.000Z");
  });

  it("同じ action でも PII らしいキーは伏せる（許可は件数だけ）", () => {
    const out = sanitize({
      rowCount: 1,
      ownerName: "山田太郎",
      address: "東京都…",
      columnNames: ["所有者名"],
    });
    expect(out.rowCount).toBe(1);
    expect(out.ownerName).toBe(REDACTED);
    expect(out.address).toBe(REDACTED);
    expect(out.columnNames).toBe(REDACTED);
  });

  it("他の action では同じキーでも残さない（allowlist は action 限定）", () => {
    const out = sanitizeAuditDetail("some_other_action", {
      columnCount: 3,
    }) as Record<string, unknown>;
    expect(out.columnCount).toBe(REDACTED);
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

  it("取込エラー行の migration は専用権限だけを配る（役割を混ぜない）", () => {
    // 全件CSVの許可は別 migration に分ける＝どの判断でどこまで開いたかが追える。
    expect(read(MIGRATION)).not.toContain("'csv_export_personal'");
  });
});

describe("全件CSVの許可（発注者判断 2026-07-31）", () => {
  // ⚠**方針転換**。2026-07-30 時点は「取込エラー行だけ開ける」だったが、
  // 発注者判断で**全件CSVも事務担当に許可する**ことになった。
  // ここは「うっかり広がった」ではなく「意図して広げた」ことを固定する。
  const GRANT_MIGRATION =
    "prisma/migrations/20260731040000_grant_csv_export_personal_to_office_staff/migration.sql";

  it("seed の事務担当テンプレに共有権限がある（宣言側と行生成側の2箇所とも）", () => {
    const seed = read("prisma/seed.ts");
    const officeBlock = seed.slice(
      seed.indexOf('name: "事務担当用"'),
      seed.indexOf('name: "管理者用"'),
    );
    expect(officeBlock).toMatch(/csv_export_personal: \{ read: true \}/);
    expect(seed).toMatch(
      /officeStaffTemplate\.id, resource: "csv_export_personal", action: "read", granted: true/,
    );
  });

  it("本番へ届く経路（データ migration）がある", () => {
    const sql = read(GRANT_MIGRATION);
    expect(sql).toContain('INSERT INTO "template_permissions"');
    expect(sql).toContain("'csv_export_personal', 'read', true");
    expect(sql).toContain("pt.\"name\" = '事務担当用'");
    expect(sql).toContain("ON CONFLICT");
    expect(sql).not.toMatch(/ALTER TABLE|CREATE TABLE|DROP/i);
  });

  it("専用権限 import_error_csv は残す（より狭い付与のために要る）", () => {
    // 事務担当には冗長になるが、「取込エラー行だけ落とせる」付与（アルバイト等）に必要。
    const seed = read("prisma/seed.ts");
    expect(seed).toMatch(
      /officeStaffTemplate\.id, resource: "import_error_csv", action: "read", granted: true/,
    );
    // route 側の OR 判定も残っていること
    expect(
      read("src/app/api/import/jobs/[jobId]/export-errors/route.ts"),
    ).toContain('hasPermission(perms, "import_error_csv", "read")');
  });

  it("全件CSV3経路のゲート自体は緩めていない（権限を配っただけ）", () => {
    for (const route of [
      "src/app/api/properties/export/route.ts",
      "src/app/api/properties/dm-export/route.ts",
      "src/app/api/properties/property-dm-export/route.ts",
    ]) {
      const src = read(route);
      expect(src).toMatch(
        /hasPermission\(\s*permissions,\s*"csv_export",\s*"read"\s*\)/,
      );
      expect(src).toMatch(
        /hasPermission\(\s*permissions,\s*"csv_export_personal",\s*"read"\s*\)/,
      );
    }
  });
});
