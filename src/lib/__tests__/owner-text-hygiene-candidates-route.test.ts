/**
 * GET /api/admin/owners/text-hygiene-candidates のルートテスト（DQ-04）。
 *
 * 検証観点:
 * - 認可（user_management:read / owner:read の 403）
 * - 複数フィールド（name/nameKana/address/note）走査と per-field reports（fields[]）
 * - type フィルタ（all / control_chars / zero_width / bidi / replacement_char / mojibake）
 * - recommendedAction（removable→sanitize_candidate / audit-only→review / note は常に review）
 * - archived 除外（where: isArchived false）
 * - フィールド可視性ゲート（不可視フィールドは分類・summary 非寄与＝隠し PII 推測防止）
 * - summary 集計（スキャン窓全体・フィルタ非依存）
 * - AuditLog detail に生値が含まれない（type / 件数 / summary のみ）
 * - cursor / limit ページング（DB カーソル where:{id:{gt}}）+ scan cap 前進
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
  },
}));

import prisma from "@/lib/prisma";
import { getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { GET } from "../../app/api/admin/owners/text-hygiene-candidates/route";

const pm = prisma as unknown as {
  owner: { findMany: Mock };
};

// 不可視（ソースに制御文字リテラルを埋めない）。
const SOH = String.fromCharCode(1); // C0 control（removable）
const ZWSP = String.fromCharCode(0x200b); // zero-width（removable）
const RLO = String.fromCharCode(0x202e); // bidi（removable）
const FFFD = String.fromCharCode(0xfffd); // replacement char（audit-only）
const MOJIBAKE = String.fromCharCode(0x00c2, 0x00a3, 0x00c2, 0x00a5); // Â£Â¥（audit-only）

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
    address: string | null;
    note: string | null;
    version: number;
  }> = {},
) {
  return {
    id: over.id ?? "o-1",
    name: over.name ?? "山田太郎",
    nameKana: over.nameKana ?? null,
    address: over.address ?? null,
    note: over.note ?? null,
    version: over.version ?? 1,
  };
}

function url(query = "") {
  return new Request(
    `http://localhost/api/admin/owners/text-hygiene-candidates${query}`,
  ) as unknown as import("next/server").NextRequest;
}

type Row = {
  ownerId: string;
  version: number;
  fields: Array<{
    field: string;
    valueMasked: string | null;
    issues: string[];
    severity: string | null;
    removable: boolean;
    auditOnly: boolean;
    recommendedAction: string;
  }>;
};

function ids(json: { candidates: Row[] }): string[] {
  return json.candidates.map((c) => c.ownerId).sort();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL);
  vi.mocked(getOwnerDisplayConfig).mockResolvedValue(DISPLAY_FULL);
  pm.owner.findMany.mockResolvedValue([]);
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

describe("分類とフィルタ（複数フィールド）", () => {
  beforeEach(() => {
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: `山田${SOH}太郎` }), // control_chars (name)
      owner({ id: "o-2", address: `東京${ZWSP}都` }), // zero_width (address)
      owner({ id: "o-3", name: `住所${FFFD}` }), // replacement_char (name)
      owner({ id: "o-4", nameKana: `ヤマダ${RLO}` }), // bidi (nameKana)
      owner({ id: "o-5", name: "山田太郎", address: "東京都" }), // clean
    ]);
  });

  it("type=all は issue を持つ owner を全件返す（DQ-04 は info 区分なし）", async () => {
    const json = await (await GET(url())).json();
    expect(ids(json)).toEqual(["o-1", "o-2", "o-3", "o-4"]);
  });

  it("type=control_chars で control のみ", async () => {
    const json = await (await GET(url("?type=control_chars"))).json();
    expect(json.candidates).toHaveLength(1);
    expect(json.candidates[0].ownerId).toBe("o-1");
    expect(json.candidates[0].fields[0].field).toBe("name");
    expect(json.candidates[0].fields[0].issues).toContain("control_chars");
  });

  it("type=zero_width で zero-width のみ（address フィールド）", async () => {
    const json = await (await GET(url("?type=zero_width"))).json();
    expect(json.candidates.map((c: Row) => c.ownerId)).toEqual(["o-2"]);
    expect(json.candidates[0].fields[0].field).toBe("address");
  });

  it("type=replacement_char で U+FFFD のみ", async () => {
    const json = await (await GET(url("?type=replacement_char"))).json();
    expect(json.candidates.map((c: Row) => c.ownerId)).toEqual(["o-3"]);
  });

  it("type=bidi で nameKana の bidi", async () => {
    const json = await (await GET(url("?type=bidi"))).json();
    expect(json.candidates.map((c: Row) => c.ownerId)).toEqual(["o-4"]);
    expect(json.candidates[0].fields[0].field).toBe("nameKana");
  });

  it("clean owner は候補に出ない", async () => {
    const json = await (await GET(url())).json();
    expect(json.candidates.find((c: Row) => c.ownerId === "o-5")).toBeUndefined();
  });

  it("mojibake を検出する（audit-only）", async () => {
    pm.owner.findMany.mockResolvedValue([owner({ id: "o-9", name: MOJIBAKE })]);
    const json = await (await GET(url("?type=mojibake"))).json();
    expect(json.candidates).toHaveLength(1);
    expect(json.candidates[0].fields[0].issues).toContain("mojibake");
    expect(json.candidates[0].fields[0].auditOnly).toBe(true);
  });
});

describe("recommendedAction", () => {
  it("removable のみ・fixable フィールド（name）は sanitize_candidate", async () => {
    pm.owner.findMany.mockResolvedValue([owner({ id: "o-1", name: `山田${SOH}太郎` })]);
    const json = await (await GET(url("?type=control_chars"))).json();
    expect(json.candidates[0].fields[0].recommendedAction).toBe(
      "sanitize_candidate",
    );
    expect(json.candidates[0].fields[0].removable).toBe(true);
  });

  it("U+FFFD（audit-only）は review", async () => {
    pm.owner.findMany.mockResolvedValue([owner({ id: "o-1", name: `住所${FFFD}` })]);
    const json = await (await GET(url("?type=replacement_char"))).json();
    expect(json.candidates[0].fields[0].recommendedAction).toBe("review");
  });

  it("note は removable でも常に review（fixable 対象外・ZWJ 保護）", async () => {
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", note: `メモ${SOH}` }),
    ]);
    const json = await (await GET(url("?type=control_chars"))).json();
    expect(json.candidates[0].fields[0].field).toBe("note");
    expect(json.candidates[0].fields[0].removable).toBe(true);
    expect(json.candidates[0].fields[0].recommendedAction).toBe("review");
  });

  it("除去すると空になる removable のみ（would_be_empty）は review", async () => {
    pm.owner.findMany.mockResolvedValue([owner({ id: "o-1", name: `${SOH}${ZWSP}` })]);
    const json = await (await GET(url("?type=control_chars"))).json();
    expect(json.candidates[0].fields[0].recommendedAction).toBe("review");
  });
});

describe("複数フィールド同居", () => {
  it("1 owner の複数フィールドの issue を fields[] に列挙する", async () => {
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: `山田${SOH}太郎`, address: `東京${ZWSP}都` }),
    ]);
    const json = await (await GET(url())).json();
    expect(json.candidates).toHaveLength(1);
    const fieldsByName = Object.fromEntries(
      json.candidates[0].fields.map((f: Row["fields"][number]) => [f.field, f]),
    );
    expect(fieldsByName.name.issues).toContain("control_chars");
    expect(fieldsByName.address.issues).toContain("zero_width");
  });

  it("type フィルタは per-field（複数フィールド owner で選択 type のフィールドのみ・偽陽性なし・Codex P2）", async () => {
    // name=control_chars(removable) / address=replacement_char(audit-only) を持つ owner。
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: `山田${SOH}太郎`, address: `住所${FFFD}` }),
    ]);
    // type=control_chars: address(replacement_char のみ)の偽陽性行を出さず name だけ。
    const c = await (await GET(url("?type=control_chars"))).json();
    expect(c.candidates).toHaveLength(1);
    expect(
      c.candidates[0].fields.map((f: Row["fields"][number]) => f.field),
    ).toEqual(["name"]);
    // type=replacement_char: address だけ。
    const r = await (await GET(url("?type=replacement_char"))).json();
    expect(
      r.candidates[0].fields.map((f: Row["fields"][number]) => f.field),
    ).toEqual(["address"]);
    // type=all: 両フィールドを返す。
    const a = await (await GET(url())).json();
    expect(
      a.candidates[0].fields.map((f: Row["fields"][number]) => f.field).sort(),
    ).toEqual(["address", "name"]);
  });
});

describe("archived 除外", () => {
  it("findMany の where は isArchived:false", async () => {
    await GET(url());
    expect(pm.owner.findMany.mock.calls[0][0].where).toEqual({
      isArchived: false,
    });
  });
});

describe("フィールド可視性ゲート（隠し PII の品質推測を防ぐ）", () => {
  it("name が masked なら name 由来 issue を分類しない（summary 非寄与）", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      name: "masked",
    });
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: `山田${SOH}太郎` }), // name 不可視 → 出ない
      owner({ id: "o-2", address: `東京${ZWSP}都` }), // address 可視 → 出る
    ]);
    const json = await (await GET(url())).json();
    expect(ids(json)).toEqual(["o-2"]);
    expect(json.summary.controlChars).toBe(0); // name 由来は summary にも乗らない
    expect(json.summary.zeroWidth).toBe(1);
  });

  it("partial も生値非可視として分類しない", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      name: "partial",
      nameKana: "partial",
      address: "partial",
      note: "partial",
    });
    pm.owner.findMany.mockResolvedValue([owner({ id: "o-1", name: `山田${SOH}太郎` })]);
    const json = await (await GET(url())).json();
    expect(json.candidates).toHaveLength(0);
    expect(json.summary.totalCandidates).toBe(0);
  });

  it("全フィールド hidden では type を変えても候補ゼロ（推測不能）", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValue({
      ...DISPLAY_FULL,
      name: "hidden",
      nameKana: "hidden",
      address: "hidden",
      note: "hidden",
    });
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: `山田${SOH}太郎`, address: `東京${ZWSP}都` }),
    ]);
    for (const t of ["all", "control_chars", "zero_width", "replacement_char"]) {
      const json = await (await GET(url(`?type=${t}`))).json();
      expect(json.candidates).toHaveLength(0);
    }
  });
});

describe("PII マスキング", () => {
  it("可視フィールドの issue 行を返しつつ、不可視フィールドの生値は返さない", async () => {
    // name 可視（full・issue で行が出る）/ address masked（生値非可視＝分類されない）。
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      address: "masked",
    });
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: `山田${SOH}太郎`, address: `1234567${ZWSP}` }),
    ]);
    const json = await (await GET(url())).json();
    expect(json.candidates).toHaveLength(1);
    const reported = json.candidates[0].fields.map(
      (f: Row["fields"][number]) => f.field,
    );
    expect(reported).toContain("name");
    expect(reported).not.toContain("address"); // masked は分類されない
    const blob = JSON.stringify(json.candidates[0]);
    expect(blob).not.toContain("1234567");
  });
});

describe("summary 集計", () => {
  it("種別ごとに集計し totalCandidates はフィールド単位", async () => {
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: `山田${SOH}太郎`, address: `東京${ZWSP}都` }), // control + zero_width = 2 候補
      owner({ id: "o-2", name: `住所${FFFD}` }), // replacement = 1 候補
    ]);
    const json = await (await GET(url())).json();
    expect(json.summary.controlChars).toBe(1);
    expect(json.summary.zeroWidth).toBe(1);
    expect(json.summary.replacementChar).toBe(1);
    expect(json.summary.totalCandidates).toBe(3);
  });
});

describe("AuditLog 非PII", () => {
  it("detail に生値が含まれず type/summary/resultCount のみ", async () => {
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: `機密太郎${SOH}` }),
    ]);
    await GET(url("?type=control_chars"));
    const call = vi.mocked(writeAuditLog).mock.calls[0][0];
    expect(call.action).toBe("owner_text_hygiene_candidates_list");
    const detailJson = JSON.stringify(call.detail);
    expect(detailJson).not.toContain("機密太郎");
    expect(call.detail).toHaveProperty("summary");
    expect(call.detail).toHaveProperty("resultCount");
  });
});

describe("ページング", () => {
  beforeEach(() => {
    const fixtures = Array.from({ length: 5 }, (_, i) =>
      owner({ id: `o-${i}`, name: `山田${SOH}太郎` }),
    );
    pm.owner.findMany.mockImplementation(
      (args: { where?: { id?: { gt?: string } }; take?: number }) => {
        const gt = args?.where?.id?.gt ?? null;
        const rows = gt ? fixtures.filter((o) => o.id > gt) : fixtures;
        return Promise.resolve(rows.slice(0, args?.take ?? rows.length));
      },
    );
  });

  it("limit=2 で 2 件 + hasNextPage + nextCursor", async () => {
    const json = await (await GET(url("?limit=2"))).json();
    expect(json.candidates).toHaveLength(2);
    expect(json.hasNextPage).toBe(true);
    expect(json.nextCursor).toBe(json.candidates[1].ownerId);
  });

  it("cursor は DB クエリの where に id.gt として渡る", async () => {
    await GET(url("?limit=2&cursor=o-1"));
    expect(pm.owner.findMany.mock.calls[0][0].where).toEqual({
      isArchived: false,
      id: { gt: "o-1" },
    });
  });

  it("cursor で続きを取得", async () => {
    const json1 = await (await GET(url("?limit=2"))).json();
    const json2 = await (
      await GET(url(`?limit=2&cursor=${json1.nextCursor}`))
    ).json();
    expect(json2.candidates[0].ownerId > json1.nextCursor).toBe(true);
  });
});

describe("scan cap 超のページング前進（取りこぼし防止）", () => {
  function generateOwners(cursorId: string | null, total: number, take: number) {
    const all = Array.from({ length: total }, (_, i) =>
      owner({
        id: `o-${String(i).padStart(6, "0")}`,
        // 末尾にだけ control ゴミ（窓内で matched が枯渇する状況を作る）。
        name: i >= total - 1 ? `山田${SOH}太郎` : "山田太郎",
      }),
    );
    const startIdx = cursorId ? all.findIndex((o) => o.id > cursorId) : 0;
    const from = startIdx < 0 ? all.length : startIdx;
    return all.slice(from, from + take);
  }

  it("truncated 窓で matched 枯渇 → hasNextPage=true・nextCursor は窓末尾へ前進", async () => {
    const TOTAL = 10_005;
    pm.owner.findMany.mockImplementation(
      (args: { where?: { id?: { gt?: string } }; take?: number }) =>
        Promise.resolve(
          generateOwners(
            args?.where?.id?.gt ?? null,
            TOTAL,
            args?.take ?? 10_001,
          ),
        ),
    );
    const json = await (await GET(url("?type=control_chars&limit=2"))).json();
    expect(json.candidates).toHaveLength(0);
    expect(json.truncated).toBe(true);
    expect(json.hasNextPage).toBe(true);
    expect(json.nextCursor).toBe(`o-${String(9999).padStart(6, "0")}`);
  });

  it("前進した cursor で次窓の scan cap 超候補へ到達できる", async () => {
    const TOTAL = 10_005;
    pm.owner.findMany.mockImplementation(
      (args: { where?: { id?: { gt?: string } }; take?: number }) =>
        Promise.resolve(
          generateOwners(
            args?.where?.id?.gt ?? null,
            TOTAL,
            args?.take ?? 10_001,
          ),
        ),
    );
    const json1 = await (await GET(url("?type=control_chars&limit=2"))).json();
    const json2 = await (
      await GET(url(`?type=control_chars&limit=2&cursor=${json1.nextCursor}`))
    ).json();
    expect(json2.candidates.length).toBeGreaterThan(0);
    expect(json2.candidates[0].ownerId).toBe(`o-${String(10004).padStart(6, "0")}`);
  });
});
