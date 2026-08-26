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

describe("端から端まで: CSVで入った行を、貼り付け取込がブロックする", () => {
  it("★CSVが混在幅で取り込んだ番号を貼り付けても blocked になる（比較の正規化）", async () => {
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

    // ③ **比較は両側を正規化**するので、保存の表記が違っても重複と判定される。
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

describe("★正規化は重複チェックより前に効く（18巡目 ①）", () => {
  /**
   * ⚠保存時だけ正規化していたときの壊れ方:
   *   ①全角キーの行は、半角で保存済みの既存行と**照合で一致せず**
   *   ②そのまま**正規化されたキーで新規作成**される
   *   → 同じ番号の物件が2件できる。同一CSV内の等価な2行でも同じ。
   */
  it("★全角キーの行は、半角で保存済みの既存行と照合で一致する（新規作成しない）", async () => {
    pm.property.findMany.mockResolvedValue([
      {
        id: "existing-1",
        address: "東京都千代田区9-9",
        roomNo: null,
        buildingId: null,
        realEstateNumber: null,
        externalLinkKey: "SA2608-1234567",
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
      externalLinkKey: "SA2608-1234567",
    });

    const csv = "住所,リンクキー\n東京都千代田区1-1,ＳＡ２６０８－１２３４５６７\n";
    const res = await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(res.status).toBe(201);
    // 既存行と一致したので**新規作成されない**。
    expect(pm.property.create).not.toHaveBeenCalled();
  });

  it("★混在幅のキーでも照合で一致する", async () => {
    pm.property.findMany.mockResolvedValue([
      {
        id: "existing-1",
        address: "東京都千代田区9-9",
        roomNo: null,
        buildingId: null,
        realEstateNumber: null,
        externalLinkKey: "SA2608-1234567",
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
      externalLinkKey: "SA2608-1234567",
    });

    const csv = "住所,リンクキー\n東京都千代田区1-1,SA2608－1234567\n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(pm.property.create).not.toHaveBeenCalled();
  });

  it("★同一CSV内の全角と半角の等価な2行が、2件にならない", async () => {
    pm.property.findMany.mockResolvedValue([]); // 既存行は無い状態から始める
    // 1行目で作った行は dedupe index に入る。2行目(全角)は照合で一致するべき。
    const csv =
      "住所,リンクキー\n" +
      "東京都千代田区1-1,SA2608-1234567\n" +
      "東京都千代田区2-2,ＳＡ２６０８－１２３４５６７\n";
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

    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    // 作られるのは1件だけ。
    expect(pm.property.create).toHaveBeenCalledTimes(1);
    expect(lastCreateData().externalLinkKey).toBe("SA2608-1234567");
  });

  it("★別の番号なら従来どおり2件できる（照合が広がりすぎていない）", async () => {
    pm.property.findMany.mockResolvedValue([]);
    const csv =
      "住所,リンクキー\n" +
      "東京都千代田区1-1,SA2608-1111111\n" +
      "東京都千代田区2-2,SA2608-2222222\n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(pm.property.create).toHaveBeenCalledTimes(2);
  });
});

describe("★照合は両側を同じ関数で正規化する（19巡目 ③）", () => {
  /** 既存行1件を DB に置く。key の表記はそのまま(＝この変更以前のデータを再現)。 */
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

  it("★既存行が**全角**・新しいCSV行が半角 → 重複と判定される", () => {
    // ⚠入ってくる側だけ正規化していたときは一致せず、2件目ができていた。
    existingWithKey("ＳＡ２６０８－１２３４５６７");
    const csv = "住所,リンクキー\n東京都千代田区1-1,SA2608-1234567\n";
    return POST(makeRequest({ fileName: "x.csv", csvText: csv })).then(() => {
      expect(pm.property.create).not.toHaveBeenCalled();
    });
  });

  it("★逆方向: 既存行が半角・新しいCSV行が全角 → 重複と判定される", async () => {
    existingWithKey("SA2608-1234567");
    const csv = "住所,リンクキー\n東京都千代田区1-1,ＳＡ２６０８－１２３４５６７\n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(pm.property.create).not.toHaveBeenCalled();
  });

  it("★既存行が**混在幅** → 半角の新しい行と重複と判定される", async () => {
    existingWithKey("SA2608－1234567");
    const csv = "住所,リンクキー\n東京都千代田区1-1,SA2608-1234567\n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(pm.property.create).not.toHaveBeenCalled();
  });

  it("★別の番号なら重複にしない（正規化で潰しすぎていない）", async () => {
    existingWithKey("ＳＡ２６０８－９９９９９９９");
    const csv = "住所,リンクキー\n東京都千代田区1-1,SA2608-1234567\n";
    await POST(makeRequest({ fileName: "x.csv", csvText: csv }));
    expect(pm.property.create).toHaveBeenCalledTimes(1);
  });
});
