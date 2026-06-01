/**
 * A-2a: 謄本PDF取込で「confirm 画面の編集結果が確定に反映される」ことと、
 *       parse API の _rawTextPreview 削除を、source-assertion で検証する。
 *
 * 既存の registry-pdf 系テスト（registry-pdf-page-*.test.ts 等）と同じ
 * source-assertion 方式に合わせる。挙動の回帰は既存 parse/import テスト＋
 * フルスイートでカバーする。
 *
 * Codex対応（部分編集）: applyEditedToParsed が edited.fields の「実際に送信された
 * キーだけ」を parsed に反映し、未送信キーは parser の元値を保持することを、
 * POST ハンドラ経由の挙動テストで検証する（parseRegistryText を mock してベース
 * 値を固定し、レスポンスの parsed を確認する）。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ── 挙動テスト用 mock（source-assertion テストには影響しない）──────────────
vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(input, init);
    }
  }
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
    getApiSession: vi.fn().mockResolvedValue({
      id: "user-1",
      email: "admin@test.com",
      name: "Admin",
      role: "admin",
    }),
    getUserPermissions: vi
      .fn()
      .mockResolvedValue([
        { resource: "import", action: "write", granted: true },
      ]),
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
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data, { status }),
    ),
  };
});

vi.mock("@/lib/permissions", () => ({
  hasPermission: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

vi.mock("@/lib/change-log", () => ({
  recordChanges: vi.fn(),
  PROPERTY_TRACKED_FIELDS: [],
}));

vi.mock("@/lib/pdf-registry-parser", () => ({
  parseRegistryText: vi.fn(),
}));

vi.mock("@/lib/pdf-extract", () => ({
  extractTextFromPdf: vi.fn(),
  isPdfBuffer: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findFirst: vi.fn(), create: vi.fn() },
    importJob: { create: vi.fn(), update: vi.fn() },
    importJobRow: { create: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { POST as REGISTRY_PDF_POST } from "../../app/api/import/registry-pdf/route";

const read = (p: string) =>
  fs.readFileSync(path.resolve(process.cwd(), p), "utf8");

const pageSrc = read("src/app/(dashboard)/import/registry-pdf/page.tsx");
const apiClientSrc = read("src/lib/api-client.ts");
// PR1: 取込コアは @/lib/registry-pdf/process へ移動したため、route.ts 単独ではなく
// route.ts + process.ts の連結に対して source-assertion を行う（実装の所在に依存しない）。
const routeSrc =
  read("src/app/api/import/registry-pdf/route.ts") +
  "\n" +
  read("src/lib/registry-pdf/process.ts");
const parseRouteSrc = read("src/app/api/import/registry-pdf/parse/route.ts");

// ── A-2a-1: 編集結果を確定APIへ送る ───────────────────────────────────────

describe("A-2a-1 (UI): confirm の編集 fields/owners を確定APIへ送る", () => {
  it("page.tsx が edited(fields + owners) を組み立てる", () => {
    expect(pageSrc).toMatch(/const edited = \{/);
    expect(pageSrc).toMatch(/realEstateNumber: fields\.realEstateNumber\.value/);
    expect(pageSrc).toMatch(/address: fields\.address\.value/);
    expect(pageSrc).toMatch(/landCategory: fields\.landCategory\.value/);
    expect(pageSrc).toMatch(/area: fields\.area\.value/);
    expect(pageSrc).toMatch(/owners: owners\.map\(/);
  });

  it("page.tsx が edited を file/text 両モードの確定APIに渡す", () => {
    expect(pageSrc).toMatch(/importRegistryPdfFile\([\s\S]*?edited,?\s*\)/);
    expect(pageSrc).toMatch(/importRegistryPdf\([\s\S]*?edited,?\s*\)/);
  });
});

describe("A-2a-1 (api-client): edited を JSON / FormData に積む", () => {
  it("importRegistryPdf が edited 引数を受け JSON body に含める", () => {
    expect(apiClientSrc).toMatch(
      /export async function importRegistryPdf\([\s\S]*?edited\?: unknown/,
    );
    expect(apiClientSrc).toMatch(
      /JSON\.stringify\(\{ text, propertyId, fileName, edited \}\)/,
    );
  });

  it("importRegistryPdfFile が edited 引数を受け FormData に積む", () => {
    expect(apiClientSrc).toMatch(
      /export async function importRegistryPdfFile\([\s\S]*?edited\?: unknown/,
    );
    expect(apiClientSrc).toMatch(
      /form\.append\("edited", JSON\.stringify\(edited\)\)/,
    );
  });
});

describe("A-2a-1 (server): 受領値を zod 検証し、再parseより優先", () => {
  it("editedImportSchema(zod) を定義し multipart で parse 検証する", () => {
    expect(routeSrc).toMatch(/const editedImportSchema = z\.object\(/);
    expect(routeSrc).toMatch(/editedImportSchema\.parse\(/);
  });

  it("JSON schema に edited を含める", () => {
    expect(routeSrc).toMatch(/edited: editedImportSchema\.optional\(\)/);
  });

  it("parse 結果に編集値をマージ（編集優先）してから下流で使う", () => {
    expect(routeSrc).toMatch(/function applyEditedToParsed/);
    expect(routeSrc).toMatch(
      /applyEditedToParsed\(parseRegistryText\(text\), edited\)/,
    );
  });

  it("owners は name 空を除外して反映する", () => {
    expect(routeSrc).toMatch(/\.filter\(\(o\) => o\.name\.length > 0\)/);
  });

  it("不正 JSON の edited は 400 で拒否する（multipart）", () => {
    expect(routeSrc).toMatch(/INVALID_EDITED/);
  });
});

// ── Codex対応: 地目 / 地積 も編集値を再parseより優先反映する ─────────────────

describe("A-2a-1 (Codex): landCategory / area も編集値を再parseより優先反映", () => {
  it("editedImportSchema.fields が landCategory / area を受け付ける", () => {
    expect(routeSrc).toMatch(/landCategory: z\.string\(\)\.nullish\(\)/);
    expect(routeSrc).toMatch(/area: z\.string\(\)\.nullish\(\)/);
  });

  it("applyEditedToParsed が landCategory を編集値（nz 正規化）で上書きする", () => {
    expect(routeSrc).toMatch(
      /parsed\.landCategory = nz\(edited\.fields\.landCategory\)/,
    );
  });

  it("applyEditedToParsed が area を編集値（nz 正規化）で上書きする", () => {
    expect(routeSrc).toMatch(/parsed\.area = nz\(edited\.fields\.area\)/);
  });
});

// ── PII / AuditLog 据置 ───────────────────────────────────────────────────

describe("A-2a-1 (PII): AuditLog に所有者名/住所/本文を増やさない", () => {
  it("route の writeAuditLog detail に rawText / 所有者名配列を入れない", () => {
    expect(routeSrc).not.toMatch(/rawText/);
    // AuditLog detail に owners 名や address を直接載せていないこと
    expect(routeSrc).not.toMatch(/detail:\s*\{[\s\S]*?ownerNames/);
  });
});

// ── A-2a-2: parse API の _rawTextPreview 削除 ─────────────────────────────

describe("A-2a-2: parse API レスポンスから _rawTextPreview を削除", () => {
  it("parse route に _rawTextPreview が存在しない", () => {
    expect(parseRouteSrc).not.toMatch(/_rawTextPreview/);
  });
});

// ── Codex対応（挙動）: 部分編集は送信キーだけ反映し未送信は parser値を保持 ──────
//
// edited.fields の各項目は optional。applyEditedToParsed は「実際に送信された
// キー」だけを parsed に反映し、未送信キーは parser の元値を維持しなければ
// ならない（未指定項目が undefined → null になり住所等を消す不具合の回帰防止）。
// parseRegistryText を mock してベース値を固定し、POST のレスポンス parsed を
// 確認する。propertyId を渡さない Mode B 経路で検証する。

type ParsedResult = ReturnType<typeof parseRegistryText>;

const pm = prisma as unknown as {
  property: { findFirst: Mock; create: Mock };
  importJob: { create: Mock; update: Mock };
  importJobRow: { create: Mock };
};

// parser が抽出した「元値」。全フィールド非 null で区別可能な値を入れておく。
const PARSER_BASE = (): ParsedResult => ({
  realEstateNumber: "REN-PARSER",
  address: "東京都千代田区一番町1",
  lotNumber: "1番1",
  buildingNumber: "家屋1番",
  landCategory: "宅地",
  area: "123.45",
  owners: [],
  confidence: 0.9,
  warnings: [],
});

function makeRequest(edited: unknown) {
  return new Request("http://localhost/api/import/registry-pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "dummy registry text", edited }),
  }) as unknown as import("next/server").NextRequest;
}

// edited を渡して POST を実行し、レスポンスにエコーされる merged parsed を返す。
async function postEdited(edited: unknown): Promise<ParsedResult> {
  vi.mocked(parseRegistryText).mockReturnValue(PARSER_BASE());
  const res = await REGISTRY_PDF_POST(makeRequest(edited));
  const body = await res.json();
  return body.parsed as ParsedResult;
}

describe("A-2a (Codex/挙動): 部分編集は送信キーだけ反映し未送信は parser値を保持", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pm.importJob.create.mockResolvedValue({ id: "job-1" });
    pm.importJob.update.mockResolvedValue({});
    pm.importJobRow.create.mockResolvedValue({});
    pm.property.findFirst.mockResolvedValue(null);
    pm.property.create.mockResolvedValue({ id: "prop-1" });
  });

  it("lotNumber だけ送ると lotNumber だけ編集値、他は parser値を保持する", async () => {
    const parsed = await postEdited({ fields: { lotNumber: "9番9" } });
    expect(parsed.lotNumber).toBe("9番9");
    // 未送信キーは parser の元値を保持（null に消されない）
    expect(parsed.realEstateNumber).toBe("REN-PARSER");
    expect(parsed.address).toBe("東京都千代田区一番町1");
    expect(parsed.buildingNumber).toBe("家屋1番");
    expect(parsed.landCategory).toBe("宅地");
    expect(parsed.area).toBe("123.45");
  });

  it("landCategory だけ送ると landCategory だけ編集値、他は parser値を保持する", async () => {
    const parsed = await postEdited({ fields: { landCategory: "田" } });
    expect(parsed.landCategory).toBe("田");
    expect(parsed.realEstateNumber).toBe("REN-PARSER");
    expect(parsed.address).toBe("東京都千代田区一番町1");
    expect(parsed.lotNumber).toBe("1番1");
    expect(parsed.buildingNumber).toBe("家屋1番");
    expect(parsed.area).toBe("123.45");
  });

  it("area だけ送ると area だけ編集値、他は parser値を保持する", async () => {
    const parsed = await postEdited({ fields: { area: "999.99" } });
    expect(parsed.area).toBe("999.99");
    expect(parsed.realEstateNumber).toBe("REN-PARSER");
    expect(parsed.address).toBe("東京都千代田区一番町1");
    expect(parsed.lotNumber).toBe("1番1");
    expect(parsed.buildingNumber).toBe("家屋1番");
    expect(parsed.landCategory).toBe("宅地");
  });

  it("空文字を明示送信したキーは null に上書きされ、未送信キーは保持される", async () => {
    const parsed = await postEdited({ fields: { address: "" } });
    expect(parsed.address).toBeNull();
    // 未送信キーは parser の元値を保持
    expect(parsed.realEstateNumber).toBe("REN-PARSER");
    expect(parsed.lotNumber).toBe("1番1");
    expect(parsed.buildingNumber).toBe("家屋1番");
    expect(parsed.landCategory).toBe("宅地");
    expect(parsed.area).toBe("123.45");
  });

  it("送信したキーは parser値より優先される（全 fields 送信時）", async () => {
    const parsed = await postEdited({
      fields: {
        realEstateNumber: "REN-EDIT",
        address: "東京都港区2",
        lotNumber: "2番2",
        buildingNumber: "家屋2番",
        landCategory: "畑",
        area: "1.00",
      },
    });
    expect(parsed.realEstateNumber).toBe("REN-EDIT");
    expect(parsed.address).toBe("東京都港区2");
    expect(parsed.lotNumber).toBe("2番2");
    expect(parsed.buildingNumber).toBe("家屋2番");
    expect(parsed.landCategory).toBe("畑");
    expect(parsed.area).toBe("1.00");
  });
});
