/**
 * GET /api/admin/owners/name-quality-candidates のルートテスト（DQ-01）。
 *
 * 検証観点:
 * - 認可（user_management:read / owner:read の 403）
 * - type フィルタ（all は info を除外 / numeric_only / mostly_digits）
 * - archived 除外（where: isArchived false）
 * - PII マスキング（name / nameKana）
 * - summary 集計
 * - blockReasons / recommendedAction
 * - AuditLog detail に氏名生値が含まれない
 * - cursor / limit ページング
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

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
    getApiSession: vi.fn().mockResolvedValue({ id: "user-1", role: "admin" }),
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
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data, { status }),
    ),
  };
});

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  default: {
    owner: { findMany: vi.fn() },
    changeLog: { findMany: vi.fn() },
    importJobRow: { findMany: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { GET } from "../../app/api/admin/owners/name-quality-candidates/route";

const pm = prisma as unknown as {
  owner: { findMany: Mock };
  changeLog: { findMany: Mock };
  importJobRow: { findMany: Mock };
};

const PERMS_FULL = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
];

const DISPLAY_FULL = {
  name: "full" as const,
  nameKana: "full" as const,
  phone: "full" as const,
  zip: "full" as const,
  address: "full" as const,
  note: "full" as const,
  email: "full" as const,
  corporateNumber: "full" as const,
};

function owner(
  over: Partial<{
    id: string;
    name: string;
    nameKana: string | null;
    note: string | null;
    corporateNumber: string | null;
    externalLinkKey: string | null;
    version: number;
    propertyOwners: number;
  }> = {},
) {
  return {
    id: over.id ?? "o-1",
    name: over.name ?? "44225",
    nameKana: over.nameKana ?? null,
    note: over.note ?? null,
    corporateNumber: over.corporateNumber ?? null,
    externalLinkKey: over.externalLinkKey ?? null,
    version: over.version ?? 1,
    _count: { propertyOwners: over.propertyOwners ?? 0 },
  };
}

function url(query = "") {
  return new Request(
    `http://localhost/api/admin/owners/name-quality-candidates${query}`,
  ) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL);
  vi.mocked(getOwnerDisplayConfig).mockResolvedValue(DISPLAY_FULL);
  pm.owner.findMany.mockResolvedValue([]);
  pm.changeLog.findMany.mockResolvedValue([]);
  pm.importJobRow.findMany.mockResolvedValue([]);
});

describe("認可", () => {
  it("user_management:read 無しで 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce([
      { resource: "owner", action: "read", granted: true },
    ]);
    expect((await GET(url())).status).toBe(403);
  });

  it("owner:read 無しで 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce([
      { resource: "user_management", action: "read", granted: true },
    ]);
    expect((await GET(url())).status).toBe(403);
  });
});

describe("分類とフィルタ", () => {
  beforeEach(() => {
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: "44225" }), // numeric_only
      owner({ id: "o-2", name: "---" }), // symbol_only
      owner({ id: "o-3", name: "302山" }), // mostly_digits (info)
      owner({ id: "o-4", name: "山田太郎" }), // 問題なし
    ]);
  });

  it("type=all は error/warning のみ（info の mostly_digits を除外）", async () => {
    const res = await GET(url());
    const json = await res.json();
    const ids = json.candidates.map((c: { ownerId: string }) => c.ownerId).sort();
    expect(ids).toEqual(["o-1", "o-2"]);
  });

  it("type=numeric_only で numeric のみ", async () => {
    const res = await GET(url("?type=numeric_only"));
    const json = await res.json();
    expect(json.candidates).toHaveLength(1);
    expect(json.candidates[0].ownerId).toBe("o-1");
    expect(json.candidates[0].issues).toContain("numeric_only");
  });

  it("type=mostly_digits で info も明示表示できる", async () => {
    const res = await GET(url("?type=mostly_digits"));
    const json = await res.json();
    expect(json.candidates.map((c: { ownerId: string }) => c.ownerId)).toEqual(["o-3"]);
  });

  it("summary は全 owner ベース", async () => {
    const res = await GET(url());
    const json = await res.json();
    expect(json.summary.numericOnly).toBe(1);
    expect(json.summary.symbolOnly).toBe(1);
    expect(json.summary.mostlyDigits).toBe(1);
    expect(json.summary.totalCandidates).toBe(3);
  });

  it("問題なし owner は候補に出ない", async () => {
    const res = await GET(url());
    const json = await res.json();
    expect(
      json.candidates.find((c: { ownerId: string }) => c.ownerId === "o-4"),
    ).toBeUndefined();
  });
});

describe("archived 除外", () => {
  it("findMany の where は isArchived:false", async () => {
    await GET(url());
    const arg = pm.owner.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ isArchived: false });
  });
});

describe("blockReasons / recommendedAction", () => {
  it("safeguard（紐づきあり）は hold", async () => {
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: "44225", propertyOwners: 2 }),
    ]);
    const res = await GET(url("?type=numeric_only"));
    const json = await res.json();
    expect(json.candidates[0].blockReasons).toContain("property_owner_exists");
    expect(json.candidates[0].recommendedAction).toBe("hold");
  });

  it("制御文字のみ・safeguard なしは sanitize_candidate", async () => {
    const controlName = "山田太郎".slice(0, 2) + String.fromCharCode(1) + "太郎";
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: controlName }),
    ]);
    pm.importJobRow.findMany.mockResolvedValue([
      { createdId: "o-1", status: "success" },
    ]);
    const res = await GET(url("?type=control_chars"));
    const json = await res.json();
    expect(json.candidates[0].recommendedAction).toBe("sanitize_candidate");
  });

  it("数値ゴミ・safeguard なしは review", async () => {
    pm.owner.findMany.mockResolvedValue([owner({ id: "o-1", name: "44225" })]);
    pm.importJobRow.findMany.mockResolvedValue([
      { createdId: "o-1", status: "success" },
    ]);
    const res = await GET(url("?type=numeric_only"));
    const json = await res.json();
    expect(json.candidates[0].recommendedAction).toBe("review");
  });
});

// Issue1: 複数 ImportJobRow を持つ owner は取込元が一意に特定できない
// （= correction-candidates の import_source_ambiguous 相当）。success 行が
// 紛れていても自動補正の根拠にできないため、blockReasons に
// import_source_ambiguous を付け、sanitize_candidate へ昇格させない。
describe("複数 ImportJobRow の曖昧性（import_source_ambiguous）", () => {
  it("import 行が 2 件以上なら success があっても import_source_ambiguous を付ける", async () => {
    const controlName = "山田" + String.fromCharCode(1) + "太郎";
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: controlName }),
    ]);
    // success と failed が混在（旧実装は success を採用してブロックしなかった）。
    pm.importJobRow.findMany.mockResolvedValue([
      { createdId: "o-1", status: "failed" },
      { createdId: "o-1", status: "success" },
    ]);
    const res = await GET(url("?type=control_chars"));
    const json = await res.json();
    expect(json.candidates[0].blockReasons).toContain("import_source_ambiguous");
    // 取込元が曖昧なので import_source_unknown は付けない（排他）。
    expect(json.candidates[0].blockReasons).not.toContain("import_source_unknown");
  });

  it("曖昧な取込元の owner は sanitize_candidate に昇格せず review に倒す", async () => {
    // 単一 success なら sanitize_candidate になる制御文字混入ケースで検証。
    const controlName = "山田" + String.fromCharCode(1) + "太郎";
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: controlName }),
    ]);
    pm.importJobRow.findMany.mockResolvedValue([
      { createdId: "o-1", status: "success" },
      { createdId: "o-1", status: "success" },
    ]);
    const res = await GET(url("?type=control_chars"));
    const json = await res.json();
    expect(json.candidates[0].recommendedAction).toBe("review");
    expect(json.candidates[0].recommendedAction).not.toBe("sanitize_candidate");
  });

  it("単一 ImportJobRow は従来通り曖昧フラグを付けない", async () => {
    const controlName = "山田" + String.fromCharCode(1) + "太郎";
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: controlName }),
    ]);
    pm.importJobRow.findMany.mockResolvedValue([
      { createdId: "o-1", status: "success" },
    ]);
    const res = await GET(url("?type=control_chars"));
    const json = await res.json();
    expect(json.candidates[0].blockReasons).not.toContain(
      "import_source_ambiguous",
    );
    expect(json.candidates[0].recommendedAction).toBe("sanitize_candidate");
  });
});

// Codex P2: 自動補正（sanitize_candidate）の安全網は「success な owner_csv 取込行が
// 存在する」ことが前提。取込行が無い（import_source_unknown）／単一だが非 success
// （import_row_not_success）の owner は、たとえ name が sanitize 可能でも昇格させず
// review に倒す（import_source_ambiguous と整合）。
describe("success 取込行を sanitize 昇格の前提にする（import_row_not_success / import_source_unknown）", () => {
  const controlName = "山田" + String.fromCharCode(1) + "太郎"; // sanitize 可能

  it("success な単一取込行があれば sanitize_candidate に昇格できる", async () => {
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: controlName }),
    ]);
    pm.importJobRow.findMany.mockResolvedValue([
      { createdId: "o-1", status: "success" },
    ]);
    const res = await GET(url("?type=control_chars"));
    const json = await res.json();
    expect(json.candidates[0].recommendedAction).toBe("sanitize_candidate");
  });

  it("取込行が無い（import_source_unknown）owner は sanitize 可能でも review", async () => {
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: controlName }),
    ]);
    pm.importJobRow.findMany.mockResolvedValue([]); // owner_csv 取込行なし
    const res = await GET(url("?type=control_chars"));
    const json = await res.json();
    expect(json.candidates[0].blockReasons).toContain("import_source_unknown");
    expect(json.candidates[0].recommendedAction).toBe("review");
    expect(json.candidates[0].recommendedAction).not.toBe("sanitize_candidate");
  });

  it("単一だが非 success の取込行（import_row_not_success）owner は review に倒す", async () => {
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: controlName }),
    ]);
    pm.importJobRow.findMany.mockResolvedValue([
      { createdId: "o-1", status: "failed" },
    ]);
    const res = await GET(url("?type=control_chars"));
    const json = await res.json();
    expect(json.candidates[0].blockReasons).toContain("import_row_not_success");
    expect(json.candidates[0].recommendedAction).toBe("review");
    expect(json.candidates[0].recommendedAction).not.toBe("sanitize_candidate");
  });
});

describe("PII マスキング", () => {
  it("nameKana は display-level に従ってマスクされる（name 可視で行がマッチ）", async () => {
    // name は可視（full）で numeric_only マッチ → 行が出る。nameKana は masked。
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      nameKana: "masked",
    });
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: "44225", nameKana: "ヤマダタロウ" }),
    ]);
    const res = await GET(url("?type=numeric_only"));
    const json = await res.json();
    expect(json.candidates).toHaveLength(1);
    expect(json.candidates[0].nameKanaMasked).not.toBe("ヤマダタロウ");
  });

  it("name が masked のとき name 由来候補は出ない（P1 でマスク漏洩経路を遮断）", async () => {
    // 以前は masked でも候補を出し maskValue でマスクしていたが、P1 で
    // 不可視フィールドは分類自体をスキップする（候補に出さない）方針へ変更。
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      name: "masked",
    });
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: "山123456" }),
    ]);
    const res = await GET(url("?type=mostly_digits"));
    const json = await res.json();
    expect(json.candidates).toHaveLength(0);
  });
});

describe("可視性ゲート（P1: 不可視フィールドを分類しない）", () => {
  it("name が masked のユーザーには name 由来の候補/issue/summary を出さない", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      name: "masked",
    });
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: "44225" }), // numeric_only（name 由来）
      owner({ id: "o-2", name: "---" }), // symbol_only（name 由来）
    ]);
    const res = await GET(url());
    const json = await res.json();
    // name 不可視 → name 由来 issue は分類されず候補ゼロ
    expect(json.candidates).toHaveLength(0);
    expect(json.summary.numericOnly).toBe(0);
    expect(json.summary.symbolOnly).toBe(0);
    expect(json.summary.totalCandidates).toBe(0);
  });

  it("name が hidden でも type= を変えて隠し PII を推測できない（全 type で件数 0）", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValue({
      ...DISPLAY_FULL,
      name: "hidden",
    });
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: "44225" }),
      owner({ id: "o-2", name: "山" + String.fromCharCode(1) + "田" }),
    ]);
    for (const t of ["numeric_only", "symbol_only", "control_chars", "all"]) {
      const res = await GET(url(`?type=${t}`));
      const json = await res.json();
      expect(json.candidates).toHaveLength(0);
    }
  });

  it("name 不可視・nameKana 可視なら kana 由来候補のみ出る（name 由来は出ない）", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      name: "masked",
    });
    pm.owner.findMany.mockResolvedValue([
      // numeric_only(name 由来) は出ない / kana_non_kana(kana 由来) は出る
      owner({ id: "o-1", name: "44225", nameKana: "やまだABC" }),
    ]);
    pm.importJobRow.findMany.mockResolvedValue([
      { createdId: "o-1", status: "success" },
    ]);
    const res = await GET(url("?type=kana_non_kana"));
    const json = await res.json();
    expect(json.candidates).toHaveLength(1);
    expect(json.candidates[0].kanaIssues).toContain("kana_non_kana");
    expect(json.candidates[0].issues).not.toContain("numeric_only");
  });

  it("name 不可視・kana のみマッチの行は sanitize_candidate を出さない（review）", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      name: "masked",
    });
    // name 自体は制御文字混入（=本来 sanitize 可能）だが name 不可視。
    const controlName = "山田" + String.fromCharCode(1) + "太郎";
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: controlName, nameKana: "やまだABC" }),
    ]);
    pm.importJobRow.findMany.mockResolvedValue([
      { createdId: "o-1", status: "success" },
    ]);
    const res = await GET(url("?type=kana_non_kana"));
    const json = await res.json();
    expect(json.candidates).toHaveLength(1);
    // 隠し name の自動補正可否を漏らさない
    expect(json.candidates[0].recommendedAction).not.toBe("sanitize_candidate");
    expect(json.candidates[0].recommendedAction).toBe("review");
  });

  it("partial レベルも生値非可視として分類しない", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      name: "partial",
    });
    pm.owner.findMany.mockResolvedValue([owner({ id: "o-1", name: "44225" })]);
    const res = await GET(url());
    const json = await res.json();
    expect(json.candidates).toHaveLength(0);
    expect(json.summary.numericOnly).toBe(0);
  });
});

describe("可視性ゲート（P2: 隠し法人番号を分類に渡さない）", () => {
  // too_long 緩和は corporateNumber の有無で 60→100 に変わる。owner_corporate_number が
  // 不可視のユーザーには corporateNumber を classify に渡さない（隠し法人番号の有無を
  // too_long の出現差で推測させない）。name は可視前提（生値長で分類は成立する）。
  const longName = "あ".repeat(61); // 60 超 100 以下

  it("corporateNumber が masked のとき too_long 緩和を効かせない（候補に出る）", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      corporateNumber: "masked",
    });
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: longName, corporateNumber: "1234567890123" }),
    ]);
    const res = await GET(url("?type=too_long"));
    const json = await res.json();
    // corporateNumber 不可視 → 緩和なし → 既定上限 60 超で too_long
    expect(json.candidates).toHaveLength(1);
    expect(json.candidates[0].issues).toContain("too_long");
    expect(json.summary.tooLong).toBe(1);
  });

  it("corporateNumber が full のときは緩和が効き too_long を出さない（従来通り）", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      corporateNumber: "full",
    });
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: longName, corporateNumber: "1234567890123" }),
    ]);
    const res = await GET(url("?type=too_long"));
    const json = await res.json();
    expect(json.candidates).toHaveLength(0);
    expect(json.summary.tooLong).toBe(0);
  });

  it("corporateNumber 不可視でも全 type で隠し法人番号は推測不能（緩和差が出ない=候補内容は法人番号非依存）", async () => {
    // corporateNumber を hidden に固定。法人番号あり owner / なし owner の
    // too_long 判定が同一（どちらも 60 超で too_long）になることを確認。
    vi.mocked(getOwnerDisplayConfig).mockResolvedValue({
      ...DISPLAY_FULL,
      corporateNumber: "hidden",
    });
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: longName, corporateNumber: "1234567890123" }),
      owner({ id: "o-2", name: longName, corporateNumber: null }),
    ]);
    const res = await GET(url("?type=too_long"));
    const json = await res.json();
    const ids = json.candidates.map((c: { ownerId: string }) => c.ownerId).sort();
    expect(ids).toEqual(["o-1", "o-2"]);
  });
});

describe("AuditLog PII 漏洩防止", () => {
  it("detail に氏名生値が含まれず type/summary のみ", async () => {
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: "44225" }),
    ]);
    await GET(url("?type=numeric_only"));
    const call = vi.mocked(writeAuditLog).mock.calls[0][0];
    expect(call.action).toBe("owner_name_quality_candidates_list");
    const detailJson = JSON.stringify(call.detail);
    expect(detailJson).not.toContain("44225");
    expect(call.detail).toHaveProperty("summary");
    expect(call.detail).toHaveProperty("resultCount");
  });
});

describe("ページング", () => {
  beforeEach(() => {
    // cursor は DB の where:{id:{gt:cursor}} で適用されるため、mock も尊重する。
    const fixtures = Array.from({ length: 5 }, (_, i) =>
      owner({ id: `o-${i}`, name: `${1000 + i}` }),
    );
    pm.owner.findMany.mockImplementation(
      (args: { where?: { id?: { gt?: string } }; take?: number }) => {
        const gt = args?.where?.id?.gt ?? null;
        const rows = gt ? fixtures.filter((o) => o.id > gt) : fixtures;
        return Promise.resolve(rows.slice(0, args?.take ?? rows.length));
      },
    );
  });

  it("limit=2 で 2 件 + hasNextPage", async () => {
    const res = await GET(url("?type=numeric_only&limit=2"));
    const json = await res.json();
    expect(json.candidates).toHaveLength(2);
    expect(json.hasNextPage).toBe(true);
    expect(json.nextCursor).toBe(json.candidates[1].ownerId);
  });

  it("cursor で続きを取得", async () => {
    const res1 = await GET(url("?type=numeric_only&limit=2"));
    const json1 = await res1.json();
    const res2 = await GET(url(`?type=numeric_only&limit=2&cursor=${json1.nextCursor}`));
    const json2 = await res2.json();
    expect(json2.candidates[0].ownerId > json1.nextCursor).toBe(true);
  });

  it("cursor は DB クエリの where に id.gt として渡る（先頭固定スキャンにしない）", async () => {
    await GET(url("?type=numeric_only&limit=2&cursor=o-1"));
    const arg = pm.owner.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ isArchived: false, id: { gt: "o-1" } });
  });

  it("cursor 無しのときは where に id 条件を付けない", async () => {
    await GET(url("?type=numeric_only&limit=2"));
    const arg = pm.owner.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ isArchived: false });
  });
});

// MAX_SCAN(10k) 超のデータでもページングが取りこぼさないことを検証する。
// 10k 件をモックするのは非現実的なので、route 内部の MAX_SCAN を一時的に
// 小さく上書きできない以上、ここでは「window が truncated かつページ内で
// matchedRows を使い切ったとき、hasNextPage=true・nextCursor が
// 最後にスキャンした owner の id まで前進する」契約を検証する。
//
// この契約により、次リクエストは where:{id:{gt:nextCursor}} で
// スキャン窓の続きへ進めるため、10k 超の owner も到達可能になる。
describe("scan cap 超のページング前進（取りこぼし防止）", () => {
  // route の MAX_SCAN は 10_000。テストで擬似的に超過させるため、
  // findMany が take 件数ぶん返すよう動的生成する（cursor を尊重）。
  function generateOwners(cursorId: string | null, total: number, take: number) {
    // total 件の連番 owner（id は 0 埋め6桁で昇順安定）からスキャンを再現。
    const all = Array.from({ length: total }, (_, i) => {
      const idx = i;
      return owner({
        id: `o-${String(idx).padStart(6, "0")}`,
        // 末尾に向けてのみ numeric_only ゴミを置く（窓内で matched が枯渇する状況を作る）
        name: idx >= total - 1 ? `${1000 + idx}` : `山田太郎`,
      });
    });
    const startIdx = cursorId
      ? all.findIndex((o) => o.id > cursorId)
      : 0;
    const from = startIdx < 0 ? all.length : startIdx;
    return all.slice(from, from + take);
  }

  it("truncated 窓で matched 枯渇 → hasNextPage=true かつ nextCursor は最後にスキャンした id へ前進", async () => {
    // 総数 = MAX_SCAN + 5。最初の窓 = 先頭 10_000 件（take=10_001 で truncated 検知）。
    // 先頭 10_000 件はすべて「山田太郎」(問題なし) で matched 0 件。
    const TOTAL = 10_005;
    pm.owner.findMany.mockImplementation((args: { where?: { id?: { gt?: string } }; take?: number }) => {
      const cursorId = args?.where?.id?.gt ?? null;
      return Promise.resolve(generateOwners(cursorId, TOTAL, args?.take ?? 10_001));
    });

    const res = await GET(url("?type=numeric_only&limit=2"));
    const json = await res.json();

    // 先頭窓には numeric ゴミが無いので candidates は空。
    expect(json.candidates).toHaveLength(0);
    // しかし truncated（窓の先にまだ owner がいる）なので前進しなければならない。
    expect(json.truncated).toBe(true);
    expect(json.hasNextPage).toBe(true);
    // nextCursor は最後にスキャンした owner の id（= 窓の末尾）まで前進する。
    expect(json.nextCursor).toBe(`o-${String(9999).padStart(6, "0")}`);
  });

  it("前進した cursor で次窓を取得すると scan cap 超の候補へ到達できる", async () => {
    const TOTAL = 10_005;
    pm.owner.findMany.mockImplementation((args: { where?: { id?: { gt?: string } }; take?: number }) => {
      const cursorId = args?.where?.id?.gt ?? null;
      return Promise.resolve(generateOwners(cursorId, TOTAL, args?.take ?? 10_001));
    });

    const res1 = await GET(url("?type=numeric_only&limit=2"));
    const json1 = await res1.json();
    const res2 = await GET(
      url(`?type=numeric_only&limit=2&cursor=${json1.nextCursor}`),
    );
    const json2 = await res2.json();

    // 2 窓目で 10_000 番目以降の numeric ゴミ（10_004 = "o-010004"）へ到達。
    expect(json2.candidates.length).toBeGreaterThan(0);
    expect(json2.candidates[0].ownerId).toBe(`o-${String(10004).padStart(6, "0")}`);
  });
});
