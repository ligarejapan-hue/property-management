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

describe("POST /api/import/csv — 外部キーは**書式のまま保存**する（22巡目）", () => {
  it("★混在幅のキーは、そのままの表記で保存される（変換しない）", () => {
    // ⚠17〜19巡目は保存時にも正規化していたが、22巡目で撤回した。
    //   リンクキーは利用者が付ける任意の管理コードで、物件CSVと所有者CSVは
    //   **生値の完全一致**で紐付く(owner-property-linker.ts)。所有者CSV側は
    //   `.trim()` のみで保存するので、物件側だけ変換すると紐付けが壊れる。
    const csv = "住所,リンクキー\n東京都千代田区1-1,SA2608－1234567\n";
    return POST(makeRequest({ fileName: "x.csv", csvText: csv })).then((res) => {
      expect(res.status).toBe(201);
      expect(lastCreateData().externalLinkKey).toBe("SA2608－1234567");
    });
  });

  it("★全角のキーもそのまま保存される", async () => {
    const csv = "住所,リンクキー\n東京都千代田区1-1,ＳＡ２６０８－１２３４５６７\n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(lastCreateData().externalLinkKey).toBe("ＳＡ２６０８－１２３４５６７");
  });

  it("★長音符を含む任意の管理コード『顧客ー001』がそのまま保存される", () => {
    // ⚠これが撤回の理由そのもの。正規化すると `ー`→`-` になり `顧客-001` に変わる。
    //   所有者CSVは生値で保存するので、変換した瞬間に紐付かなくなる。
    const csv = "住所,リンクキー\n東京都千代田区1-1,顧客ー001\n";
    return POST(makeRequest({ fileName: "x.csv", csvText: csv })).then(() => {
      expect(lastCreateData().externalLinkKey).toBe("顧客ー001");
    });
  });

  it("★前後の空白だけは落とす（所有者CSV側と同じ .trim() のみ）", async () => {
    const csv = "住所,リンクキー\n東京都千代田区1-1,  顧客ー001  \n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(lastCreateData().externalLinkKey).toBe("顧客ー001");
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

describe("端から端まで: CSVで入った行を、貼り付け取込側がブロックする", () => {
  it("★CSVが混在幅で保存した番号でも、**貼り付け取込側の**判定はブロックする", async () => {
    // ① CSV取込（書込側）。**生値のまま**保存される。
    const csv = "住所,リンクキー\n東京都千代田区1-1,SA2608－1234567\n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    const stored = lastCreateData().externalLinkKey as string;
    expect(stored).toBe("SA2608－1234567");

    // ② 貼り付け取込（読み側）。こちらは自機能が発行する鍵なので正規形で持つ。
    const draft = buildPasteDraft(
      "■査定ナンバー： SA2608－1234567\n■物件所在地： 東京都千代田区1-1",
    );
    expect(draft.externalLinkKey).toBe("SA2608-1234567");

    // ③ ⚠ここで効いているのは**貼り付け取込側の判定**(judgeDuplicates は
    //   normalizeForCompare で両側を正規化する)。
    //   CSV取込側の重複ガードは raw 比較なので当たらない(23巡目の契約)。
    //   自機能の鍵の意味論は自機能の中でだけ適用する、という線引き。
    const verdict = judgeDuplicates(
      { address: "東京都千代田区1-1", lotNumber: null, externalLinkKey: draft.externalLinkKey },
      [{ id: "p-csv", address: "東京都千代田区1-1", lotNumber: null, externalLinkKey: stored }],
    );
    expect(verdict.blocked).toBe(true);
    expect(verdict.blockedByPropertyId).toBe("p-csv");
  });

  it("★物件CSVと所有者CSVの『生値の完全一致』リンクの前提が保たれる", () => {
    // owner-property-linker.ts は Owner.externalLinkKey と Property.externalLinkKey を
    // **生値の完全一致**(where: { externalLinkKey: owner.externalLinkKey })で突合する。
    // 所有者CSVは `.trim()` のみで保存するので、物件CSV側も同じでなければ紐付かない。
    const fromOwnerCsv = "顧客ー001".trim();
    const csv = "住所,リンクキー\n東京都千代田区1-1,顧客ー001\n";
    return POST(makeRequest({ fileName: "x.csv", csvText: csv })).then(() => {
      expect(lastCreateData().externalLinkKey).toBe(fromOwnerCsv);
    });
  });

  it("★paste-import が発行する鍵は正規形なので、確定側の2表記に必ず当たる", () => {
    // ⚠paste-import 側の**保存の正規化は維持**している(R16)。
    //   あちらは自機能が発行する鍵で、査定ナンバーの正規形=半角ASCIIと定義できる。
    //   commit / recheck は `in: [半角形, 全角形]` で引くので必ず当たる。
    const stored = normalizeExternalLinkKey("SA2608－1234567") as string;
    expect(stored).toBe("SA2608-1234567");
    const variants = Array.from(new Set([stored, toFullWidth(stored)]));
    expect(variants).toContain(stored);
  });
});

describe("★重複判定は externalLinkKey を**生値で raw 比較**する（23巡目・契約）", () => {
  /**
   * ⚠src/lib/import-dedupe.ts の明文の契約:
   *   「識別子 (realEstateNumber / externalLinkKey) は正規化せず raw 比較
   *     （DB 側 exact を想定）」
   *
   * ⚠さらに `externalLinkKey一致` は **update-eligible（更新対象）** の判定理由。
   *   正規化して「一致」と判定した瞬間、`顧客ー001` と `顧客-001` を**意図的に
   *   別キー**として使う運用では、**別の物件のフィールドが上書きされ得る**。
   *   CSV のリンクキーは顧客の管理コードで、幅の違いに意味があり得る。
   *   「幅の違い＝同じ」は、自機能が発行して正規形を定義できる査定ナンバー
   *   (paste-import) にしか成立しない。他機能の鍵の意味論を変えない。
   */
  function existingWithKey(storedKey: string) {
    pm.property.findMany.mockResolvedValue([
      {
        id: "existing-1",
        address: "東京都千代田区9-9",
        roomNo: null,
        buildingId: null,
        realEstateNumber: null,
        externalLinkKey: storedKey,
      },
    ]);
    pm.property.findUnique.mockResolvedValue({
      id: "existing-1",
      address: "東京都千代田区9-9",
      registryStatus: "unconfirmed",
    });
    pm.property.updateMany.mockResolvedValue({ count: 1 });
    pm.property.findUniqueOrThrow.mockResolvedValue({
      id: "existing-1",
      address: "東京都千代田区9-9",
      roomNo: null,
      buildingId: null,
      realEstateNumber: null,
      externalLinkKey: storedKey,
    });
  }

  it("★`顧客-001` の既存行に対し `顧客ー001` の行は**重複と判定されない**（別物件として作成）", async () => {
    // ⚠今回の指摘の核心。正規化比較だと `ー`→`-` で一致し、
    //   別キー運用の物件が**上書き**される(externalLinkKey一致 = update-eligible)。
    existingWithKey("顧客-001");
    const csv = "住所,リンクキー\n東京都千代田区1-1,顧客ー001\n";
    const res = await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(res.status).toBe(201);
    expect(pm.property.create).toHaveBeenCalledTimes(1);
    expect(lastCreateData().externalLinkKey).toBe("顧客ー001");
    // 既存行は触られていない。
    expect(pm.property.updateMany).not.toHaveBeenCalled();
  });

  it("★生値が同一なら従来どおり一致する（重複ガード自体は効いている）", async () => {
    existingWithKey("顧客ー001");
    const csv = "住所,リンクキー\n東京都千代田区1-1,顧客ー001\n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(pm.property.create).not.toHaveBeenCalled();
  });

  it("★全角キーの既存行に対し半角の行は**一致しない**（raw 比較なので検出しない・契約どおり）", async () => {
    // ⚠混在幅/全角の査定ナンバーが CSV 経由で入っていた場合、重複ガードは
    //   効かない。**本番0件**であり、明文の契約(raw 比較)を優先する。
    existingWithKey("ＳＡ２６０８－１２３４５６７");
    const csv = "住所,リンクキー\n東京都千代田区1-1,SA2608-1234567\n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(pm.property.create).toHaveBeenCalledTimes(1);
  });

  it("★混在幅の行も、半角で保存済みの既存行と**一致しない**（同上）", async () => {
    existingWithKey("SA2608-1234567");
    const csv = "住所,リンクキー\n東京都千代田区1-1,SA2608－1234567\n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(pm.property.create).toHaveBeenCalledTimes(1);
  });

  it("★同一CSV内の全角と半角は**別物**として2件できる（raw 比較の帰結）", async () => {
    pm.property.findMany.mockResolvedValue([]);
    const csv =
      "住所,リンクキー\n" +
      "東京都千代田区1-1,SA2608-1234567\n" +
      "東京都千代田区2-2,ＳＡ２６０８－１２３４５６７\n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(pm.property.create).toHaveBeenCalledTimes(2);
  });

  it("★同一CSV内で生値が同じ2行なら、従来どおり2件にならない", async () => {
    pm.property.findMany.mockResolvedValue([]);
    pm.property.findUnique.mockResolvedValue({
      id: "new-1",
      address: "東京都千代田区1-1",
      registryStatus: "unconfirmed",
    });
    pm.property.updateMany.mockResolvedValue({ count: 1 });
    pm.property.findUniqueOrThrow.mockResolvedValue({
      id: "new-1",
      address: "東京都千代田区1-1",
      roomNo: null,
      buildingId: null,
      realEstateNumber: null,
      externalLinkKey: "SA2608-1234567",
    });
    const csv =
      "住所,リンクキー\n" +
      "東京都千代田区1-1,SA2608-1234567\n" +
      "東京都千代田区2-2,SA2608-1234567\n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(pm.property.create).toHaveBeenCalledTimes(1);
  });

  it("★別の番号なら従来どおり2件できる", async () => {
    pm.property.findMany.mockResolvedValue([]);
    const csv =
      "住所,リンクキー\n" +
      "東京都千代田区1-1,SA2608-1111111\n" +
      "東京都千代田区2-2,SA2608-2222222\n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(pm.property.create).toHaveBeenCalledTimes(2);
  });
});
