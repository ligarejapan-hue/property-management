/**
 * POST /api/import/csv（物件CSV取込）の**外部キー(リンクキー)正規化**の統合テスト。
 *
 * ⚠なぜ書込側でも正規化するか(@codex PR#414 17巡目 ②):
 *   混在幅のキー(`SA2608－1234567` のように一部だけ全角)は、貼り付け取込の
 *   重複判定が引く2表記(純半角/純全角)のどちらにも当たらない。
 *   **書込む全経路が同じ正規化を通れば、混在幅の行は今後生まれ得なくなる**。
 *   (既存データの backfill は本番0件のため不要。)
 * ⚠正規化以外の CSV の挙動は変えていない。
 *
 * prisma は全面モック。正規化(normalizeExternalLinkKey)と permissions は実物。
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

// recordChanges だけ spy にし、PROPERTY_TRACKED_FIELDS 等は実物を維持する。
vi.mock("@/lib/change-log", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/change-log")>();
  return { ...actual, recordChanges: vi.fn() };
});

vi.mock("@/lib/prisma", () => ({
  default: {
    importJob: { create: vi.fn(), update: vi.fn() },
    importJobRow: { create: vi.fn() },
    property: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      // 重複更新は scheduled ガード付きの updateMany 経由(@codex #394 R27)。
      updateMany: vi.fn(),
    },
    building: { findMany: vi.fn(), create: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { POST } from "../../app/api/import/csv/route";

const pm = prisma as unknown as {
  importJob: { create: Mock; update: Mock };
  importJobRow: { create: Mock };
  property: {
    findMany: Mock;
    findUnique: Mock;
    findUniqueOrThrow: Mock;
    create: Mock;
    update: Mock;
    updateMany: Mock;
  };
  building: { findMany: Mock; create: Mock };
};

const PERMS = [{ resource: "import", action: "write", granted: true }];

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/import/csv", {
    method: "POST",
    headers: { "content-type": "application/json" , "content-length": String(Buffer.byteLength(JSON.stringify(body))) },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

/** property.create に渡された data を取得（最後の呼び出し）。 */
function lastCreateData(): Record<string, unknown> {
  return pm.property.create.mock.calls.at(-1)?.[0]?.data ?? {};
}


beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue({
    id: "user-1",
    email: "a@a",
    name: "A",
    role: "admin",
  } as never);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS as never);

  pm.importJob.create.mockResolvedValue({ id: "job-1" });
  pm.importJob.update.mockResolvedValue({ id: "job-1" });
  pm.importJobRow.create.mockResolvedValue({ id: "row-1" });
  pm.property.findMany.mockResolvedValue([]); // dedupe index は空（=新規作成）
  pm.building.findMany.mockResolvedValue([]);
  // create は渡された data を反映して返す（route が id/address 等を後続利用する）
  pm.property.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({
      id: "new-1",
      address: data.address,
      roomNo: data.roomNo ?? null,
      buildingId: data.buildingId ?? null,
      realEstateNumber: data.realEstateNumber ?? null,
      externalLinkKey: data.externalLinkKey ?? null,
      ...data,
    }),
  );
});


import { buildPasteDraft } from "@/lib/paste-import/build-draft";
import { judgeDuplicates } from "@/lib/paste-import/find-duplicates";
import { normalizeExternalLinkKey, toFullWidth } from "@/lib/paste-import/normalize";

describe("POST /api/import/csv — 外部キーの正規化（create）", () => {
  it("★混在幅のキーが正規化された形で保存される", async () => {
    // 「SA2608－1234567」は数字とハイフンだけ全角。2表記の列挙では拾えなかった形。
    const csv = "住所,リンクキー\n東京都千代田区1-1,SA2608－1234567\n";
    const res = await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(res.status).toBe(201);
    expect(lastCreateData().externalLinkKey).toBe("SA2608-1234567");
  });

  it("★全角のキーも正規化される", async () => {
    const csv = "住所,リンクキー\n東京都千代田区1-1,ＳＡ２６０８－１２３４５６７\n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(lastCreateData().externalLinkKey).toBe("SA2608-1234567");
  });

  it("半角のキーは従来どおりそのまま（保存される文字列を変えない）", async () => {
    const csv = "住所,リンクキー\n東京都千代田区1-1,SA2608-1234567\n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(lastCreateData().externalLinkKey).toBe("SA2608-1234567");
  });

  it("空欄なら従来どおり externalLinkKey を設定しない", async () => {
    const csv = "住所,リンクキー\n東京都千代田区1-1,\n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect("externalLinkKey" in lastCreateData()).toBe(false);
  });

  it("空白だけなら設定しない（null で上書きもしない）", async () => {
    const csv = "住所,リンクキー\n東京都千代田区1-1,   \n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect("externalLinkKey" in lastCreateData()).toBe(false);
  });

  it("リンクキー列が無い従来のCSVも変わらず取り込める", async () => {
    const csv = "住所\n東京都千代田区1-1\n";
    const res = await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(res.status).toBe(201);
    expect(pm.property.create).toHaveBeenCalledTimes(1);
    expect("externalLinkKey" in lastCreateData()).toBe(false);
  });
});

describe("端から端まで: CSVで入った行を、貼り付け取込がブロックする", () => {
  it("★CSVが混在幅で取り込んだ番号を貼り付けると blocked になる", async () => {
    // ① CSV取込（書込側）
    const csv = "住所,リンクキー\n東京都千代田区1-1,SA2608－1234567\n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    const stored = lastCreateData().externalLinkKey as string;

    // ② 貼り付け取込（読み側）。人が混在幅のまま貼っても同じ形に畳まれる。
    const draft = buildPasteDraft(
      "■査定ナンバー： SA2608－1234567\n■物件所在地： 東京都千代田区1-1",
    );
    expect(draft.externalLinkKey).toBe(stored);

    // ③ 重複判定は「保存された値」に当たる。
    const verdict = judgeDuplicates(
      { address: "東京都千代田区1-1", lotNumber: null, externalLinkKey: draft.externalLinkKey },
      [{ id: "p-csv", address: "東京都千代田区1-1", lotNumber: null, externalLinkKey: stored }],
    );
    expect(verdict.blocked).toBe(true);
    expect(verdict.blockedByPropertyId).toBe("p-csv");
  });

  it("★確定側が引く2表記のどちらかに、保存された値が必ず含まれる", () => {
    // commit / recheck は `in: [半角形, 全角形]` で引く。書込側が正規化されていれば
    // 保存値は必ず半角形なので当たる。
    const stored = normalizeExternalLinkKey("SA2608－1234567") as string;
    const variants = Array.from(new Set([stored, toFullWidth(stored)]));
    expect(variants).toContain(stored);
  });
});
