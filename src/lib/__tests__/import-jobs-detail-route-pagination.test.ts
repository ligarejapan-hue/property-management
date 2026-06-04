/**
 * GET /api/import/jobs/[jobId] の rows サーバーサイドページング(PR-B / B1)テスト。
 *
 * 検証内容:
 *   - page / limit / status のパース（および不正値の扱い）
 *   - rows findMany が orderBy / status where / skip / take を使うこと
 *   - page / limit 省略時は全件返却（skip/take 無し・後方互換）
 *   - pagination メタが正しいこと（totalRows は status フィルタ後の母数）
 *   - summary は **ジョブ全体** のまま維持され、status フィルタでページ分に化けないこと
 *   - isReceptionOwnerJob（owner_csv のみ findFirst で確定）
 *   - duplicateCount（重複由来の要レビュー/スキップ件数）
 *   - 存在しない jobId は 404
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

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
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
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
  hasPermission: vi.fn(() => true),
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    importJob: { findUnique: vi.fn() },
    importJobRow: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      groupBy: vi.fn(),
      count: vi.fn(),
    },
  },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { GET } from "@/app/api/import/jobs/[jobId]/route";
import { summaryFromStatusCounts } from "@/lib/import-summary";

const pm = prisma as unknown as {
  importJob: { findUnique: Mock };
  importJobRow: {
    findMany: Mock;
    findFirst: Mock;
    groupBy: Mock;
    count: Mock;
  };
};

const JOB_ID = "job-1";

type StatusGroup = {
  status: "success" | "error" | "skipped" | "needs_review";
  _count: { _all: number };
};

interface SetupArgs {
  job?: unknown;
  rows?: unknown[];
  statusGroups?: StatusGroup[];
  updatedGroups?: { jobId: string; _count: { _all: number } }[];
  filteredTotal?: number;
  duplicateCount?: number;
  duplicateActionableCount?: number;
  markerRow?: { rawData: unknown } | null;
}

function setup({
  job = { id: JOB_ID, jobType: "property_csv", fileName: "f.csv" },
  rows = [],
  statusGroups = [],
  updatedGroups = [],
  filteredTotal = 0,
  duplicateCount = 0,
  duplicateActionableCount = 0,
  markerRow = null,
}: SetupArgs) {
  pm.importJob.findUnique.mockResolvedValue(job);
  pm.importJobRow.findMany.mockResolvedValue(rows);
  pm.importJobRow.findFirst.mockResolvedValue(markerRow);
  pm.importJobRow.groupBy.mockImplementation((args: { by: string[] }) =>
    Promise.resolve(args.by.includes("status") ? statusGroups : updatedGroups),
  );
  // count は3種:
  //   filteredTotal               : errorMessage 条件なし
  //   duplicateCount              : 「重複」始まり かつ status:{in:[...]}（オブジェクト）
  //   duplicateActionableCount    : 「重複」始まり かつ status:"needs_review"（文字列）
  pm.importJobRow.count.mockImplementation(
    (args: {
      where?: { status?: unknown; errorMessage?: { startsWith?: string } };
    }) => {
      const where = args.where ?? {};
      if (where.errorMessage?.startsWith === "重複") {
        return Promise.resolve(
          typeof where.status === "string"
            ? duplicateActionableCount
            : duplicateCount,
        );
      }
      return Promise.resolve(filteredTotal);
    },
  );
}

async function callGet(query = "", jobId = JOB_ID) {
  const req = new Request(`http://t/api/import/jobs/${jobId}${query}`);
  const res = await GET(req as never, { params: Promise.resolve({ jobId }) });
  return { status: res.status, body: await res.json() };
}

function findManyArgs() {
  return pm.importJobRow.findMany.mock.calls[0][0] as {
    where: Record<string, unknown>;
    orderBy: unknown;
    skip?: number;
    take?: number;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([
    { resource: "import", action: "write", granted: true },
  ]);
  (hasPermission as Mock).mockReturnValue(true);
});

describe("GET /api/import/jobs/[jobId] — rows pagination (PR-B / B1)", () => {
  it("page/limit 省略時は全件返却・skip/take 無し（後方互換）", async () => {
    setup({
      rows: [{ id: "r1" }, { id: "r2" }, { id: "r3" }],
      statusGroups: [{ status: "success", _count: { _all: 3 } }],
      filteredTotal: 3,
    });

    const { status, body } = await callGet("");

    expect(status).toBe(200);
    const args = findManyArgs();
    expect(args.where).toEqual({ jobId: JOB_ID });
    expect(args.orderBy).toEqual({ rowNumber: "asc" });
    expect(args).not.toHaveProperty("skip");
    expect(args).not.toHaveProperty("take");
    expect(body.rows).toHaveLength(3);
    expect(body.pagination).toEqual({
      page: 1,
      limit: 3, // 全件=1ページ
      totalRows: 3,
      totalPages: 1,
      hasNextPage: false,
      hasPrevPage: false,
      status: null,
      reason: null, // Phase 2: additive（未指定）
    });
  });

  it("page/limit 指定時は skip/take/orderBy を使い、pagination メタが正しい", async () => {
    setup({
      rows: [{ id: "rA" }, { id: "rB" }],
      statusGroups: [{ status: "success", _count: { _all: 25 } }],
      filteredTotal: 25,
    });

    const { body } = await callGet("?page=2&limit=10");

    const args = findManyArgs();
    expect(args.where).toEqual({ jobId: JOB_ID });
    expect(args.orderBy).toEqual({ rowNumber: "asc" });
    expect(args.skip).toBe(10); // (2-1)*10
    expect(args.take).toBe(10);
    expect(body.pagination).toEqual({
      page: 2,
      limit: 10,
      totalRows: 25,
      totalPages: 3, // ceil(25/10)
      hasNextPage: true, // 2 < 3
      hasPrevPage: true, // 2 > 1
      status: null,
      reason: null, // Phase 2: additive（未指定）
    });
  });

  it("status 指定時: rows where に status 反映・totalRows は status 後・summary は全体不変", async () => {
    // ジョブ全体 = success5(うち更新2) / error3 / needs_review1 → summary は全体
    setup({
      rows: [{ id: "e1" }, { id: "e2" }],
      statusGroups: [
        { status: "success", _count: { _all: 5 } },
        { status: "error", _count: { _all: 3 } },
        { status: "needs_review", _count: { _all: 1 } },
      ],
      updatedGroups: [{ jobId: JOB_ID, _count: { _all: 2 } }],
      filteredTotal: 3, // error の件数（status フィルタ後）
    });

    const { body } = await callGet("?status=error&page=1&limit=5");

    // rows where に status
    expect(findManyArgs().where).toEqual({ jobId: JOB_ID, status: "error" });
    // pagination.totalRows は status フィルタ後 = 3
    expect(body.pagination.status).toBe("error");
    expect(body.pagination.totalRows).toBe(3);

    // summary は **ジョブ全体**（success/更新/error/needs_review すべて反映）
    expect(body.summary).toEqual(
      summaryFromStatusCounts(
        { success: 5, error: 3, needs_review: 1 },
        2,
      ),
    );
    // ページ分(error 2件)に化けていないこと
    expect(body.summary.totalCount).toBe(9);
    expect(body.summary.createdCount).toBe(3); // 5 - 2
    expect(body.summary.updatedCount).toBe(2);
    expect(body.summary.errorCount).toBe(3);

    // summary 用の groupBy(by:["status"]) は status フィルタを掛けず jobId 全体で集計
    const statusGroupByCall = pm.importJobRow.groupBy.mock.calls
      .map((c) => c[0])
      .find((a) => a.by.includes("status"));
    expect(statusGroupByCall.where).toEqual({ jobId: JOB_ID });
  });

  it("不正な status は無視（全 status 扱い・where に status を入れない）", async () => {
    setup({
      statusGroups: [{ status: "success", _count: { _all: 4 } }],
      filteredTotal: 4,
    });

    const { body } = await callGet("?status=bogus&page=1&limit=5");

    expect(findManyArgs().where).toEqual({ jobId: JOB_ID });
    expect(body.pagination.status).toBeNull();
  });

  it("極端な page/limit はクランプされる（page>=1, limit<=MAX=100）", async () => {
    setup({ filteredTotal: 1000 });

    await callGet("?page=-3&limit=9999");

    const args = findManyArgs();
    expect(args.take).toBe(100); // MAX_ROW_LIMIT
    expect(args.skip).toBe(0); // page クランプ → 1 → (1-1)*100
  });

  it("数値でない page/limit は default にフォールバック（limit=50, page=1）", async () => {
    setup({ filteredTotal: 200 });

    await callGet("?page=abc&limit=xyz");

    const args = findManyArgs();
    expect(args.take).toBe(50); // DEFAULT_ROW_LIMIT
    expect(args.skip).toBe(0);
  });

  // ---- Codex #101 P2: 小数/Infinity の整数正規化 ----
  it("小数 page/limit は切り捨てで整数化され skip/take が整数になる", async () => {
    setup({ filteredTotal: 100 });

    await callGet("?page=1.5&limit=10");

    const args = findManyArgs();
    expect(args.skip).toBe(0); // floor(1.5)=1 → (1-1)*10
    expect(args.take).toBe(10);
    expect(Number.isInteger(args.skip)).toBe(true);
    expect(Number.isInteger(args.take)).toBe(true);
  });

  it("小数 page=2.9 / limit=10.9 でも skip/take は整数（切り捨て）", async () => {
    setup({ filteredTotal: 100 });

    await callGet("?page=2.9&limit=10.9");

    const args = findManyArgs();
    // floor(2.9)=2, floor(10.9)=10 → skip=(2-1)*10
    expect(args.skip).toBe(10);
    expect(args.take).toBe(10);
    expect(Number.isInteger(args.skip)).toBe(true);
    expect(Number.isInteger(args.take)).toBe(true);
  });

  it("1 未満に切り捨てられる小数 page（0.4）は fallback で page=1", async () => {
    setup({ filteredTotal: 100 });

    await callGet("?page=0.4&limit=10");

    const args = findManyArgs();
    expect(args.skip).toBe(0); // floor(0.4)=0 (<1) → fallback page=1 → skip 0
    expect(args.take).toBe(10);
    expect(Number.isInteger(args.skip)).toBe(true);
  });

  it("Infinity / 非有限値は安全に fallback（page=1, limit=DEFAULT・skip/take 整数）", async () => {
    setup({ filteredTotal: 100 });

    await callGet("?page=Infinity&limit=Infinity");

    const args = findManyArgs();
    expect(args.skip).toBe(0); // page → 1
    expect(args.take).toBe(50); // limit → DEFAULT_ROW_LIMIT
    expect(Number.isInteger(args.skip)).toBe(true);
    expect(Number.isInteger(args.take)).toBe(true);
  });

  it("isReceptionOwnerJob: owner_csv + マーカ付き先頭行 → true（findFirst 利用）", async () => {
    setup({
      job: { id: JOB_ID, jobType: "owner_csv", fileName: "owner.csv" },
      markerRow: { rawData: { __owner_link_data: "[{\"name\":\"x\"}]" } },
      statusGroups: [{ status: "needs_review", _count: { _all: 2 } }],
      filteredTotal: 2,
    });

    const { body } = await callGet("");

    expect(pm.importJobRow.findFirst).toHaveBeenCalledTimes(1);
    expect(body.isReceptionOwnerJob).toBe(true);
  });

  it("isReceptionOwnerJob: owner_csv 以外は findFirst を呼ばず false", async () => {
    setup({
      job: { id: JOB_ID, jobType: "property_csv", fileName: "p.csv" },
      statusGroups: [{ status: "success", _count: { _all: 1 } }],
      filteredTotal: 1,
    });

    const { body } = await callGet("");

    expect(pm.importJobRow.findFirst).not.toHaveBeenCalled();
    expect(body.isReceptionOwnerJob).toBe(false);
  });

  it("duplicateCount: 重複由来(要レビュー/スキップ)の件数を additive に返す", async () => {
    setup({
      statusGroups: [{ status: "needs_review", _count: { _all: 6 } }],
      filteredTotal: 6,
      duplicateCount: 4,
    });

    const { body } = await callGet("");

    expect(body.duplicateCount).toBe(4);
    // 重複 count の where を確認
    const dupCall = pm.importJobRow.count.mock.calls
      .map((c) => c[0])
      .find((a) => a.where?.errorMessage?.startsWith === "重複");
    expect(dupCall.where).toEqual({
      jobId: JOB_ID,
      status: { in: ["needs_review", "skipped"] },
      errorMessage: { startsWith: "重複" },
    });
  });

  it("duplicateActionableCount(B4 Codex P2): needs_review のみ・skipped 重複があっても過大にならない", async () => {
    // needs_review 重複3 + skipped 重複1 → duplicateCount=4 / actionable=3
    setup({
      statusGroups: [
        { status: "needs_review", _count: { _all: 6 } },
        { status: "skipped", _count: { _all: 5 } },
      ],
      filteredTotal: 11,
      duplicateCount: 4, // needs_review + skipped × 「重複」始まり
      duplicateActionableCount: 3, // needs_review のみ × 「重複」始まり
    });

    const { body } = await callGet("");

    expect(body.duplicateCount).toBe(4);
    expect(body.duplicateActionableCount).toBe(3);

    // duplicateCount は needs_review + skipped（status は { in: [...] }）。
    const dupCall = pm.importJobRow.count.mock.calls
      .map((c) => c[0])
      .find(
        (a) =>
          a.where?.errorMessage?.startsWith === "重複" &&
          typeof a.where?.status === "object",
      );
    expect(dupCall.where).toEqual({
      jobId: JOB_ID,
      status: { in: ["needs_review", "skipped"] },
      errorMessage: { startsWith: "重複" },
    });

    // duplicateActionableCount は needs_review のみ（status は文字列）＝bulk endpoint と一致。
    const actCall = pm.importJobRow.count.mock.calls
      .map((c) => c[0])
      .find(
        (a) =>
          a.where?.errorMessage?.startsWith === "重複" &&
          typeof a.where?.status === "string",
      );
    expect(actCall.where).toEqual({
      jobId: JOB_ID,
      status: "needs_review",
      errorMessage: { startsWith: "重複" },
    });

    // 確認件数（actionable）は duplicateCount を上回らない（過大表示にならない）。
    expect(body.duplicateActionableCount).toBeLessThanOrEqual(
      body.duplicateCount,
    );
  });

  // ---- Plan-T(17-B): duplicateCount と duplicateActionableCount の分離（境界） ----
  it("duplicateCount>0 かつ duplicateActionableCount=0（skipped 重複のみ残存）＝ボタン非表示・過大表示なし", async () => {
    // 重複行が全て skip 済み → duplicateCount(needs_review+skipped)>0 だが
    // duplicateActionableCount(needs_review のみ)=0。UI の「重複候補のみスキップ」は
    // counts.duplicateActionable>0 でしか出ないため、この状態ではボタンが出ない。
    setup({
      statusGroups: [
        { status: "skipped", _count: { _all: 5 } },
        { status: "success", _count: { _all: 3 } },
      ],
      filteredTotal: 8,
      duplicateCount: 2, // skipped 重複のみ（needs_review+skipped × 「重複」）
      duplicateActionableCount: 0, // needs_review 重複は残っていない
    });

    const { body } = await callGet("");

    expect(body.duplicateCount).toBe(2);
    expect(body.duplicateActionableCount).toBe(0);
    // actionable は duplicateCount を超えない（境界で 0）。
    expect(body.duplicateActionableCount).toBeLessThanOrEqual(
      body.duplicateCount,
    );

    // 2 つの count は「status の形」だけが異なる別述語であることを明示ロック:
    //   duplicateCount           : status:{ in:["needs_review","skipped"] }（オブジェクト）
    //   duplicateActionableCount : status:"needs_review"（文字列・bulk endpoint と一致）
    const dupCall = pm.importJobRow.count.mock.calls
      .map((c) => c[0])
      .find(
        (a) =>
          a.where?.errorMessage?.startsWith === "重複" &&
          typeof a.where?.status === "object",
      );
    expect(dupCall.where).toEqual({
      jobId: JOB_ID,
      status: { in: ["needs_review", "skipped"] },
      errorMessage: { startsWith: "重複" },
    });
    const actCall = pm.importJobRow.count.mock.calls
      .map((c) => c[0])
      .find(
        (a) =>
          a.where?.errorMessage?.startsWith === "重複" &&
          typeof a.where?.status === "string",
      );
    expect(actCall.where).toEqual({
      jobId: JOB_ID,
      status: "needs_review",
      errorMessage: { startsWith: "重複" },
    });
    // どちらの述語も「住所」prefix（reception 住所重複）を含めない＝B4.1 現状維持。
    expect(JSON.stringify(dupCall.where)).not.toContain("住所");
    expect(JSON.stringify(actCall.where)).not.toContain("住所");
  });

  it("レスポンス root に rows を維持し summary を additive に返す（非破壊）", async () => {
    setup({
      job: { id: JOB_ID, jobType: "property_csv", fileName: "f.csv" },
      rows: [{ id: "r1" }],
      statusGroups: [{ status: "success", _count: { _all: 1 } }],
      filteredTotal: 1,
    });

    const { body } = await callGet("");

    expect(body.id).toBe(JOB_ID);
    expect(body.fileName).toBe("f.csv");
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.summary).toBeDefined();
    expect(body.pagination).toBeDefined();
  });

  it("存在しない jobId は 404", async () => {
    setup({ job: null });

    const { status, body } = await callGet("", "missing");

    expect(status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });
});

describe("GET /api/import/jobs/[jobId] — 理由別 filter (Phase 2)", () => {
  // server の ROW_REASON_WHERE と完全一致させる期待値（route 変更時は両方を更新）。
  // message はテンプレ prefix / exact 値のみ＝PII を含まない。
  const REASON_WHERE = {
    dup_candidate: { errorMessage: { startsWith: "重複" } },
    address_dup: { errorMessage: { startsWith: "住所が既存物件と重複" } },
    no_address: {
      OR: [
        { errorMessage: { startsWith: "住所なし" } },
        { errorMessage: "住所が空です" },
      ],
    },
    owner_unmatched: { errorMessage: "要レビュー（所有者未突合）" },
    no_key: { errorMessage: "要レビュー（キー不足）" },
    // Codex P2: csv route の実メッセージ（4 変種すべて「棟名」始まり）に合わせた prefix。
    building_unresolved: { errorMessage: { startsWith: "棟名" } },
  } as const;

  it.each(Object.keys(REASON_WHERE) as (keyof typeof REASON_WHERE)[])(
    "reason=%s: rows where に理由条件を AND 合成する",
    async (token) => {
      setup({ filteredTotal: 2 });

      await callGet(`?reason=${token}&page=1&limit=10`);

      expect(findManyArgs().where).toEqual({
        jobId: JOB_ID,
        ...REASON_WHERE[token],
      });
    },
  );

  it("building_unresolved は csv route の実メッセージ全形式に一致し、無関係な理由を拾わない（Codex P2）", () => {
    // csv/route.ts resolveBuildingId（:192/:217/:225）と fallback（:462）が
    // 実際に生成する文言の fixture（棟名はダミー値・PII なし）。
    const realBuildingMessages = [
      "棟名「テスト棟」が見つかりません。棟を先に登録するか、レビュー画面で対応してください",
      "棟名「テスト棟」に一致する棟が2件あり特定できません。レビュー画面で選択してください",
      "棟名「テスト棟」に類似する棟が3件見つかりました。レビュー画面で選択してください",
      "棟名が見つかりません。棟を先に登録してください", // resolution.error ?? の fallback
    ];
    const prefix = REASON_WHERE.building_unresolved.errorMessage.startsWith;
    for (const msg of realBuildingMessages) {
      expect(msg.startsWith(prefix)).toBe(true);
    }
    // 無関係な理由のメッセージは prefix に一致しない（広すぎる contains を排除）。
    const unrelatedMessages = [
      "住所なし（H/I/J/K 列が全て空）",
      "住所が既存物件と重複（ID: prop-1）",
      "住所が空です",
      "氏名が空です",
      "重複の可能性[住所一致（正規化比較）]: 既存物件ID=p1 (ダミー住所)",
      "要レビュー（所有者未突合）",
      "要レビュー（キー不足）",
      "手動スキップ",
      "手動エラー確定",
    ];
    for (const msg of unrelatedMessages) {
      expect(msg.startsWith(prefix)).toBe(false);
    }
  });

  it("reason + status は AND 直交合成・pagination.reason を additive に返す", async () => {
    setup({ filteredTotal: 1 });

    const { body } = await callGet(
      "?status=needs_review&reason=dup_candidate&page=1&limit=10",
    );

    expect(findManyArgs().where).toEqual({
      jobId: JOB_ID,
      status: "needs_review",
      errorMessage: { startsWith: "重複" },
    });
    expect(body.pagination.reason).toBe("dup_candidate");
    expect(body.pagination.status).toBe("needs_review");
  });

  it("不正な reason は無視（全理由扱い・where 不変＝後方互換）", async () => {
    setup({ filteredTotal: 4 });

    // B4 bulk の scope 値 "duplicate" は reason token として受け付けない（衝突回避）。
    const { body } = await callGet("?reason=duplicate&page=1&limit=5");

    expect(findManyArgs().where).toEqual({ jobId: JOB_ID });
    expect(body.pagination.reason).toBeNull();
  });

  it("reason 指定時も summary / duplicateCount / duplicateActionableCount の where は不変（jobId-only / 既存述語）", async () => {
    setup({
      statusGroups: [{ status: "needs_review", _count: { _all: 6 } }],
      filteredTotal: 6,
      duplicateCount: 4,
      duplicateActionableCount: 3,
    });

    const { body } = await callGet("?reason=address_dup&page=1&limit=10");

    // summary 用 groupBy は jobId 全体（reason 非依存）。
    const statusGroupByCall = pm.importJobRow.groupBy.mock.calls
      .map((c) => c[0])
      .find((a) => a.by.includes("status"));
    expect(statusGroupByCall.where).toEqual({ jobId: JOB_ID });

    // duplicateCount / duplicateActionableCount の述語は既存のまま（reason 非依存）。
    const dupCall = pm.importJobRow.count.mock.calls
      .map((c) => c[0])
      .find(
        (a) =>
          a.where?.errorMessage?.startsWith === "重複" &&
          typeof a.where?.status === "object",
      );
    expect(dupCall.where).toEqual({
      jobId: JOB_ID,
      status: { in: ["needs_review", "skipped"] },
      errorMessage: { startsWith: "重複" },
    });
    const actCall = pm.importJobRow.count.mock.calls
      .map((c) => c[0])
      .find(
        (a) =>
          a.where?.errorMessage?.startsWith === "重複" &&
          typeof a.where?.status === "string",
      );
    expect(actCall.where).toEqual({
      jobId: JOB_ID,
      status: "needs_review",
      errorMessage: { startsWith: "重複" },
    });
    expect(body.duplicateCount).toBe(4);
    expect(body.duplicateActionableCount).toBe(3);
  });

  it("totalRows は reason 合成後の where ベース（ページングの母数）", async () => {
    setup({});
    // count の戻りを where ごとに振り分ける:
    //   合成 rowWhere（owner_unmatched）と一致 → 7（filteredTotal）／それ以外 → 0
    const composed = {
      jobId: JOB_ID,
      errorMessage: "要レビュー（所有者未突合）",
    };
    pm.importJobRow.count.mockImplementation((args: { where?: unknown }) =>
      Promise.resolve(
        JSON.stringify(args.where) === JSON.stringify(composed) ? 7 : 0,
      ),
    );

    const { body } = await callGet("?reason=owner_unmatched&page=1&limit=5");

    expect(body.pagination.totalRows).toBe(7);
    expect(body.pagination.totalPages).toBe(2); // ceil(7/5)
    expect(body.pagination.reason).toBe("owner_unmatched");
  });
});
